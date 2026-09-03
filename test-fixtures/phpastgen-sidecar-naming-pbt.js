import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import * as fc from "./pbt.mjs";
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_THREADS,
  DIAGNOSTICS_FILENAME,
  MANIFEST_FILENAME,
  writeDiagnostics,
  writeManifest
} from "../phpastgen.js";

// Property-based tests for the side-record naming invariant (design §2.4, Requirement 2.3).
//
// Invariant 2 / Property 4 (P4): Side-record naming.
//   chen reads every `*.json` under the output directory as an AST (skipping `*.jsonl`), so the
//   run-level side-records (manifest, diagnostics) MUST always be named `*.jsonl` and NEVER
//   `*.json`. A side-record ending in `.json` would be mis-ingested as an AST and corrupt the
//   consumer.
//
// The invariant is pinned at three complementary levels, none of which requires a PHP runtime
// (we drive writeManifest / writeDiagnostics directly):
//   * P4a — the side-record filename CONSTANTS end in `.jsonl` and never `.json`.
//   * P4b — over arbitrary output dirs and arbitrary diagnostics arrays, the files the writers
//           actually create on disk always carry a `.jsonl` extension, and no produced file
//           matches /(_manifest|_diagnostics)\.json$/ (the design's P4 regex).
//   * P4c — every `.json` file present in the output dir after the writers run parses as a single
//           AST object (a lone JSON value on one line), i.e. it is never a multi-line JSONL
//           side-record. Since the writers never emit `.json`, this is exercised by seeding the
//           output dir with a genuine single-object AST `.json` file and confirming the writers
//           leave it a valid single AST while emitting their side-records as `.jsonl`.
//
// **Validates: Requirement 2.3** — Property: P4

// The design's authoritative P4 regex: no produced file may match this.
const FORBIDDEN_SIDE_RECORD = /(_manifest|_diagnostics)\.json$/;

// A safe path segment generator (letters/digits) so generated dir names are always valid.
const segArb = fc
  .string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
    minLength: 1,
    maxLength: 10
  })
  .filter((s) => s.length > 0);

// An arbitrary diagnostic record shaped like buildDiagnostic output (design §2.4).
const diagnosticArb = fc.record({
  file_path: fc.string({ minLength: 1, maxLength: 40 }),
  rel_file_path: fc.string({ minLength: 1, maxLength: 40 }),
  parse_error: fc.record({
    message: fc.string({ maxLength: 60 }),
    line: fc.nat({ max: 100000 }),
    column: fc.nat({ max: 1000 }),
    reason: fc.constantFrom(
      "parse-error",
      "unexpected_eof",
      "syntax_error",
      "unknown"
    )
  })
});

// ---------------------------------------------------------------------------------------------
// P4a — the side-record filename constants are `.jsonl`, never `.json`.
// ---------------------------------------------------------------------------------------------
{
  for (const name of [MANIFEST_FILENAME, DIAGNOSTICS_FILENAME]) {
    assert.ok(
      name.endsWith(".jsonl"),
      `side-record filename '${name}' must end in .jsonl`
    );
    assert.ok(
      !name.endsWith(".json"),
      `side-record filename '${name}' must never end in .json`
    );
    assert.ok(
      !FORBIDDEN_SIDE_RECORD.test(name),
      `side-record filename '${name}' must not match ${FORBIDDEN_SIDE_RECORD}`
    );
  }
  console.log("ok P4a side-record filename constants are .jsonl, never .json");
}

