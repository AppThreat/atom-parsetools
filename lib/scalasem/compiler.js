// Compiler resolution: the TASTy header names the exact compiler that wrote a file, and that
// is the compiler whose inspector reads it. The jars come from the build first, then from the
// local Coursier and Maven caches, and only when installs are allowed from a throwaway sbt
// project. The debug printer is never used: it crashes on TASTy newer than the compiler.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  PATH_LIST_SEPARATOR,
  javaCommand,
  readHead,
  run,
  scratchDir
} from "./util.js";

const TASTY_MAGIC = Buffer.from([0x5c, 0xa1, 0xab, 0x1f]);
const HELPER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "inspector",
  "ScalasemInspector.scala"
);

/**
 * Read one TASTy natural number: big endian base 128, the last byte has the high bit set.
 *
 * @param {Buffer} buf File head
 * @param {number} offset Read position
 * @returns {[number, number]} Value and the position after it
 */
function tastyNat(buf, offset) {
  let value = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i];
    value = value * 128 + (byte & 0x7f);
    i += 1;
    if (byte & 0x80) {
      return [value, i];
    }
  }
  return [value, i];
}

/**
 * Read the header of a `.tasty` file: the TASTy version triplet and the tooling string that
 * names the compiler release, for example `Scala 3.3.7`.
 *
 * @param {string} file TASTy file
 * @returns {{ major: number, minor: number, experimental: number, toolVersion?: string }|undefined}
 */
export function readTastyHeader(file) {
  const head = readHead(file, 96);
  if (!head || !head.subarray(0, 4).equals(TASTY_MAGIC)) {
    return undefined;
  }
  const [major, afterMajor] = tastyNat(head, 4);
  const [minor, afterMinor] = tastyNat(head, afterMajor);
  const [experimental, afterExperimental] = tastyNat(head, afterMinor);
  const result = { major, minor, experimental };
  if (afterExperimental + 1 < head.length) {
    const [length, stringStart] = tastyNat(head, afterExperimental);
    if (length > 0 && stringStart + length <= head.length) {
      const tooling = head
        .subarray(stringStart, stringStart + length)
        .toString("utf-8");
      const version = /^Scala ([0-9][0-9A-Za-z.\w-]*)$/.exec(tooling)?.[1];
      if (version) {
        result.toolVersion = version;
      }
    }
  }
  return result;
}

/**
 * Local artifact caches, most specific first. Coursier caches keep one directory per
 * repository (`https/repo1.maven.org/maven2/...`); a Maven local repository is the layout itself.
 *
 * @returns {{ root: string, layout: "coursier"|"maven" }[]}
 */
function cacheRoots() {
  const roots = [];
  const home = homedir();
  if (process.env.COURSIER_CACHE) {
    roots.push(process.env.COURSIER_CACHE);
  }
  if (process.platform === "darwin") {
    roots.push(join(home, "Library", "Caches", "Coursier", "v1"));
  } else if (process.platform === "win32") {
    roots.push(
      join(
        process.env.LOCALAPPDATA || join(home, "AppData", "Local"),
        "Coursier",
        "Cache",
        "v1"
      )
    );
  } else {
    roots.push(join(home, ".cache", "coursier", "v1"));
  }
  return [
    ...roots.map((root) => ({ root, layout: "coursier" })),
    { root: join(home, ".m2", "repository"), layout: "maven" }
  ];
}

/**
 * Locate an artifact in the caches by its repository relative path, for example
 * `org/scala-lang/scala3-compiler_3/3.3.7`.
 *
 * @param {string} relPath Repository path without the version
 * @param {string[]} versions Acceptable versions, first hit wins
 * @returns {string|undefined} Jar path
 */
function cachedArtifact(relPath, versions) {
  for (const cache of cacheRoots()) {
    const root = cache.root;
    for (const repo of repoPrefixes(cache)) {
      for (const version of versions) {
        const artifact = relPath.split("/").pop();
        const jar = join(
          root,
          ...repo,
          ...relPath.split("/"),
          version,
          `${artifact}-${version}.jar`
        );
        if (existsSync(jar)) {
          return jar;
        }
      }
    }
  }
  return undefined;
}

