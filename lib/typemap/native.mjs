// The native type map sidecar: ASTGEN_TYPES=native runs atom-parsetools-native once for the project
// and merges the .typemap files it wrote into the output directory. Babel still parses.
//
// Everything here is a function of its arguments so it can be tested without running astgen.

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";

export const NATIVE_BINARY_NAME = process.platform === "win32" ? "atom-parsetools-native.exe" : "atom-parsetools-native";

/** File name of the side-record. Must end in .jsonl: chen reads every *.json under the output as an AST. */
export const MANIFEST_FILENAME = "astgen_manifest.jsonl";

/**
 * The engine ASTGEN_TYPES asks for. Anything but "native" is the TypeScript 6 path, which is the
 * default; an unknown value is reported once and treated as ts6.
 */
export function requestedEngine(env = process.env, warn = () => {}) {
  const raw = (env.ASTGEN_TYPES ?? "").trim().toLowerCase();
  if (raw === "" || raw === "ts6") return "ts6";
  if (raw === "native") return "native";
  warn(`ASTGEN_TYPES=${env.ASTGEN_TYPES} is not one of native, ts6; using ts6.`);
  return "ts6";
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Where the binary is: ASTGEN_NATIVE_BIN, else next to astgen.js, else on PATH.
 * Returns { path } or { error } (an explicit ASTGEN_NATIVE_BIN that is not a file is an error, not a
 * reason to look elsewhere: the user named a binary).
 */
export function findNativeBinary({ env = process.env, astgenDir, name = NATIVE_BINARY_NAME } = {}) {
  if (env.ASTGEN_NATIVE_BIN) {
    return isFile(env.ASTGEN_NATIVE_BIN)
      ? { path: env.ASTGEN_NATIVE_BIN }
      : { error: `ASTGEN_NATIVE_BIN=${env.ASTGEN_NATIVE_BIN} is not a file` };
  }
  if (astgenDir) {
    const beside = join(astgenDir, name);
    if (isFile(beside)) return { path: beside };
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && isFile(join(dir, name))) return { path: join(dir, name) };
  }
  return { error: `${name} was not found (ASTGEN_NATIVE_BIN, next to astgen.js, PATH)` };
}

function listTypemaps(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".typemap")) out.push(relative(root, p));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * Run the binary once for the project. It writes into a private directory inside the output; on success
 * its .typemap files are moved to their place in the output, on any failure nothing is left behind.
 *
 * @returns {Promise<{ok: true, files: string[], report: object} | {ok: false, reason: string}>}
 */
export async function runNativeTypes({ bin, src, output, type, env = process.env, onFile = () => {}, spawnImpl = spawn }) {
  mkdirSync(output, { recursive: true });
  const work = mkdtempSync(join(output, ".typemap-native-"));
  const reportPath = join(work, "report.json");
  const staging = join(work, "out");
  mkdirSync(staging);
  try {
    const args = ["typemap", "-i", src, "-o", staging, "--report", reportPath];
    if (type) args.push("-t", type);
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(bin, args, { env, stdio: ["ignore", "inherit", "inherit"] });
      } catch (err) {
        resolve({ error: `cannot start ${bin}: ${err.message}` });
        return;
      }
      child.once("error", (err) => resolve({ error: `cannot run ${bin}: ${err.message}` }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.error) return { ok: false, reason: result.error };
    if (result.code !== 0) {
      return { ok: false, reason: `${bin} ended with ${result.signal ? `signal ${result.signal}` : `status ${result.code}`}` };
    }
    let report = {};
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      // a run without a report is still a run; the diagnostics are just missing
    }
    const files = listTypemaps(staging);
    for (const rel of files) {
      const dest = join(output, rel);
      mkdirSync(dirname(dest), { recursive: true });
      renameSync(join(staging, rel), dest);
      onFile(rel, dest);
    }
    return { ok: true, files, report };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Append one record to astgen_manifest.jsonl (never a .json name). */
export function writeManifestRecord(output, record) {
  const file = join(output, MANIFEST_FILENAME);
  if (!file.endsWith(".jsonl")) throw new Error("the manifest must be a .jsonl file");
  mkdirSync(output, { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/** The manifest record for a type phase. */
export function typesRecord({ engine, requested, fallbackReason, bin, report, files, version }) {
  const r = { kind: "types", engine, requested, astgen_version: version };
  if (fallbackReason) r.fallback_reason = fallbackReason;
  if (engine === "native") {
    r.binary = bin;
    r.typemap_files = files;
    r.typescript = report?.typescript;
    r.workers = report?.workers;
    r.config = report?.config;
    r.types_given_up = report?.gaveUpTypes ?? 0;
    r.program_rebuilds = report?.programRebuilds ?? 0;
    r.diagnostics = report?.diagnostics ?? [];
    r.warnings = report?.warnings ?? [];
  }
  return r;
}

export { mkdtempSync, writeFileSync };
