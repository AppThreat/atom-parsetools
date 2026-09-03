// PHP emitted-contract shape snapshot (Requirements 4.3, 4.4; design Decision 4).
//
// This is the GENERATOR-SIDE counterpart to chen's DecodedShapeContractSpec (task 15). Together
// the two pin the JSON contract shapes phpastgen emits so a breaking (non-additive) change fails
// CI in BOTH places: chen fails to decode a shape it no longer recognizes, and this snapshot fails
// the moment a contract key is removed or renamed. A purely additive change (a NEW optional key)
// is tolerated but recorded, so it becomes a conscious, reviewed re-baseline rather than a silent
// drift.
//
// What is pinned, and how a removal/rename fails:
//   * AST wrapper REQUIRED top-level keys — the five keys always present on every emitted AST
//     (ast, parser_backend, generator_version, php_version, target_version). Asserted as an EXACT
//     set: removing or renaming any one FAILS immediately (a key chen's Domain decoder reads would
//     vanish). Optional keys observed for the fixture (e.g. rel_file_path) are recorded in the
//     baseline; a newly appearing optional key forces a reviewed re-baseline but is not itself a
//     hard failure (it is additive).
//   * framework_facts fact-object key sets — the additive per-node fact shapes: an attribute fact
//     ({attributes}) and a superglobal fact ({superglobal, request}). Pinned as an exact set of
//     observed fact-key-sets: dropping `request` or renaming `superglobal` FAILS.
//   * manifest keys — the 14 authoritative MANIFEST_FIELDS, pinned EXACTLY in order (deep-equal on
//     the ordered key list). This is the strongest guard: any add/remove/rename/reorder FAILS.
//   * diagnostics record keys — the diagnostic object keys (file_path, rel_file_path, parse_error)
//     and the parse_error sub-keys (message, line, column, reason). Pinned as exact sets.
//   * side-record filenames — the manifest and diagnostics files MUST be *.jsonl, never *.json
//     (invariant 2: chen reads every *.json under the output as an AST).
//
// The expected contract lives in a committed baseline under baseline/php-contract-snapshot.json.
// On drift the test prints the offending surface + the added/removed/renamed key and reminds the
// reader that contract changes must be additive and coordinated with chen (Decision 4). To
// intentionally re-baseline after a reviewed change:
//
//   UPDATE_PHP_CONTRACT_SNAPSHOT=1 node test-fixtures/phpastgen-contract-snapshot.js
//
// This uses a DEDICATED fixture project (projects/php-contract) so it is independent of
// phpastgen-regression.js's counters: adding a framework_facts fixture here never perturbs that
// suite. Real parsing is required, so the suite skips cleanly when PHP or the vendored php-parse
// binary is unavailable, mirroring phpastgen-regression.js.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const wrapper = join(repoRoot, "phpastgen.js");
const fixtureRoot = join(__dirname, "projects", "php-contract");
const baselinePath = join(__dirname, "baseline", "php-contract-snapshot.json");
const phpParseBin =
  process.env.PHP_PARSER_BIN || join(repoRoot, "plugins", "bin", "php-parse");

// The 14 authoritative manifest fields, in the order phpastgen emits them (phpastgen.js
// MANIFEST_FIELDS). Kept here so the snapshot pins order + set explicitly rather than only
// echoing back whatever the generator produced.
const EXPECTED_MANIFEST_KEYS = [
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

// The five AST wrapper keys attachProvenance always emits (design §attachProvenance). These are
// pinned as an exact required set; optional keys (rel_file_path, encoding_scrubbed, truncated_nodes)
// are additive and recorded separately.
const EXPECTED_REQUIRED_AST_KEYS = [
  "ast",
  "parser_backend",
  "generator_version",
  "php_version",
  "target_version"
];

function hasPhp() {
  const result = spawnSync(process.env.PHP_CMD || "php", ["--version"], {
    encoding: "utf-8"
  });
  return result.status === 0;
}

if (!hasPhp()) {
  console.log("SKIP phpastgen-contract-snapshot: PHP runtime not found on PATH");
  process.exit(0);
}
if (!existsSync(phpParseBin)) {
  console.log(
    `SKIP phpastgen-contract-snapshot: vendored php-parse binary not found at ${phpParseBin} (run composer install under plugins/)`
  );
  process.exit(0);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sortedKeys(obj) {
  return Object.keys(obj).sort();
}

// Walk an AST payload collecting every distinct framework_facts key-set (sorted), so the snapshot
// pins which fact shapes are emitted regardless of how many nodes carry them.
function collectFactKeySets(node, seen) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectFactKeySets(child, seen);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.framework_facts && typeof node.framework_facts === "object") {
    seen.add(sortedKeys(node.framework_facts).join(","));
  }
  for (const key of Object.keys(node)) {
    if (key === "framework_facts") {
      continue;
    }
    collectFactKeySets(node[key], seen);
  }
}

