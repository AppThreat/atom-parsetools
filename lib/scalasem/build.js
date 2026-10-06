// Build discovery and the module inventory: which modules a Scala build has, their Scala
// version, class directories, source roots and the compiler and dependency classpaths the
// build itself resolved. Nothing here reads TASTy; that is the inspector stage.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import process from "node:process";

import { jarCoordinate, listDirsHolding, listFiles, run } from "./util.js";

const SBT_PROJECT_LINE = /^\[info\]\s+(\*?)\s*([A-Za-z0-9_.-]+)\s*$/;
const SBT_KEY_LABEL = /^[A-Za-z0-9_.-]+(?: \/ [A-Za-z0-9_.-]+)*$/;
// Terminal colour codes.
const ANSI_ESCAPE = /\x1B\[[0-9;]*[A-Za-z]/g;

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
  if (
    existsSync(join(dir, "build.mill")) ||
    existsSync(join(dir, "build.sc"))
  ) {
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
      const head = readFileSync(join(dir, entry.name), "utf-8")
        .split("\n")
        .slice(0, 10);
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
        ...(await sbtInventory(
          dir,
          { ...opts, version: detected.version },
          diagnostics
        )),
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
      return {
        tool: "maven",
        ...mavenInventory(dir, opts, diagnostics),
        diagnostics
      };
    case "scala-cli":
      return {
        tool: "scala-cli",
        ...scalaCliInventory(dir, opts, diagnostics),
        diagnostics
      };
    default:
      return {
        tool: "none",
        ...noBuildInventory(dir, opts, diagnostics),
        diagnostics
      };
  }
}

/**
 * The joined sbt inventory command for a project list: the compiler instance, the class
 * directory, the source roots and the dependency classpath of every project, delimited by
 * markers.
 *
 * @param {string[]} projects Project ids
 * @param {boolean} includeTests Whether to query the Test configuration as well
 * @param {string} [scalaVersion] Scala version to switch the build to first
 * @returns {string} One command line
 */
export function sbtInventoryCommand(projects, includeTests, scalaVersion) {
  const commands = [];
  const mark = (tag, project) => {
    commands.push(`eval println("scalasem-section:${tag}:${project}")`);
  };
  const configurations = includeTests ? ["Compile", "Test"] : ["Compile"];
  // A requested Scala version switches the build before anything is queried, so every
  // reported path and classpath belongs to that version.
  if (scalaVersion) {
    commands.push(`++${scalaVersion}`);
  }
  // Without this, a query on an aggregating project evaluates every aggregated subproject too,
  // and one that cannot be resolved fails the query of the root.
  commands.push("set Global / aggregate := false");
  for (const project of projects) {
    mark("instance", project);
    commands.push(`print ${project}/scalaInstance`);
    for (const configuration of configurations) {
      const suffix = configuration === "Compile" ? "" : "-test";
      mark(`classpath${suffix}`, project);
      commands.push(`export ${project}/${configuration}/dependencyClasspath`);
      mark(`classdir${suffix}`, project);
      commands.push(`export ${project}/${configuration}/classDirectory`);
      mark(`sources${suffix}`, project);
      commands.push(
        `print ${project}/${configuration}/unmanagedSourceDirectories`
      );
    }
  }
  return commands.join("; ");
}

/**
 * Run the inventory session. sbt stops a `;` chain at the first command that fails, for
 * example the classpath of a subproject with an unresolvable dependency, so the session is run
 * again for the projects after the failing one, which is the one whose marker came last.
 */
function querySbt(sbt, projects, diagnostics, includeTests, scalaVersion) {
  const sections = {};
  let pending = [...projects];
  for (
    let attempt = 0;
    pending.length && attempt < projects.length;
    attempt++
  ) {
    const result = sbt.run([
      "-batch",
      "-no-colors",
      sbtInventoryCommand(pending, includeTests, scalaVersion)
    ]);
    collectSections(result.stdout || "", sections);
    if (result.status === 0 && !result.error) {
      break;
    }
    const failed = lastMarkedProject(result.stdout || "");
    if (!failed || !pending.includes(failed)) {
      diagnostics.push({ code: "sbt-inventory-failed", tool: "sbt" });
      break;
    }
    diagnostics.push({
      code: "sbt-project-failed",
      tool: "sbt",
      module: failed
    });
    pending = pending.slice(pending.indexOf(failed) + 1);
  }
  return sections;
}

