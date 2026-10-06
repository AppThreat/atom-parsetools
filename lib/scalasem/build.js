// Build discovery and the module inventory: which modules a Scala build has, their Scala
// version, class directories, source roots and the compiler and dependency classpaths the
// build itself resolved. Nothing here reads TASTy; that is the inspector stage.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import process from "node:process";

import {
  jarCoordinate,
  listDirsHolding,
  listFiles,
  run
} from "./util.js";

const SBT_PROJECT_LINE = /^\[info\]\s+(\*?)\s*([A-Za-z0-9_.-]+)\s*$/;

/**
 * Which build tool owns a directory, with the version when it is known statically.
 *
 * @param {string} dir Project directory
 * @returns {{ tool: "sbt"|"mill"|"maven"|"scala-cli"|"none", version?: string }}
 */
export function detectBuildTool(dir) {
  const sbtVersion = readSbtVersion(dir);
  if (
    existsSync(join(dir, "build.sbt")) ||
    existsSync(join(dir, "project", "build.properties")) ||
    (sbtVersion && readdirSync(dir).some((f) => f.endsWith(".sbt")))
  ) {
    return { tool: "sbt", version: sbtVersion };
  }
  if (existsSync(join(dir, "build.mill")) || existsSync(join(dir, "build.sc"))) {
    return { tool: "mill", version: readMillVersion(dir) };
  }
  const pom = join(dir, "pom.xml");
  if (existsSync(pom)) {
    try {
      if (readFileSync(pom, "utf-8").includes("scala-maven-plugin")) {
        return { tool: "maven" };
      }
    } catch (_err) {
      // unreadable pom falls through
    }
  }
  if (hasScalaCliDirectives(dir)) {
    return { tool: "scala-cli" };
  }
  return { tool: "none" };
}

function readSbtVersion(dir) {
  const props = join(dir, "project", "build.properties");
  if (!existsSync(props)) {
    return undefined;
  }
  try {
    const line = readFileSync(props, "utf-8")
      .split("\n")
      .find((l) => l.trim().startsWith("sbt.version"));
    return line ? line.split("=").pop().trim() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function readMillVersion(dir) {
  const dot = join(dir, ".mill-version");
  if (existsSync(dot)) {
    try {
      return readFileSync(dot, "utf-8").trim();
    } catch (_err) {
      // fall through to the header
    }
  }
  for (const name of ["build.mill", "build.sc"]) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      continue;
    }
    try {
      const header = readFileSync(file, "utf-8").split("\n").slice(0, 5);
      const line = header.find((l) => l.includes("mill-version:"));
      if (line) {
        return line.split("mill-version:").pop().trim();
      }
    } catch (_err) {
      // unreadable build file
    }
  }
  return undefined;
}

function hasScalaCliDirectives(dir) {
  if (existsSync(join(dir, ".scala-build"))) {
    return true;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(scala|sc)$/.test(entry.name)) {
      continue;
    }
    try {
      const head = readFileSync(join(dir, entry.name), "utf-8").split("\n").slice(0, 10);
      if (head.some((l) => l.trim().startsWith("//> using "))) {
        return true;
      }
    } catch (_err) {
      // unreadable file
    }
  }
  return false;
}

/**
 * Collect the module inventory of a project.
 *
 * @param {string} dir Project directory
 * @param {Object} opts `{ noBuild, noCompile, includeTests, installDeps, sbtCommand, millCommand, scalaVersion }`
 * @returns {Promise<{ tool: string, version?: string, modules: Object[], diagnostics: Object[] }>}
 */
export async function inventory(dir, opts = {}) {
  const detected =
    opts.build && opts.build !== "auto"
      ? { tool: opts.build, version: undefined }
      : detectBuildTool(dir);
  const diagnostics = [];
  switch (detected.tool) {
    case "sbt":
      return {
        tool: "sbt",
        version: detected.version,
        ...(await sbtInventory(dir, { ...opts, version: detected.version }, diagnostics)),
        diagnostics
      };
    case "mill":
      return {
        tool: "mill",
        version: detected.version,
        ...millInventory(dir, opts, diagnostics),
        diagnostics
      };
    case "maven":
      return { tool: "maven", ...mavenInventory(dir, opts, diagnostics), diagnostics };
    case "scala-cli":
      return {
        tool: "scala-cli",
        ...scalaCliInventory(dir, opts, diagnostics),
        diagnostics
      };
    default:
      return { tool: "none", ...noBuildInventory(dir, opts, diagnostics), diagnostics };
  }
}