// Produce real generator output over the dedicated fixture project and distill it into the
// contract snapshot: the observed key sets at every contract surface.
function buildSnapshot() {
  const outputRoot = mkdtempSync(join(tmpdir(), "php-contract-snapshot-"));
  try {
    const run = spawnSync(process.execPath, [wrapper, "-i", fixtureRoot, "-o", outputRoot], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env }
    });
    // Per-file failures must not fail the run (invariant 3): broken.php fails but exit stays 0.
    assert.equal(
      run.status,
      0,
      `phpastgen exited ${run.status}: ${run.stderr ?? ""}`
    );

    const generated = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          generated.push(relative(outputRoot, full));
        }
      }
    };
    walk(outputRoot);
    generated.sort();

    // --- AST wrapper keys, over every emitted *.json AST -------------------------------------
    const astFiles = generated.filter(
      (f) => f.endsWith(".json") && !f.startsWith("phpastgen_")
    );
    assert.ok(astFiles.length >= 1, "expected at least one emitted AST file");

    const requiredAstKeys = new Set();
    const optionalAstKeys = new Set();
    const factKeySets = new Set();
    for (const astFile of astFiles) {
      const wrapperObj = readJson(join(outputRoot, astFile));
      const keys = sortedKeys(wrapperObj);
      for (const key of keys) {
        if (EXPECTED_REQUIRED_AST_KEYS.includes(key)) {
          requiredAstKeys.add(key);
        } else {
          optionalAstKeys.add(key);
        }
      }
      collectFactKeySets(wrapperObj.ast, factKeySets);
    }

    // --- manifest keys -----------------------------------------------------------------------
    const manifestName = generated.find((f) => f.startsWith("phpastgen_manifest"));
    assert.ok(manifestName, "the manifest side-record must be written");
    const manifest = readJson(join(outputRoot, manifestName));

    // --- diagnostics keys --------------------------------------------------------------------
    const diagnosticsName = generated.find((f) =>
      f.startsWith("phpastgen_diagnostics")
    );
    assert.ok(
      diagnosticsName,
      "the diagnostics side-record must be written (broken.php fails to parse)"
    );
    const diagnostics = readJsonl(join(outputRoot, diagnosticsName));
    assert.ok(diagnostics.length >= 1, "expected at least one diagnostic record");
    const diag = diagnostics[0];

    return {
      astWrapper: {
        requiredKeys: [...requiredAstKeys].sort(),
        optionalKeys: [...optionalAstKeys].sort()
      },
      frameworkFacts: {
        factKeySets: [...factKeySets].sort()
      },
      manifest: {
        keys: Object.keys(manifest) // preserve emission order (not sorted): order is pinned
      },
      diagnostics: {
        recordKeys: sortedKeys(diag),
        parseErrorKeys: sortedKeys(diag.parse_error)
      },
      sideRecordFilenames: {
        manifest: manifestName,
        diagnostics: diagnosticsName
      }
    };
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

