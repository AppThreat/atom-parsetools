import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const fixtureRoot = join(
  __dirname,
  "projects",
  "type-inference-regression"
);
const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-astgen-"));

const fixtureFiles = ["index.js", "util.js", "types.ts"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadFixture(fileName) {
  return {
    code: readFileSync(join(fixtureRoot, fileName), "utf8"),
    ast: readJson(join(outputRoot, `${fileName}.json`)),
    typemap: readJson(join(outputRoot, `${fileName}.typemap`))
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

try {
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "astgen.js"),
      "-i",
      fixtureRoot,
      "-o",
      outputRoot,
      "-t",
      "js"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  const fixtures = Object.fromEntries(
    fixtureFiles.map((fileName) => [fileName, loadFixture(fileName)])
  );

  for (const [fileName, fixture] of Object.entries(fixtures)) {
    assertOutputShape(fileName, fixture);
  }

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
  expectType(types, "pickName(user", "(user: User) => string");
  expectType(types, "user: User", "{ id: number; name: string; }");
  expectType(types, "pickedName", "string");

  console.log("astgen type inference regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
