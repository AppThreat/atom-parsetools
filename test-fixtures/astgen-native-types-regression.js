// ASTGEN_TYPES=native: the sidecar, its lookup, its fallback, and that both engines see the same files.
// Needs the Go binary (native/_deps/bin/atom-parsetools-native, built by `npm run test:native`
// or `go build ./cmd/atom-parsetools-native` in native/); without it the tests that run it are
// skipped with a reason.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
  MANIFEST_FILENAME,
  findNativeBinary,
  nativeLimits,
  requestedEngine,
  runNativeTypes,
  typesRecord,
  writeManifestRecord
} from "../lib/typemap/native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const astgen = join(repo, "astgen.js");
const exe = process.platform === "win32" ? ".exe" : "";
const builtBinary = join(repo, "native", "_deps", "bin", `atom-parsetools-native${exe}`);
const haveBinary = existsSync(builtBinary);
const root = mkdtempSync(join(tmpdir(), "astgen-native-"));
let failures = 0;
let skipped = 0;

// CI's native job builds the binary first and sets ASTGEN_NATIVE_REQUIRED, so there a missing binary fails.
if (process.env.ASTGEN_NATIVE_REQUIRED && !haveBinary) {
  console.error(`not ok - ASTGEN_NATIVE_REQUIRED is set and there is no binary at ${builtBinary}`);
  process.exit(1);
}

