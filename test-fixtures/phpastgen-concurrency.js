// phpastgen batch concurrency regression (design §2.1 threading; review finding A-H1).
//
// What this pins:
//   1. `--threads` genuinely bounds CONCURRENT `php php-parse` subprocesses. Before the async
//      conversion, `parseOneFile` used blocking `spawnSync`, so every pool runner occupied the
//      single Node thread for a whole parse and files were parsed strictly one at a time — the
//      observed peak concurrency was 1 no matter what `--threads` said.
//   2. `--threads N` is an UPPER bound, never exceeded (threads=3 over 6 files never holds 4
//      children).
//   3. `--threads 1` is exactly serial (peak concurrency 1).
//   4. The run-invariant PHP version probe (`php -r 'echo PHP_VERSION;'`) happens ONCE per batch,
//      not once per file (review finding A-M1).
//   5. Concurrency does not change what is emitted: the serial and parallel runs produce
//      byte-identical AST outputs.
//
// How concurrency is proven — a live-counter, not a stopwatch. `PHP_CMD` points at a POSIX shell
// stub that stands in for the real `php` binary. On each parse invocation the stub registers itself
// as "live" (a file named after its pid in a shared dir), samples the number of live siblings
// repeatedly over ~300ms keeping the maximum, deregisters, then prints a minimal valid nikic JSON
// AST (`[]`). The test reads back every stub's observed maximum and takes the peak. Peak > 1 is
// direct evidence that N php processes were resident simultaneously; peak <= N is direct evidence
// the pool respects its bound. Repeated sampling over the whole 300ms window (rather than one
// sample at startup, or a wall-clock comparison) is what keeps this non-flaky on a loaded machine.
//
// A wall-clock comparison is still reported, and asserted only with a very generous margin as a
// secondary signal: 6 files x ~300ms serially cannot come close to the parallel run's ~300ms.
//
// No PHP runtime and no vendored php-parse binary are needed: the stub replaces both. The suite
// skips on Windows, where the POSIX shell stub does not apply.

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBatch, MANIFEST_FILENAME } from "../phpastgen.js";

if (process.platform === "win32") {
  console.log(
    "SKIP phpastgen-concurrency: the POSIX shell stub used to observe concurrency is not available on Windows"
  );
  process.exit(0);
}

// Number of PHP files in the fixture tree. Small enough to keep the serial run quick, large enough
// that a bounded pool of 3 is visibly a bound.
const FILE_COUNT = 6;

// How long each stub parse "takes". Long enough that overlap is unambiguous, short enough that the
// serial run (FILE_COUNT * PARSE_MS) stays around two seconds.
const PARSE_MS = 300;

const root = mkdtempSync(join(tmpdir(), "phpastgen-conc-"));
const inputDir = join(root, "input");
const liveDir = join(root, "live");
const obsDir = join(root, "obs");
const probeDir = join(root, "probes");
const stubPath = join(root, "php-stub.sh");

// ---------------------------------------------------------------------------
// The stub `php`. Two modes, matching the two ways phpastgen invokes PHP:
//   `php -r 'echo PHP_VERSION;'`      -> record a version probe, print a fixed version
//   `php <php-parse-bin> ... <file>`  -> register live, sample peak liveness, print a JSON AST
// ---------------------------------------------------------------------------
const STUB = `#!/bin/sh
if [ "$1" = "-r" ]; then
  : > "$PHPASTGEN_STUB_PROBES/$$"
  printf '8.5.8'
  exit 0
fi

: > "$PHPASTGEN_STUB_LIVE/$$"
peak=0
i=0
while [ "$i" -lt 6 ]; do
  n=$(ls "$PHPASTGEN_STUB_LIVE" | wc -l | tr -d ' ')
  if [ "$n" -gt "$peak" ]; then
    peak="$n"
  fi
  sleep 0.05
  i=$((i + 1))
done
printf '%s\\n' "$peak" > "$PHPASTGEN_STUB_OBS/$$"
rm -f "$PHPASTGEN_STUB_LIVE/$$"
printf '%s' '[]'
`;

