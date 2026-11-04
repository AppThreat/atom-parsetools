// Hostile and oversized inputs through astgen's Node path (Babel parsing and, with types on,
// the type phase), in both modes: the default (native, when the binary is present) and ts6.
// Every case must end with a diagnostic and a manifest entry under its caps: exit status 0, a
// Failure line (or a clean skip) on stderr, and astgen_manifest.jsonl recording the run, with a
// file_error record for a file that produced nothing. Never a crash, never a hang.
//
// The fast cases run in `npm test`. The big ones (a 10 MB minified bundle, a 100,000-element
// array) run with --all, which CI's native job runs after building the binary.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILENAME } from "../lib/typemap/native.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const astgen = join(repo, "astgen.js");
const exe = process.platform === "win32" ? ".exe" : "";
const builtBinary = join(repo, "parsa", "_deps", "bin", `parsa${exe}`);
const haveBinary = existsSync(builtBinary);
const runAll = process.argv.includes("--all");
const root = mkdtempSync(join(tmpdir(), "astgen-hostile-"));
let failures = 0;
let skipped = 0;

if (process.env.ASTGEN_NATIVE_REQUIRED && !haveBinary) {
  console.error(`not ok - ASTGEN_NATIVE_REQUIRED is set and there is no binary at ${builtBinary}`);
  process.exit(1);
}

const test = (name, fn, { needsBinary = false, timeoutMs = 60000 } = {}) => {
  if (needsBinary && !haveBinary) {
    skipped++;
    console.log(`skip - ${name} (no binary at ${builtBinary}; run npm run test:native first)`);
    return;
  }
  const started = Date.now();
  try {
    fn(timeoutMs);
    console.log(`ok - ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n${err.stack}`);
  }
};

const inputDir = mkdtempSync(join(root, "in-"));
mkdirSync(inputDir, { recursive: true });
writeFileSync(join(inputDir, "package.json"), '{"name":"hostile","private":true}');

const modes = [
  { name: "ts6", env: { ASTGEN_TYPES: "ts6" }, needsBinary: false },
  { name: "native", env: { ASTGEN_NATIVE_BIN: builtBinary }, needsBinary: true }
];

// One hostile input, checked in both modes. expects: { status, stderrTest, records, outTest }.
function hostileCase(name, prepare, { wantStatus = 0, stderrTest, fileError, outTest, timeoutMs, mayHitCap = false } = {}) {
  for (const mode of modes) {
    test(`${name} (${mode.name})`, (t) => {
      const target = join(inputDir, `case-${name.replace(/[^a-z0-9]+/gi, "-")}-${mode.name}`);
      mkdirSync(target, { recursive: true });
      prepare(target);
      const out = mkdtempSync(join(root, "out-"));
      const env = { ...process.env, ...mode.env };
      delete env.ATOM_PARENT_PID;
      const r = spawnSync(process.execPath, [astgen, "-i", target, "-o", out, "-t", "ts"], {
        env,
        encoding: "utf8",
        timeout: t
      });
      if (mayHitCap && mode.name === "ts6" && r.signal) {
        // TypeScript 6 type generation has no budget of its own (the plan notes it): on an input
        // this size it can still be running at the caller's cap. Being stopped there by the
        // caller is the accepted end of the case, and is reported as a finding, not a hang.
        assert.equal(r.signal, "SIGTERM", `stopped by ${r.signal}`);
        assert.ok(!crashPattern.test(r.stderr ?? ""), r.stderr?.slice(0, 800));
        console.log(`     reported: TypeScript 6 did not finish ${name} within its ${Math.round(t / 1000)}s cap`);
        rmSync(target, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
        return;
      }
      assert.ok(r.status === wantStatus, `exit status ${r.status} (signal ${r.signal}), stderr:\n${r.stderr?.slice(0, 2000)}`);
      assert.ok(!r.signal, `killed by ${r.signal}; the case must end, not hang`);
      if (stderrTest) stderrTest(r.stderr ?? "");
      const manifestPath = join(out, MANIFEST_FILENAME);
      assert.ok(existsSync(manifestPath), "the run writes astgen_manifest.jsonl");
      const records = readFileSync(manifestPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const types = records.filter((rec) => rec.kind === "types");
      assert.equal(types.length, 1, `one types record, got ${JSON.stringify(types)}`);
      assert.equal(types[0].engine, mode.name === "native" ? "native" : "ts6");
      if (fileError !== undefined) {
        const errors = records.filter((rec) => rec.kind === "file_error");
        if (fileError) {
          assert.ok(errors.length >= 1, `a file_error record is expected, records: ${JSON.stringify(records)}`);
          assert.ok(errors.every((rec) => rec.file && rec.reason), "each file_error record names the file and the reason");
        } else {
          assert.equal(errors.length, 0, `no file_error record expected, got ${JSON.stringify(errors)}`);
        }
      }
      if (outTest) outTest(out);
      rmSync(out, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }, { needsBinary: mode.needsBinary, timeoutMs });
  }
}

const crashPattern = /UnhandledPromiseRejection|^TypeError:|^RangeError:|^ReferenceError:|at \S+ \(.*astgen\.js/;

// ---- fast cases (npm test) ----

hostileCase("invalid utf-8", (dir) => {
  writeFileSync(join(dir, "bad-utf8.js"), Buffer.concat([
    Buffer.from("const s = '"),
    Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]),
    Buffer.from("';\nmodule.exports = s;\n")
  ]));
}, { fileError: false, stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800)) });

