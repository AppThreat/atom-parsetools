// The schema v2 writer: deterministic key and array order, stable ids, caps with a truncation
// flag, and the sanitizers that keep secrets and query strings out of the report.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import process from "node:process";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const toolVersion = require("../../package.json").version;

/**
 * Caps of the writer. Every value can be raised through the environment.
 *
 * @param {Object} [env] Environment to read
 * @returns {Object}
 */
export function reportCaps(env = process.env) {
  const int = (name, def) => {
    const value = Number.parseInt(env[name], 10);
    return Number.isNaN(value) ? def : value;
  };
  return {
    files: int("SCALASEM_MAX_FILES", 5000),
    calls: int("SCALASEM_MAX_CALLS_PER_FILE", 2000),
    references: int("SCALASEM_MAX_REFERENCES_PER_FILE", 2000),
    definitions: int("SCALASEM_MAX_DEFINITIONS_PER_FILE", 2000),
    literals: int("SCALASEM_MAX_LITERALS_PER_FILE", 100)
  };
}

/**
 * Assemble the schema v2 report.
 *
 * @param {Object} parts `{ projectDir, build, tool, version, modules, fileEntries, config, diagnostics, toolchains, evidence }`
 * @param {Object} [caps] Writer caps
 * @returns {Object} Report ready to serialise
 */
export function buildReport(parts, caps = reportCaps()) {
  const evidence = parts.evidence || {};
  const report = {
    _meta: {
      schemaVersion: "scalasem/2",
      tool: "scalasem",
      toolVersion,
      projectPath: parts.projectDir,
      generatedFrom: [
        ...new Set([
          ...(parts.toolchains?.length ? ["tasty"] : []),
          ...(parts.factsSources || [])
        ])
      ].sort(),
      build: {
        tool: parts.tool,
        ...(parts.version ? { version: parts.version } : {})
      },
      compilers: uniqueCompilers(parts.toolchains || []),
      platforms: [
        ...new Set((parts.modules || []).map((m) => m.platform).filter(Boolean))
      ].sort(),
      counts: {},
      diagnostics: parts.diagnostics || [],
      truncated: false
    },
    config: parts.config || { routes: [] },
    modules: (parts.modules || []).map((m) => moduleEntry(m, parts.projectDir)),
    entryPoints: evidence.entryPoints || [],
    callGraph: evidence.callGraph || { edges: [] },
    callStacks: evidence.callStacks || [],
    crypto: evidence.crypto || [],
    endpoints: evidence.endpoints || [],
    services: evidence.services || []
  };
  const files = Object.keys(parts.fileEntries || {}).sort();
  const limited = files.slice(0, caps.files);
  for (const file of limited) {
    report[file] = parts.fileEntries[file];
  }
  if (limited.length < files.length) {
    report._meta.truncated = true;
  }
  const counts = {
    files: limited.length,
    calls: 0,
    references: 0,
    definitions: 0,
    endpoints: report.endpoints.length,
    crypto: report.crypto.length,
    services: report.services.length,
    callStacks: report.callStacks.length
  };
  for (const file of limited) {
    counts.calls += parts.fileEntries[file].calls?.length || 0;
    counts.references += parts.fileEntries[file].references?.length || 0;
    counts.definitions += parts.fileEntries[file].definitions?.length || 0;
  }
  counts.routes = (parts.config?.routes || []).length;
  if (parts.config?.values?.length) {
    counts.configValues = parts.config.values.length;
  }
  report._meta.counts = counts;
  if (Object.values(parts.fileEntries || {}).some((entry) => entry.truncated)) {
    report._meta.truncated = true;
  }
  return sortKeysDeep(report, ["_meta", "config", "modules"]);
}

/** One entry per compiler release and source, however many modules share it. */
function uniqueCompilers(toolchains) {
  const seen = new Map();
  for (const t of toolchains) {
    seen.set(`${t.version}\u0000${t.source}`, {
      version: t.version,
      source: t.source
    });
  }
  return [...seen.values()];
}

function moduleEntry(module, projectDir) {
  return {
    id: module.id,
    platform: module.platform || "jvm",
    ...(module.scalaVersion ? { scalaVersion: module.scalaVersion } : {}),
    classDirs: (module.classDirs || []).map((d) =>
      relativeModulePath(projectDir, d)
    ),
    sourceRoots: (module.sourceRoots || []).map((d) =>
      relativeModulePath(projectDir, d)
    ),
    classpath: (module.classpath || [])
      .filter((entry) => entry.group)
      .map((entry) => ({
        path: entry.path,
        group: entry.group,
        artifact: entry.artifact,
        version: entry.version
      }))
  };
}

function relativeModulePath(projectDir, dir) {
  if (!projectDir) {
    return dir;
  }
  const rel = relative(projectDir, dir);
  if (!rel || rel.startsWith("..")) {
    return dir;
  }
  return rel.split("\\").join("/");
}

// Arrays whose order carries meaning: call arguments by position, call stack frames and value
// chains from the entry outwards, classpaths and source roots in build order. Every other array
// is a set and is sorted.
const ORDERED_ARRAYS = new Set([
  "args",
  "frames",
  "via",
  "parents",
  "classpath",
  "classDirs",
  "sourceRoots",
  "params",
  "parts"
]);

/**
 * Sort the keys of the report and its set-like arrays, so two runs of the same tree byte
 * compare equal. `_meta`, `config` and `modules` stay in place; file entries follow in sorted
 * order.
 *
 * @param {Object} report Report
 * @param {string[]} head Keys that lead the object
 * @returns {Object} Sorted report
 */
export function sortKeysDeep(report, head = []) {
  const sortValue = (value, key) => {
    if (Array.isArray(value)) {
      const items = value.map((item) => sortValue(item));
      return ORDERED_ARRAYS.has(key) ? items : items.sort(sortArrayEntry);
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value).sort()) {
        out[k] = sortValue(value[k], k);
      }
      return out;
    }
    return value;
  };
  const out = {};
  for (const key of head) {
    if (key in report) {
      out[key] = sortValue(report[key], key);
    }
  }
  const sorted = sortValue(report);
  for (const key of Object.keys(sorted)) {
    if (!(key in out)) {
      out[key] = sorted[key];
    }
  }
  return out;
}

function sortArrayEntry(a, b) {
  const aLine =
    typeof a === "object" && a
      ? (a.line ?? a.path ?? a.id ?? a.sym)
      : undefined;
  const bLine =
    typeof b === "object" && b
      ? (b.line ?? b.path ?? b.id ?? b.sym)
      : undefined;
  if (
    typeof aLine === "number" &&
    typeof bLine === "number" &&
    aLine !== bLine
  ) {
    return aLine - bLine;
  }
  if (
    typeof aLine === "string" &&
    typeof bLine === "string" &&
    aLine !== bLine
  ) {
    return aLine < bLine ? -1 : 1;
  }
  const aText = JSON.stringify(a);
  const bText = JSON.stringify(b);
  return aText < bText ? -1 : aText > bText ? 1 : 0;
}

/**
 * Write the report.
 *
 * @param {string} outFile Destination
 * @param {Object} report Report
 * @param {boolean} [pretty=false] Indent the JSON
 */
export function writeReport(outFile, report, pretty = false) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, pretty ? 2 : 0) + "\n");
}
