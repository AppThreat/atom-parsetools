import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "./pbt.mjs";
import {
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_THREADS,
  MANIFEST_FILENAME,
  PHP_EXTENSIONS,
  VENDOR_DIRS,
  discoverFiles,
  runBatch,
  writeManifest
} from "../phpastgen.js";

// Property-based tests for the phpastgen manifest count invariant (design §2.4, §2.11,
// Requirement 2.3).
//
// Property 2 (P2): Manifest count invariant.
//   files_parsed + files_failed + files_skipped_nonphp + files_excluded == total files walked.
//
// The invariant is pinned at three complementary levels:
//   * writeManifest schema/field completeness — the emitted line always carries exactly the 14
//     authoritative fields and the four count fields sum to the number of walked files (no PHP
//     runtime required).
//   * discoverFiles accounting — over generated temp directory trees, the discovery split
//     (included + excluded + skipped-non-php) equals the number of walkable regular files, which
//     is the "total files walked" denominator the manifest reports (no PHP runtime required).
//   * runBatch end-to-end — the emitted manifest's four counts sum to total walked, and
//     files_parsed + files_failed == the number of included (candidate) files. Gated behind a PHP
//     runtime + vendored parser check (mirrors phpastgen-legacy-regression.js skip pattern).
//
// **Validates: Requirement 2.3** — Property: P2

// The authoritative manifest field set (design §2.4). writeManifest must always emit exactly these.
const MANIFEST_FIELDS = [
  "input",
  "output",
  "php_version",
  "parser_backend",
  "generator_version",
  "generated_at",
  "target_version",
  "files_parsed",
  "files_failed",
  "files_skipped_nonphp",
  "files_excluded",
  "truncated_files",
  "threads",
  "max_depth"
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);

// ---------------------------------------------------------------------------------------------
// P2a — writeManifest field completeness + count-sum invariant (no PHP runtime required).
//
// For any partition of `totalWalked` files into the four count buckets, writeManifest must emit a
// line whose keys are exactly the authoritative field set and whose four count fields recover the
// same total. This pins both the schema (field completeness) and the arithmetic invariant at the
// point the manifest is serialized.
// ---------------------------------------------------------------------------------------------
{
  const partitionArb = fc
    .array(fc.nat({ max: 500 }), { minLength: 4, maxLength: 4 })
    .map(([parsed, failed, skipped, excluded]) => ({
      parsed,
      failed,
      skipped,
      excluded
    }));

  fc.assert(
    fc.property(partitionArb, (p) => {
      const totalWalked = p.parsed + p.failed + p.skipped + p.excluded;
      const tmp = mkdtempSync(join(tmpdir(), "phpastgen-manifest-a-"));
      try {
        const manifestPath = writeManifest(tmp, {
          input: "/abs/project",
          output: tmp,
          php_version: "8.3.0",
          parser_backend: "nikic/php-parser@5.8.0",
          generator_version: "2.0.0",
          target_version: null,
          files_parsed: p.parsed,
          files_failed: p.failed,
          files_skipped_nonphp: p.skipped,
          files_excluded: p.excluded,
          truncated_files: 0,
          threads: DEFAULT_THREADS,
          max_depth: DEFAULT_MAX_DEPTH
        });

        // The side-record is always a `.jsonl` file (never `.json`) so chen does not mis-consume it.
        assert.ok(
          manifestPath.endsWith(MANIFEST_FILENAME),
          "manifest must be written as phpastgen_manifest.jsonl"
        );

        const lines = readFileSync(manifestPath, "utf-8").trim().split("\n");
        assert.equal(lines.length, 1, "manifest is exactly one JSONL line");
        const record = JSON.parse(lines[0]);

        // Field completeness: exactly the authoritative field set, no more, no less.
        assert.deepEqual(
          Object.keys(record).sort(),
          [...MANIFEST_FIELDS].sort(),
          "manifest must contain exactly the authoritative field set (design §2.4)"
        );

        // P2: the four count fields recover the total walked.
        assert.equal(
          record.files_parsed +
            record.files_failed +
            record.files_skipped_nonphp +
            record.files_excluded,
          totalWalked,
          "files_parsed + files_failed + files_skipped_nonphp + files_excluded == total walked"
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }),
    { numRuns: 300 }
  );
  console.log("ok P2a writeManifest field completeness + count-sum invariant");
}

// ---------------------------------------------------------------------------------------------
// Generated directory-tree model (shared by P2b and P2c).
//
// Each generated file is one of three kinds that map to the three discovery buckets:
//   * "php"      — a recognized PHP file (extension in PHP_EXTENSIONS) -> included (candidate)
//   * "nonphp"   — a file with a non-PHP extension                     -> skipped_nonphp
//   * "excluded" — a PHP file placed under a top-level `tests/` dir     -> excluded (DEFAULT_EXCLUDE)
//
// Files are laid out under generated sub-directories. Vendor directories are never generated at a
// path that would change the walked-file count in a way the model cannot predict; instead a
// dedicated `vendor/` subtree is optionally added and its files are asserted to be skipped wholesale
// (they must NOT count toward total walked). This keeps the model's `totalWalked` exact.
// ---------------------------------------------------------------------------------------------

// A safe file-name segment (letters/digits only) so generated paths are always valid.
const nameArb = fc
  .string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), minLength: 1, maxLength: 8 })
  .filter((s) => s.length > 0);

