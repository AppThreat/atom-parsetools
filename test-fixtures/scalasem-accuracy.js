#!/usr/bin/env node
// The local accuracy check of scalasem over a large, current Scala build, run by hand before a
// release or after a change to the inventory, the compiler handling or the derivation rules.
// Not part of CI and not part of npm test.
//
//   node test-fixtures/scalasem-accuracy.js <project-dir> [--no-build]
//        [--baseline <numbers.json>] [--out <numbers.json>]
//
// The project is built with sbt unless --no-build is given, then analysed with scalasem, and
// the report is scored against facts that do not come from scalasem: the share of main source
// files the report covers per module, the libraries the class files really reference against
// the ones the report names, and a spot check of the reported call sites against the sources.
// A `helper-compile-failed` or `stale-output` diagnostic counts as a failure. The numbers land
// in a JSON file, and against a baseline file the differences are shown.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

import {
  baselineDiff,
  constantPoolClasses,
  scalasemVersion,
  scoreLibraries,
  zipEntryNames
} from "./scalasem-accuracy-lib.js";

const SOURCE_EXTENSIONS = [".scala", ".sc", ".java"];
// Test sources are not part of the coverage the issue tracks.
const TEST_SEGMENTS = ["/src/test/", "/src/it/", "/src/bench/"];
// Upstream modules of the project itself are not libraries.
const OWN_GROUP = "io.appthreat";
const CALL_SITE_SAMPLE = 200;

function parseArgs(argv) {
  const opts = { noBuild: false, baseline: undefined, out: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-build") {
      opts.noBuild = true;
    } else if (arg === "--baseline") {
      opts.baseline = resolve(argv[++i]);
    } else if (arg.startsWith("--baseline=")) {
      opts.baseline = resolve(arg.slice("--baseline=".length));
    } else if (arg === "--out") {
      opts.out = resolve(argv[++i]);
    } else if (arg.startsWith("--out=")) {
      opts.out = resolve(arg.slice("--out=".length));
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    cwd,
    env: process.env,
    maxBuffer: 1024 * 1024 * 1024
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

/**
 * Run a command and keep its wall clock time and peak memory, the latter read from the
 * `/usr/bin/time` report of the platform when that wrapper exists.
 */
function runMeasured(cmd, args, cwd) {
  const started = Date.now();
  const timeBin = "/usr/bin/time";
  if (existsSync(timeBin)) {
    const flag = process.platform === "darwin" ? "-l" : "-v";
    const result = run(timeBin, [flag, cmd, ...args], cwd);
    const text = `${result.stderr}`;
    const line = text
      .split("\n")
      .find((l) => /maximum resident set size/i.test(l));
    // macOS reports the size at the front of the line, Linux at the back, in bytes on
    // macOS and kilobytes on Linux.
    const reported = Number(
      /(\d+)\s+maximum resident set size|^\s*(\d+)\s+maximum/
        .exec(line || "")
        ?.slice(1)
        .filter(Boolean)[0]
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      seconds: (Date.now() - started) / 1000,
      peakMemoryMb: Number.isFinite(reported)
        ? Math.round(
            reported / (process.platform === "darwin" ? 1048576 : 1024)
          )
        : undefined
    };
  }
  const result = run(cmd, args, cwd);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    seconds: (Date.now() - started) / 1000,
    peakMemoryMb: undefined
  };
}

function git(dir, args) {
  return run("git", ["-C", dir, ...args], dir).stdout.trim();
}

function listFiles(dir, extensions) {
  const result = [];
  const visit = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        result.push(full);
      }
    }
  };
  visit(dir);
  return result.sort();
}

/**
 * The main source files a module covers: every source file under its source roots that is not
 * a test source and nothing a build generated.
 */
function mainSourcesOf(projectDir, module) {
  const roots = (module.sourceRoots || [])
    .map((root) => (isAbsolute(root) ? root : join(projectDir, root)))
    .filter(existsSync);
  const files = [];
  for (const root of roots) {
    for (const file of listFiles(root, SOURCE_EXTENSIONS)) {
      const rel = `/${relative(projectDir, file).replaceAll("\\", "/")}`;
      if (
        TEST_SEGMENTS.some((segment) => rel.includes(segment)) ||
        rel.includes("/target/")
      ) {
        continue;
      }
      files.push(file);
    }
  }
  return files.sort();
}