// ---------------------------------------------------------------------------------------------
// P4b — over arbitrary output dirs and arbitrary diagnostics arrays, every file the writers
// create carries a `.jsonl` extension and no produced file matches the forbidden `.json` pattern.
// ---------------------------------------------------------------------------------------------
{
  fc.assert(
    fc.property(
      segArb,
      fc.array(diagnosticArb, { minLength: 0, maxLength: 12 }),
      (subdir, diagnostics) => {
        // A fresh temp output dir per run; `subdir` varies the leaf name to exercise arbitrary dirs.
        const outDir = mkdtempSync(join(tmpdir(), `phpastgen-sidecar-b-${subdir}-`));
        try {
          const manifestPath = writeManifest(outDir, {
            input: "/abs/project",
            output: outDir,
            php_version: "8.3.0",
            parser_backend: "nikic/php-parser@5.8.0",
            generator_version: "2.0.0",
            files_parsed: 3,
            files_failed: diagnostics.length,
            files_skipped_nonphp: 0,
            files_excluded: 0,
            truncated_files: 0,
            threads: DEFAULT_THREADS,
            max_depth: DEFAULT_MAX_DEPTH
          });
          const diagPath = writeDiagnostics(outDir, diagnostics);

          // The manifest is always written as `.jsonl`.
          assert.ok(
            manifestPath.endsWith(".jsonl") && manifestPath.endsWith(MANIFEST_FILENAME),
            `manifest must be written as ${MANIFEST_FILENAME}`
          );

          // Diagnostics: written only when there were failures; when written it is `.jsonl`.
          if (diagnostics.length === 0) {
            assert.equal(diagPath, null, "clean run writes no diagnostics file");
            assert.ok(
              !existsSync(join(outDir, DIAGNOSTICS_FILENAME)),
              "clean run leaves no diagnostics side-record"
            );
          } else {
            assert.ok(
              diagPath !== null &&
                diagPath.endsWith(".jsonl") &&
                diagPath.endsWith(DIAGNOSTICS_FILENAME),
              `diagnostics must be written as ${DIAGNOSTICS_FILENAME}`
            );
          }

          // P4: every file the writers produced in the output dir is `.jsonl`, and NONE matches
          // the forbidden `.json` side-record pattern.
          for (const entry of readdirSync(outDir)) {
            assert.ok(
              !FORBIDDEN_SIDE_RECORD.test(entry),
              `produced file '${entry}' must not match ${FORBIDDEN_SIDE_RECORD}`
            );
            assert.notEqual(
              extname(entry),
              ".json",
              `produced side-record '${entry}' must never have a .json extension`
            );
            assert.equal(
              extname(entry),
              ".jsonl",
              `produced side-record '${entry}' must have a .jsonl extension`
            );
          }
        } finally {
          rmSync(outDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 300 }
  );
  console.log(
    "ok P4b writers only ever produce .jsonl side-records (never .json) over arbitrary inputs"
  );
}

// ---------------------------------------------------------------------------------------------
// P4c — any `.json` file present in the output dir parses as a single AST object (a lone JSON
// value on one line), never a multi-line JSONL side-record. The writers never emit `.json`, so we
// seed a genuine single-object AST `.json` next to them and confirm: (a) the writers do not touch
// or shadow it, (b) it still parses as one AST object, and (c) the writers' own records land in
// separate `.jsonl` files (so a `.json` consumer never encounters side-record content).
// ---------------------------------------------------------------------------------------------
{
  fc.assert(
    fc.property(
      segArb,
      fc.array(diagnosticArb, { minLength: 1, maxLength: 8 }),
      (astName, diagnostics) => {
        const outDir = mkdtempSync(join(tmpdir(), "phpastgen-sidecar-c-"));
        try {
          // Seed a single-object AST `.json` file (what chen legitimately consumes).
          const astFile = join(outDir, `${astName}.json`);
          const ast = { type: "Program", name: astName, children: [] };
          writeFileSync(astFile, `${JSON.stringify(ast)}\n`, "utf-8");

          // Run the writers; failures present, so diagnostics is also written.
          writeManifest(outDir, {
            input: "/abs/project",
            output: outDir,
            files_failed: diagnostics.length
          });
          writeDiagnostics(outDir, diagnostics);

          // Every `.json` file in the output dir must parse as a single AST object: exactly one
          // JSON value, i.e. its trimmed content is one line that JSON.parse accepts as an object.
          for (const entry of readdirSync(outDir)) {
            if (extname(entry) !== ".json") continue;
            const raw = readFileSync(join(outDir, entry), "utf-8");
            const lines = raw.split("\n").filter((l) => l.trim().length > 0);
            assert.equal(
              lines.length,
              1,
              `.json file '${entry}' must be a single AST value, not multi-line JSONL`
            );
            const parsed = JSON.parse(raw);
            assert.equal(
              typeof parsed,
              "object",
              `.json file '${entry}' must parse as a single AST object`
            );
            assert.ok(
              parsed !== null && !Array.isArray(parsed),
              `.json file '${entry}' must be a single object, not an array/null`
            );
          }

          // And the side-records the writers emitted are `.jsonl`, disjoint from the `.json` AST.
          assert.ok(
            existsSync(join(outDir, MANIFEST_FILENAME)),
            "manifest emitted as .jsonl"
          );
          assert.ok(
            existsSync(join(outDir, DIAGNOSTICS_FILENAME)),
            "diagnostics emitted as .jsonl (failures present)"
          );
        } finally {
          rmSync(outDir, { recursive: true, force: true });
        }
      }
    ),
    { numRuns: 150 }
  );
  console.log(
    "ok P4c every .json file in the output dir parses as a single AST object (never a side-record)"
  );
}

console.log("phpastgen-sidecar-naming-pbt: all checks passed");