const phpExtArb = fc.constantFrom(...PHP_EXTENSIONS);
const nonPhpExtArb = fc.constantFrom(".txt", ".md", ".json", ".xml", ".yml", ".lock", ".css");

// A single generated file descriptor.
const fileArb = fc.oneof(
  fc.record({ kind: fc.constant("php"), name: nameArb, ext: phpExtArb }),
  fc.record({ kind: fc.constant("nonphp"), name: nameArb, ext: nonPhpExtArb }),
  // A recognized PHP file that lives under a top-level `tests/` dir -> matches DEFAULT_EXCLUDE.
  fc.record({ kind: fc.constant("excluded"), name: nameArb, ext: phpExtArb })
);

const treeArb = fc.record({
  // Root-level files (php / nonphp buckets; excluded files carry their own `tests/` prefix).
  files: fc.array(fileArb, { minLength: 0, maxLength: 25 }),
  // Whether to also drop some recognized PHP files inside a `vendor/` subtree (must be skipped).
  vendorFiles: fc.array(nameArb, { minLength: 0, maxLength: 6 })
});

// Materialize a generated tree on disk under `root`. Returns the model's expected counts.
function materializeTree(root, tree) {
  let expectedIncluded = 0;
  let expectedSkippedNonPhp = 0;
  let expectedExcluded = 0;

  const testsDir = join(root, "tests");
  const usedPaths = new Set();

  const uniquePath = (dir, base) => {
    let candidate = join(dir, base);
    let n = 0;
    while (usedPaths.has(candidate)) {
      n += 1;
      candidate = join(dir, `${base}.${n}`);
    }
    usedPaths.add(candidate);
    return candidate;
  };

  for (let i = 0; i < tree.files.length; i++) {
    const f = tree.files[i];
    if (f.kind === "excluded") {
      // A recognized PHP file under a top-level `tests/` dir: excluded by DEFAULT_EXCLUDE.
      mkdirSync(testsDir, { recursive: true });
      const p = uniquePath(testsDir, `${f.name}${i}${f.ext}`);
      writeFileSync(p, "<?php // excluded fixture\n", "utf-8");
      expectedExcluded += 1;
    } else if (f.kind === "php") {
      const p = uniquePath(root, `${f.name}${i}${f.ext}`);
      writeFileSync(p, "<?php echo 1;\n", "utf-8");
      expectedIncluded += 1;
    } else {
      const p = uniquePath(root, `${f.name}${i}${f.ext}`);
      writeFileSync(p, "not php\n", "utf-8");
      expectedSkippedNonPhp += 1;
    }
  }

  // Vendor subtree: files here must be skipped wholesale and never counted toward total walked.
  if (tree.vendorFiles.length > 0) {
    const vendorDir = join(root, "vendor");
    mkdirSync(vendorDir, { recursive: true });
    for (let i = 0; i < tree.vendorFiles.length; i++) {
      const p = uniquePath(vendorDir, `${tree.vendorFiles[i]}${i}.php`);
      writeFileSync(p, "<?php echo 'vendored';\n", "utf-8");
    }
  }

  // "total files walked" is the set of walkable regular files the discovery visits: everything
  // except the vendor subtree (skipped wholesale). It is exactly the sum of the three buckets.
  const expectedTotalWalked =
    expectedIncluded + expectedSkippedNonPhp + expectedExcluded;

  return {
    expectedIncluded,
    expectedSkippedNonPhp,
    expectedExcluded,
    expectedTotalWalked
  };
}