function lastMarkedProject(stdout) {
  let project;
  for (const raw of stdout.split("\n")) {
    const mark = /^scalasem-section:[a-z-]+:([A-Za-z0-9_.-]+)$/.exec(
      raw.trim()
    );
    if (mark) {
      project = mark[1];
    }
  }
  return project;
}

/** True when none of the class directories the build reports exists yet. */
function reportedClassDirsMissing(sections, projects) {
  const dirs = projects.flatMap((p) => ownValues(sections[`classdir:${p}`]));
  return dirs.length > 0 && !dirs.some((d) => existsSync(d));
}

/**
 * sbt: one session lists the projects, a second runs the per module `print` and `export`
 * commands joined into a single argument, which is the only form sbt 2 parses correctly.
 */
async function sbtInventory(dir, opts, diagnostics) {
  if (opts.noBuild) {
    return noBuildInventory(dir, opts, diagnostics, "sbt");
  }
  const sbt = sbtRunner(dir, opts);
  let projects;
  let sections;
  try {
    projects = sbtProjects(sbt, diagnostics);
    if (!projects.length) {
      return noBuildInventory(dir, opts, diagnostics, "sbt");
    }
    sections = querySbt(
      sbt,
      projects,
      diagnostics,
      opts.includeTests,
      opts.scalaVersion
    );
    if (
      !opts.noCompile &&
      (needsCompile(dir, "sbt") || reportedClassDirsMissing(sections, projects))
    ) {
      const compileCommand =
        process.env.SBT_COMPILE_COMMAND ||
        (opts.scalaVersion ? `++${opts.scalaVersion} compile` : "compile");
      const result = sbt.run(["-batch", "-no-colors", compileCommand]);
      if (result.status !== 0) {
        diagnostics.push({ code: "build-compile-failed", tool: "sbt" });
      } else {
        sections = querySbt(
          sbt,
          projects,
          diagnostics,
          opts.includeTests,
          opts.scalaVersion
        );
      }
    }
  } finally {
    sbt.stop();
  }
  const modules = sbtModules(sections, projects, dir, opts.includeTests);
  if (!modules.length) {
    return noBuildInventory(dir, opts, diagnostics, "sbt");
  }
  if (diagnostics.some((d) => d.code === "sbt-project-failed")) {
    modules.push(...undescribedLeftovers(dir, opts, modules, diagnostics));
  }
  return { modules };
}

/**
 * The output a previous build left for the projects the inventory could not describe. A
 * leftover tree of a module the build did describe stays out: it is another Scala version of
 * the same sources.
 */
function undescribedLeftovers(dir, opts, modules, diagnostics) {
  const keyOf = (classDir) => {
    const info = leftoverModule(dir, classDir);
    return `${info.id}:${info.platform}`;
  };
  const described = new Set(
    modules.flatMap((m) => m.classDirs).map((d) => keyOf(d))
  );
  const leftoverDiagnostics = [];
  const added = noBuildInventory(
    dir,
    opts,
    leftoverDiagnostics,
    "sbt"
  ).modules.filter((m) => !described.has(keyOf(m.classDirs[0])));
  const ids = new Set(added.map((m) => m.id));
  diagnostics.push(...leftoverDiagnostics.filter((d) => ids.has(d.module)));
  return added;
}

/**
 * Runs sbt in the build directory. The sbt 2 launcher runs a thin client by default, and when a
 * server is already running for the build, an IDE's for example, the client prints nothing the
 * inventory reads; `--server` keeps sbt 2 in-process. `sbt.bat` has no such option, so on
 * Windows the client stays and the server it starts is shut down afterwards. A server that was
 * running before the inventory is left alone.
 */