/**
 * The joined sbt query for one project list: the compiler instance, the class directory, the
 * source roots and the dependency classpath of every project, delimited by markers.
 */
function querySbt(sbt, dir, projects, diagnostics) {
  const sections = {};
  const commands = [];
  const mark = (tag, project) => {
    commands.push(`eval println("scalasem-section:${tag}:${project}")`);
  };
  for (const project of projects) {
    mark("instance", project);
    commands.push(`print ${project}/scalaInstance`);
    mark("classpath", project);
    commands.push(`export ${project}/Compile/dependencyClasspath`);
    mark("classdir", project);
    commands.push(`export ${project}/Compile/classDirectory`);
    mark("sources", project);
    commands.push(`print ${project}/Compile/unmanagedSourceDirectories`);
  }
  const result = run(sbt, ["-batch", "-no-colors", commands.join("; ")], { cwd: dir });
  if (result.status !== 0 || result.error) {
    diagnostics.push({ code: "sbt-inventory-failed", tool: "sbt" });
  }
  collectSections(result.stdout || "", sections);
  return sections;
}

/** True when none of the class directories the build reports exists yet. */
function reportedClassDirsMissing(sections, projects) {
  const dirs = projects.flatMap((p) => ownExportValues(sections[`classdir:${p}`] || []));
  return dirs.length > 0 && !dirs.some((d) => existsSync(d));
}

/**
 * sbt: one session lists the projects, a second runs the per module `print` and `export`
 * commands joined into a single argument, which is the only form sbt 2 parses correctly.
 */
async function sbtInventory(dir, opts, diagnostics) {
  const sbt = opts.sbtCommand || process.env.SBT_CMD || "sbt";
  const sbt2 = opts.version ? !opts.version.startsWith("1.") : false;
  if (opts.noBuild) {
    return noBuildInventory(dir, opts, diagnostics, "sbt");
  }
  const projects = sbtProjects(sbt, dir, diagnostics);
  if (!projects.length) {
    return noBuildInventory(dir, opts, diagnostics, "sbt");
  }
  let sections = querySbt(sbt, dir, projects, diagnostics);
  if (sbt2) {
    // sbt 2 leaves its server running after a batch invocation.
    run(sbt, ["-batch", "-no-colors", "shutdown"], { cwd: dir });
  }
  if (
    !opts.noCompile &&
    (needsCompile(dir, "sbt") || reportedClassDirsMissing(sections, projects))
  ) {
    const compileCommand =
      process.env.SBT_COMPILE_COMMAND ||
      (opts.scalaVersion ? `++${opts.scalaVersion} compile` : "compile");
    const result = run(sbt, ["-batch", "-no-colors", compileCommand], { cwd: dir });
    if (result.status !== 0) {
      diagnostics.push({ code: "build-compile-failed", tool: "sbt" });
    } else {
      sections = querySbt(sbt, dir, projects, diagnostics);
      if (sbt2) {
        run(sbt, ["-batch", "-no-colors", "shutdown"], { cwd: dir });
      }
    }
  }
  const modules = [];
  for (const project of projects) {
    const instance = parseScalaInstance(sections[`instance:${project}`]);
    const classDirs = ownExportValues(sections[`classdir:${project}`] || []);
    const sourceRoots = (sections[`sources:${project}`] || [])
      .map((l) => l.replace(/^\*\s*/, "").trim())
      .filter(Boolean);
    const classpath = ownExportValues(sections[`classpath:${project}`] || []).flatMap((l) =>
      splitClasspath(expandVirtualPaths(l, dir))
    );
    if (!instance && !classDirs.length) {
      continue;
    }
    modules.push({
      id: project,
      buildTool: "sbt",
      scalaVersion: instance?.version,
      platform: platformOfClasspath(classpath.map((c) => c.path)),
      classDirs,
      sourceRoots,
      compilerJars: instance?.compilerJars || [],
      libraryJars: instance?.libraryJars || [],
      inspectorJar: instance?.inspectorJar,
      classpath,
      scope: "main"
    });
  }
  if (!modules.length) {
    return noBuildInventory(dir, opts, diagnostics, "sbt");
  }
  return { modules };
}

