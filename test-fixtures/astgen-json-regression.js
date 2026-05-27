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
  "src/advanced-types.ts",
  "src/alias-consumer.ts",
  "src/ambient.d.ts",
  "src/index.ts",
  "src/models.ts",
  "src/services.ts",
  "src/view.tsx"
];

const expectedNodeCounts = {
  "src/advanced-types.ts": {
    TSModuleDeclaration: 1,
    TSInterfaceDeclaration: 1,
    TSEnumDeclaration: 1,
    TSEnumMember: 2,
    TSDeclareFunction: 2,
    ObjectPattern: 1,
    ArrayPattern: 1
  },
  "src/alias-consumer.ts": {
    ImportDeclaration: 3,
    ImportAttribute: 1,
    AwaitExpression: 1,
    Import: 1,
    CallExpression: 4,
    TSTypeLiteral: 1
  },
  "src/ambient.d.ts": {
    TSModuleDeclaration: 2,
    TSInterfaceDeclaration: 2,
    TSDeclareFunction: 2,
    ExportNamedDeclaration: 2,
    TSQualifiedName: 2
  },
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

function assertNormalizedImportTypeStrings(relativeName, typemap) {
  for (const typeName of Object.values(typemap)) {
    assert.doesNotMatch(
      typeName,
      /resolution-mode/,
      `${relativeName} should not retain TypeScript resolution-mode import noise: ${typeName}`
    );
    assert.doesNotMatch(
      typeName,
      /import\("(?:\/|file:\/\/|[A-Za-z]:[\\/])/,
      `${relativeName} should not retain absolute import type paths: ${typeName}`
    );
  }
}

function findNeedle(source, needle, occurrence = 0) {
  let fromIndex = 0;
  let position = -1;
  for (let index = 0; index <= occurrence; index++) {
    position = source.indexOf(needle, fromIndex);
    assert.notEqual(position, -1, `Missing fixture needle: ${needle}`);
    fromIndex = position + needle.length;
  }
  return position;
}

function assertTypemapEntry(
  relativeName,
  source,
  typemap,
  needle,
  expectedType,
  options = {}
) {
  const position =
    findNeedle(source, needle, options.occurrence ?? 0) +
    (options.offset ?? 0);
  const expectedTypes = Array.isArray(expectedType) ? expectedType : [expectedType];
  const actual = typemap[String(position)]?.replace(/\s+/g, " ").trim();
  assert.ok(
    expectedTypes
      .map((candidate) => candidate.replace(/\s+/g, " ").trim())
      .includes(actual),
    `${relativeName} unexpected typemap value for ${needle}\nactual expected\n\n'${actual}'\n\n${expectedTypes.map((candidate) => `'${candidate.replace(/\s+/g, " ").trim()}'`).join("\n")}`
  );
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
    assertNormalizedImportTypeStrings(relativeName, typemap);

    const counts = countAstNodes(astOutput.ast);
    for (const [nodeType, minimumCount] of Object.entries(expectedNodeCounts[relativeName])) {
      assert.ok(
        (counts[nodeType] ?? 0) >= minimumCount,
        `${relativeName} expected at least ${minimumCount} ${nodeType} nodes, got ${counts[nodeType] ?? 0}`
      );
    }

    if (relativeName === "src/alias-consumer.ts") {
      assertTypemapEntry(relativeName, source, typemap, "aliasUser", [
        "User<{ department: string; }>",
        '{ id: import("@models/models").EntityId; name: string; role: import("@models/models").UserRole.Admin; metadata: { department: string; }; createdAt: Date; }'
      ]);
      assertTypemapEntry(relativeName, source, typemap, "aliasDepartment", "string");
      assertTypemapEntry(relativeName, source, typemap, "serviceName", "string");
      assertTypemapEntry(relativeName, source, typemap, "retryLimit", "number");
      assertTypemapEntry(relativeName, source, typemap, "betaEnabled", "boolean");
      assertTypemapEntry(relativeName, source, typemap, "parsedFromString", "FixtureRuntime.Context");
      assertTypemapEntry(relativeName, source, typemap, "loadServices", "() => Promise<typeof import(\"./services\").UserRepository>");
      assertTypemapEntry(relativeName, source, typemap, "repositoryCtorPromise", "Promise<typeof import(\"./services\").UserRepository>");
      assertTypemapEntry(relativeName, source, typemap, "loadServices()", "Promise<typeof import(\"./services\").UserRepository>", { occurrence: 1 });
    }
    if (relativeName === "src/advanced-types.ts") {
      assertTypemapEntry(relativeName, source, typemap, "StatusCode", "StatusCode");
      assertTypemapEntry(relativeName, source, typemap, "formatInput(input: string | RuntimeShapes.Coordinates)", ["{ (input: string): string; (input: RuntimeShapes.Coordinates): string; }", "(input: string | RuntimeShapes.Coordinates) => string"]);
      assertTypemapEntry(relativeName, source, typemap, "projectPoint({ x, y, label = \"origin\" }", ["({ x, y, label }: RuntimeShapes.Coordinates) => { x: number; y: number; label: string; }", "({ x, y, label = \"origin\" }: RuntimeShapes.Coordinates) => { x: number; y: number; label: string; }"]);
      assertTypemapEntry(relativeName, source, typemap, "pointX", "number");
      assertTypemapEntry(relativeName, source, typemap, "pointY", "number");
      assertTypemapEntry(relativeName, source, typemap, "formattedFromCoords", "string");
      assertTypemapEntry(relativeName, source, typemap, "projected", "{ x: number; y: number; label: string; }");
      assertTypemapEntry(relativeName, source, typemap, "status =", ["StatusCode", "StatusCode.Ok"]);
    }
    if (relativeName === "src/index.ts") {
      assertTypemapEntry(relativeName, source, typemap, "summaries", 'Array<{ id: import("./models").EntityId; name: string; metadata: { department: string; }; }>');
      assertTypemapEntry(relativeName, source, typemap, "firstSummary", '{ id: import("./models").EntityId; name: string; metadata: { department: string; }; }');
    }
  }

  console.log("astgen TypeScript JSON regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
