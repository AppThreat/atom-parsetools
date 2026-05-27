import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-astgen-"));

const fixtureProjects = [
  {
    name: "type-inference-regression",
    files: ["index.js", "util.js", "types.ts"]
  },
  {
    name: "inference-edge-cases",
    files: ["jsdoc-flows.js", "modern-syntax.js", "generic-types.ts"]
  }
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function getFixtureRoot(projectName) {
  return join(__dirname, "projects", projectName);
}

function getProjectOutputRoot(projectName) {
  return join(outputRoot, projectName);
}

function loadFixture(projectName, fileName) {
  return {
    code: readFileSync(join(getFixtureRoot(projectName), fileName), "utf8"),
    ast: readJson(join(getProjectOutputRoot(projectName), `${fileName}.json`)),
    typemap: readJson(join(getProjectOutputRoot(projectName), `${fileName}.typemap`))
  };
}

function findNeedle(code, needle, occurrence = 0) {
  let fromIndex = 0;
  let position = -1;
  for (let index = 0; index <= occurrence; index++) {
    position = code.indexOf(needle, fromIndex);
    assert.notEqual(position, -1, `Missing fixture needle: ${needle}`);
    fromIndex = position + needle.length;
  }
  return position;
}

function normalizeType(typeName) {
  return typeName.replace(/\s+/g, " ").trim();
}

function expectType(fixture, needle, expectedTypes, options = {}) {
  const expected = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
  const basePosition = findNeedle(
    fixture.code,
    needle,
    options.occurrence ?? 0
  );
  const position = basePosition + (options.offset ?? 0);
  const actual = fixture.typemap[String(position)];
  assert.ok(
    actual,
    `Missing typemap entry for ${needle} at offset ${position}`
  );
  assert.ok(
    expected.map(normalizeType).includes(normalizeType(actual)),
    `Unexpected type for ${needle} at offset ${position}: expected one of ${expected.join(
      ", "
    )}, got ${actual}`
  );
}

function assertOutputShape(fileName, fixture) {
  assert.deepEqual(
    Object.keys(fixture.ast).sort(),
    ["ast", "fullName", "relativeName"],
    `${fileName}.json shape changed`
  );
  assert.equal(fixture.ast.relativeName, fileName);
  assert.equal(typeof fixture.ast.fullName, "string");
  assert.ok(fixture.ast.ast && typeof fixture.ast.ast === "object");

  assert.equal(
    Object.getPrototypeOf(fixture.typemap),
    Object.prototype,
    `${fileName}.typemap must be a plain JSON object`
  );
  assert.ok(
    Object.keys(fixture.typemap).length > 0,
    `${fileName}.typemap should contain inferred types`
  );

  for (const [key, value] of Object.entries(fixture.typemap)) {
    assert.match(key, /^\d+$/, `${fileName}.typemap key is not numeric: ${key}`);
    const position = Number(key);
    assert.ok(
      position >= 0 && position < fixture.code.length,
      `${fileName}.typemap key ${key} is outside the source file bounds`
    );
    assert.equal(typeof value, "string", `${fileName}.typemap value must be a string`);
    assert.notEqual(value, "any", `${fileName}.typemap should not persist any types`);
  }
}

function runAstgen(projectName) {
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "astgen.js"),
      "-i",
      getFixtureRoot(projectName),
      "-o",
      getProjectOutputRoot(projectName),
      "-t",
      "js"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

function loadProjectFixtures(project) {
  return Object.fromEntries(
    project.files.map((fileName) => [fileName, loadFixture(project.name, fileName)])
  );
}

try {
  const fixturesByProject = new Map();
  for (const project of fixtureProjects) {
    runAstgen(project.name);
    const projectFixtures = loadProjectFixtures(project);
    fixturesByProject.set(project.name, projectFixtures);
    for (const [fileName, fixture] of Object.entries(projectFixtures)) {
      assertOutputShape(fileName, fixture);
    }
  }

  const fixtures = fixturesByProject.get("type-inference-regression");
  const index = fixtures["index.js"];
  expectType(index, "primitiveNumber", "number");
  expectType(index, "numericList", "Array<number>");
  expectType(index, "mixedRecord", "{ name: string; score: number; active: boolean; }");
  expectType(index, "spreadRecord", "{ role: string; name: string; score: number; active: boolean; }");
  expectType(index, "optionalScore", "number");
  expectType(index, "countLabel", "string");
  expectType(index, "boxedLabel", "{ value: string; }");
  expectType(index, "destructuredValue", "string");
  expectType(index, "tupleLike", "[number, string]");
  expectType(index, "tupleNumber", "number");
  expectType(index, "tupleString", "string");
  expectType(index, "expressionResult", "number");
  expectType(index, "ternaryResult", '"large" | "small"');
  expectType(index, "export function typedAdd", "number");
  expectType(index, "typedAdd(left", "(left: number, right: number) => number");
  expectType(index, "left, right", "number");
  expectType(index, "left, right", "number", { offset: "left, ".length });
  expectType(index, "value = 0", "number");
  expectType(index, "increment(step)", "(step: number) => number");
  expectType(index, "step) {", "number");
  expectType(index, "counter =", "Counter");
  expectType(index, "nextValue", "number");

  const util = fixtures["util.js"];
  expectType(util, "DEFAULT_COUNT", "number");
  expectType(util, "makeLabel", "(value: number) => string");
  expectType(util, "box(value)", "<T>(value: T) => { value: T; }");

  const types = fixtures["types.ts"];
  expectType(types, "typedUser", "{ id: number; name: string; }");
  expectType(types, "readonlyIds", "readonly [1, 2, 3]");
  expectType(types, "firstReadonlyId", "number");
  expectType(types, "pickName(user", ["(user: User) => string", "(user: { id: number; name: string; }) => string"]);
  expectType(types, "user: User", "{ id: number; name: string; }");
  expectType(types, "pickedName", "string");

  const edgeFixtures = fixturesByProject.get("inference-edge-cases");
  const jsdocFlows = edgeFixtures["jsdoc-flows.js"];
  expectType(jsdocFlows, "primaryUser", ["{ id: number; name: string; tags?: string[]; }", "{ id: number; name: string; tags: Array<string>; }"]);
  expectType(jsdocFlows, "userName", "string");
  expectType(jsdocFlows, "firstTag", "string");
  expectType(jsdocFlows, "userEntries", "Array<[string, string | number | Array<string>]>");
  expectType(jsdocFlows, "userIdSet", "Set<number>");
  expectType(jsdocFlows, "findUser(users", ["(users: UserRecord[], predicate: (user: UserRecord) => boolean) => UserRecord | undefined", "(users: Array<UserRecord>, predicate: (user: UserRecord) => boolean) => UserRecord | undefined"]);
  expectType(jsdocFlows, "users, predicate", "Array<UserRecord>");
  expectType(jsdocFlows, "predicate) {", "(user: UserRecord) => boolean");
  expectType(jsdocFlows, "selectedUser", "UserRecord | undefined");
  expectType(jsdocFlows, "selectedName", "string");
  expectType(jsdocFlows, "indexBy(values", ["<T>(values: T[], getKey: (value: T, index: number) => string) => Map<string, T>", "(values: Array<T>, getKey: (value: T, index: number) => string) => Map<string, T>"]);
  expectType(jsdocFlows, "values, getKey", "Array<T>");
  expectType(jsdocFlows, "getKey) {", "(value: T, index: number) => string");
  expectType(jsdocFlows, "userIndex", "Map<string, UserRecord>");
  expectType(jsdocFlows, "indexedUser", "UserRecord | undefined");
  expectType(jsdocFlows, "helpers =", "{ label(user: UserRecord): string; names(users: UserRecord[]): Array<string>; }");
  expectType(jsdocFlows, "helperLabel", "string");
  expectType(jsdocFlows, "helperNames", "Array<string>");
  expectType(jsdocFlows, "controlledCounter", "() => Generator<number, string, boolean>");
  expectType(jsdocFlows, "counterIterator", "Generator<number, string, boolean>");
  expectType(jsdocFlows, "firstCounterResult", "IteratorYieldResult<number> | IteratorReturnResult<string>");
  expectType(jsdocFlows, "loadUser()", "() => Promise<UserRecord>");
  expectType(jsdocFlows, "loadedUserPromise", "Promise<UserRecord>");
  expectType(jsdocFlows, "loadedUserNamePromise", "Promise<string>");

  const modernSyntax = edgeFixtures["modern-syntax.js"];
  expectType(modernSyntax, "config =", "{ mode: string; retries: number; features: { tracing: boolean; sampling: number; }; }");
  expectType(modernSyntax, "mode =", "string");
  expectType(modernSyntax, "tracingEnabled", "boolean");
  expectType(modernSyntax, "samplingRate", "number");
  expectType(modernSyntax, "mergedConfig", "{ region: string; mode: string; retries: number; features: { tracing: boolean; sampling: number; }; }");
  expectType(modernSyntax, "records =", "Array<{ kind: string; value: number; message?: never; } | { kind: string; message: string; value?: never; }>");
  expectType(modernSyntax, "okRecords", "Array<{ kind: string; value: number; message?: never; } | { kind: string; message: string; value?: never; }>");
  expectType(modernSyntax, "recordKinds", "Array<string>");
  expectType(modernSyntax, "totalValue", "number");
  expectType(modernSyntax, "matrix =", "Array<Array<number>>");
  expectType(modernSyntax, "flattenedMatrix", "Array<number>");
  expectType(modernSyntax, "matrixFirst", "number | undefined");
  expectType(modernSyntax, "formatter", "Intl.NumberFormat");
  expectType(modernSyntax, "formattedTotal", "string");
  expectType(modernSyntax, "url =", "URL");
  expectType(modernSyntax, "debugParam", "string | null");
  expectType(modernSyntax, "urlParts", "Array<string>");
  expectType(modernSyntax, "uniqueKinds", "Set<string>");
  expectType(modernSyntax, "kindArray", "Array<string>");
  expectType(modernSyntax, "kindSummary", "string");
  expectType(modernSyntax, "dynamicValue", "string");

  const genericTypes = edgeFixtures["generic-types.ts"];
  expectType(genericTypes, "productResult", ["ApiFailure | ApiSuccess<Product>", "{ ok: true; data: { sku: string; price: number; metadata: { color: string; }; }; }"]);
  expectType(genericTypes, "unwrap<T>", ["<T>(result: ApiResult<T>, fallback: T) => T", "(result: ApiFailure | ApiSuccess<T>, fallback: T) => T"]);
  expectType(genericTypes, "result: ApiResult", "ApiFailure | ApiSuccess<T>");
  expectType(genericTypes, "fallback: T", "T");
  expectType(genericTypes, "fallbackProduct", "{ sku: string; price: number; metadata?: Record<string, string>; }");
  expectType(genericTypes, "product =", "{ sku: string; price: number; metadata?: Record<string, string>; }");
  expectType(genericTypes, "productSku", "string");
  expectType(genericTypes, "productColor", "string | undefined");
  expectType(genericTypes, "pluck<T", "<T, K extends keyof T>(value: T, key: K) => T[K]");
  expectType(genericTypes, "value: T", "T");
  expectType(genericTypes, "key: K", "K");
  expectType(genericTypes, "pluckedPrice", "number");
  expectType(genericTypes, "pluckedMetadata", "Record<string, string> | undefined");
  expectType(genericTypes, "Repository<T", "Repository<T>");
  expectType(genericTypes, "items =", "Map<string, T>");
  expectType(genericTypes, "add(item", "(item: T) => this");
  expectType(genericTypes, "item: T", "T");
  expectType(genericTypes, "get(sku", "(sku: string) => T | undefined");
  expectType(genericTypes, "productRepository", "Repository<Product>");
  expectType(genericTypes, "repositoryAfterAdd", "Repository<Product>");
  expectType(genericTypes, "repositoryProduct", "Product | undefined");

  console.log("astgen type inference regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