/**
 * `export` on an aggregating project prints one labelled value per aggregated subproject and
 * one for the project itself; only the project's own value may be used, the others belong to
 * modules that are queried separately.
 */
function ownExportValues(lines) {
  const values = [];
  for (let i = 0; i < lines.length; i += 2) {
    const label = lines[i];
    const value = lines[i + 1];
    if (value === undefined) {
      // A single unlabelled line is the project's own value.
      if (label?.trim() && !label.includes(" / ")) {
        values.push(label.trim());
      }
      continue;
    }
    if (label && label.split(" / ").length === 2) {
      values.push(value.trim());
    }
  }
  return values.filter(Boolean);
}

function sbtProjects(sbt, dir, diagnostics) {
  const result = run(sbt, ["-batch", "-no-colors", "projects"], { cwd: dir });  if (result.status !== 0 || result.error) {
    diagnostics.push({ code: "sbt-projects-failed", tool: "sbt" });
    return [];
  }
  const projects = [];
  for (const line of (result.stdout || "").split("\n")) {
    const match = SBT_PROJECT_LINE.exec(line.trim().replace(/\r/g, ""));
    if (match && !["info", "warn"].includes(match[2])) {
      projects.push(match[2]);
    }
  }
  return projects;
}

/** Split the marked sections of a joined sbt command output. */
function collectSections(stdout, sections) {
  let current;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r/g, "");
    if (line.startsWith("[info]")) {
      continue;
    }
    const mark = /scalasem-section:([a-z]+):([A-Za-z0-9_.-]+)/.exec(line);
    if (mark) {
      current = `${mark[1]}:${mark[2]}`;
      sections[current] = [];
      continue;
    }
    if (current && line.trim() && !line.startsWith("[success]")) {
      sections[current].push(line);
    }
  }
}

/**
 * sbt 2 prints virtual Coursier paths such as `List(${CSR_CACHE}/https/...)`, which have to
 * be expanded before they can be opened. Mill prints `qref:v1:<hash>:` prefixed paths.
 */
export function expandVirtualPaths(line, projectDir) {
  const cacheRoots = coursierCacheRoots();
  let expanded = line.trim().replace(/^List\(|\)$/g, "");
  const unquote = (v) => v.trim().replace(/^"|"$/g, "").replace(/qref:v1:[0-9a-f]+:/, "").replace(/ref:v0:[0-9a-f]+:/, "");
  return expanded
    .split(", ")
    .map(unquote)
    .filter(Boolean)
    .map((p) => {
      if (!p.includes("${")) {
        return p;
      }
      for (const root of cacheRoots) {
        const candidate = p.replaceAll("${CSR_CACHE}", root).replaceAll("${BASE}", projectDir).replaceAll("${WORKSPACE}", projectDir);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
      return p.replaceAll("${CSR_CACHE}", cacheRoots[0] || "").replaceAll("${BASE}", projectDir).replaceAll("${WORKSPACE}", projectDir);
    })
    .join(process.platform === "win32" ? ";" : ":");
}

function coursierCacheRoots() {
  const roots = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  const configured = process.env.COURSIER_CACHE;
  if (configured) {
    roots.push(configured);
  }
  if (home) {
    roots.push(join(home, "Library", "Caches", "Coursier", "v1"));
    roots.push(join(home, ".cache", "coursier", "v1"));
    if (process.env.LOCALAPPDATA) {
      roots.push(join(process.env.LOCALAPPDATA, "Coursier", "Cache", "v1"));
    }
  }
  return roots;
}

function splitClasspath(classpath) {
  return classpath
    .split(process.platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((p) => ({ path: p, ...jarCoordinate(p) }))
    .filter((entry) => entry.path.endsWith(".jar") || existsSync(entry.path));
}

function parseScalaInstance(lines) {
  const text = (lines || []).join(" ");
  if (!text.includes("Scala instance")) {
    return undefined;
  }
  const version = /version label ([0-9][^,]*)/.exec(text)?.[1];
  const jars = (label) => {
    const part = `${label} jars: `.length;
    const start = text.indexOf(`${label} jars: `);
    if (start < 0) {
      return [];
    }
    const rest = text.slice(start + part);
    const end = ["library jars: ", "compiler jars: ", "other jars: ", "}"]
      .map((marker) => rest.indexOf(marker))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0];
    return (end === undefined ? rest : rest.slice(0, end))
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.endsWith(".jar") && existsSync(p));
  };
  return {
    version,
    libraryJars: jars("library"),
    compilerJars: jars("compiler"),
    inspectorJar: jars("other").find((p) => basename(p).startsWith("scala3-tasty-inspector"))
  };
}

