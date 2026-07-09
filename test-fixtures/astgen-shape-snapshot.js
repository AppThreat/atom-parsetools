// Shape & accuracy snapshot regression test.
//
// Purpose: guarantee that migrating the TypeScript dependency (e.g. moving to
// the @typescript/typescript6 bridge for the TypeScript 7.0 native release)
// does NOT change the AST shapes or the inferred type maps that astgen emits.
//
// For every fixture source file we capture:
//   * a deterministic histogram of AST node `type` values plus the total node
//     count (the "shape"), and
//   * the complete typemap (offset -> inferred type string) (the "accuracy").
//
// The combined snapshot is compared against a committed baseline. If astgen's
// output drifts for any reason, this test fails and prints the first
// difference. To intentionally re-baseline after a reviewed change, run:
//
//   UPDATE_SHAPE_SNAPSHOT=1 node test-fixtures/astgen-shape-snapshot.js

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const projectsRoot = join(__dirname, "projects");
const baselinePath = join(__dirname, "baseline", "shape-snapshot.json");
const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-shape-"));

// Keep this list in sync with evaluate-astgen.js so every fixture project is
// exercised by the snapshot.
const fixtureProjects = [
  "simple-js",
  "complex-patterns",
  "advanced-patterns",
  "type-inference-regression",
  "inference-edge-cases",
  "typescript-parsing",
  "vue-precision"
];

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(?:js|jsx|cjs|mjs|ts|tsx|vue)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Recursively tally AST node `type` values. AST nodes are plain objects that
// carry a string `type` field; we walk every array and object reachable from
// the root so the histogram reflects the full tree shape.
function collectShape(node, counts, totals) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectShape(child, counts, totals);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  if (typeof node.type === "string") {
    counts[node.type] = (counts[node.type] || 0) + 1;
    totals.count += 1;
  }
  for (const key of Object.keys(node)) {
    // `loc`/positional metadata never contains nested AST nodes; skipping it
    // keeps the walk fast without affecting the histogram.
    if (key === "loc" || key === "start" || key === "end") {
      continue;
    }
    collectShape(node[key], counts, totals);
  }
}

function sortObject(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

function analyzeProject(projectName) {
  const fixtureRoot = join(projectsRoot, projectName);
  const projectOutputRoot = join(outputRoot, projectName);
  const sourceFiles = listSourceFiles(fixtureRoot);

  execFileSync(
    process.execPath,
    [
      join(repoRoot, "astgen.js"),
      "-i",
      fixtureRoot,
      "-o",
      projectOutputRoot,
      "-t",
      "js"
    ],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );

  const fileSnapshots = {};
  for (const sourceFile of sourceFiles) {
    const relativeName = relative(fixtureRoot, sourceFile);
    const ast = readJson(join(projectOutputRoot, `${relativeName}.json`));
    const typemap = readJson(join(projectOutputRoot, `${relativeName}.typemap`));

    const counts = {};
    const totals = { count: 0 };
    collectShape(ast.ast, counts, totals);

    fileSnapshots[relativeName] = {
      totalNodes: totals.count,
      nodeTypeCounts: sortObject(counts),
      typemap: sortObject(typemap)
    };
  }
  return sortObject(fileSnapshots);
}

function buildSnapshot() {
  const snapshot = {};
  for (const projectName of fixtureProjects) {
    snapshot[projectName] = analyzeProject(projectName);
  }
  return snapshot;
}

// Depth-first structural diff that returns a human readable path + values for
// the first mismatch, so a regression points straight at the offending file /
// node type / offset.
function findFirstDiff(expected, actual, path = "") {
  if (
    typeof expected !== "object" ||
    typeof actual !== "object" ||
    expected === null ||
    actual === null
  ) {
    if (expected !== actual) {
      return { path, expected, actual };
    }
    return null;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    const nextPath = path ? `${path} > ${key}` : key;
    if (!(key in expected)) {
      return { path: nextPath, expected: undefined, actual: actual[key] };
    }
    if (!(key in actual)) {
      return { path: nextPath, expected: expected[key], actual: undefined };
    }
    const diff = findFirstDiff(expected[key], actual[key], nextPath);
    if (diff) {
      return diff;
    }
  }
  return null;
}

try {
  const snapshot = buildSnapshot();
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (process.env.UPDATE_SHAPE_SNAPSHOT === "1" || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, serialized);
    console.log(
      `astgen shape snapshot ${existsSync(baselinePath) ? "updated" : "created"}: ${baselinePath}`
    );
  } else {
    const baseline = readJson(baselinePath);
    const diff = findFirstDiff(baseline, snapshot);
    assert.equal(
      diff,
      null,
      diff
        ? `astgen shape/accuracy drift at "${diff.path}":\n  expected: ${JSON.stringify(diff.expected)}\n  actual:   ${JSON.stringify(diff.actual)}`
        : undefined
    );
    console.log("astgen shape & accuracy snapshot regression tests passed");
  }
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