function sbtRunner(dir, opts) {
  const command = opts.sbtCommand || process.env.SBT_CMD || "sbt";
  const version = opts.version || readSbtVersion(dir);
  const major = Number.parseInt(String(version || "").split(".")[0], 10);
  const sbt2 = major >= 2;
  const launcher = sbt2 && process.platform !== "win32" ? ["--server"] : [];
  const serverFile = join(dir, "project", "target", "active.json");
  const serverWasRunning = existsSync(serverFile);
  return {
    run: (args) => run(command, [...launcher, ...args], { cwd: dir }),
    stop: () => {
      if (sbt2 && !serverWasRunning && existsSync(serverFile)) {
        run(command, ["-batch", "-no-colors", "shutdown"], { cwd: dir });
      }
    }
  };
}

/**
 * The modules of an sbt build from the marked sections of the inventory session.
 *
 * @param {Object} sections Output lines by `<tag>:<project>`
 * @param {string[]} projects Project ids
 * @param {string} dir Project directory
 * @param {boolean} includeTests Whether the Test configuration was queried
 * @returns {Object[]} Module inventory entries
 */
export function sbtModules(sections, projects, dir, includeTests) {
  const modules = [];
  for (const project of projects) {
    const instance = parseScalaInstance(
      ownValues(sections[`instance:${project}`])
    );
    const configurations = includeTests ? ["", "-test"] : [""];
    for (const suffix of configurations) {
      const classDirs = ownValues(sections[`classdir${suffix}:${project}`]);
      const sourceRoots = ownValues(sections[`sources${suffix}:${project}`])
        .map((l) => l.replace(/^\*\s*/, ""))
        .filter(Boolean);
      const classpath = ownValues(
        sections[`classpath${suffix}:${project}`]
      ).flatMap((l) => splitClasspath(expandVirtualPaths(l, dir)));
      // sbt prints a class directory for every project it can describe, so a project without
      // one is a query that failed before it.
      if (!classDirs.length) {
        continue;
      }
      modules.push({
        id: suffix ? `${project}-test` : project,
        buildTool: "sbt",
        scalaVersion: instance?.version,
        platform: platformOfClasspath(classpath.map((c) => c.path)),
        classDirs,
        sourceRoots,
        compilerJars: instance?.compilerJars || [],
        libraryJars: instance?.libraryJars || [],
        inspectorJar: instance?.inspectorJar,
        classpath,
        scope: suffix ? "test" : "main"
      });
    }
  }
  return modules;
}

/**
 * `print` and `export` on an aggregating project print one labelled block per aggregated
 * subproject plus the project's own, with the values indented under each label
 * (`backend / Compile / classDirectory`, then `Compile / classDirectory`). Only the project's own
 * block, the label with the fewest scope segments, may be used; the others belong to modules
 * that are queried separately. A project that aggregates nothing prints its values unlabelled.
 *
 * @param {string[]} lines Section lines
 * @returns {string[]} The project's own value lines, trimmed
 */
export function ownValues(lines) {
  const values = (lines || []).filter((l) => l.trim());
  // A label is a bare key path such as `backend / Compile / classDirectory` or `scalaInstance`;
  // values are paths, `List(...)` forms or printed objects. `print` indents its values under the
  // label, `export` does not.
  const isLabel = (l) => SBT_KEY_LABEL.test(l.trim());
  if (
    !values.some((l) => isLabel(l) && l.includes(" / ")) &&
    !isLabel(values[0] || "")
  ) {
    return values.map((l) => l.trim());
  }
  const blocks = [];
  for (const line of values) {
    if (isLabel(line)) {
      blocks.push({ segments: line.trim().split(" / ").length, values: [] });
    } else {
      blocks.at(-1)?.values.push(line.trim());
    }
  }
  const fewest = Math.min(...blocks.map((b) => b.segments));
  return blocks.find((b) => b.segments === fewest)?.values || [];
}