/**
 * Mill: run `__.compile` when allowed, then read the JSON files the build wrote under
 * `out/<module>/`, which carry the same data a `show` would print.
 */
function millInventory(dir, opts, diagnostics) {
  if (!opts.noBuild) {
    const mill = millCommand(dir, opts);
    if (needsCompile(dir, "mill") && !opts.noCompile) {
      const compileCommand = process.env.MILL_COMPILE_COMMAND || "__.compile";
      const result = run(mill.cmd, ["--no-server", ...compileCommand.split(" ")], {
        cwd: dir
      });
      if (result.status !== 0) {
        diagnostics.push({ code: "build-compile-failed", tool: "mill" });
      }
    }
  }
  const outDir = join(dir, "out");
  const modules = [];
  if (!existsSync(outDir)) {
    return { modules };
  }
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "mill-build" || entry.name.startsWith("mill-")) {
      continue;
    }
    const moduleDir = join(outDir, entry.name);
    const classDir = join(moduleDir, "compile.dest", "classes");
    const scalaVersion = readMillJson(moduleDir, "scalaVersion");
    if (!scalaVersion) {
      continue;
    }
    const compilerJars = readMillJson(moduleDir, "scalaCompilerClasspath") || [];
    const classpath = [
      ...(readMillJson(moduleDir, "compileClasspath") || []),
      ...(readMillJson(moduleDir, "localCompileClasspath") || [])
    ];
    const suffix = readMillJson(moduleDir, "platformSuffix") || "";
    modules.push({
      id: entry.name,
      buildTool: "mill",
      scalaVersion,
      platform: millPlatform(suffix, classpath),
      classDirs: existsSync(classDir) ? [classDir] : [],
      sourceRoots: uniqDirs(readMillJson(moduleDir, "allSourceFiles") || []),
      compilerJars,
      libraryJars: compilerJars.filter((p) =>
        /scala3-library|scala-library[\d-]/.test(basename(p))
      ),
      inspectorJar: compilerJars.find((p) =>
        basename(p).startsWith("scala3-tasty-inspector")
      ),
      classpath: classpath
        .filter((p) => p.endsWith(".jar"))
        .map((p) => ({ path: p, ...jarCoordinate(p) })),
      scope: "main"
    });
  }
  return { modules };
}

function millCommand(dir, opts) {
  const wrapper = join(dir, "mill");
  if (existsSync(wrapper)) {
    return { cmd: wrapper };
  }
  return { cmd: opts.millCommand || process.env.MILL_CMD || "mill" };
}

function readMillJson(moduleDir, name) {
  const file = join(moduleDir, `${name}.json`);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    const value = parsed?.value;
    if (Array.isArray(value)) {
      return value.map((v) =>
        String(v).replace(/qref:v1:[0-9a-f]+:/, "").replace(/ref:v0:[0-9a-f]+:/, "")
      );
    }
    return typeof value === "string" ? value : undefined;
  } catch (_err) {
    return undefined;
  }
}

function uniqDirs(files) {
  const dirs = new Set(files.map((f) => dirname(f)));
  return [...dirs];
}

function millPlatform(suffix, classpath) {
  if (suffix.includes("sjs") || classpath.some((p) => basename(p).startsWith("scalajs-library"))) {
    return "js";
  }
  if (suffix.includes("native") || classpath.some((p) => basename(p).startsWith("nativelib"))) {
    return "native";
  }
  return "jvm";
}

