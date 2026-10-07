#!/usr/bin/env node
// Usage: scalasem <dir> <outFile> [--no-build] [--no-compile] [--build auto|sbt|mill|maven|scala-cli|none]
//
// Produces the scalasem report of a Scala project: compiler facts with file and line for every
// TASTy file the build produced, plus the routes and configuration values. The build tool
// supplies the module inventory and the compiler; no compiler from the PATH is ever run.
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { exitWithSupervisor, timeLimitReached } from "./supervise.js";
import { inventory } from "./lib/scalasem/build.js";
import { collectFacts } from "./lib/scalasem/collect.js";
import { buildFileEntry } from "./lib/scalasem/facts.js";
import { parseProjectConfig } from "./lib/scalasem/config.js";
import { buildReport, reportCaps, writeReport } from "./lib/scalasem/schema.js";
import { deriveContext, deriveEvidence } from "./lib/scalasem/derive/index.js";

function parseArgs(argv) {
  const positional = [];
  const opts = {
    noBuild: ["true", "1"].includes(process.env.SCALASEM_NO_BUILD),
    noCompile: ["true", "1"].includes(process.env.SCALASEM_NO_COMPILE),
    build: "auto",
    installDeps: !["true", "1"].includes(process.env.SCALASEM_NO_INSTALL),
    includeTests: ["true", "1"].includes(process.env.SCALASEM_INCLUDE_TESTS),
    scalaVersion: process.env.SCALA_VERSION,
    semanticdb: process.env.SCALASEM_SEMANTICDB || "auto",
    pretty: false
  };
  // `--build sbt` is accepted as well as `--build=sbt`.
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (
      ["--build", "--semanticdb"].includes(argv[i]) &&
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith("--")
    ) {
      args.push(`${argv[i]}=${argv[i + 1]}`);
      i += 1;
    } else {
      args.push(argv[i]);
    }
  }
  for (const arg of args) {
    if (arg === "--no-build") {
      opts.noBuild = true;
    } else if (arg === "--no-compile") {
      opts.noCompile = true;
    } else if (arg === "--include-tests") {
      opts.includeTests = true;
    } else if (arg === "--pretty") {
      opts.pretty = true;
    } else if (arg.startsWith("--build=")) {
      opts.build = arg.slice("--build=".length);
    } else if (arg.startsWith("--semanticdb=")) {
      opts.semanticdb = arg.slice("--semanticdb=".length);
    } else if (arg.startsWith("--max-")) {
      const [name, value] = arg.slice("--max-".length).split("=");
      const envName = `SCALASEM_MAX_${name.replace(/-/g, "_").toUpperCase()}`;
      process.env[envName] = value;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

async function main(argv) {
  const { positional, opts } = parseArgs(argv);
  if (positional.length < 1) {
    console.error(
      "usage: scalasem <dir> <outFile> [--no-build] [--no-compile]"
    );
    return false;
  }
  const requested = resolve(positional[0]);
  if (!existsSync(requested)) {
    console.error(`No such directory: ${requested}`);
    return false;
  }
  // Build tools report resolved paths, so the project directory has to be resolved too for
  // the relative paths of the report to line up.
  const projectDir = realpathSync(requested);
  const outFile =
    positional.length > 1
      ? resolve(positional[1])
      : resolve(projectDir, "slices.json");
  const detected = await inventory(projectDir, opts);
  const collected = collectFacts(projectDir, detected.modules, opts);
  const diagnostics = [...detected.diagnostics, ...collected.diagnostics];
  const {
    files: rawFiles,
    moduleOf,
    platformsOf,
    toolchains,
    factsSources,
    modulesWithOutput
  } = collected;
  const tastyTotal = collected.tastyFiles;
  const readTotal = collected.readFiles;
  const config = parseProjectConfig(projectDir);
  const evidence = deriveEvidence(
    deriveContext(
      rawFiles,
      {
        routes: config.routes,
        values: config.values,
        routerMounts: config.routerMounts
      },
      { projectDir }
    )
  );
  const fileEntries = {};
  for (const [file, facts] of rawFiles) {
    const entry = buildFileEntry(facts, moduleOf.get(file), file, {
      caps: reportCaps()
    });
    const derived = evidence.tagsByFile?.get(file);
    if (derived?.size) {
      entry.tags = [...new Set([...entry.tags, ...derived])].sort();
    }
    // A source compiled into several modules of a cross build belongs to every platform.
    const platforms = [...(platformsOf.get(file) || new Set())].sort();
    if (platforms.length > 1) {
      entry.platforms = platforms;
    }
    fileEntries[file] = entry;
  }
  const report = buildReport(
    {
      projectDir,
      tool: detected.tool,
      version: detected.version,
      modules: modulesWithOutput,
      fileEntries,
      config,
      diagnostics: mergeDiagnostics(diagnostics),
      toolchains,
      factsSources,
      evidence
    },
    reportCaps()
  );
  // The watchdog may have started stopping this run while the facts were collected, for
  // example when a build tool hung past the handed-down limit and was stopped. What the
  // run gathered from then on is a fraction of the evidence, and must not pass for a
  // complete report.
  if (timeLimitReached()) {
    console.error(
      "The time limit was reached or the supervising process is gone; no report was written."
    );
    return false;
  }
  writeReport(outFile, report, opts.pretty);
  const files = report._meta.counts.files;
  console.log(
    `Slices file ${outFile} created with ${files} entries (${tastyTotal} TASTy files read into ${readTotal} sources).`
  );
  if (!files && !config.routes.length) {
    console.log("Empty slices file created.");
  }
  return true;
}

function mergeDiagnostics(diagnostics) {
  const merged = new Map();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}:${diagnostic.module || ""}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count = (existing.count || 1) + (diagnostic.count || 1);
    } else {
      merged.set(key, { ...diagnostic, count: diagnostic.count || 1 });
    }
  }
  return [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// SCALASEM_TIMEOUT (milliseconds) bounds the whole run, the builds it starts included: a caller
// that stopped scalasem on its own timeout would leave those running.
exitWithSupervisor(process.env, {
  timeoutMs: Number.parseInt(process.env.SCALASEM_TIMEOUT || "", 10)
});
let ok = false;
try {
  ok = await main(process.argv.slice(2));
} catch (err) {
  console.error(`scalasem failed: ${err?.stack || err}`);
}
process.exit(ok ? 0 : 1);