function sbtProjects(sbt, diagnostics) {
  const result = sbt.run(["-batch", "-no-colors", "projects"]);
  if (result.status !== 0 || result.error) {
    diagnostics.push({ code: "sbt-projects-failed", tool: "sbt" });
    return [];
  }
  return parseSbtProjects(result.stdout || "");
}

/**
 * The project ids an sbt `projects` listing prints.
 *
 * @param {string} stdout Output of `sbt projects`
 * @returns {string[]}
 */
export function parseSbtProjects(stdout) {
  const projects = [];
  for (const line of stdout.split("\n")) {
    const match = SBT_PROJECT_LINE.exec(line.trim().replace(/\r/g, ""));
    if (match && !["info", "warn"].includes(match[2])) {
      projects.push(match[2]);
    }
  }
  return projects;
}

/**
 * Split the marked sections of a joined sbt command output.
 *
 * @param {string} stdout Session output
 * @param {Object} [sections] Map to fill
 * @returns {Object} Output lines by `<tag>:<project>`
 */
export function collectSections(stdout, sections = {}) {
  let current;
  for (const raw of stdout.split("\n")) {
    // sbt 2 colours its status lines even with -no-colors.
    const line = raw.replace(/\r/g, "").replace(ANSI_ESCAPE, "");
    if (/^\[(info|warn|error|debug|success)\]/.test(line)) {
      continue;
    }
    const mark = /^scalasem-section:([a-z-]+):([A-Za-z0-9_.-]+)$/.exec(
      line.trim()
    );
    if (mark) {
      current = `${mark[1]}:${mark[2]}`;
      sections[current] = [];
      continue;
    }
    if (current && line.trim() && !line.startsWith("[success]")) {
      sections[current].push(line);
    }
  }
  return sections;
}

/**
 * sbt 2 prints virtual Coursier paths such as `List(${CSR_CACHE}/https/...)`, which have to
 * be expanded before they can be opened. Mill prints `qref:v1:<hash>:` prefixed paths.
 */
export function expandVirtualPaths(line, projectDir) {
  const cacheRoots = coursierCacheRoots();
  let expanded = line.trim().replace(/^List\(|\)$/g, "");
  // sbt 2 appends the content digest and size to its own outputs: `<jar>>sha256-<hex>/<size>`
  const unquote = (v) =>
    v
      .trim()
      .replace(/^"|"$/g, "")
      .replace(/>sha256-[0-9a-f]+\/\d+$/, "")
      .replace(/qref:v1:[0-9a-f]+:/, "")
      .replace(/ref:v0:[0-9a-f]+:/, "");
  return expanded
    .split(", ")
    .map(unquote)
    .filter(Boolean)
    .map((p) => {
      if (!p.includes("${")) {
        return p;
      }
      for (const root of cacheRoots) {
        const candidate = expandVariables(p, root, projectDir);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
      return expandVariables(p, cacheRoots[0] || "", projectDir);
    })
    .join(process.platform === "win32" ? ";" : ":");
}

function expandVariables(p, cacheRoot, projectDir) {
  return p
    .replaceAll("${CSR_CACHE}", cacheRoot)
    .replaceAll("${OUT}", join(projectDir, "target", "out"))
    .replaceAll("${BASE}", projectDir)
    .replaceAll("${WORKSPACE}", projectDir);
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
    inspectorJar: jars("other").find((p) =>
      basename(p).startsWith("scala3-tasty-inspector")
    )
  };
}

/**
 * Mill: run `__.compile` when allowed, then read the JSON files the build wrote under
 * `out/`. A module directory is one that holds `compile.dest` next to its task metadata,
 * which also finds cross build directories such as `out/cask/3.3.4` and nested modules.
 */