/** Maven: the pom names the compiler version, `dependency:build-classpath` the classpath. */
function mavenInventory(dir, opts, diagnostics) {
  const pom = readFileSync(join(dir, "pom.xml"), "utf-8");
  const scalaVersion =
    /<scala\.version>([^<]+)<\/scala\.version>/.exec(pom)?.[1] ||
    /<scalaVersion>([^<]+)<\/scalaVersion>/.exec(pom)?.[1];
  const classDir = join(dir, "target", "classes");
  const classDirs = existsSync(classDir) ? [classDir] : [];
  const modules = [
    {
      id: basename(dir),
      buildTool: "maven",
      scalaVersion,
      platform: "jvm",
      classDirs,
      sourceRoots: [join(dir, "src", "main", "scala")],
      compilerJars: [],
      libraryJars: [],
      inspectorJar: undefined,
      classpath: [],
      scope: "main"
    }
  ];
  if (opts.noBuild || opts.noCompile) {
    return { modules };
  }
  const mvn = process.env.MVN_CMD || "mvn";
  const outFile = join(dir, "target", "scalasem-classpath.txt");
  try {
    mkdirSync(join(dir, "target"), { recursive: true });
    const result = run(
      mvn,
      ["-q", "dependency:build-classpath", `-Dmdep.outputFile=${outFile}`],
      { cwd: dir }
    );
    if (result.status === 0 && existsSync(outFile)) {
      modules[0].classpath = splitClasspath(readFileSync(outFile, "utf-8").trim());
    } else {
      diagnostics.push({ code: "maven-classpath-failed", tool: "maven" });
    }
  } finally {
    try {
      rmSync(outFile, { force: true });
    } catch (_err) {
      // best effort cleanup
    }
  }
  return { modules };
}

/** scala-cli: outputs live under `.scala-build/<project>_<hash>/classes/main`. */
function scalaCliInventory(dir, opts, diagnostics) {
  const directives = scalaCliDirectives(dir);
  const buildDir = join(dir, ".scala-build");
  const module = {
    id: "scala-cli",
    buildTool: "scala-cli",
    scalaVersion: directives.scala,
    platform: directives.platform,
    classDirs: [],
    sourceRoots: [dir],
    compilerJars: [],
    libraryJars: [],
    inspectorJar: undefined,
    classpath: [],
    scope: "main"
  };
  if (existsSync(buildDir)) {
    for (const project of readdirSync(buildDir, { withFileTypes: true })) {
      if (!project.isDirectory()) {
        continue;
      }
      const mainClasses = join(buildDir, project.name, "classes", "main");
      if (existsSync(mainClasses)) {
        module.id = project.name;
        module.classDirs.push(mainClasses);
      }
    }
  }
  if (!opts.noBuild) {
    const printed = printScalaCliClassPath(dir);
    if (printed) {
      module.classpath = splitClasspath(printed);
      for (const entry of module.classpath) {
        const jar = basename(entry.path);
        if (jar.startsWith("scala3-compiler_3")) {
          module.compilerJars.push(entry.path);
        } else if (/^scala3-library_3|^scala-library-2/.test(jar)) {
          module.libraryJars.push(entry.path);
        }
      }
    } else if (!module.classDirs.length) {
      diagnostics.push({ code: "scala-cli-compile-failed", tool: "scala-cli" });
    }
  }
  return { modules: module.classDirs.length || module.classpath.length ? [module] : [] };
}

function scalaCliDirectives(dir) {
  const directives = { scala: undefined, platform: "jvm" };
  const files = ["project.scala"];
  try {
    files.push(
      ...readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.(scala|sc)$/.test(e.name))
        .map((e) => e.name)
    );
  } catch (_err) {
    // unreadable directory
  }
  for (const name of files) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      continue;
    }
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const directive = line.trim();
      if (!directive.startsWith("//> using ")) {
        continue;
      }
      const scala = /^\/\/> using scala\s+(\S+)/.exec(directive);
      if (scala) {
        directives.scala = scala[1];
      }
      if (/\/\/> using platform\s+scala-js/.test(directive)) {
        directives.platform = "js";
      }
      if (/\/\/> using platform\s+scala-native/.test(directive)) {
        directives.platform = "native";
      }
    }
  }
  return directives;
}

function printScalaCliClassPath(dir) {
  const candidates = [
    ["scala-cli", ["compile", "--print-class-path", "."]],
    ["scala", ["--power", "compile", "--print-class-path", "."]]
  ];
  for (const [cmd, args] of candidates) {
    const result = run(cmd, args, { cwd: dir });
    if (result.status === 0 && (result.stdout || "").trim()) {
      const line = result.stdout
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.includes(".jar") || l.includes("classes"));
      if (line) {
        return line;
      }
    }
  }
  return undefined;
}

