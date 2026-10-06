// Runs the inspector helper for one module: groups the TASTy files by the compiler that wrote
// them, resolves that compiler, and turns the JSON lines of the helper into per file facts.
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";

import {
  compileHelper,
  readTastyHeader,
  resolveToolchain,
  runInspector
} from "./compiler.js";
import { semanticdbModuleFacts } from "./semanticdb.js";
import { listFiles, normaliseSourcePath } from "./util.js";

// The helper receives its file list on the command line, so batches stay small enough for
// every platform's argument length limit.
const BATCH_SIZE = 40;
// A batch the compiler aborts is split until the offending files are alone. A module whose
// files all fail the same way would otherwise cost two JVM runs per file, so the splitting
// stops after this many extra runs and the rest of a failed batch counts as unreadable.
const RETRY_BUDGET = 32;

/**
 * Inspect the TASTy files of one module.
 *
 * @param {string} projectDir Absolute project directory
 * @param {Object} module Module inventory entry
 * @param {Object} opts `{ scalaVersion, installDeps }`
 * @returns {{ files: Map<string, Object>, tastyFiles: number, readFiles: number, diagnostics: Object[], toolchains: Object[] }}
 */
export function inspectModule(projectDir, module, opts = {}) {
  const diagnostics = [];
  const toolchains = [];
  const files = new Map();
  const semanticdbAllowed = opts.semanticdb !== "never";
  if (
    semanticdbAllowed &&
    (module.scalaVersion?.startsWith("2.") ||
      process.env.SCALASEM_COMPILER === "none" ||
      opts.semanticdb === "always")
  ) {
    // Scala 2 writes class files only; its facts come from SemanticDB.
    const facts = semanticdbModuleFacts(projectDir, module);
    if (facts.size) {
      return {
        files: facts,
        tastyFiles: 0,
        readFiles: facts.size,
        diagnostics,
        toolchains,
        factsSource: "semanticdb"
      };
    }
    diagnostics.push({
      code: module.scalaVersion?.startsWith("2.")
        ? "scala2-unsupported"
        : "semanticdb-missing",
      module: module.id,
      detail: module.scalaVersion
    });
    return { files, tastyFiles: 0, readFiles: 0, diagnostics, toolchains };
  }
  if (module.scalaVersion?.startsWith("2.")) {
    // SemanticDB is turned off, and Scala 2 writes no TASTy.
    diagnostics.push({
      code: "scala2-unsupported",
      module: module.id,
      detail: module.scalaVersion
    });
    return { files, tastyFiles: 0, readFiles: 0, diagnostics, toolchains };
  }
  const tastyFiles = module.classDirs
    .flatMap((d) => listFiles(d, ".tasty"))
    .filter((f) => !isBuildScriptOutput(projectDir, f));
  if (opts.scalaVersion && !opts.scalaVersion.startsWith("3.")) {
    diagnostics.push({
      code: "scala-version-mismatch",
      module: module.id,
      detail: opts.scalaVersion
    });
    return { files, tastyFiles: 0, readFiles: 0, diagnostics, toolchains };
  }
  if (!tastyFiles.length) {
    // A tree without TASTy but with SemanticDB is a Scala 2 tree the last build filled.
    if (semanticdbAllowed && module.semanticdbDirs?.length) {
      const facts = semanticdbModuleFacts(projectDir, module);
      if (facts.size) {
        return {
          files: facts,
          tastyFiles: 0,
          readFiles: facts.size,
          diagnostics,
          toolchains,
          factsSource: "semanticdb"
        };
      }
    }
    return { files, tastyFiles: 0, readFiles: 0, diagnostics, toolchains };
  }
  const total = tastyFiles.length;
  const byVersion = new Map();
  for (const file of tastyFiles) {
    const header = readTastyHeader(file);
    const version =
      header?.toolVersion || `${header?.major ?? 28}.${header?.minor ?? 0}.0`;
    if (!byVersion.has(version)) {
      byVersion.set(version, []);
    }
    byVersion.get(version).push(file);
  }
  let unreadable = 0;
  let unresolved = 0;
  const budget = { retries: RETRY_BUDGET };
  const runDiagnostics = new Map();
  for (const [version, group] of byVersion) {
    const toolchain = resolveToolchain(
      { ...module, scalaVersion: version },
      opts
    );
    if (!toolchain) {
      diagnostics.push({
        code: "compiler-unavailable",
        module: module.id,
        detail: version
      });
      unresolved += group.length;
      continue;
    }
    if (!toolchain.inspectorJar) {
      diagnostics.push({
        code: "tasty-inspector-unavailable",
        module: module.id,
        detail: version
      });
      unresolved += group.length;
      continue;
    }
    const helperDir = compileHelper(toolchain);
    if (!helperDir) {
      diagnostics.push({
        code: "helper-compile-failed",
        module: module.id,
        detail: version
      });
      unresolved += group.length;
      continue;
    }
    toolchains.push({ version, source: toolchain.source });
    const classpath = [
      ...module.classpath.map((c) => c.path),
      ...module.classDirs
    ];
    for (let i = 0; i < group.length; i += BATCH_SIZE) {
      const batch = group.slice(i, i + BATCH_SIZE);
      const { lines, failed } = inspectBatch(
        toolchain,
        helperDir,
        classpath,
        batch,
        budget
      );
      const facts = parseFacts(projectDir, lines);
      for (const [file, entry] of facts) {
        mergeEntry(files, file, entry);
      }
      for (const [code, count] of runDiagnosticsOf(lines)) {
        runDiagnostics.set(code, (runDiagnostics.get(code) || 0) + count);
      }
      unreadable += failed;
    }
  }
  // The helper reports unresolved symbols and files its walker could not finish; a batch that
  // aborted is already counted as unreadable files.
  runDiagnostics.delete("inspector-errors");
  for (const [code, count] of runDiagnostics) {
    diagnostics.push({ code, module: module.id, count });
  }
  if (unreadable > 0) {
    diagnostics.push({
      code: "unreadable-tasty",
      module: module.id,
      count: unreadable
    });
  }
  // The SemanticDB the build left covers the sources whose TASTy could not be read, for
  // example when no compiler of that release can be resolved.
  let factsSource;
  if (
    (unresolved > 0 || unreadable > 0) &&
    semanticdbAllowed &&
    module.semanticdbDirs?.length
  ) {
    for (const [file, facts] of semanticdbModuleFacts(projectDir, module)) {
      if (!files.has(file)) {
        files.set(file, facts);
        factsSource = "semanticdb";
      }
    }
  }
  return {
    files,
    tastyFiles: total,
    readFiles: files.size,
    diagnostics,
    toolchains,
    ...(factsSource ? { factsSource } : {})
  };
}

