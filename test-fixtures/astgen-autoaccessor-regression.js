// TC39 auto-accessors (`accessor x = 1`, atom-parsetools#34) must parse as
// ClassAccessorProperty, decorated or not, in JavaScript and TypeScript. The
// plugin that enables them (`decoratorAutoAccessors`) must not change any
// other file's AST: for the legacy-decorator fixtures the AST parsed without
// it is compared byte for byte with the AST astgen emits with it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { babelParserOptions, fileToJsAst, makeBabelOptions } from "../astgen.js";
import { createOutputRoot, readJson, runAstgen } from "./ast-regression-helpers.js";

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(__dirname, "projects", "auto-accessors");
const outputRoot = createOutputRoot("atom-parsetools-autoaccessor-");

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

const lineOf = (code, needle, occurrence = 0) => {
  let fromIndex = 0;
  let position = -1;
  for (let index = 0; index <= occurrence; index++) {
    position = code.indexOf(needle, fromIndex);
    assert.notEqual(position, -1, `Missing fixture needle: ${needle}`);
    fromIndex = position + needle.length;
  }
  return code.slice(0, position).split("\n").length;
};

const accessorFixtures = ["accessor-decorated.js", "accessor-decorated.ts"];
const legacyFixtures = ["legacy-decorators.js", "legacy-decorators.ts"];

try {
  runAstgen(fixtureRoot, outputRoot);

  const expectedAccessors = {
    "accessor-decorated.js": {
      names: ["count", "mouse", "untouched"],
      decorated: ["mouse", "count"],
      positioned: { member: "mouse", needle: "accessor mouse = nanoid()" }
    },
    "accessor-decorated.ts": {
      names: ["id", "limit", "tags"],
      decorated: ["id", "limit"],
      positioned: { member: "id", needle: "accessor id: string = uuidv4()" }
    }
  };
  for (const relativeName of accessorFixtures) {
    const expected = expectedAccessors[relativeName];
    const code = readFileSync(join(fixtureRoot, relativeName), "utf8");
    const nodes = nodesOf(loadAst(relativeName).program);

    const accessors = nodes.filter((node) => node.type === "ClassAccessorProperty");
    assert.equal(
      accessors.length,
      expected.names.length,
      `${relativeName} should hold ${expected.names.length} auto-accessors`
    );
    // the members keep the names they declare, whatever decorates them
    assert.deepEqual(
      accessors.map((node) => node.key?.name ?? node.key?.value).sort(),
      [...expected.names].sort(),
      `${relativeName} accessor names`
    );
    // an auto-accessor keeps its decorators like a class property does
    assert.deepEqual(
      accessors
          .filter((node) => (node.decorators ?? []).length === 1)
          .map((node) => node.key?.name ?? node.key?.value)
          .sort(),
      [...expected.decorated].sort(),
      `${relativeName} decorated accessors`
    );
    // and its position addresses the real file line, not a lowered buffer
    assert.equal(
      accessors.find((node) => node.key?.name === expected.positioned.member).loc.start.line,
      lineOf(code, expected.positioned.needle),
      `${relativeName} accessor line`
    );
  }

  for (const relativeName of legacyFixtures) {
    const source = readFileSync(join(fixtureRoot, relativeName), "utf8");
    const emitted = loadAst(relativeName);

    // the same primary options astgen builds for the file, with and without
    // decoratorAutoAccessors: enabling it must not change one byte of the AST
    const withPluginOptions = makeBabelOptions(babelParserOptions, join(fixtureRoot, relativeName));
    const withPlugin = parse(source, withPluginOptions);
    assert.deepEqual(withPlugin.errors ?? [], [], `${relativeName} primary parse errors`);
    const withoutPluginOptions = {
      ...withPluginOptions,
      plugins: withPluginOptions.plugins.filter(
        (plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) !== "decoratorAutoAccessors"
      )
    };
    const withoutPlugin = parse(source, withoutPluginOptions);
    assert.equal(
      JSON.stringify(withoutPlugin),
      JSON.stringify(withPlugin),
      `${relativeName} AST changed when decoratorAutoAccessors was enabled`
    );

    // the legacy decorators keep their node kinds: no auto-accessor in sight
    const nodes = nodesOf(emitted.program);
    assert.equal(
      nodes.filter((node) => node.type === "ClassAccessorProperty").length,
      0,
      `${relativeName} must hold no auto-accessor`
    );
    assert.ok(
      nodes.some((node) => node.type === "Decorator"),
      `${relativeName} must hold decorators`
    );
    assert.ok(
      nodes.some((node) => node.type === "ClassProperty"),
      `${relativeName} must hold class properties`
    );
  }

  // the same fixtures through the whole per-file pipeline (the function the
  // CLI uses), so the emitted JSON and the parse agree on every plugin
  for (const relativeName of [...accessorFixtures, ...legacyFixtures]) {
    const viaPipeline = fileToJsAst(join(fixtureRoot, relativeName), "ts");
    assert.deepEqual(
      viaPipeline.errors ?? [],
      [],
      `${relativeName} parsed with errors through fileToJsAst`
    );
  }

  console.log("astgen-autoaccessor-regression: all checks passed");
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(outputRoot, { recursive: true, force: true });
}