/**
 * No build tool at all: read what the last build left on disk. sbt writes the resolved
 * classpath to `target/streams/...`, Mill to `out/<module>/*.json`; without either, the
 * classpath is unknown and only the classes are read.
 */
function noBuildInventory(dir, opts, diagnostics, tool) {
  const modules = [];
  const tastyDirs = listDirsHolding(dir, ".tasty", {
    skip: ["node_modules", "out"]
  }).filter((d) => !isBuildDefinitionDir(dir, d));
  const classpath = readLeftoverClasspath(dir);
  for (const classDir of tastyDirs) {
    // The module id of a leftover output tree is the directory that owns it: the subproject
    // for `core/target/scala-...`, the project itself for a root level `target`.
    const rel = relative(dir, classDir).replaceAll("\\", "/");
    const owner = /^([^/]+)\/(target|out)\//.exec(rel)?.[1] || basename(dir);
    modules.push({
      id: owner,
      buildTool: tool || "none",
      scalaVersion: undefined,
      platform: platformOfDir(classDir),
      classDirs: [classDir],
      sourceRoots: guessSourceRoots(dir, classDir),
      compilerJars: [],
      libraryJars: [],
      inspectorJar: undefined,
      classpath,
      scope: "main"
    });
  }
  return { modules };
}

function isBuildDefinitionDir(projectDir, classDir) {
  const rel = relative(projectDir, classDir).replaceAll("\\", "/");
  return (
    rel.startsWith("project/target") ||
    rel.startsWith("project/project") ||
    rel.startsWith("out/mill-build") ||
    rel.includes("meta-build")
  );
}

/** The platform a module compiles for, taken from the libraries it links. */
function platformOfClasspath(paths) {
  const names = paths.map((p) => basename(p));
  if (names.some((n) => n.startsWith("scalajs-library") || n.startsWith("scalajs-runtime"))) {
    return "js";
  }
  if (names.some((n) => n.startsWith("nativelib"))) {
    return "native";
  }
  return "jvm";
}

function platformOfDir(classDir) {
  try {
    const siblings = readdirSync(classDir);
    if (siblings.some((f) => f.endsWith(".sjsir"))) {
      return "js";
    }
    if (siblings.some((f) => f.endsWith(".nir"))) {
      return "native";
    }
  } catch (_err) {
    // unreadable directory
  }
  return "jvm";
}

function guessSourceRoots(projectDir, classDir) {
  const rel = relative(projectDir, classDir).replaceAll("\\", "/");
  const scalaDir = /(^|\/)(target\/scala-[^/]+\/classes|target\/out\/[^/]+\/scala-[^/]+\/[^/]+\/classes|compile\.dest\/classes)(\/|$)/.exec(rel);
  if (scalaDir) {
    const prefix = rel.slice(0, scalaDir.index);
    const after = rel.slice(scalaDir.index + scalaDir[0].length);
    const depth = after ? after.split("/").length : 0;
    let root = prefix ? join(projectDir, prefix) : projectDir;
    for (let i = 0; i < depth; i++) {
      root = dirname(root);
    }
    return [root];
  }
  return [projectDir];
}

function readLeftoverClasspath(dir) {
  const sbtStream = join(
    dir,
    "target",
    "streams",
    "compile",
    "dependencyClasspath",
    "_global",
    "streams",
    "export"
  );
  if (existsSync(sbtStream)) {
    try {
      return splitClasspath(readFileSync(sbtStream, "utf-8").trim());
    } catch (_err) {
      // unreadable stream file
    }
  }
  const outDir = join(dir, "out");
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "mill-build") {
        continue;
      }
      const compileClasspath = readMillJson(join(outDir, entry.name), "compileClasspath");
      if (compileClasspath?.length) {
        return compileClasspath
          .filter((p) => p.endsWith(".jar"))
          .map((p) => ({ path: p, ...jarCoordinate(p) }));
      }
    }
  }
  return [];
}

/** A compile is worth running only when the build produced no class files yet. */
function needsCompile(dir, tool) {
  if (tool === "mill") {
    const outDir = join(dir, "out");
    if (!existsSync(outDir)) {
      return true;
    }
    return listFiles(outDir, ".tasty", { skip: ["mill-build"] }).length === 0;
  }
  const targetDir = join(dir, "target");
  if (!existsSync(targetDir)) {
    return true;
  }
  return listFiles(targetDir, ".tasty").length === 0;
}

export { needsCompile };