function millInventory(dir, opts, diagnostics) {
  if (!opts.noBuild && !opts.noCompile && needsCompile(dir, "mill")) {
    const mill = millCommand(dir, opts);
    const compileCommand = process.env.MILL_COMPILE_COMMAND || "__.compile";
    const result = run(
      mill.cmd,
      ["--no-server", ...compileCommand.split(" ")],
      {
        cwd: dir
      }
    );
    if (result.status !== 0) {
      diagnostics.push({ code: "build-compile-failed", tool: "mill" });
    }
  }
  const outDir = join(dir, "out");
  const modules = [];
  if (!existsSync(outDir)) {
    return { modules };
  }
  for (const moduleDir of findMillModules(outDir)) {
    const scalaVersion = readMillJson(moduleDir, "scalaVersion");
    if (!scalaVersion) {
      continue;
    }
    const rel = relative(outDir, moduleDir).replaceAll("\\", "/");
    const scope = rel.split("/").includes("test") ? "test" : "main";
    if (scope === "test" && !opts.includeTests) {
      continue;
    }
    const classDir = join(moduleDir, "compile.dest", "classes");
    const compilerJars =
      readMillJson(moduleDir, "scalaCompilerClasspath") || [];
    const classpath = [
      ...(readMillJson(moduleDir, "compileClasspath") || []),
      ...(readMillJson(moduleDir, "localCompileClasspath") || []),
      // The classes of the modules this one compiles against.
      ...(readMillJson(moduleDir, "upstreamCompileOutput") || [])
        .map((entry) => entry?.classes)
        .filter(Boolean)
        .map((classes) =>
          classes
            .replace(/qref:v1:[0-9a-f]+:/, "")
            .replace(/ref:v0:[0-9a-f]+:/, "")
        )
    ];
    const suffix = readMillJson(moduleDir, "platformSuffix") || "";
    // A cross build adds the version as a path segment; the module name is the path without it.
    const id =
      rel
        .split("/")
        .filter((segment) => segment !== scalaVersion)
        .join("/") || basename(dir);
    modules.push({
      id,
      buildTool: "mill",
      scalaVersion,
      platform: millPlatform(suffix, classpath),
      classDirs: existsSync(classDir) ? [classDir] : [],
      sourceRoots: millSourceRoots(moduleDir),
      compilerJars,
      libraryJars: compilerJars.filter((p) =>
        /^scala3-library_3|^scala-library-/.test(basename(p))
      ),
      inspectorJar: compilerJars.find((p) =>
        basename(p).startsWith("scala3-tasty-inspector")
      ),
      // Class directories of upstream modules stay in the classpath without coordinates,
      // which keeps the module entry free of them.
      classpath: classpath
        .filter((p) => p.endsWith(".jar") || existsSync(p))
        .map((p) => ({ path: p, ...jarCoordinate(p) })),
      scope
    });
  }
  return { modules };
}

/** Directories under a Mill `out/` tree that hold a module's compiled output. */
function findMillModules(outDir) {
  const found = [];
  const visit = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    const isModule =
      entries.some((e) => e.name === "compile.dest" && e.isDirectory()) &&
      entries.some((e) => e.name === "scalaVersion.json" && e.isFile());
    if (isModule) {
      found.push(d);
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const name = entry.name;
      if (
        name === "mill-build" ||
        name.startsWith("mill-") ||
        name.startsWith("mill.") ||
        name.endsWith(".dest")
      ) {
        continue;
      }
      // A module directory can hold nested submodules, so the walk continues either way.
      visit(join(d, name));
    }
  };
  visit(outDir);
  return found.sort();
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
      if (value.every((v) => typeof v === "string")) {
        return value.map((v) =>
          v.replace(/qref:v1:[0-9a-f]+:/, "").replace(/ref:v0:[0-9a-f]+:/, "")
        );
      }
      return value;
    }
    return typeof value === "string" ? value : undefined;
  } catch (_err) {
    return undefined;
  }
}

/** The module's source directories, or the directories of its source files on older Mill. */
function millSourceRoots(moduleDir) {
  const roots = (readMillJson(moduleDir, "allSources") || []).filter((p) =>
    existsSync(p)
  );
  if (roots.length) {
    return [...new Set(roots)];
  }
  const files = readMillJson(moduleDir, "allSourceFiles") || [];
  return [...new Set(files.map((f) => dirname(f)))];
}