/** The names the report mentions for a module: types, reference symbols and call owners. */
function reportedNamesOf(report, moduleId) {
  const names = new Set();
  for (const entry of Object.values(report)) {
    if (!entry || typeof entry !== "object" || entry.module !== moduleId) {
      continue;
    }
    for (const name of entry.usedTypes || []) {
      names.add(name);
    }
    for (const reference of entry.references || []) {
      // A symbol carries a trailing terminator and disambiguator; the type name is what
      // precedes them.
      const typeLike = /^[A-Za-z0-9_.$]+/.exec(
        String(reference.symbol || "")
      )?.[0];
      if (typeLike) {
        names.add(typeLike);
      }
    }
    for (const call of entry.calls || []) {
      if (call.owner) {
        names.add(call.owner);
      }
    }
  }
  return [...names];
}

/** The classes the compiled class files of a module name in their constant pools. */
function referencedClassesOf(classDirs) {
  const names = new Set();
  for (const classDir of (classDirs || []).filter(existsSync)) {
    for (const classFile of listFiles(classDir, [".class"])) {
      try {
        for (const name of constantPoolClasses(readFileSync(classFile))) {
          names.add(name);
        }
      } catch (_err) {
        // a class file this reader cannot parse scores as nothing
      }
    }
  }
  return [...names];
}

const jarEntriesCache = new Map();
function jarEntries(path) {
  if (!jarEntriesCache.has(path)) {
    try {
      jarEntriesCache.set(path, zipEntryNames(path));
    } catch (_err) {
      jarEntriesCache.set(path, []);
    }
  }
  return jarEntriesCache.get(path);
}

function scoreModuleLibraries(report, projectDir, module) {
  const jars = (module.classpath || [])
    .filter(
      (entry) =>
        entry.path &&
        entry.path.endsWith(".jar") &&
        existsSync(entry.path) &&
        statSync(entry.path).size > 0
    )
    .map((entry) => ({
      path: entry.path,
      group: entry.group || "",
      artifact: entry.artifact || basename(entry.path).replace(/\.jar$/, ""),
      version: entry.version || "",
      entries: jarEntries(entry.path)
    }));
  return scoreLibraries(
    jars,
    referencedClassesOf(
      (module.classDirs || [])
        .map((d) => (isAbsolute(d) ? d : join(projectDir, d)))
        .filter(existsSync)
    ),
    reportedNamesOf(report, module.id),
    OWN_GROUP
  );
}

/**
 * A sample of the reported call sites, checked for the called name appearing on the reported
 * line of the source file.
 */
function spotCheckCallSites(report, projectDir) {
  const sites = [];
  for (const [file, entry] of Object.entries(report)) {
    if (!entry || typeof entry !== "object" || !entry.module) {
      continue;
    }
    for (const call of entry.calls || []) {
      sites.push({ file, call });
    }
  }
  const stride = Math.max(1, Math.floor(sites.length / CALL_SITE_SAMPLE));
  let checked = 0;
  let named = 0;
  for (let i = 0; i < sites.length; i += stride) {
    const { file, call } = sites[i];
    if (!file || !call.name || !Number.isInteger(call.line)) {
      continue;
    }
    const abs = isAbsolute(file) ? file : join(projectDir, file);
    let line;
    try {
      line = readFileSync(abs, "utf-8").split("\n")[call.line - 1];
    } catch (_err) {
      continue;
    }
    checked += 1;
    // A constructor call is written with the type name, never with the `<init>` the class
    // file names.
    const needle =
      call.name === "<init>"
        ? (call.owner || "").split(".").pop().replace(/\$$/, "")
        : call.name;
    if (needle && line !== undefined && line.includes(needle)) {
      named += 1;
    }
  }
  return {
    checked,
    named,
    namedShare: checked
      ? Math.round((named / checked) * 1000) / 1000
      : undefined
  };
}