const test = (name, fn, { needsBinary = false } = {}) => {
  if (needsBinary && !haveBinary) {
    skipped++;
    console.log(`skip - ${name} (no binary at ${builtBinary}; run npm run test:native first)`);
    return;
  }
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n${err.stack}`);
  }
};

// Run astgen over a project with a given environment; returns { status, stdout, stderr, out }.
function runAstgen(project, extraEnv = {}, args = []) {
  const out = mkdtempSync(join(root, "out-"));
  const env = { ...process.env, ...extraEnv };
  delete env.ATOM_PARENT_PID;
  const r = spawnSync(process.execPath, [astgen, "-i", project, "-o", out, "-t", "ts", ...args], {
    env,
    encoding: "utf8",
    timeout: 110000
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
}

function listFiles(dir, suffix) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!suffix || e.name.endsWith(suffix)) found.push(relative(dir, p).split("\\").join("/"));
    }
  };
  walk(dir);
  return found.sort();
}

const fixtureProjects = ["type-inference-regression", "inference-edge-cases", "simple-js", "typescript-parsing", "ignored-dirs", "vue-precision", "svelte-precision", "node-builtins"]
  .map((n) => join(here, "projects", n))
  .filter((p) => existsSync(p));

// ---- pure functions ----

test("requestedEngine: ts6 by default, native on request, unknown values warn and mean ts6", () => {
  assert.equal(requestedEngine({}), "ts6");
  assert.equal(requestedEngine({ ASTGEN_TYPES: "" }), "ts6");
  assert.equal(requestedEngine({ ASTGEN_TYPES: "ts6" }), "ts6");
  assert.equal(requestedEngine({ ASTGEN_TYPES: "NATIVE" }), "native");
  const warned = [];
  assert.equal(requestedEngine({ ASTGEN_TYPES: "tsgo" }, (m) => warned.push(m)), "ts6");
  assert.equal(warned.length, 1);
  assert.match(warned[0], /tsgo/);
});

test("findNativeBinary: ASTGEN_NATIVE_BIN, then next to astgen.js, then PATH", () => {
  const a = mkdtempSync(join(root, "bin-a-"));
  const b = mkdtempSync(join(root, "bin-b-"));
  const c = mkdtempSync(join(root, "bin-c-"));
  const name = `atom-parsetools-native${exe}`;
  const put = (d) => {
    writeFileSync(join(d, name), "x");
    return join(d, name);
  };
  const explicit = join(c, "mine");
  writeFileSync(explicit, "x");
  const onPath = put(b);
  const beside = put(a);
  const env = { PATH: [b].join(delimiter) };
  assert.equal(findNativeBinary({ env: { ...env, ASTGEN_NATIVE_BIN: explicit }, astgenDir: a }).path, explicit, "the variable wins");
  assert.equal(findNativeBinary({ env, astgenDir: a }).path, beside, "next to astgen.js before PATH");
  assert.equal(findNativeBinary({ env, astgenDir: join(root, "empty") }).path, onPath, "then PATH");
  const none = findNativeBinary({ env: { PATH: "" }, astgenDir: join(root, "empty") });
  assert.ok(none.error && !none.path);
  const bad = findNativeBinary({ env: { ASTGEN_NATIVE_BIN: join(c, "missing"), PATH: b }, astgenDir: a });
  assert.ok(bad.error, "an explicit variable that is not a file is an error, not a reason to look elsewhere");
});

test("the manifest is a .jsonl file and records the diagnostics", () => {
  assert.ok(MANIFEST_FILENAME.endsWith(".jsonl") && !MANIFEST_FILENAME.endsWith(".json"));
  const out = mkdtempSync(join(root, "man-"));
  const file = writeManifestRecord(out, typesRecord({
    engine: "native", requested: "native", bin: "/x", version: "4.5.2", files: 3,
    report: { typescript: "abc", workers: 2, gaveUpTypes: 4, diagnostics: [{ file: "a.js", reason: "file-work-limit" }], warnings: ["w"] }
  }));
  const rec = JSON.parse(readFileSync(file, "utf8").trim());
  assert.equal(rec.engine, "native");
  assert.equal(rec.types_given_up, 4);
  assert.deepEqual(rec.diagnostics, [{ file: "a.js", reason: "file-work-limit" }]);
  const fb = typesRecord({ engine: "ts6", requested: "native", fallbackReason: "no binary", version: "x" });
  assert.equal(fb.fallback_reason, "no binary");
  assert.equal(fb.diagnostics, undefined);
});

// ---- default behaviour ----

test("without ASTGEN_TYPES nothing changes: no manifest, no native run", () => {
  const project = join(here, "projects", "simple-js");
  const r = runAstgen(project, { ASTGEN_TYPES: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(r.out, MANIFEST_FILENAME)), "the default run must not write a manifest");
  assert.ok(listFiles(r.out, ".typemap").length > 0);
  rmSync(r.out, { recursive: true, force: true });
});

// ---- fallback ----

test("a missing binary warns once and the run still has TypeScript 6 types", () => {
  const project = join(here, "projects", "simple-js");
  const base = runAstgen(project, { ASTGEN_TYPES: "" });
  const r = runAstgen(project, { ASTGEN_TYPES: "native", ASTGEN_NATIVE_BIN: join(root, "does-not-exist"), PATH: "" });
  assert.equal(r.status, 0, r.stderr);
  const warnings = r.stderr.split("\n").filter((l) => /ASTGEN_TYPES=native/.test(l));
  assert.equal(warnings.length, 1, `one warning expected, got ${warnings.length}:\n${r.stderr}`);
  assert.match(warnings[0], /falling back to TypeScript 6/);
  assert.deepEqual(listFiles(r.out, ".typemap"), listFiles(base.out, ".typemap"));
  for (const f of listFiles(base.out, ".typemap")) {
    assert.equal(readFileSync(join(r.out, f), "utf8"), readFileSync(join(base.out, f), "utf8"), `${f} must equal the TypeScript 6 output`);
  }
  const rec = JSON.parse(readFileSync(join(r.out, MANIFEST_FILENAME), "utf8").trim().split("\n").pop());
  assert.equal(rec.engine, "ts6");
  assert.equal(rec.requested, "native");
  assert.match(rec.fallback_reason, /ASTGEN_NATIVE_BIN/);
  rmSync(r.out, { recursive: true, force: true });
  rmSync(base.out, { recursive: true, force: true });
});

test("a binary that fails leaves no partial type maps, warns once, and falls back", () => {
  if (process.platform === "win32") return;
  const project = join(here, "projects", "simple-js");
  const bad = join(mkdtempSync(join(root, "fail-")), "fake-native");
  // writes a type map into the staging directory it was given, then fails
  writeFileSync(bad, `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\nmkdir -p "$out"; echo '{"0":"half"}' > "$out/partial.js.typemap"\nexit 3\n`);
  chmodSync(bad, 0o755);
  const r = runAstgen(project, { ASTGEN_TYPES: "native", ASTGEN_NATIVE_BIN: bad });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.split("\n").filter((l) => /ASTGEN_TYPES=native/.test(l)).length, 1, r.stderr);
  assert.ok(!existsSync(join(r.out, "partial.js.typemap")), "output of the failed run must not stay");
  assert.ok(readdirSync(r.out).every((n) => !n.startsWith(".typemap-native-")), "the staging directory must be removed");
  assert.ok(listFiles(r.out, ".typemap").length > 0, "TypeScript 6 types are written instead");
  rmSync(r.out, { recursive: true, force: true });
});

test("a binary that does not finish within the shared timeout is stopped and astgen falls back", () => {
  if (process.platform === "win32") return;
  const project = join(here, "projects", "simple-js");
  const slow = join(mkdtempSync(join(root, "slow-")), "slow-native");
  writeFileSync(slow, "#!/bin/sh\nexec sleep 60\n");
  chmodSync(slow, 0o755);
  const started = Date.now();
  const r = runAstgen(project, { ASTGEN_TYPES: "native", ASTGEN_NATIVE_BIN: slow, ASTGEN_TIMEOUT: "1500" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 30000, "the binary must be stopped, not waited for");
  assert.match(r.stderr, /did not finish within 1500 ms; falling back/);
  assert.ok(listFiles(r.out, ".typemap").length > 0, "TypeScript 6 types are written instead");
  rmSync(r.out, { recursive: true, force: true });
});

test("nativeLimits: GOMEMLIMIT and the memory cap follow ASTGEN_NATIVE_MEMORY_MB; the caller's GOMEMLIMIT wins", () => {
  assert.equal(nativeLimits({}).env.GOMEMLIMIT, "6144MiB");
  assert.deepEqual(nativeLimits({}).args, []);
  const l = nativeLimits({ ASTGEN_NATIVE_MEMORY_MB: "2048", ASTGEN_TIMEOUT: "9000" });
  assert.equal(l.env.GOMEMLIMIT, "2048MiB");
  assert.deepEqual(l.args, ["--memory-mb", "2048"]);
  assert.equal(l.timeoutMs, 9000);
  assert.equal(nativeLimits({ GOMEMLIMIT: "1GiB" }).env.GOMEMLIMIT, "1GiB");
  assert.equal(nativeLimits({ ATOM_TIMEOUT: "100", ASTGEN_TIMEOUT: "200" }).timeoutMs, 100);
});

await (async () => {
  const name = "a type map that cannot be moved into place takes back what was moved and fails the phase";
  try {
    const output = mkdtempSync(join(root, "move-"));
    // b.js.typemap cannot replace a directory of the same name
    mkdirSync(join(output, "b.js.typemap", "x"), { recursive: true });
    const spawnImpl = (bin, args) => {
      const child = new EventEmitter();
      const staging = args[args.indexOf("-o") + 1];
      writeFileSync(join(staging, "a.js.typemap"), '{"0":"number"}');
      writeFileSync(join(staging, "b.js.typemap"), '{"0":"string"}');
      setImmediate(() => child.emit("exit", 0, null));
      return child;
    };
    const r = await runNativeTypes({ bin: "fake", src: here, output, env: {}, spawnImpl });
    assert.equal(r.ok, false);
    assert.match(r.reason, /cannot move the type maps/);
    assert.ok(!existsSync(join(output, "a.js.typemap")), "a type map moved before the failure must be taken back");
    assert.ok(readdirSync(output).every((n) => !n.startsWith(".typemap-native-")), "the staging directory must be removed");
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n${err.stack}`);
  }
})();