function repoPrefixes({ root, layout }) {
  if (layout === "maven") {
    return [[]];
  }
  // The default repository prefix of a Coursier cache for Maven Central.
  const prefixes = [["https", "repo1.maven.org", "maven2"]];
  try {
    const protocols = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const protocol of protocols) {
      for (const host of readdirSync(join(root, protocol), {
        withFileTypes: true
      })) {
        if (!host.isDirectory()) {
          continue;
        }
        if (host.name !== "repo1.maven.org") {
          prefixes.push([protocol, host.name, "maven2"]);
        }
      }
    }
  } catch (_err) {
    // cache without the usual layout
  }
  return prefixes;
}

/**
 * The full compiler toolchain for a Scala 3 version, from the build or the caches.
 *
 * @param {Object} module Module inventory entry
 * @param {Object} opts `{ installDeps }`
 * @returns {{ compilerJars: string[], libraryJars: string[], inspectorJar?: string, version: string, source: string }|undefined}
 */
export function resolveToolchain(module, opts = {}) {
  const version = module.scalaVersion;
  if (!version || !version.startsWith("3.")) {
    return undefined;
  }
  if (module.compilerJars?.length) {
    return {
      compilerJars: module.compilerJars,
      libraryJars: module.libraryJars?.length
        ? module.libraryJars
        : module.compilerJars.filter((p) =>
            /scala3-library_3|^scala-library-2/.test(basename(p))
          ),
      // Mill and Maven builds do not resolve the tasty inspector, so the caches fill the gap.
      inspectorJar:
        module.inspectorJar ||
        module.compilerJars.find((p) =>
          basename(p).startsWith("scala3-tasty-inspector")
        ) ||
        cachedArtifact("org/scala-lang/scala3-tasty-inspector_3", [version]) ||
        (opts.installDeps !== false ? fetchInspector(version) : undefined),
      version,
      source: module.buildTool || "cache"
    };
  }
  let toolchain = toolchainFromCaches(version);
  if (!toolchain?.inspectorJar && opts.installDeps !== false) {
    // The throwaway project resolves the inspector together with the compiler and library it
    // depends on, so a cache that held none of them is complete afterwards.
    const fetched = fetchInspector(version);
    toolchain = toolchainFromCaches(version);
    if (toolchain && !toolchain.inspectorJar) {
      toolchain.inspectorJar = fetched;
    }
  }
  return toolchain;
}

/** The compiler, library and inspector jars of one Scala 3 release from the local caches. */
function toolchainFromCaches(version) {
  const compilerJars = [];
  // The compiler, its interfaces and tasty-core share the release version; the assembler and
  // the sbt bridge version independently of it.
  for (const [relPath, exact] of [
    ["org/scala-lang/scala3-compiler_3", true],
    ["org/scala-lang/scala3-interfaces", true],
    ["org/scala-lang/tasty-core_3", true],
    ["org/scala-lang/modules/scala-asm", false],
    ["org/scala-sbt/compiler-interface", false]
  ]) {
    const jar =
      cachedArtifact(relPath, [version]) ||
      (exact ? undefined : newestCached(relPath));
    if (jar) {
      compilerJars.push(jar);
    }
  }
  const libraryJars = [];
  const scala3Library = cachedArtifact("org/scala-lang/scala3-library_3", [
    version
  ]);
  if (scala3Library && isRealJar(scala3Library)) {
    // Before the congruent library switch, `scala3-library_3` holds the classes and the
    // Scala 2 library of the matching 2.13 line completes them.
    libraryJars.push(scala3Library);
    const scala2 = newestCached("org/scala-lang/scala-library", "2.13.0");
    if (scala2) {
      libraryJars.push(scala2);
    }
  } else {
    // Since the switch, `scala3-library_3` is an empty redirect and the classes live in the
    // artifact named like the Scala 2 library.
    const congruent = cachedArtifact("org/scala-lang/scala-library", [version]);
    if (congruent) {
      libraryJars.push(congruent);
    }
  }
  if (!compilerJars.length || !libraryJars.length) {
    return undefined;
  }
  const inspectorJar = cachedArtifact(
    "org/scala-lang/scala3-tasty-inspector_3",
    [version]
  );
  return { compilerJars, libraryJars, inspectorJar, version, source: "cache" };
}

function isRealJar(file) {
  try {
    return statSync(file).size > 1024;
  } catch (_err) {
    return false;
  }
}

