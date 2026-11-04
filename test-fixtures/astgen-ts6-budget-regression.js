// The budgets of astgen's TypeScript 6 type phase. The checker cannot be cancelled from inside the
// flow analysis that grows exponentially on an untyped array reassigned in many `if` blocks
// (cdxgen's scanOnePathInner), nor while it builds the checker for a bundle that redeclares the
// same names, so the phase runs in a worker thread that astgen stops past a budget. Each case must
// end well inside its spawn timeout: a budget that does not stop the worker shows up as a timeout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILENAME } from "../lib/typemap/native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const astgen = join(dirname(here), "astgen.js");
const root = mkdtempSync(join(tmpdir(), "astgen-ts6-budget-"));
let failures = 0;

const test = (name, fn) => {
  const started = Date.now();
  try {
    fn();
    console.log(`ok - ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n${err.stack}`);
  }
};

// cdxgen's shape: `let components = [];` reassigned with concat in `blocks` sequential `if` blocks.
// TypeScript 6 takes about 12 s to type it with 20 blocks.
const evolvingArray = (blocks) => {
  const lines = ["function scan(opts) {", "  let components = [];"];
  for (let i = 0; i < blocks; i++) {
    lines.push(`  if (opts.t${i}) {`, `    components = components.concat(load${i}(opts));`, "  }");
  }
  lines.push("  return components;", "}");
  for (let i = 0; i < blocks; i++) lines.push(`function load${i}(o) { return [{ name: "c${i}", o }]; }`);
  lines.push("module.exports = { scan };");
  return `${lines.join("\n")}\n`;
};

const SMALL = "const add = (a, b) => a + b;\nmodule.exports = { add };\n";

const run = (files, env) => {
  const dir = mkdtempSync(join(root, "in-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const out = join(dir, "..", `${dir.split(/[\\/]/).pop()}-out`);
  mkdirSync(out, { recursive: true });
  const r = spawnSync(process.execPath, [astgen, "-t", "js", "-o", out], {
    cwd: dir,
    env: { ...process.env, ASTGEN_TYPES: "ts6", ...env },
    encoding: "utf8",
    timeout: 60000
  });
  assert.ok(!r.signal, `astgen was stopped by ${r.signal}: a budget did not end the type phase`);
  assert.equal(r.status, 0, r.stderr?.slice(0, 1500));
  const manifest = join(out, MANIFEST_FILENAME);
  const records = existsSync(manifest)
    ? readFileSync(manifest, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  return { out, stderr: r.stderr ?? "", budgets: records.filter((x) => x.kind === "type_budget"), records };
};

test("a file past the per-file budget keeps its AST, gets no types, and the files after it are typed", () => {
  // z-after.js sorts after scan.js, so it is typed by the worker that replaces the stopped one
  const r = run({ "scan.js": evolvingArray(20), "z-after.js": SMALL }, { ASTGEN_TYPE_FILE_TIMEOUT_MS: "1500" });
  assert.ok(existsSync(join(r.out, "scan.js.json")), "the AST is written before the types");
  assert.ok(!existsSync(join(r.out, "scan.js.typemap")), "no type map for the file that ran over");
  assert.ok(existsSync(join(r.out, "z-after.js.typemap")), "the next file is typed by a new worker");
  assert.deepEqual(r.budgets, [{ kind: "type_budget", engine: "ts6", reason: "file-wall-time", file: "scan.js", limit_ms: 1500 }]);
  assert.match(r.stderr, /typing scan\.js took longer than 1500 ms/);
});

test("a program not built within its budget leaves every AST and no types", () => {
  // the checker set-up grows faster than quadratically with redeclared names: about 11 s at 2 MB
  const chunk = "var a1=1,a2=2,a3=3;function f1(){return a1+a2+a3;}f1();";
  const bundle = chunk.repeat(Math.ceil((2 * 1024 * 1024) / chunk.length));
  const r = run({ "bundle.js": bundle, "small.js": SMALL }, { ASTGEN_TYPE_PROGRAM_TIMEOUT_MS: "1000" });
  assert.ok(existsSync(join(r.out, "bundle.js.json")) && existsSync(join(r.out, "small.js.json")), "every AST is written");
  assert.ok(!existsSync(join(r.out, "small.js.typemap")), "no types without a program");
  const vue = run({ "c.vue": "<script setup lang=\"ts\">\nconst n: number = 1;\n</script>\n<template><p>{{ n }}</p></template>\n", "bundle.js": bundle }, { ASTGEN_TYPE_PROGRAM_TIMEOUT_MS: "1000" });
  assert.ok(!existsSync(join(vue.out, "c.vue.typemap")), "a .vue file is not typed on its own once the program is given up");
  assert.deepEqual(r.budgets, [{ kind: "type_budget", engine: "ts6", reason: "program-wall-time", limit_ms: 1000, files: 2 }]);
  assert.match(r.stderr, /program was not built within 1000 ms/);
});

test("a run inside its budgets types every file and records no budget", () => {
  const r = run({ "a.js": SMALL, "b.js": SMALL }, { ASTGEN_TYPE_FILE_TIMEOUT_MS: "not a number" });
  assert.ok(existsSync(join(r.out, "a.js.typemap")) && existsSync(join(r.out, "b.js.typemap")));
  assert.deepEqual(r.budgets, []);
  const types = r.records.filter((x) => x.kind === "types");
  assert.equal(types.length, 1);
  assert.equal(types[0].engine, "ts6");
});

test("the budgets hold with sharded type workers too", () => {
  const r = run({ "scan.js": evolvingArray(20), "z-after.js": SMALL, "y.js": SMALL }, { ASTGEN_TYPE_FILE_TIMEOUT_MS: "1500", ASTGEN_TYPE_WORKERS: "2" });
  assert.ok(!existsSync(join(r.out, "scan.js.typemap")));
  assert.ok(existsSync(join(r.out, "z-after.js.typemap")) && existsSync(join(r.out, "y.js.typemap")));
  assert.equal(r.budgets.length, 1);
  assert.equal(r.budgets[0].file, "scan.js");
});

rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("astgen TypeScript 6 budget tests passed");