// ---- the native run ----

test("native types land in the same .typemap files and the manifest records the run", () => {
  const project = join(here, "projects", "type-inference-regression");
  const r = runAstgen(project, { ASTGEN_TYPES: "native", ASTGEN_NATIVE_BIN: builtBinary });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/falling back to TypeScript 6/.test(r.stderr), r.stderr);
  const base = runAstgen(project, { ASTGEN_TYPES: "" });
  assert.deepEqual(listFiles(r.out, ".json"), listFiles(base.out, ".json"), "the ASTs are Babel's either way");
  for (const f of listFiles(base.out, ".json")) {
    assert.equal(readFileSync(join(r.out, f), "utf8"), readFileSync(join(base.out, f), "utf8"), `${f}: the AST must not depend on ASTGEN_TYPES`);
  }
  assert.ok(listFiles(r.out, ".typemap").length > 0);
  assert.ok(readdirSync(r.out).every((n) => !n.startsWith(".typemap-native-")), "the staging directory must be removed");
  const rec = JSON.parse(readFileSync(join(r.out, MANIFEST_FILENAME), "utf8").trim().split("\n").pop());
  assert.equal(rec.engine, "native");
  assert.match(rec.typescript, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(rec.diagnostics));
  assert.ok(listFiles(r.out, ".json").every((f) => !f.endsWith("jsonl")), "no side record may end in .json");
  rmSync(r.out, { recursive: true, force: true });
  rmSync(base.out, { recursive: true, force: true });
}, { needsBinary: true });