/** The run wide diagnostics of one helper run, by code. */
function runDiagnosticsOf(lines) {
  const counts = new Map();
  for (const line of lines) {
    if (!line.includes('"kind":"diag"')) {
      continue;
    }
    try {
      const fact = JSON.parse(line);
      if (fact.code && !fact.file) {
        counts.set(fact.code, (counts.get(fact.code) || 0) + (fact.count || 1));
      }
    } catch (_err) {
      // not a fact line
    }
  }
  return counts;
}

/** Mill writes the build script's own classes under `out/mill-build`; sbt under `project/target`. */
function isBuildScriptOutput(projectDir, file) {
  const rel = normaliseSourcePath(projectDir, file);
  return (
    rel.startsWith("out/mill-build/") ||
    rel.startsWith("project/target/") ||
    rel.includes("/mill-build/")
  );
}

/**
 * Turn the JSON lines of one helper run into a per file map.
 *
 * @param {string} projectDir Absolute project directory
 * @param {string[]} lines JSON lines
 * @returns {Map<string, Object>}
 */
export function parseFacts(projectDir, lines) {
  const files = new Map();
  // Code inlined from a library keeps the positions of the library's own sources, which are
  // not files of this project.
  const present = new Map();
  const inProject = (key) => {
    if (!present.has(key)) {
      present.set(key, !isAbsolute(key) && existsSync(join(projectDir, key)));
    }
    return present.get(key);
  };
  const entryFor = (path) => {
    const key = normaliseSourcePath(projectDir, path);
    if (!inProject(key)) {
      return undefined;
    }
    if (!files.has(key)) {
      files.set(key, {
        definitions: [],
        calls: [],
        patterns: [],
        references: [],
        constants: [],
        diagnostics: [],
        factsSource: "tasty"
      });
    }
    return files.get(key);
  };
  for (const line of lines) {
    let fact;
    try {
      fact = JSON.parse(line);
    } catch (_err) {
      continue;
    }
    if (!fact?.file) {
      if (fact?.kind === "diag") {
        // Run wide diagnostics are returned by the caller through the module diagnostics.
        continue;
      }
      continue;
    }
    const entry = entryFor(fact.file);
    if (!entry) {
      continue;
    }
    switch (fact.kind) {
      case "call":
        entry.calls.push({
          line: fact.line,
          column: fact.column,
          ...(fact.endLine !== undefined ? { endLine: fact.endLine } : {}),
          ...(fact.endColumn !== undefined
            ? { endColumn: fact.endColumn }
            : {}),
          caller: fact.caller,
          ...(fact.callerSignature
            ? { callerSignature: fact.callerSignature }
            : {}),
          owner: fact.owner,
          name: fact.name,
          ...(fact.signature ? { signature: fact.signature } : {}),
          ...(fact.recv ? { recv: fact.recv } : {}),
          ...(fact.byName !== undefined ? { byName: fact.byName } : {}),
          ...(fact.args ? { args: fact.args } : {})
        });
        break;
      case "pattern":
        entry.patterns.push({
          line: fact.line,
          column: fact.column,
          ...(fact.owner ? { owner: fact.owner } : {}),
          ...(fact.name ? { name: fact.name } : {}),
          ...(fact.args ? { args: fact.args } : {}),
          ...(fact.idents ? { idents: fact.idents } : {})
        });
        break;
      case "def":
        entry.definitions.push({
          kind: definitionKind(fact),
          name: fact.name,
          owner: fact.owner,
          ...(fact.sym ? { sym: fact.sym } : {}),
          line: fact.line,
          endLine: fact.endLine,
          column: fact.column,
          ...(fact.flags ? { flags: fact.flags } : {}),
          ...(fact.parents ? { parents: fact.parents } : {}),
          ...(fact.annotations ? { annotations: fact.annotations } : {}),
          ...(fact.params ? { params: fact.params } : {}),
          ...(fact.signature ? { signature: fact.signature } : {})
        });
        break;
      case "ref":
        entry.references.push({
          line: fact.line,
          column: fact.column,
          symbol: fact.symbol,
          owner: fact.owner,
          kind: fact.refKind || "term"
        });
        break;
      case "const":
        entry.constants.push({
          sym: fact.sym,
          value: fact.value,
          tpe: fact.tpe,
          line: fact.line
        });
        break;
      default:
        break;
    }
  }
  return files;
}