function millPlatform(suffix, classpath) {
  if (
    suffix.includes("sjs") ||
    classpath.some((p) => basename(p).startsWith("scalajs-library"))
  ) {
    return "js";
  }
  if (
    suffix.includes("native") ||
    classpath.some((p) => basename(p).startsWith("nativelib"))
  ) {
    return "native";
  }
  return "jvm";
}

/**
 * Maven: the pom names the compiler version and `dependency:build-classpath` the classpath.
 * Without a build tool run, the classpath is the pom's own dependencies found in the local
 * repository.
 */
function mavenInventory(dir, opts, diagnostics) {
  const pom = readFileSync(join(dir, "pom.xml"), "utf-8");
  const properties = pomProperties(pom);
  const declared =
    properties["scala.version"] ||
    /<scalaVersion>([^<]+)<\/scalaVersion>/.exec(pom)?.[1];
  const scalaVersion =
    declared?.replace(/\$\{([^}]+)\}/g, (_m, name) => properties[name] ?? "") ||
    undefined;
  const classDir = join(dir, "target", "classes");
  const mvn = process.env.MVN_CMD || "mvn";
  if (
    !opts.noBuild &&
    !opts.noCompile &&
    !(existsSync(classDir) && listFiles(classDir, ".tasty").length)
  ) {
    const result = run(mvn, ["-q", "-DskipTests", "compile"], { cwd: dir });
    if (result.status !== 0) {
      diagnostics.push({ code: "build-compile-failed", tool: "maven" });
    }
  }
  const module = {
    id: basename(dir),
    buildTool: "maven",
    scalaVersion,
    platform: "jvm",
    classDirs: existsSync(classDir) ? [classDir] : [],
    sourceRoots: [join(dir, "src", "main", "scala")],
    compilerJars: [],
    libraryJars: [],
    inspectorJar: undefined,
    classpath: [],
    scope: "main"
  };
  if (opts.noBuild) {
    module.classpath = pomDependencyJars(pom, properties, opts.includeTests);
    return { modules: [module] };
  }
  const outFile = join(dir, "target", "scalasem-classpath.txt");
  try {
    mkdirSync(join(dir, "target"), { recursive: true });
    const result = run(
      mvn,
      ["-q", "dependency:build-classpath", `-Dmdep.outputFile=${outFile}`],
      { cwd: dir }
    );
    if (result.status === 0 && existsSync(outFile)) {
      module.classpath = splitClasspath(readFileSync(outFile, "utf-8").trim());
    } else {
      diagnostics.push({ code: "maven-classpath-failed", tool: "maven" });
    }
  } finally {
    rmSync(outFile, { force: true });
  }
  return { modules: [module] };
}

/** The `<properties>` of a pom, plus the project version. */
function pomProperties(pom) {
  const properties = {};
  const block = /<properties>([\s\S]*?)<\/properties>/.exec(pom)?.[1] || "";
  for (const match of block.matchAll(/<([A-Za-z0-9_.-]+)>([^<]*)<\/\1>/g)) {
    properties[match[1]] = match[2].trim();
  }
  return properties;
}