// A .vue file goes through astgen's own virtual program when types are on, even without a project
// program. In native mode that path must stay off, or it would overwrite what the binary wrote.
test("astgen does not type single-file components itself in native mode", () => {
  const project = join(here, "projects", "vue-precision");
  const nat = runAstgen(project, { ASTGEN_TYPES: "native", ASTGEN_NATIVE_BIN: builtBinary });
  assert.equal(nat.status, 0, nat.stderr);
  // "Converted types for <file>[.typemap] to <path>": count each destination path once
  const lines = nat.stdout.split("\n").filter((l) => l.startsWith("Converted types for"));
  const seen = new Map();
  for (const l of lines) {
    const dest = l.slice(l.lastIndexOf(" to ") + 4);
    seen.set(dest, (seen.get(dest) ?? 0) + 1);
  }
  const twice = [...seen].filter(([, n]) => n > 1);
  assert.deepEqual(twice, [], `type maps written twice: ${JSON.stringify(twice)}`);
  assert.ok(listFiles(nat.out, ".typemap").some((f) => f.endsWith(".vue.typemap")), "the binary types .vue files");
  rmSync(nat.out, { recursive: true, force: true });
}, { needsBinary: true });

// ---- the file sets ----

const envCases = [
  {},
  { ASTGEN_INCLUDE_TEST_FILES: "true" },
  { ASTGEN_INCLUDE_MINIFIED: "true" },
  { ASTGEN_IGNORE_DIRS: "build,dist" },
  { ASTGEN_IGNORE_FILE_PATTERN: "\\.stories\\.(ts|tsx)$" }
];

for (const project of fixtureProjects) {
  for (const extra of envCases) {
    test(`file sets match on ${project.split("/").pop()} ${JSON.stringify(extra)}`, () => {
      // Every file astgen typed with TypeScript 6 that is a program file must have a native type map,
      // and the native binary must not type files astgen would not parse.
      const ts6 = runAstgen(project, { ASTGEN_TYPES: "ts6", ...extra });
      const nat = runAstgen(project, { ASTGEN_TYPES: "native", ASTGEN_NATIVE_BIN: builtBinary, ...extra });
      assert.equal(nat.status, 0, nat.stderr);
      assert.ok(!/falling back to TypeScript 6/.test(nat.stderr), nat.stderr);
      assert.deepEqual(listFiles(nat.out, ".json"), listFiles(ts6.out, ".json"), "AST file sets");
      const asts = new Set(listFiles(nat.out, ".json").map((f) => f.slice(0, -".json".length)));
      const natMaps = listFiles(nat.out, ".typemap").map((f) => f.slice(0, -".typemap".length));
      const ts6Maps = listFiles(ts6.out, ".typemap").map((f) => f.slice(0, -".typemap".length));
      for (const f of natMaps) assert.ok(asts.has(f), `native typed ${f}, which astgen did not parse`);
      const onlyTs6 = ts6Maps.filter((f) => !natMaps.includes(f));
      assert.deepEqual(onlyTs6, [], `files typed by TypeScript 6 and not by the binary: ${onlyTs6}`);
      rmSync(ts6.out, { recursive: true, force: true });
      rmSync(nat.out, { recursive: true, force: true });
    }, { needsBinary: true });
  }
}

rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log(`astgen native types tests passed${skipped ? ` (${skipped} skipped: no binary)` : ""}`);