function setup() {
  mkdirSync(inputDir, { recursive: true });
  writeFileSync(stubPath, STUB, "utf-8");
  chmodSync(stubPath, 0o755);
  for (let i = 0; i < FILE_COUNT; i++) {
    // "src<i>.php" is not matched by the default exclude regex.
    writeFileSync(join(inputDir, `src${i}.php`), `<?php echo ${i};\n`, "utf-8");
  }
}

function resetObservations() {
  for (const dir of [liveDir, obsDir, probeDir]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
}

function peakConcurrency() {
  const observations = readdirSync(obsDir).map((name) =>
    Number.parseInt(readFileSync(join(obsDir, name), "utf-8").trim(), 10)
  );
  assert.equal(
    observations.length,
    FILE_COUNT,
    `expected one liveness observation per parsed file, saw ${observations.length}`
  );
  return Math.max(...observations);
}

function astOutputs(outputDir) {
  const out = new Map();
  for (const name of readdirSync(outputDir)) {
    if (name.endsWith(".json") && !name.endsWith(".jsonl")) {
      out.set(name, readFileSync(join(outputDir, name), "utf-8"));
    }
  }
  return out;
}

// Run one batch through the stub and report what the stub observed.
async function runWithThreads(threads) {
  const outputDir = join(root, `out-${threads}`);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  resetObservations();

  process.env.PHP_CMD = stubPath;
  process.env.PHPASTGEN_STUB_LIVE = liveDir;
  process.env.PHPASTGEN_STUB_OBS = obsDir;
  process.env.PHPASTGEN_STUB_PROBES = probeDir;

  const started = Date.now();
  const exitCode = await runBatch({
    input: inputDir,
    output: outputDir,
    threads
  });
  const elapsedMs = Date.now() - started;

  const manifest = JSON.parse(
    readFileSync(join(outputDir, MANIFEST_FILENAME), "utf-8").trim()
  );

  return {
    exitCode,
    elapsedMs,
    manifest,
    peak: peakConcurrency(),
    versionProbes: readdirSync(probeDir).length,
    outputs: astOutputs(outputDir)
  };
}

setup();

try {
  // -------------------------------------------------------------------------
  // --threads 1: a pool of one is strictly serial.
  // -------------------------------------------------------------------------
  const serial = await runWithThreads(1);
  assert.equal(serial.exitCode, 0, "serial run exits 0");
  assert.equal(
    serial.manifest.files_parsed,
    FILE_COUNT,
    "serial run parses every file"
  );
  assert.equal(
    serial.peak,
    1,
    `--threads 1 must never hold more than one php-parse child at a time (peak ${serial.peak})`
  );
  console.log(
    `ok --threads 1 is serial: peak concurrency ${serial.peak}, ${serial.elapsedMs}ms`
  );

  // -------------------------------------------------------------------------
  // --threads 6 over 6 files: parses genuinely overlap.
  // -------------------------------------------------------------------------
  const parallel = await runWithThreads(FILE_COUNT);
  assert.equal(parallel.exitCode, 0, "parallel run exits 0");
  assert.equal(
    parallel.manifest.files_parsed,
    FILE_COUNT,
    "parallel run parses every file"
  );
  assert.ok(
    parallel.peak > 1,
    `--threads ${FILE_COUNT} must run php-parse children concurrently, but peak concurrency was ${parallel.peak} (batch is still serial)`
  );
  assert.ok(
    parallel.peak <= FILE_COUNT,
    `peak concurrency ${parallel.peak} must not exceed --threads ${FILE_COUNT}`
  );
  console.log(
    `ok --threads ${FILE_COUNT} overlaps: peak concurrency ${parallel.peak}, ${parallel.elapsedMs}ms`
  );

  // Secondary, deliberately loose wall-clock signal: FILE_COUNT sequential ~300ms parses cannot
  // finish anywhere near as fast as one overlapped batch. The margin is generous so a loaded
  // machine cannot flip the result; the peak-concurrency assertions above are the real proof.
  assert.ok(
    parallel.elapsedMs < serial.elapsedMs * 0.6,
    `parallel run (${parallel.elapsedMs}ms) should be well under 60% of the serial run (${serial.elapsedMs}ms)`
  );
  console.log(
    `ok wall clock reflects the overlap: ${parallel.elapsedMs}ms vs ${serial.elapsedMs}ms serial`
  );

  // -------------------------------------------------------------------------
  // --threads 3 over 6 files: the pool is a real upper bound, not just a hint.
  // -------------------------------------------------------------------------
  const bounded = await runWithThreads(3);
  assert.equal(bounded.exitCode, 0, "bounded run exits 0");
  assert.equal(
    bounded.manifest.files_parsed,
    FILE_COUNT,
    "bounded run parses every file"
  );
  assert.ok(
    bounded.peak > 1,
    `--threads 3 must still overlap parses (peak ${bounded.peak})`
  );
  assert.ok(
    bounded.peak <= 3,
    `--threads 3 must never hold more than 3 php-parse children (peak ${bounded.peak})`
  );
  console.log(
    `ok --threads 3 bounds concurrency: peak concurrency ${bounded.peak} (<= 3), ${bounded.elapsedMs}ms`
  );

  // -------------------------------------------------------------------------
  // A-M1: the run-invariant PHP version is probed once per run, not once per file.
  // -------------------------------------------------------------------------
  for (const [label, run] of [
    ["serial", serial],
    ["parallel", parallel],
    ["bounded", bounded]
  ]) {
    assert.equal(
      run.versionProbes,
      1,
      `${label} run must probe the PHP version exactly once for the whole batch, saw ${run.versionProbes} probes for ${FILE_COUNT} files`
    );
  }
  console.log(
    "ok PHP version is detected once per run, not once per file (one `php -r` subprocess per batch)"
  );

  // -------------------------------------------------------------------------
  // Concurrency changes scheduling only: emitted ASTs are byte-identical.
  // -------------------------------------------------------------------------
  assert.deepEqual(
    [...parallel.outputs.keys()].sort(),
    [...serial.outputs.keys()].sort(),
    "the serial and parallel runs must emit the same AST files"
  );
  for (const [name, text] of serial.outputs) {
    assert.equal(
      parallel.outputs.get(name),
      text,
      `AST output ${name} must be byte-identical between the serial and parallel runs`
    );
  }
  assert.equal(
    serial.manifest.threads,
    1,
    "the manifest records the requested thread count"
  );
  assert.equal(parallel.manifest.threads, FILE_COUNT);
  console.log("ok serial and parallel runs emit byte-identical ASTs");

  // The stub's PHP version reaches provenance through the cached value.
  const sample = JSON.parse(serial.outputs.get("src0.php.json"));
  assert.equal(
    sample.php_version,
    "8.5.8",
    "the cached PHP version is what lands in per-file provenance"
  );
  assert.equal(
    serial.manifest.php_version,
    "8.5.8",
    "the manifest reuses the same cached PHP version"
  );
  assert.ok(
    !existsSync(join(root, "out-1", "phpastgen_diagnostics.jsonl")),
    "a clean run writes no diagnostics"
  );
  console.log("ok provenance and manifest share the once-detected PHP version");
} finally {
  delete process.env.PHP_CMD;
  delete process.env.PHPASTGEN_STUB_LIVE;
  delete process.env.PHPASTGEN_STUB_OBS;
  delete process.env.PHPASTGEN_STUB_PROBES;
  rmSync(root, { recursive: true, force: true });
}

console.log("phpastgen-concurrency: all checks passed");