function coverageOf(report, projectDir) {
  // The main sources a module covers, counted per module only when its source roots are its
  // own: an inventory that could not ask the build leaves every module the whole project as
  // its root, and the files are then counted once, over the union.
  const rootOwners = new Map();
  for (const module of report.modules || []) {
    for (const root of module.sourceRoots || []) {
      rootOwners.set(root, (rootOwners.get(root) || 0) + 1);
    }
  }
  const exclusiveRootsOf = (module) =>
    (module.sourceRoots || []).filter((root) => rootOwners.get(root) === 1);
  const covered = new Set(
    Object.entries(report)
      .filter(
        ([, entry]) =>
          entry &&
          typeof entry === "object" &&
          entry.scope === "main" &&
          entry.module
      )
      .map(([file]) => file)
  );
  const modules = [];
  const union = new Set();
  let withFacts = 0;
  for (const module of report.modules || []) {
    const sources = mainSourcesOf(projectDir, module);
    const coveredCount = sources.filter((file) =>
      covered.has(relative(projectDir, file).replaceAll("\\", "/"))
    ).length;
    for (const file of sources) {
      union.add(relative(projectDir, file).replaceAll("\\", "/"));
    }
    withFacts += coveredCount;
    const exclusive = exclusiveRootsOf(module);
    const files = exclusive.length
      ? mainSourcesOf(projectDir, { sourceRoots: exclusive }).length
      : undefined;
    const share =
      files && files > 0
        ? Math.round((coveredCount / files) * 1000) / 1000
        : undefined;
    modules.push({
      id: module.id,
      scalaVersion: module.scalaVersion,
      files,
      withFacts: coveredCount,
      share
    });
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  const total = union.size;
  return {
    overall: {
      files: total,
      withFacts: [...union].filter((file) => covered.has(file)).length,
      share: total
        ? Math.round(
            ([...union].filter((file) => covered.has(file)).length / total) *
              1000
          ) / 1000
        : undefined
    },
    modules
  };
}

function diagnosticsOf(report) {
  const counts = {};
  const failures = [];
  for (const diagnostic of report._meta?.diagnostics || []) {
    counts[diagnostic.code] =
      (counts[diagnostic.code] || 0) + (diagnostic.count || 1);
    if (
      diagnostic.code === "helper-compile-failed" ||
      diagnostic.code === "stale-output"
    ) {
      failures.push({
        code: diagnostic.code,
        module: diagnostic.module,
        detail: diagnostic.detail,
        missingClass: diagnostic.missingClass,
        skippedDir: diagnostic.skippedDir,
        skippedVersion: diagnostic.skippedVersion,
        usedDir: diagnostic.usedDir,
        usedVersion: diagnostic.usedVersion,
        count: diagnostic.count || 1
      });
    }
  }
  return { counts, failures };
}

async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  if (!positional.length) {
    console.error(
      "usage: node test-fixtures/scalasem-accuracy.js <project-dir> [--no-build] [--baseline <json>] [--out <json>]"
    );
    return false;
  }
  const packageRoot = resolve(new URL("..", import.meta.url).pathname);
  const projectDir = resolve(positional[0]);
  if (!existsSync(join(projectDir, "build.sbt"))) {
    console.error(`No sbt project at ${projectDir}`);
    return false;
  }
  const outFile = opts.out || join(process.cwd(), "scalasem-accuracy.json");
  const reportFile = join(tmpdir(), `scalasem-accuracy-${Date.now()}.json`);

  if (!opts.noBuild) {
    if (!process.env.GITHUB_TOKEN) {
      console.log(
        "note: GITHUB_TOKEN is not set; the sbt build needs it for the GitHub Packages plugins"
      );
    }
    const sbt = process.env.SBT_CMD || "sbt";
    console.log(`building ${basename(projectDir)} with ${sbt}...`);
    const built = run(sbt, ["-batch", "compile"], projectDir);
    if (built.status !== 0) {
      console.error(
        `sbt compile failed:\n${(built.stderr || built.stdout).split("\n").slice(-15).join("\n")}`
      );
      return false;
    }
  }

  const scalasemArgs = [
    join(packageRoot, "scalasem.js"),
    projectDir,
    reportFile,
    ...(opts.noBuild ? ["--no-build"] : [])
  ];
  console.log(`running scalasem ${opts.noBuild ? "--no-build" : ""}...`);
  const measured = runMeasured(process.execPath, scalasemArgs, packageRoot);
  if (measured.status !== 0 || !existsSync(reportFile)) {
    console.error(
      `scalasem failed:\n${(measured.stderr || measured.stdout).split("\n").slice(-15).join("\n")}`
    );
    return false;
  }
  const report = JSON.parse(readFileSync(reportFile, "utf-8"));

  const coverage = coverageOf(report, projectDir);
  const diagnostics = diagnosticsOf(report);
  const libraries = {};
  const libraryTotals = { used: 0, misses: 0, suspects: 0 };
  for (const module of report.modules || []) {
    const scored = scoreModuleLibraries(report, projectDir, module);
    const key = (list) =>
      list.map((c) => `${c.group}:${c.artifact}:${c.version}`).sort();
    libraries[module.id] = {
      used: key(scored.used),
      misses: key(scored.misses),
      suspects: key(scored.suspects)
    };
    libraryTotals.used += scored.used.length;
    libraryTotals.misses += scored.misses.length;
    libraryTotals.suspects += scored.suspects.length;
  }
  const callSites = spotCheckCallSites(report, projectDir);
  const numbers = {
    project: {
      path: basename(projectDir),
      commit: git(projectDir, ["rev-parse", "HEAD"]),
      dirty: Boolean(git(projectDir, ["status", "--porcelain"]))
    },
    scalasem: {
      version: scalasemVersion(),
      noBuild: opts.noBuild
    },
    coverage,
    diagnostics: diagnostics.counts,
    failures: diagnostics.failures,
    libraries,
    libraryTotals,
    callSites,
    counts: Object.fromEntries(
      ["calls", "definitions", "callStacks", "crypto", "endpoints"].map(
        (key) => [key, report._meta?.counts?.[key]]
      )
    ),
    runtime: {
      seconds: Math.round(measured.seconds),
      peakMemoryMb: measured.peakMemoryMb
    }
  };

  mkdirSync(join(outFile, ".."), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(numbers, null, 2)}\n`);

  const overall = coverage.overall;
  console.log(
    `coverage: ${overall.withFacts} of ${overall.files} main source files (${overall.share})`
  );
  for (const module of coverage.modules) {
    console.log(
      `  ${module.id}: ${module.withFacts}/${module.files}${module.share === undefined ? "" : ` (${module.share})`}`
    );
  }
  const diagnosticText = Object.entries(diagnostics.counts)
    .map(([code, count]) => `${code}=${count}`)
    .join(", ");
  console.log(`diagnostics: ${diagnosticText || "none"}`);
  for (const failure of diagnostics.failures) {
    const version =
      failure.skippedVersion || failure.usedVersion || failure.detail;
    const detail = failure.missingClass
      ? ` missing ${failure.missingClass}`
      : failure.skippedDir
        ? ` skipped ${failure.skippedDir} (${version})`
        : "";
    const at =
      failure.detail && !failure.skippedDir ? ` (${failure.detail})` : "";
    console.log(`  FAILURE ${failure.code}: ${failure.module}${at}${detail}`);
  }
  console.log(
    `libraries: ${libraryTotals.used} used, ${libraryTotals.misses} misses, ${libraryTotals.suspects} suspects`
  );
  console.log(
    `call sites: ${callSites.named}/${callSites.checked} name the called method on the reported line`
  );
  console.log(
    `counts: ${JSON.stringify(numbers.counts)}, ${numbers.runtime.seconds}s, ${numbers.runtime.peakMemoryMb ?? "?"} MB peak`
  );
  if (opts.baseline && existsSync(opts.baseline)) {
    const baseline = JSON.parse(readFileSync(opts.baseline, "utf-8"));
    const { fields, regressions } = baselineDiff(numbers, baseline);
    console.log(`against ${basename(opts.baseline)}:`);
    for (const field of fields) {
      const mark = field.delta > 0 ? "+" : field.delta < 0 ? "-" : "=";
      console.log(`  ${mark} ${field.key}: ${field.before} -> ${field.after}`);
    }
    if (regressions.length) {
      console.log(`regressions:\n  ${regressions.join("\n  ")}`);
    } else {
      console.log("no regressions against the baseline");
    }
  }
  rmSync(reportFile, { force: true });
  return (diagnostics.failures.length || 0) === 0;
}

process.exit((await main(process.argv.slice(2))) ? 0 : 1);