/** class, trait and object definitions all arrive as class trees; the flags tell them apart. */
function definitionKind(fact) {
  if (fact.flags?.includes("module")) {
    return "object";
  }
  if (fact.defKind !== "class") {
    return fact.defKind || "def";
  }
  if (fact.flags?.includes("trait")) {
    return "trait";
  }
  return "class";
}

/**
 * Run one batch of TASTy files. A file the compiler cannot load aborts the whole batch, so a
 * batch that printed nothing is retried in halves until only the offending files are left.
 */
function inspectBatch(toolchain, helperDir, classpath, batch, budget) {
  const lines = runInspector(toolchain, helperDir, classpath, batch);
  // A run that only reports a diagnostic read none of its files.
  const read = lines.some((line) => !line.includes('"kind":"diag"'));
  if (read) {
    return { lines, failed: 0 };
  }
  if (batch.length === 1 || budget.retries < 2) {
    return { lines: [], failed: batch.length };
  }
  budget.retries -= 2;
  const middle = Math.ceil(batch.length / 2);
  const first = inspectBatch(
    toolchain,
    helperDir,
    classpath,
    batch.slice(0, middle),
    budget
  );
  const second = inspectBatch(
    toolchain,
    helperDir,
    classpath,
    batch.slice(middle),
    budget
  );
  return {
    lines: [...first.lines, ...second.lines],
    failed: first.failed + second.failed
  };
}

function mergeEntry(files, file, entry) {
  const existing = files.get(file);
  if (!existing) {
    files.set(file, entry);
    return;
  }
  existing.definitions.push(...entry.definitions);
  existing.calls.push(...entry.calls);
  existing.patterns.push(...(entry.patterns || []));
  existing.references.push(...entry.references);
  existing.constants.push(...entry.constants);
}
