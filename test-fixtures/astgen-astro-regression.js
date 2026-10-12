// Astro regression tests for astgen.
//
// astgen lowers `.astro` components to stock Babel AST: the frontmatter and the
// client scripts as statements (parsed over a position-preserving masked
// buffer), the template as JSX. The contract these tests pin:
//
//   1. Every emitted node's [start, end) is an absolute offset into the original
//      `.astro` file, and `loc` agrees with it.
//   2. Every emitted node `type` is a stock Babel node type.
//   3. The constructs that matter downstream keep their shape: `set:html={x}`
//      is a JSXAttribute named by a JSXNamespacedName whose value is an
//      expression; template expressions (also ones holding JSX, with
//      apostrophes in JSX text) are parsed; the frontmatter's statements come
//      first and the template last; a client `<script>` contributes its
//      statements; a file without frontmatter is template only.
//
// The fixture project is test-fixtures/projects/astro-precision.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOutputRoot, runAstgen, readJson } from "./ast-regression-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputRoot = createOutputRoot("atom-parsetools-astro-");
const fixtureRoot = join(__dirname, "projects", "astro-precision");

let babelTypes = null;
try {
  babelTypes = new Set(Object.keys((await import("@babel/types")).VISITOR_KEYS));
} catch {
  console.warn("@babel/types not resolvable; skipping the node-type vocabulary check");
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const nodesOf = (root) => {
  const out = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (typeof node.type === "string") {
      out.push(node);
    }
    for (const key of Object.keys(node)) {
      if (key !== "loc" && key !== "range") {
        visit(node[key]);
      }
    }
  };
  visit(root);
  return out;
};

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n  ${err.message}`);
  }
};

try {
  runAstgen(fixtureRoot, outputRoot);
  const outputs = walk(outputRoot).filter((p) => p.endsWith(".astro.json"));
  const byName = Object.fromEntries(
    outputs.map((p) => [p.split(/[\\/]/).pop().replace(".json", ""), readJson(p)])
  );

  check("every component is converted", () => {
    assert.deepEqual(Object.keys(byName).sort(), ["Card.astro", "Plain.astro", "search.astro"]);
  });

  for (const [name, json] of Object.entries(byName)) {
    const src = readFileSync(join(fixtureRoot, json.relativeName), "utf8");
    const nodes = nodesOf(json.ast);

    check(`${name}: offsets are absolute and loc agrees`, () => {
      for (const node of nodes) {
        if (typeof node.start !== "number") {
          continue;
        }
        assert.ok(node.start <= node.end && node.end <= src.length, `${node.type} range`);
        if (node.loc) {
          assert.equal(node.loc.start.index, node.start, `${node.type} loc.start`);
          assert.equal(node.loc.end.index, node.end, `${node.type} loc.end`);
        }
      }
    });

    check(`${name}: identifiers slice to their own name`, () => {
      for (const node of nodes) {
        // Babel's range of an annotated identifier (`results: string[]`) includes the annotation
        if (
          (node.type === "Identifier" || node.type === "JSXIdentifier") &&
          node.end > node.start &&
          !node.typeAnnotation &&
          !node.optional
        ) {
          assert.equal(src.slice(node.start, node.end), node.name);
        }
      }
    });

    check(`${name}: no parse errors`, () => {
      assert.deepEqual(json.ast.errors ?? [], []);
    });

    if (babelTypes) {
      check(`${name}: only stock Babel node types`, () => {
        for (const node of nodes) {
          assert.ok(babelTypes.has(node.type), `unexpected type ${node.type}`);
        }
      });
    }
  }

  check("search.astro: frontmatter first, template last", () => {
    const body = byName["search.astro"].ast.program.body;
    assert.equal(body[0].type, "ImportDeclaration");
    const last = body[body.length - 1];
    assert.equal(last.type, "ExpressionStatement");
    assert.equal(last.expression.type, "JSXFragment");
  });

  check("search.astro: set:html is a namespaced attribute with an expression value", () => {
    const attr = nodesOf(byName["search.astro"].ast).find(
      (n) => n.type === "JSXAttribute" && n.name.type === "JSXNamespacedName" && n.name.name.name === "html"
    );
    assert.ok(attr, "set:html attribute");
    assert.equal(attr.name.namespace.name, "set");
    assert.equal(attr.value.type, "JSXExpressionContainer");
    assert.equal(attr.value.expression.type, "Identifier");
    assert.equal(attr.value.expression.name, "q");
  });

  check("search.astro: expressions holding JSX, and JSX text with an apostrophe", () => {
    const nodes = nodesOf(byName["search.astro"].ast);
    assert.ok(nodes.some((n) => n.type === "CallExpression" && n.callee.property?.name === "map"));
    assert.ok(nodes.some((n) => n.type === "LogicalExpression" && n.right.type === "JSXElement"));
    assert.ok(!nodes.some((n) => n.type === "Identifier" && n.name === "__astgen_unparsed"));
  });

  check("search.astro: a template-literal attribute is a TemplateLiteral", () => {
    const href = nodesOf(byName["search.astro"].ast).find(
      (n) => n.type === "JSXAttribute" && n.name.name === "href"
    );
    assert.equal(href.value.expression.type, "TemplateLiteral");
  });

  check("Card.astro: shorthand and spread attributes, client script statements", () => {
    const nodes = nodesOf(byName["Card.astro"].ast);
    assert.ok(nodes.some((n) => n.type === "JSXSpreadAttribute"));
    assert.ok(nodes.some((n) => n.type === "JSXAttribute" && n.name.name === "title" && n.value?.type === "JSXExpressionContainer"));
    const imports = byName["Card.astro"].ast.program.body.filter((s) => s.type === "ImportDeclaration");
    assert.equal(imports.length, 1);
    assert.equal(imports[0].source.value, "../lib/track");
  });

  check("Plain.astro: no frontmatter - the template alone", () => {
    const body = byName["Plain.astro"].ast.program.body;
    assert.equal(body.length, 1);
    assert.equal(body[0].expression.type, "JSXFragment");
  });
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} Astro regression check(s) failed`);
  process.exit(1);
}
console.log("Astro regression checks passed");