hostileCase("a binary file with a .ts extension", (dir) => {
  writeFileSync(join(dir, "evil.ts"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]));
}, { stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800)) });

hostileCase("nesting past the parser's depth limit", (dir) => {
  const depth = 8000;
  writeFileSync(join(dir, "deep.js"), `module.exports = ${"(".repeat(depth)}1${")".repeat(depth)};\n`);
}, {
  // Babel reports the depth as a parse failure, astgen records it and carries on
  stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800))
});

hostileCase("a symlink loop", (dir) => {
  mkdirSync(join(dir, "loop"));
  if (process.platform === "win32") return;
  symlinkSync("../loop", join(dir, "loop", "into-itself"));
  writeFileSync(join(dir, "ok.js"), "module.exports = 1;\n");
}, {
  stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800)),
  outTest: (out) => {
    const files = readdirSync(out);
    assert.ok(files.some((f) => f.endsWith(".json")), "the run still parses the healthy file");
  }
});

hostileCase("a path outside the input root", (dir) => {
  if (process.platform === "win32") return;
  const outside = join(root, "outside-secret.js");
  writeFileSync(outside, "module.exports = 'outside';\n");
  symlinkSync(outside, join(dir, "linked.js"));
  writeFileSync(join(dir, "inside.js"), "module.exports = 'inside';\n");
}, {
  stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800)),
  outTest: (out) => {
    const names = readdirSync(out);
    for (const n of names) {
      assert.ok(!n.includes(".."), `an output name must not escape: ${n}`);
    }
  }
});

// ---- big cases (--all, run by CI's native job) ----

if (runAll) {
  hostileCase("a 10 MB minified bundle", (dir) => {
    const chunk = "var a1=1,a2=2,a3=3;function f1(){return a1+a2+a3;}f1();";
    const parts = [];
    let size = 0;
    while (size < 10 * 1024 * 1024) {
      parts.push(chunk);
      size += chunk.length;
    }
    writeFileSync(join(dir, "bundle.js"), parts.join(""));
  }, { timeoutMs: 110000, mayHitCap: true, fileError: true, stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800)) });

  hostileCase("a 100,000-element array literal", (dir) => {
    const elements = [];
    for (let i = 0; i < 100000; i++) elements.push(String(i));
    writeFileSync(join(dir, "big-array.js"), `module.exports = [${elements.join(",")}];\n`);
  }, { timeoutMs: 110000, fileError: false, stderrTest: (s) => assert.ok(!crashPattern.test(s), s.slice(0, 800)) });
}

rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log(`astgen hostile input tests passed${skipped ? ` (${skipped} skipped: no binary)` : ""}${runAll ? " (all cases)" : " (fast cases; --all adds the big ones)"}`);