// ---------------------------------------------------------------------------------------------
// P2b — discoverFiles accounting invariant (no PHP runtime required).
//
// Over generated temp trees, the discovery split must sum to the walked-file total, and each
// bucket must match the model's expectation. Vendor-subtree files must be excluded from the walk
// entirely (they contribute to none of the buckets), which pins the "skipped wholesale" rule that
// keeps `total walked` well-defined.
// ---------------------------------------------------------------------------------------------
{
  const excludeRegex = new RegExp(DEFAULT_EXCLUDE);
  fc.assert(
    fc.property(treeArb, (tree) => {
      const root = mkdtempSync(join(tmpdir(), "phpastgen-manifest-b-"));
      try {
        const model = materializeTree(root, tree);
        const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
          root,
          excludeRegex
        );

        // Bucket-level agreement with the model.
        assert.equal(
          included.length,
          model.expectedIncluded,
          "included (candidate) count matches the generated PHP files"
        );
        assert.equal(
          skippedNonPhpCount,
          model.expectedSkippedNonPhp,
          "skipped-non-php count matches the generated non-PHP files"
        );
        assert.equal(
          excludedCount,
          model.expectedExcluded,
          "excluded count matches the generated tests/ PHP files"
        );

        // P2 (discovery half): the three buckets sum to total files walked. Vendor files never
        // appear in any bucket (skipped wholesale), so they do not inflate the total.
        assert.equal(
          included.length + skippedNonPhpCount + excludedCount,
          model.expectedTotalWalked,
          "included + skipped_nonphp + excluded == total files walked"
        );

        // Defensive: no discovered candidate lives inside a vendor directory.
        for (const f of included) {
          for (const v of VENDOR_DIRS) {
            assert.ok(
              !f.split(/[/\\]/).includes(v),
              `vendor subtree '${v}' must be skipped wholesale (offending: ${f})`
            );
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }),
    { numRuns: 150 }
  );
  console.log("ok P2b discoverFiles accounting invariant (buckets sum to total walked)");
}

// ---------------------------------------------------------------------------------------------
// P2c — runBatch end-to-end manifest invariant (gated on PHP runtime + vendored parser).
//
// Drives the full batch pipeline over generated trees and asserts the emitted manifest's four
// count fields sum to total walked, and files_parsed + files_failed == the number of included
// candidate files (the per-file loop invariant surfaced in the manifest).
// ---------------------------------------------------------------------------------------------
function hasPhp() {
  const result = spawnSync(process.env.PHP_CMD || "php", ["--version"], {
    encoding: "utf-8"
  });
  return result.status === 0;
}

const phpParseBin =
  process.env.PHP_PARSER_BIN || join(repoRoot, "plugins", "bin", "php-parse");

if (!hasPhp()) {
  console.log(
    "SKIP P2c runBatch end-to-end: PHP runtime not found on PATH (writeManifest + discoverFiles invariants still verified above)"
  );
} else if (!existsSync(phpParseBin)) {
  console.log(
    `SKIP P2c runBatch end-to-end: vendored php-parse binary not found at ${phpParseBin} (run composer install under plugins/); writeManifest + discoverFiles invariants still verified above`
  );
} else {
  await fc.assert(
    fc.asyncProperty(treeArb, async (tree) => {
      const root = mkdtempSync(join(tmpdir(), "phpastgen-manifest-c-in-"));
      const outDir = mkdtempSync(join(tmpdir(), "phpastgen-manifest-c-out-"));
      try {
        const model = materializeTree(root, tree);

        const exitCode = await runBatch({
          input: root,
          output: outDir,
          exclude: DEFAULT_EXCLUDE,
          threads: DEFAULT_THREADS,
          maxDepth: DEFAULT_MAX_DEPTH,
          failOnError: false
        });

        // Without --fail-on-error, per-file failures never fail the run.
        assert.equal(exitCode, 0, "batch run without --fail-on-error exits 0");

        const manifestPath = join(outDir, MANIFEST_FILENAME);
        assert.ok(existsSync(manifestPath), "manifest is always written");
        const record = JSON.parse(
          readFileSync(manifestPath, "utf-8").trim().split("\n")[0]
        );

        // Discovery-driven fields must match the model exactly.
        assert.equal(
          record.files_skipped_nonphp,
          model.expectedSkippedNonPhp,
          "manifest files_skipped_nonphp matches discovery"
        );
        assert.equal(
          record.files_excluded,
          model.expectedExcluded,
          "manifest files_excluded matches discovery"
        );

        // The per-file loop invariant surfaced in the manifest: every included candidate lands in
        // exactly one of parsed / failed.
        assert.equal(
          record.files_parsed + record.files_failed,
          model.expectedIncluded,
          "files_parsed + files_failed == number of included candidate files"
        );

        // P2: the four count fields sum to total files walked.
        assert.equal(
          record.files_parsed +
            record.files_failed +
            record.files_skipped_nonphp +
            record.files_excluded,
          model.expectedTotalWalked,
          "P2: files_parsed + files_failed + files_skipped_nonphp + files_excluded == total walked"
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    }),
    { numRuns: 40 }
  );
  console.log("ok P2c runBatch end-to-end manifest count invariant");
}

console.log("phpastgen-manifest-pbt: all checks passed");
