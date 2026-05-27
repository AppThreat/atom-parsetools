import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const fixtureRoot = join(__dirname, "projects", "typescript-parsing");
const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-json-"));

const expectedFiles = [
  "src/index.ts",
  "src/models.ts",
  "src/services.ts",
  "src/view.tsx"
];

const expectedNodeCounts = {
  "src/models.ts": {
    TSEnumDeclaration: 1,
    TSInterfaceDeclaration: 2,
    TSTypeAliasDeclaration: 3,
    TSSatisfiesExpression: 1,
    TSAsExpression: 1,
    ExportNamedDeclaration: 5
  },
  "src/services.ts": {
    ImportDeclaration: 1,
    Decorator: 1,
    ClassDeclaration: 2,
    ClassPrivateProperty: 1,
    ClassMethod: 5,
    TSTypeParameterDeclaration: 2
  },
  "src/view.tsx": {
    ImportDeclaration: 1,
    TSTypeAliasDeclaration: 1,
    TSFunctionType: 1,
    JSXElement: 4,
    JSXOpeningElement: 4,
    JSXExpressionContainer: 4
  },
  "src/index.ts": {
    ImportDeclaration: 3,
    AwaitExpression: 1,
    ExportNamedDeclaration: 1,
    TSArrayType: 1,
    CallExpression: 7
  }
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function countAstNodes(node, counts = {}) {
  if (!node || typeof node !== "object") {
    return counts;
  }
  if (typeof node.type === "string") {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        countAstNodes(item, counts);
      }
    } else if (value && typeof value === "object") {
      countAstNodes(value, counts);
    }
  }
  return counts;
}

function assertJsonWrapper(relativeName, output) {
  assert.deepEqual(
    Object.keys(output).sort(),
    ["ast", "fullName", "relativeName"],
    `${relativeName} wrapper JSON shape changed`
  );
  assert.equal(output.relativeName, relativeName);
  assert.equal(typeof output.fullName, "string");
  assert.ok(output.fullName.endsWith(relativeName));
  assert.equal(output.ast.type, "File", `${relativeName} should emit a Babel File AST`);
  assert.equal(output.ast.program?.type, "Program", `${relativeName} should contain Program`);
  assert.equal(output.ast.program?.sourceType, "module", `${relativeName} should parse as module`);
  assert.ok(Array.isArray(output.ast.program.body), `${relativeName} Program.body should be an array`);
}

function assertTypemapShape(relativeName, typemap, sourceLength) {
  assert.equal(Object.getPrototypeOf(typemap), Object.prototype, `${relativeName}.typemap must be an object`);
  assert.ok(Object.keys(typemap).length > 0, `${relativeName}.typemap should not be empty`);
  for (const [offset, typeName] of Object.entries(typemap)) {
    assert.match(offset, /^\d+$/, `${relativeName}.typemap key should be a numeric offset`);
    assert.ok(Number(offset) >= 0 && Number(offset) < sourceLength, `${relativeName}.typemap offset out of range: ${offset}`);
    assert.equal(typeof typeName, "string", `${relativeName}.typemap value should be a string`);
  }
}

try {
  execFileSync(
    process.execPath,
    [join(repoRoot, "astgen.js"), "-i", fixtureRoot, "-o", outputRoot, "-t", "ts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  for (const relativeName of expectedFiles) {
    const source = readFileSync(join(fixtureRoot, relativeName), "utf8");
    const astOutput = readJson(join(outputRoot, `${relativeName}.json`));
    const typemap = readJson(join(outputRoot, `${relativeName}.typemap`));

    assertJsonWrapper(relativeName, astOutput);
    assertTypemapShape(relativeName, typemap, source.length);

    const counts = countAstNodes(astOutput.ast);
    for (const [nodeType, minimumCount] of Object.entries(expectedNodeCounts[relativeName])) {
      assert.ok(
        (counts[nodeType] ?? 0) >= minimumCount,
        `${relativeName} expected at least ${minimumCount} ${nodeType} nodes, got ${counts[nodeType] ?? 0}`
      );
    }
  }

  console.log("astgen TypeScript JSON regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
