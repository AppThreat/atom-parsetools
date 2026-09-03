import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fc from "./pbt.mjs";
import { DIAGNOSTICS_FILENAME, writeDiagnostics } from "../phpastgen.js";

// Property-based tests for the clean-run stale-diagnostics-removal invariant
// (design §2.4, Requirement 2.7).
//
// Property 8 (P8): Clean run leaves no stale diagnostics.
//   After a run with `files_failed == 0`, `output/phpastgen_diagnostics.jsonl` does not exist.
//
// writeDiagnostics is the building block that owns the diagnostics side-record: a run with N
// failures writes exactly N JSONL lines; a clean run (empty diagnostics) writes nothing and removes
// any pre-existing diagnostics file, returning null. This test drives writeDiagnostics directly over
// arbitrary sequences of runs (some with failures, some clean) against the same output directory and
// asserts the file's presence/absence and line count track the final run, with special attention to
// the failures -> clean transition. No PHP runtime is required.
//
// **Validates: Requirement 2.7** — Property: P8

// A single generated diagnostic record shaped like buildDiagnostic output (design §2.4). Only the
// count of lines and round-trippability matter for this property, not the exact field values.
const diagnosticArb = fc.record({
  file_path: fc.string({ minLength: 1, maxLength: 40 }),
  rel_file_path: fc.string({ minLength: 1, maxLength: 40 }),
  parse_error: fc.record({
    message: fc.string({ maxLength: 60 }),
    line: fc.nat({ max: 100000 }),
    column: fc.nat({ max: 1000 }),
    reason: fc.constantFrom("unexpected_eof", "syntax_error", "unexpected_token", "unknown")
  })
});

// A single run is either clean (empty array) or has 1..N failures.
const runArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant([]) },
  { weight: 3, arbitrary: fc.array(diagnosticArb, { minLength: 1, maxLength: 8 }) }
);

// A sequence of runs against the same output directory.
const runsArb = fc.array(runArb, { minLength: 1, maxLength: 10 });

// Assert the on-disk state matches what the given run (the diagnostics array) should produce, and
// that writeDiagnostics returned the correct value.
function assertRunState(outputDir, diagnostics, returned) {
  const diagPath = join(outputDir, DIAGNOSTICS_FILENAME);
  if (diagnostics.length === 0) {
    // Clean run: no diagnostics file may linger, and null is returned.
    assert.equal(
      existsSync(diagPath),
      false,
      "clean run must leave no diagnostics file (Requirement 2.7)"
    );
    assert.equal(returned, null, "clean run returns null");
  } else {
    // Failure run: exactly one diagnostics file with one line per failure.
    assert.ok(existsSync(diagPath), "failure run writes the diagnostics file");
    assert.ok(
      returned && returned.endsWith(DIAGNOSTICS_FILENAME),
      "failure run returns the .jsonl diagnostics path"
    );
    const raw = readFileSync(diagPath, "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(
      lines.length,
      diagnostics.length,
      "one JSONL line per failed file"
    );
    // Each line is a valid JSON object (round-trippable).
    for (const line of lines) {
      JSON.parse(line);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// P8a — sequences of runs over a shared output dir: file state always tracks the latest run.
//
// The invariant that matters is history-independent: whatever ran before, the on-disk diagnostics
// state after run K reflects only run K. In particular, a clean run always erases a diagnostics file
// left by an earlier failure run.
// ---------------------------------------------------------------------------------------------
{
  fc.assert(
    fc.property(runsArb, (runs) => {
      const outputDir = mkdtempSync(join(tmpdir(), "phpastgen-stale-diag-a-"));
      try {
        for (const diagnostics of runs) {
          const returned = writeDiagnostics(outputDir, diagnostics);
          assertRunState(outputDir, diagnostics, returned);
        }
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    }),
    { numRuns: 300 }
  );
  console.log("ok P8a run-sequence diagnostics state tracks the latest run");
}

// ---------------------------------------------------------------------------------------------
// P8b — explicit failures -> clean transition: a clean run after failures removes the stale file.
//
// This is the concrete Requirement 2.7 case. Write a non-empty diagnostics record (file exists with
// N lines), then a clean run must remove it so no stale diagnostics linger.
// ---------------------------------------------------------------------------------------------
{
  fc.assert(
    fc.property(
      fc.array(diagnosticArb, { minLength: 1, maxLength: 8 }),
      (failures) => {
        const outputDir = mkdtempSync(join(tmpdir(), "phpastgen-stale-diag-b-"));
        const diagPath = join(outputDir, DIAGNOSTICS_FILENAME);
        try {
          // Run with failures: file exists with one line per failure.
          const firstPath = writeDiagnostics(outputDir, failures);
          assert.ok(existsSync(diagPath), "failure run writes the diagnostics file");
          assert.equal(
            readFileSync(diagPath, "utf-8").trim().split("\n").length,
            failures.length,
            "one JSONL line per failed file after the failure run"
          );
          assert.ok(
            firstPath && firstPath.endsWith(DIAGNOSTICS_FILENAME),
            "failure run returns the .jsonl path"
          );

          // Subsequent clean run: stale file must be removed, null returned.
          const cleanReturn = writeDiagnostics(outputDir, []);
          assert.equal(
            existsSync(diagPath),
            false,
            "clean run after failures removes the stale diagnostics file (Requirement 2.7)"
          );
          assert.equal(cleanReturn, null, "clean run returns null");
        } finally {
          rmSync(outputDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 200 }
  );
  console.log("ok P8b failures->clean transition removes stale diagnostics");
}

console.log("phpastgen-stale-diagnostics-pbt: all checks passed");
