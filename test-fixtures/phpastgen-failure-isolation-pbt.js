import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "./pbt.mjs";
import {
  runBatch,
  resolvePhpParseBin,
  MANIFEST_FILENAME,
  DIAGNOSTICS_FILENAME
} from "../phpastgen.js";

// Property-based tests for phpastgen per-file failure isolation (design §2.3/§2.4, §2.11,
// Requirement 2.4).
//
// Property 3 (P3): Failure isolation.
//   FOR ALL directory trees mixing parseable and unparseable PHP files, a batch run WITHOUT
//   `--fail-on-error`:
//     1. exits with code 0 (a per-file failure never aborts the run),
//     2. produces exactly one AST `*.json` output for every good file (all good work survives),
//     3. records exactly one diagnostic per bad file (`diagnostics.length == files_failed`), and
//     4. reports `files_parsed == good count` and `files_failed == bad count` in the manifest.
//
// The batch is exercised end to end through the real `php-parse` binary — no mocks — so isolation
// is validated against actual parser behavior rather than a stub. Broken snippets are drawn from a
// pool pre-verified to fail parsing even under nikic's error recovery; valid snippets are drawn
// from a pool pre-verified to parse cleanly.
//
// **Validates: Requirement 2.4** — Property: P3

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Environment gate (mirrors the skip pattern in phpastgen-legacy-regression.js): the batch cannot
// run without a PHP runtime and the vendored php-parse binary.
// ---------------------------------------------------------------------------
function hasPhp() {
  const result = spawnSync(process.env.PHP_CMD || "php", ["--version"], {
    encoding: "utf-8"
  });
  return result.status === 0;
}

const phpParseBin = resolvePhpParseBin();