// Fail with a contract-oriented message: name the surface, the added/removed/renamed keys, and the
// Decision 4 additive+coordinated rule.
function assertSetEqual(surface, expected, actual, { ordered = false } = {}) {
  if (ordered) {
    assert.deepEqual(
      actual,
      expected,
      `${surface}: contract key list changed.\n` +
        `  expected: [${expected.join(", ")}]\n` +
        `  actual:   [${actual.join(", ")}]\n` +
        "  A key was added, removed, renamed, or reordered. Contract changes MUST be additive " +
        "and coordinated with chen's DecodedShapeContractSpec (design Decision 4)."
    );
    return;
  }
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const removed = expected.filter((k) => !actualSet.has(k));
  const added = actual.filter((k) => !expectedSet.has(k));
  assert.ok(
    removed.length === 0 && added.length === 0,
    `${surface}: contract key set changed.\n` +
      `  removed/renamed (FAIL): [${removed.join(", ")}]\n` +
      `  added: [${added.join(", ")}]\n` +
      "  A removed or renamed key breaks chen's decoder. Contract changes MUST be additive and " +
      "coordinated with chen's DecodedShapeContractSpec (design Decision 4). If this is an " +
      "intentional additive change, re-baseline with UPDATE_PHP_CONTRACT_SNAPSHOT=1."
  );
}

const snapshot = buildSnapshot();

// Guard 0 (independent of the baseline): the required AST keys and manifest keys must always match
// the authoritative lists compiled from phpastgen.js. This holds even on a fresh baseline, so a
// removal/rename can never be silently baked into a re-baseline.
assertSetEqual(
  "AST wrapper required keys",
  EXPECTED_REQUIRED_AST_KEYS.slice().sort(),
  snapshot.astWrapper.requiredKeys
);
assertSetEqual("manifest keys", EXPECTED_MANIFEST_KEYS, snapshot.manifest.keys, {
  ordered: true
});

// Guard 1: side-records are *.jsonl, never *.json (invariant 2).
for (const [which, name] of Object.entries(snapshot.sideRecordFilenames)) {
  assert.ok(
    name.endsWith(".jsonl") && !name.endsWith(".json"),
    `${which} side-record must be named *.jsonl (never *.json): got '${name}'`
  );
}

const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.env.UPDATE_PHP_CONTRACT_SNAPSHOT === "1" || !existsSync(baselinePath)) {
  const existed = existsSync(baselinePath);
  writeFileSync(baselinePath, serialized);
  console.log(
    `phpastgen contract snapshot ${existed ? "updated" : "created"}: ${baselinePath}`
  );
} else {
  const baseline = readJson(baselinePath);

  // Required keys and manifest order/set: strict.
  assertSetEqual(
    "AST wrapper required keys",
    baseline.astWrapper.requiredKeys,
    snapshot.astWrapper.requiredKeys
  );
  assertSetEqual("manifest keys", baseline.manifest.keys, snapshot.manifest.keys, {
    ordered: true
  });

  // framework_facts fact shapes: strict (a dropped/renamed fact key breaks chen).
  assertSetEqual(
    "framework_facts fact key sets",
    baseline.frameworkFacts.factKeySets,
    snapshot.frameworkFacts.factKeySets
  );

  // diagnostics record + parse_error sub-keys: strict.
  assertSetEqual(
    "diagnostics record keys",
    baseline.diagnostics.recordKeys,
    snapshot.diagnostics.recordKeys
  );
  assertSetEqual(
    "diagnostics parse_error keys",
    baseline.diagnostics.parseErrorKeys,
    snapshot.diagnostics.parseErrorKeys
  );

  // Optional AST keys: additive-tolerant. A REMOVED optional key is still a contract regression
  // (a consumer may rely on it); a NEW optional key is additive but must be a reviewed re-baseline
  // so the growth is conscious.
  const baseOpt = new Set(baseline.astWrapper.optionalKeys);
  const nowOpt = new Set(snapshot.astWrapper.optionalKeys);
  const removedOpt = baseline.astWrapper.optionalKeys.filter((k) => !nowOpt.has(k));
  const addedOpt = snapshot.astWrapper.optionalKeys.filter((k) => !baseOpt.has(k));
  assert.ok(
    removedOpt.length === 0,
    `AST wrapper optional keys: an optional key disappeared: [${removedOpt.join(", ")}]. ` +
      "Removing a previously emitted key is a non-additive contract change (Decision 4)."
  );
  assert.ok(
    addedOpt.length === 0,
    `AST wrapper optional keys: a NEW optional key appeared: [${addedOpt.join(", ")}]. ` +
      "This is additive, but re-baseline with UPDATE_PHP_CONTRACT_SNAPSHOT=1 so the growth is a " +
      "reviewed, conscious change coordinated with chen (Decision 4)."
  );

  console.log("phpastgen contract snapshot regression tests passed");
}