/** The jars of the pom's direct dependencies that the local Maven repository holds. */
function pomDependencyJars(pom, properties, includeTests) {
  const resolveValue = (value) =>
    (value || "").replace(
      /\$\{([^}]+)\}/g,
      (_m, name) => properties[name] ?? ""
    );
  const repository = join(homedir(), ".m2", "repository");
  const jars = [];
  const dependencies =
    /<dependencies>([\s\S]*?)<\/dependencies>/.exec(
      pom.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/, "")
    )?.[1] || "";
  for (const match of dependencies.matchAll(
    /<dependency>([\s\S]*?)<\/dependency>/g
  )) {
    const field = (name) =>
      resolveValue(
        new RegExp(`<${name}>([^<]*)</${name}>`).exec(match[1])?.[1]
      );
    const group = field("groupId");
    const artifact = field("artifactId");
    const version = field("version");
    if (!group || !artifact || !version) {
      continue;
    }
    if (field("scope") === "test" && !includeTests) {
      continue;
    }
    const jar = join(
      repository,
      ...group.split("."),
      artifact,
      version,
      `${artifact}-${version}.jar`
    );
    if (existsSync(jar)) {
      jars.push({ path: jar, group, artifact, version });
    }
  }
  return jars;
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
  if (!opts.noBuild && !opts.noCompile) {
    const printed = printScalaCliClassPath(dir);
    if (printed) {
      // The printed classpath carries the dependencies; the compiler toolchain is resolved
      // from the caches for the version the directives name, because the classpath of a
      // scala-cli build lists only the compiler jar itself.
      module.classpath = splitClasspath(printed);
    } else if (!module.classDirs.length) {
      diagnostics.push({ code: "scala-cli-compile-failed", tool: "scala-cli" });
    }
  }
  return {
    modules: module.classDirs.length || module.classpath.length ? [module] : []
  };
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
  // Without --server=false scala-cli compiles through a Bloop daemon that outlives the scan.
  const compileArgs = ["compile", "--server=false", "--print-class-path", "."];
  const candidates = [
    ["scala-cli", compileArgs],
    ["scala", ["--power", ...compileArgs]]
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
 * classpath of each module to its `streams/.../export` file, Mill to `out/<module>/*.json`;
 * without either, the classpath is unknown and only the classes are read. A cross build leaves
 * one class tree per Scala version, and only the newest Scala 3 tree of each module is read.
 */
function noBuildInventory(dir, opts, diagnostics, tool) {
  const roots = new Map();
  // A Mill `out/` tree is read through its own JSON files; sbt 2 keeps its classes under
  // `target/out`, which must not be skipped.
  for (const tastyDir of listDirsHolding(dir, ".tasty", {
    skipPaths: [join(dir, "out")]
  })) {
    const root = classRootOf(dir, tastyDir);
    if (!isBuildDefinitionDir(dir, root)) {
      roots.set(root, leftoverModule(dir, root));
    }
  }
  const chosen = new Map();
  for (const [root, info] of roots) {
    const key = `${info.id}:${info.platform}`;
    const current = chosen.get(key);
    if (
      !current ||
      compareDotted(info.scalaVersion, current.info.scalaVersion) > 0
    ) {
      chosen.set(key, { root, info, versions: (current?.versions || 0) + 1 });
    } else {
      current.versions += 1;
    }
  }
  const modules = [];
  for (const { root, info, versions } of [...chosen.values()].sort((a, b) =>
    a.root.localeCompare(b.root)
  )) {
    if (versions > 1) {
      diagnostics.push({
        code: "no-build-scala-version",
        module: info.id,
        detail: info.scalaVersion
      });
    }
    const classpath = readLeftoverClasspath(dir, root);
    modules.push({
      id: info.id,
      buildTool: tool || "none",
      scalaVersion: undefined,
      // Without IR files, the libraries the module linked still name its platform.
      platform:
        info.platform === "jvm"
          ? platformOfClasspath(classpath.map((c) => c.path))
          : info.platform,
      classDirs: [root],
      sourceRoots: guessSourceRoots(dir, root),
      compilerJars: [],
      libraryJars: [],
      inspectorJar: undefined,
      classpath,
      scope: "main"
    });
  }
  return { modules };
}

/** The class directory a package directory belongs to: the nearest `classes` ancestor. */
function classRootOf(projectDir, packageDir) {
  let d = packageDir;
  while (d.length > projectDir.length) {
    const name = basename(d);
    if (name === "classes") {
      return d;
    }
    // scala-cli: .scala-build/<project>/classes/main
    if (name === "main" && basename(dirname(d)) === "classes") {
      return d;
    }
    d = dirname(d);
  }
  return packageDir;
}

/**
 * The module a leftover class directory belongs to and the Scala version its path names:
 * `core/target/scala-3.3.7/classes` (sbt 1), `target/out/jvm/scala-3.9.0/backend/classes`
 * (sbt 2) or `target/scala-3.3.7/classes` for the root project.
 */
function leftoverModule(projectDir, root) {
  const rel = relative(projectDir, root).replaceAll("\\", "/");
  const scalaVersion = /(?:^|\/)scala-([0-9][^/]*)\//.exec(rel)?.[1];
  const sbt2 =
    /(?:^|\/)target\/out\/[^/]+\/scala-[^/]+\/([^/]+)\/classes$/.exec(rel);
  const prefix = /^(.+?)\/target\//.exec(rel)?.[1];
  return {
    id: sbt2?.[1] || prefix || basename(projectDir),
    scalaVersion,
    platform: platformOfDir(root)
  };
}

/** Compare dotted versions numerically; a missing version sorts first. */
function compareDotted(a, b) {
  if (!a || !b) {
    return a ? 1 : b ? -1 : 0;
  }
  const left = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const right = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0)) {
      return (left[i] || 0) - (right[i] || 0);
    }
  }
  return 0;
}

