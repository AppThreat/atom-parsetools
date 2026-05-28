import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);

function createOutputRoot(prefix = "atom-parsetools-vue-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runAstgen(fixtureRoot, outputDir) {
  execFileSync(
    process.execPath,
    [join(repoRoot, "astgen.js"), "-i", fixtureRoot, "-o", outputDir, "-t", "js"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function normalizeType(typeName) {
  return typeName.replace(/\s+/g, " ").trim();
}

function countUnresolved(typemap) {
  return Object.values(typemap).filter((value) =>
    /\bany\b|\bunknown\b|\berror\b|unresolved/.test(value)
  ).length;
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

function expectType({ code, typemap, relativeName }, needle, expectedTypes, options = {}) {
  const expected = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
  const basePosition = findNeedle(code, needle, options.occurrence ?? 0);
  const offset = options.offset ?? 0;
  const actual = typemap[String(basePosition + offset)];
  assert.ok(actual, `Missing typemap entry for ${relativeName} :: ${needle}`);
  assert.ok(
    expected.map(normalizeType).includes(normalizeType(actual)),
    `${relativeName} unexpected type for ${needle}: expected one of ${expected.join(", ")}, got ${actual}`
  );
}

function loadFixtureSet(fixtureRoot, outputRoot, relativeNames, minTypemapEntries) {
  return Object.fromEntries(
    relativeNames.map((relativeName) => {
      const code = readFileSync(join(fixtureRoot, relativeName), "utf8");
      const ast = readJson(join(outputRoot, `${relativeName}.json`));
      const typemap = readJson(join(outputRoot, `${relativeName}.typemap`));
      assert.equal(ast.relativeName, relativeName, `${relativeName} AST relativeName changed`);
      assert.ok(ast.ast && typeof ast.ast === "object", `${relativeName} AST payload missing`);
      assert.ok(
        Object.keys(typemap).length >= minTypemapEntries,
        `${relativeName} typemap entries dropped below ${minTypemapEntries}`
      );
      return [relativeName, { code, typemap, relativeName }];
    })
  );
}

export {
  createOutputRoot,
  runAstgen,
  readJson,
  countUnresolved,
  expectType,
  loadFixtureSet
};