if (!hasPhp()) {
  console.log(
    "SKIP phpastgen-failure-isolation-pbt: PHP runtime not found on PATH"
  );
  process.exit(0);
}
if (!existsSync(phpParseBin)) {
  console.log(
    `SKIP phpastgen-failure-isolation-pbt: vendored php-parse binary not found at ${phpParseBin} (run composer install under plugins/)`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Snippet pools. Every entry was verified against the real parseOneFile: GOOD snippets parse
// cleanly; BAD snippets fail even under error recovery (they never yield an AST). Keeping the pool
// fixed makes the property deterministic despite the randomized file mix.
// ---------------------------------------------------------------------------
const GOOD_SNIPPETS = [
  "<?php echo 1;",
  "<?php $x = 1 + 2; echo $x;",
  "<?php function f(int $a): int { return $a * 2; }",
  "<?php class C { public int $n = 0; public function m(): void {} }",
  "<?php namespace App; interface I { public function go(): string; }",
  "<?php $arr = [1, 2, 3]; foreach ($arr as $v) { echo $v; }",
  "<?php if (true) { echo 'a'; } else { echo 'b'; }"
];

const BAD_SNIPPETS = [
  "<?php function {{{ ??? >>> ",
  "<?php class {{{{ ",
  "<?php function f() { return 1;",
  "<?php class C { public function m( { ",
  "<?php function () use ( { return; ",
  "<?php $a = [1, 2, ;",
  "<?php namespace { class ",
  "<?php switch ($x { case: ",
  "<?php interface I extends { public function "
];

// A file spec: whether it is a good/bad PHP file and which snippet to use.
const fileArb = fc.oneof(
  fc.record({
    kind: fc.constant("good"),
    idx: fc.nat({ max: GOOD_SNIPPETS.length - 1 })
  }),
  fc.record({
    kind: fc.constant("bad"),
    idx: fc.nat({ max: BAD_SNIPPETS.length - 1 })
  })
);

// A directory tree: at least one file, with at least one BAD file guaranteed (the property is
// specifically about a dir with >= 1 unparseable file). We generate a list then force a bad file
// in if none was produced, so the "mix" always contains a failure to isolate.
const treeArb = fc
  .array(fileArb, { minLength: 1, maxLength: 8 })
  .map((files) => {
    if (!files.some((f) => f.kind === "bad")) {
      files.push({ kind: "bad", idx: 0 });
    }
    return files;
  });

// ---------------------------------------------------------------------------
// Materialize a tree of files into a fresh temp input dir. File names avoid the default exclude
// regex (^(tests?|vendor|Tests?)) and land flat under the input root, so each good file maps to a
// single `<name>.php.json` output and each file is discovered as recognized PHP.
// ---------------------------------------------------------------------------
function materialize(files) {
  const inputDir = mkdtempSync(join(tmpdir(), "phpastgen-iso-in-"));
  let good = 0;
  let bad = 0;
  files.forEach((f, i) => {
    const src =
      f.kind === "good" ? GOOD_SNIPPETS[f.idx] : BAD_SNIPPETS[f.idx];
    // "src<i>.php" — leading "src" is not matched by the default exclude regex.
    writeFileSync(join(inputDir, `src${i}.php`), src);
    if (f.kind === "good") {
      good += 1;
    } else {
      bad += 1;
    }
  });
  return { inputDir, good, bad };
}

// Count the produced AST files: every `*.json` under the output dir that is NOT a `.jsonl`
// side-record. Files are flat, so a simple readdir suffices for this fixture.
function countAstOutputs(outputDir) {
  return readdirSync(outputDir).filter(
    (name) => name.endsWith(".json") && !name.endsWith(".jsonl")
  ).length;
}

function readManifest(outputDir) {
  const raw = readFileSync(join(outputDir, MANIFEST_FILENAME), "utf-8").trim();
  return JSON.parse(raw);
}

function readDiagnostics(outputDir) {
  const path = join(outputDir, DIAGNOSTICS_FILENAME);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// P3 — Failure isolation over a randomized mix of good and bad files.
// ---------------------------------------------------------------------------
await fc.assert(
  fc.asyncProperty(treeArb, async (files) => {
    const { inputDir, good, bad } = materialize(files);
    const outputDir = mkdtempSync(join(tmpdir(), "phpastgen-iso-out-"));
    try {
      const exitCode = await runBatch({
        input: inputDir,
        output: outputDir,
        threads: 4
      });

      // 1. A per-file failure never aborts the run: exit 0 without --fail-on-error.
      assert.equal(
        exitCode,
        0,
        "batch without --fail-on-error must exit 0 despite failing files"
      );

      const manifest = readManifest(outputDir);
      const diagnostics = readDiagnostics(outputDir);
      const astOutputs = countAstOutputs(outputDir);

      // 2. Every good file yields exactly one AST output.
      assert.equal(
        astOutputs,
        good,
        `expected ${good} AST outputs for the good files, saw ${astOutputs}`
      );

      // 3. Counts match the actual mix.
      assert.equal(
        manifest.files_parsed,
        good,
        `files_parsed ${manifest.files_parsed} must equal good count ${good}`
      );
      assert.equal(
        manifest.files_failed,
        bad,
        `files_failed ${manifest.files_failed} must equal bad count ${bad}`
      );

      // 4. Exactly one diagnostic per failed file.
      assert.ok(
        manifest.files_failed >= 1,
        "the guaranteed bad file must produce at least one failure"
      );
      assert.equal(
        diagnostics.length,
        manifest.files_failed,
        `diagnostics count ${diagnostics.length} must equal files_failed ${manifest.files_failed}`
      );

      // Each diagnostic names a distinct failed file and carries a parse_error.
      const failedFiles = new Set();
      for (const diag of diagnostics) {
        assert.equal(
          typeof diag.file_path,
          "string",
          "each diagnostic records the failing file path"
        );
        assert.ok(
          diag.parse_error && typeof diag.parse_error === "object",
          "each diagnostic carries a parse_error object"
        );
        failedFiles.add(diag.file_path);
      }
      assert.equal(
        failedFiles.size,
        diagnostics.length,
        "diagnostics must name distinct failed files (one per bad file)"
      );
    } finally {
      rmSync(inputDir, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  }),
  // php-parse is spawned per file per run; keep the run count modest so the suite stays bounded
  // while still exercising many good/bad mixes.
  { numRuns: 25 }
);
console.log(
  "ok P3 failure isolation: good files all produce AST, one diagnostic per bad file, run exits 0"
);

// ---------------------------------------------------------------------------
// P3 concrete anchors — pin the boundary regimes the property samples over.
// ---------------------------------------------------------------------------

// All-bad directory: no AST outputs, exit 0, diagnostics == files_failed == file count.
{
  const { inputDir, good, bad } = materialize([
    { kind: "bad", idx: 0 },
    { kind: "bad", idx: 2 }
  ]);
  const outputDir = mkdtempSync(join(tmpdir(), "phpastgen-iso-out-"));
  try {
    const exitCode = await runBatch({ input: inputDir, output: outputDir });
    assert.equal(exitCode, 0, "all-bad run without --fail-on-error exits 0");
    const manifest = readManifest(outputDir);
    const diagnostics = readDiagnostics(outputDir);
    assert.equal(countAstOutputs(outputDir), 0, "no AST outputs for an all-bad dir");
    assert.equal(good, 0);
    assert.equal(manifest.files_parsed, 0, "no files parsed");
    assert.equal(manifest.files_failed, bad, "every file counted as failed");
    assert.equal(
      diagnostics.length,
      manifest.files_failed,
      "one diagnostic per failed file in the all-bad dir"
    );
    console.log("ok P3 concrete: all-bad dir isolates every failure, exit 0");
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
}

// Mixed directory with a single bad file among several good ones: good work all survives, exactly
// one diagnostic.
{
  const { inputDir, good, bad } = materialize([
    { kind: "good", idx: 0 },
    { kind: "good", idx: 2 },
    { kind: "good", idx: 3 },
    { kind: "bad", idx: 1 }
  ]);
  const outputDir = mkdtempSync(join(tmpdir(), "phpastgen-iso-out-"));
  try {
    const exitCode = await runBatch({ input: inputDir, output: outputDir });
    assert.equal(exitCode, 0, "mixed run without --fail-on-error exits 0");
    const manifest = readManifest(outputDir);
    const diagnostics = readDiagnostics(outputDir);
    assert.equal(
      countAstOutputs(outputDir),
      good,
      "every good file produced an AST output"
    );
    assert.equal(manifest.files_parsed, good, "files_parsed equals good count");
    assert.equal(manifest.files_failed, bad, "files_failed equals bad count");
    assert.equal(bad, 1, "exactly one bad file in this fixture");
    assert.equal(
      diagnostics.length,
      1,
      "exactly one diagnostic for the single bad file"
    );
    console.log(
      "ok P3 concrete: single bad file isolated, all good files survive"
    );
  } finally {
    rmSync(inputDir, { recursive: true, force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }
}

console.log("phpastgen-failure-isolation-pbt: all checks passed");
