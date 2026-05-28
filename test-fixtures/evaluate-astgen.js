import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const projectsRoot = join(__dirname, "projects");
const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-eval-"));

const fixtureProjects = [
  { name: "simple-js", minTypemapEntries: 900 },
  { name: "complex-patterns", minTypemapEntries: 900 },
  { name: "advanced-patterns", minTypemapEntries: 2500 },
  { name: "type-inference-regression", minTypemapEntries: 100 },
  { name: "inference-edge-cases", minTypemapEntries: 250 },
  { name: "typescript-parsing", minTypemapEntries: 450 },
  { name: "vue-precision", minTypemapEntries: 380 }
];

function classifyType(typeName) {
  if (/\bany\b|unknown|unresolved|error/.test(typeName)) {
    return "unresolved";
  }
  if (/=>|^\([^)]*\)\s*=>|^<[^>]+>\(/.test(typeName)) {
    return "functionTypes";
  }
  if (/\|/.test(typeName)) {
    return "unionTypes";
  }
  if (
    typeName.endsWith("[]") ||
    /\b(?:Array|ReadonlyArray|Set|Map|Promise|Record)<|^readonly \[|^\[/.test(typeName)
  ) {
    return "genericTypes";
  }
  if (/^{.*}$/.test(typeName)) {
    return "objectTypes";
  }
  if (["string", "number", "boolean", "bigint", "symbol", "null", "undefined", "void"].includes(typeName)) {
    return "primitiveTypes";
  }
  return "otherTypes";
}

function listSourceFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
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

function analyzeProject(project) {
  const fixtureRoot = join(projectsRoot, project.name);
  const projectOutputRoot = join(outputRoot, project.name);
  const sourceFiles = listSourceFiles(fixtureRoot);
  const sourceBytes = sourceFiles.reduce(
    (total, file) => total + readFileSync(file).byteLength,
    0
  );

  const startedAt = performance.now();
  execFileSync(
    process.execPath,
    [join(repoRoot, "astgen.js"), "-i", fixtureRoot, "-o", projectOutputRoot, "-t", "js"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const durationMs = performance.now() - startedAt;

  let typemapEntries = 0;
  let astFiles = 0;
  let typemapFiles = 0;
  const uniqueTypes = new Set();
  const quality = {
    primitiveTypes: 0,
    objectTypes: 0,
    functionTypes: 0,
    genericTypes: 0,
    unionTypes: 0,
    unresolved: 0,
    otherTypes: 0
  };

  for (const sourceFile of sourceFiles) {
    const relativeName = relative(fixtureRoot, sourceFile);
    const astPath = join(projectOutputRoot, `${relativeName}.json`);
    const typemapPath = join(projectOutputRoot, `${relativeName}.typemap`);
    const ast = readJson(astPath);
    const typemap = readJson(typemapPath);

    assert.equal(ast.relativeName, relativeName, `${project.name}/${relativeName} AST relativeName changed`);
    assert.ok(ast.ast && typeof ast.ast === "object", `${project.name}/${relativeName} AST payload missing`);
    assert.ok(Object.keys(typemap).length > 0, `${project.name}/${relativeName} typemap is empty`);

    astFiles++;
    typemapFiles++;
    typemapEntries += Object.keys(typemap).length;
    for (const typeName of Object.values(typemap)) {
      uniqueTypes.add(typeName);
      quality[classifyType(typeName)]++;
    }
  }

  assert.equal(astFiles, sourceFiles.length, `${project.name} AST output count mismatch`);
  assert.equal(typemapFiles, sourceFiles.length, `${project.name} typemap output count mismatch`);
  assert.ok(
    typemapEntries >= project.minTypemapEntries,
    `${project.name} typemap entries dropped below ${project.minTypemapEntries}: ${typemapEntries}`
  );

  return {
    project: project.name,
    files: sourceFiles.length,
    sourceKb: Number((sourceBytes / 1024).toFixed(2)),
    durationMs: Number(durationMs.toFixed(2)),
    typemapEntries,
    uniqueTypes: uniqueTypes.size,
    entriesPerKb: Number((typemapEntries / Math.max(sourceBytes / 1024, 1)).toFixed(2)),
    entriesPerMs: Number((typemapEntries / Math.max(durationMs, 1)).toFixed(2)),
    unresolved: quality.unresolved,
    complexTypes: quality.objectTypes + quality.functionTypes + quality.genericTypes + quality.unionTypes
  };
}

try {
  const metrics = fixtureProjects.map(analyzeProject);
  const totals = metrics.reduce(
    (accumulator, metric) => ({
      files: accumulator.files + metric.files,
      sourceKb: accumulator.sourceKb + metric.sourceKb,
      durationMs: accumulator.durationMs + metric.durationMs,
      typemapEntries: accumulator.typemapEntries + metric.typemapEntries,
      uniqueTypes: accumulator.uniqueTypes + metric.uniqueTypes
    }),
    { files: 0, sourceKb: 0, durationMs: 0, typemapEntries: 0, uniqueTypes: 0 }
  );

  console.log("\nastgen fixture evaluation");
  console.table(metrics);
  console.log(
    `Totals: files=${totals.files}, sourceKb=${totals.sourceKb.toFixed(2)}, durationMs=${totals.durationMs.toFixed(2)}, typemapEntries=${totals.typemapEntries}`
  );
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