/**
 * Compare dotted versions, epoch and pre release qualifiers included.
 *
 * @param {string} a First version
 * @param {string} b Second version
 * @returns {number} Negative when a is older
 */
function compareVersions(a, b) {
  const key = (v) =>
    v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const left = key(a);
  const right = key(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) {
      continue;
    }
    if (l === undefined) {
      return -1;
    }
    if (r === undefined) {
      return 1;
    }
    if (typeof l !== typeof r) {
      return typeof l === "number" ? -1 : 1;
    }
    return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * The newest cached version of an artifact that is at least `minimum`.
 *
 * @param {string} relPath Repository path of the artifact
 * @param {string} [minimum] Minimum acceptable version
 * @returns {string|undefined} Jar path
 */
function newestCached(relPath, minimum) {
  let best;
  for (const cache of cacheRoots()) {
    for (const repo of repoPrefixes(cache)) {
      const artifactDir = join(cache.root, ...repo, ...relPath.split("/"));
      if (!existsSync(artifactDir)) {
        continue;
      }
      const artifact = relPath.split("/").pop();
      for (const version of readdirSync(artifactDir, { withFileTypes: true })) {
        if (!version.isDirectory() || !/^\d/.test(version.name)) {
          continue;
        }
        if (minimum && compareVersions(version.name, minimum) < 0) {
          continue;
        }
        if (minimum?.startsWith("2.13") && !version.name.startsWith("2.13")) {
          continue;
        }
        const jar = join(
          artifactDir,
          version.name,
          `${artifact}-${version.name}.jar`
        );
        if (!isRealJar(jar)) {
          continue;
        }
        if (!best || compareVersions(version.name, best.version) > 0) {
          best = { version: version.name, jar };
        }
      }
    }
  }
  return best?.jar;
}

/**
 * Fetch the tasty inspector jar with a throwaway sbt project. Only called when installs are
 * allowed.
 */
function fetchInspector(version) {
  if (!/^3\.[0-9A-Za-z.-]+$/.test(version)) {
    return undefined;
  }
  let tmp;
  try {
    tmp = scratchDir("scalasem-inspector-");
    writeFileSync(
      join(tmp, "build.sbt"),
      `ThisBuild / scalaVersion := "${version}"\nlibraryDependencies += "org.scala-lang" %% "scala3-tasty-inspector" % "${version}"\n`
    );
    mkdirSync(join(tmp, "project"), { recursive: true });
    writeFileSync(
      join(tmp, "project", "build.properties"),
      "sbt.version=1.10.11\n"
    );
    const sbt = process.env.SBT_CMD || "sbt";
    // A private global base keeps the user's global plugins, which may not resolve, out of
    // the throwaway build.
    const result = run(
      sbt,
      [
        "-batch",
        "-no-colors",
        `-Dsbt.global.base=${join(tmp, "global")}`,
        "export Compile/dependencyClasspath"
      ],
      { cwd: tmp, timeout: 600000 }
    );
    const line = (result.stdout || "")
      .split("\n")
      .find((l) => l.includes("scala3-tasty-inspector_3"));
    if (line) {
      const jar = line
        .split(PATH_LIST_SEPARATOR)
        .filter((p) => p.endsWith(".jar"))
        .find((p) => basename(p).startsWith("scala3-tasty-inspector_3"));
      if (jar && existsSync(jar)) {
        return jar;
      }
    }
  } catch (_err) {
    // fetch failed, the module falls back with a diagnostic
  } finally {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return undefined;
}

/**
 * Compile the inspector helper with the given toolchain, once per compiler version and helper
 * content, into a cache directory.
 *
 * @param {{ compilerJars: string[], libraryJars: string[], inspectorJar?: string, version: string }} toolchain
 * @returns {string|undefined} Directory holding ScalasemInspector.class
 */
export function compileHelper(toolchain) {
  if (!toolchain.inspectorJar) {
    return undefined;
  }
  // A build may list the empty redirect jar the congruent library switch introduced; it
  // contributes nothing and only confuses the compiler, so it stays off every classpath.
  const jars = (list) => (list || []).filter((j) => isRealJar(j));
  const hash = createHash("sha256")
    .update(readFileSync(HELPER_SOURCE, "utf-8"))
    .update(toolchain.version)
    .digest("hex")
    .slice(0, 16);
  const outDir = join(
    helperCacheRoot(),
    `inspector-${toolchain.version}-${hash}`
  );
  if (existsSync(join(outDir, ".complete"))) {
    return outDir;
  }
  // Compile into a private directory and move it into place, so concurrent runs never see or
  // remove each other's half written output.
  const workDir = `${outDir}.${process.pid}.tmp`;
  try {
    rmSync(workDir, { recursive: true, force: true });
    mkdirSync(workDir, { recursive: true });
    const classpath = [
      ...new Set([...jars(toolchain.libraryJars), toolchain.inspectorJar])
    ].join(PATH_LIST_SEPARATOR);
    const toolchainClasspath = [
      ...new Set([
        ...jars(toolchain.compilerJars),
        ...jars(toolchain.libraryJars)
      ])
    ].join(PATH_LIST_SEPARATOR);
    const result = run(
      javaCommand(),
      [
        "-cp",
        toolchainClasspath,
        "dotty.tools.dotc.Main",
        "-classpath",
        classpath,
        "-d",
        workDir,
        HELPER_SOURCE
      ],
      { timeout: 600000 }
    );
    if (result.status !== 0) {
      console.error(
        (result.stderr || result.stdout || "").split("\n").slice(-5).join("\n")
      );
      return undefined;
    }
    writeFileSync(join(workDir, ".complete"), toolchain.version);
    try {
      renameSync(workDir, outDir);
    } catch (_err) {
      // Another run finished first; its output is identical.
      if (!existsSync(join(outDir, ".complete"))) {
        return undefined;
      }
    }
    return outDir;
  } catch (_err) {
    return undefined;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Where compiled helpers are kept: `SCALASEM_CACHE_DIR`, else `$XDG_CACHE_HOME/scalasem`, else
 * `~/.cache/scalasem`, and the system temporary directory when none of those is writable.
 *
 * @returns {string}
 */
function helperCacheRoot() {
  const candidates = [
    process.env.SCALASEM_CACHE_DIR,
    process.env.XDG_CACHE_HOME && join(process.env.XDG_CACHE_HOME, "scalasem"),
    join(homedir(), ".cache", "scalasem")
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true });
      const probe = join(candidate, `.probe-${process.pid}`);
      writeFileSync(probe, "");
      rmSync(probe, { force: true });
      return candidate;
    } catch (_err) {
      // not writable, try the next one
    }
  }
  return join(tmpdir(), "scalasem");
}

/**
 * Run the helper over a batch of TASTy files and return its JSON lines.
 *
 * @param {{ compilerJars: string[], libraryJars: string[], inspectorJar?: string }} toolchain
 * @param {string} helperDir Directory holding the compiled helper
 * @param {string[]} classpath Dependency classpath entries
 * @param {string[]} tastyFiles TASTy files of the batch
 * @returns {string[]} JSON lines
 */
export function runInspector(toolchain, helperDir, classpath, tastyFiles) {
  const scratch = scratchDir("scalasem-cp-");
  const cpFile = join(scratch, "classpath.txt");
  // A zero length jar, which an interrupted download leaves behind, makes the compiler reject
  // every file of the batch.
  const usable = classpath.filter((entry) => {
    try {
      return !entry.endsWith(".jar") || statSync(entry).size > 0;
    } catch (_err) {
      return false;
    }
  });
  writeFileSync(cpFile, usable.join(PATH_LIST_SEPARATOR));
  const realJars = (list) => (list || []).filter((j) => isRealJar(j));
  const runClasspath = [
    ...new Set([
      ...realJars(toolchain.compilerJars),
      ...realJars(toolchain.libraryJars),
      toolchain.inspectorJar,
      helperDir
    ])
  ].join(PATH_LIST_SEPARATOR);
  const result = run(
    javaCommand(),
    [
      "-cp",
      runClasspath,
      "ScalasemInspector",
      `--classpath-file=${cpFile}`,
      ...tastyFiles
    ],
    { timeout: 1200000 }
  );
  rmSync(scratch, { recursive: true, force: true });
  if (result.error) {
    console.error(result.error.message);
    return [];
  }
  if (result.status !== 0) {
    const lines = (result.stderr || result.stdout || "")
      .split("\n")
      .filter(Boolean);
    console.error(lines.slice(0, 3).join("\n"));
  }
  return (result.stdout || "")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"));
}
