// Source phase imports (`import source x from "..."`, `import.source(...)`)
// and deferred imports (`import defer * as x from "..."`, `import.defer(...)`)
// must parse. Babel represents them with the usual ImportDeclaration and
// ImportExpression nodes plus a `phase` field.

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputRoot,
  expectType,
  readJson,
  runAstgen
} from "./ast-regression-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, "projects", "import-phases");
const outputRoot = createOutputRoot("atom-parsetools-import-phases-");

const nodesOf = (node, found = []) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      nodesOf(child, found);
    }
  } else if (node && typeof node === "object") {
    if (typeof node.type === "string") {
      found.push(node);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc") {
        nodesOf(value, found);
      }
    }
  }
  return found;
};

const loadAst = (relativeName) => {
  const astPath = join(outputRoot, `${relativeName}.json`);
  assert.ok(existsSync(astPath), `${relativeName} produced no AST`);
  const data = readJson(astPath);
  assert.equal(data.relativeName, relativeName);
  assert.deepEqual(
    data.ast.errors ?? [],
    [],
    `${relativeName} parsed with errors`
  );
  return data.ast;
};

const expectImport = (nodes, relativeName, type, phase, sourceValue) => {
  const match = nodes.find(
    (node) =>
      node.type === type &&
      node.phase === phase &&
      (sourceValue === undefined || node.source?.value === sourceValue)
  );
  assert.ok(match, `${relativeName} is missing ${type} with phase "${phase}"`);
};

const expectFunctions = (nodes, relativeName, names) => {
  const declared = nodes
    .filter((node) => node.type === "FunctionDeclaration")
    .map((node) => node.id?.name);
  assert.deepEqual(declared, names, `${relativeName} lost declarations`);
};

const loadTypes = (relativeName) => {
  const typemapPath = join(outputRoot, `${relativeName}.typemap`);
  assert.ok(existsSync(typemapPath), `${relativeName} produced no type map`);
  return {
    code: readFileSync(join(fixtureRoot, relativeName), "utf8"),
    typemap: readJson(typemapPath),
    relativeName
  };
};

try {
  runAstgen(fixtureRoot, outputRoot);

  const js = nodesOf(loadAst("loader.js"));
  expectImport(js, "loader.js", "ImportDeclaration", "source", "./math.wasm");
  expectImport(js, "loader.js", "ImportDeclaration", "defer", "./reports.js");
  expectImport(js, "loader.js", "ImportExpression", "source");
  expectFunctions(js, "loader.js", ["instantiate", "sourceOf", "summary"]);
  expectType(loadTypes("loader.js"), "summary()", "() => string");

  const ts = nodesOf(loadAst("loader.ts"));
  expectImport(ts, "loader.ts", "ImportDeclaration", "source", "./math.wasm");
  expectImport(ts, "loader.ts", "ImportDeclaration", "defer", "./reports.js");
  expectImport(ts, "loader.ts", "ImportExpression", "defer");
  expectFunctions(ts, "loader.ts", [
    "instantiate",
    "deferredReports",
    "summary"
  ]);
  expectType(loadTypes("loader.ts"), "summary()", "() => string");

  loadAst("reports.js");

  console.log("astgen import phase regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