function isBuildDefinitionDir(projectDir, classDir) {
  const rel = relative(projectDir, classDir).replaceAll("\\", "/");
  return (
    rel.startsWith("project/target") ||
    rel.startsWith("project/project") ||
    rel.startsWith("out/mill-build") ||
    rel.includes("meta-build") ||
    // sbt 2 compiles the build definition as `<build>-build` next to the modules
    /(?:^|\/)target\/out\/[^/]+\/scala-[^/]+\/[^/]+-build\//.test(`${rel}/`)
  );
}

/** The platform a module compiles for, taken from the libraries it links. */
function platformOfClasspath(paths) {
  const names = paths.map((p) => basename(p));
  if (
    names.some(
      (n) => n.startsWith("scalajs-library") || n.startsWith("scalajs-runtime")
    )
  ) {
    return "js";
  }
  if (names.some((n) => n.startsWith("nativelib"))) {
    return "native";
  }
  return "jvm";
}

/**
 * The platform a class directory was compiled for. Scala.js and Scala Native write their IR
 * next to the class files, inside the package directories.
 */
function platformOfDir(classDir) {
  const pending = [classDir];
  for (let seen = 0; pending.length && seen < 2000; seen++) {
    const current = pending.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(join(current, entry.name));
      } else if (entry.name.endsWith(".sjsir")) {
        return "js";
      } else if (entry.name.endsWith(".nir")) {
        return "native";
      }
    }
  }
  return "jvm";
}

/** The module directory that owns a leftover class directory: the path before its `target`. */
function guessSourceRoots(projectDir, classDir) {
  const rel = relative(projectDir, classDir).replaceAll("\\", "/");
  const prefix = /^(.+?)\/(?:target|\.scala-build)\//.exec(rel)?.[1];
  return [prefix ? join(projectDir, prefix) : projectDir];
}

/**
 * The dependency classpath the last build exported for a class directory: next to it for
 * sbt 2 (`<module>/streams`), under the module's `target/streams` for sbt 1, else the Mill
 * `compileClasspath.json` of the first module under `out/`.
 */
function readLeftoverClasspath(dir, classRoot) {
  const exportPath = [
    "streams",
    "compile",
    "dependencyClasspath",
    "_global",
    "streams",
    "export"
  ];
  const candidates = classRoot
    ? [
        join(dirname(classRoot), ...exportPath),
        join(dirname(dirname(classRoot)), ...exportPath)
      ]
    : [];
  candidates.push(join(dir, "target", ...exportPath));
  for (const sbtStream of candidates) {
    if (!existsSync(sbtStream)) {
      continue;
    }
    try {
      return splitClasspath(
        expandVirtualPaths(readFileSync(sbtStream, "utf-8").trim(), dir)
      ).filter((entry) => existsSync(entry.path));
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
      const compileClasspath = readMillJson(
        join(outDir, entry.name),
        "compileClasspath"
      );
      if (compileClasspath?.length) {
        return compileClasspath
          .filter((p) => p.endsWith(".jar") && existsSync(p))
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
