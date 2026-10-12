// Alpine regression tests for astgen.
//
// astgen lowers an Alpine `.html` page to stock Babel AST: an inline x-data
// object's properties become one variable each, a named x-data becomes a call
// of that name, x-init becomes its statements, and elements with x-html /
// x-bind:* / x-text become JSX elements whose attribute values are the
// directive expressions (see alpineAst.js). The contract these tests pin:
//
//   1. Every emitted node's [start, end) is an absolute offset into the
//      original `.html` file, and `loc` agrees with it.
//   2. Every emitted node `type` is a stock Babel node type.
//   3. The shapes downstream relies on: the inline object's property value is
//      the original expression at its own offsets; x-init is an expression
//      statement; x-html lowers to a JSXAttribute whose name is innerHTML and
//      whose value is the directive's expression; x-bind:href to href.
//   4. A page without Alpine directives is dropped (null), as before.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAlpineFile } from "../alpineAst.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixture = join(__dirname, "projects", "alpine-precision", "index.html");
const code = readFileSync(fixture, "utf-8");

let babelTypes = null;
try {
  babelTypes = new Set(Object.keys((await import("@babel/types")).VISITOR_KEYS));
} catch {
  console.warn("@babel/types not resolvable; skipping the node-type vocabulary check");
}

const ast = parseAlpineFile(fixture, code);
assert.ok(ast, "the Alpine page parses");

const walk = (node, fn) => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, fn);
    return;
  }
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range") continue;
    walk(node[key], fn);
  }
};

const lineStarts = [0];
for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);

walk(ast, (node) => {
  if (typeof node.start === "number" && typeof node.end === "number") {
    assert.ok(node.start >= 0 && node.end <= code.length, "offsets are inside the file");
    assert.ok(node.end >= node.start, "end is not before start");
    if (node.loc) {
      assert.equal(node.loc.start.index, node.start, "loc.start.index agrees with start");
      assert.equal(node.loc.end.index, node.end, "loc.end.index agrees with end");
    }
  }
  if (babelTypes && node.type) {
    assert.ok(babelTypes.has(node.type), `stock Babel node type: ${node.type}`);
  }
});

const body = ast.program.body;

// the inline object's property: `var fragment = decodeURIComponent(...)`
const fragment = body.find(
  (s) =>
    s.type === "VariableDeclaration" &&
    s.declarations[0]?.id?.name === "fragment"
);
assert.ok(fragment, "the inline x-data object's property becomes a variable");
assert.equal(
  fragment.declarations[0].init.type,
  "CallExpression",
  "the property's value is the original call"
);
assert.equal(
  code.slice(fragment.declarations[0].init.start, fragment.declarations[0].init.end),
  "decodeURIComponent(location.hash.slice(1))",
  "the value's offsets select its own source text"
);

// x-init is an expression statement at its own offsets
const init = body.find(
  (s) => s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression"
);
assert.ok(init, "x-init becomes an assignment statement");
assert.equal(
  code.slice(init.start, init.end),
  "next = new URLSearchParams(location.search).get('next') ?? '/'",
  "the x-init statement keeps its source text"
);

// a named x-data becomes a call of that name
const named = body.find(
  (s) =>
    s.type === "VariableDeclaration" &&
    s.declarations[0]?.id?.name === "search_data"
);
assert.ok(named, "a named x-data becomes <name>_data");
assert.equal(named.declarations[0].init.type, "CallExpression");

// the JSX elements: x-html -> innerHTML, x-bind:href -> href
const exprStmt = body.find((s) => s.type === "ExpressionStatement" && s.expression.type === "JSXFragment");
assert.ok(exprStmt, "the lowered elements form one JSX fragment");
const elements = exprStmt.expression.children;
const byAttr = (name) =>
  elements.filter((el) =>
    el.openingElement.attributes.some((a) => a.name.name === name)
  );
assert.equal(byAttr("innerHTML").length, 3, "three x-html elements");
assert.equal(byAttr("href").length, 1, "x-bind:href becomes href");
assert.equal(byAttr("x-text").length, 1, "x-text keeps its own name");

// a page without directives stays unparsed
const plain = parseAlpineFile(
  join(__dirname, "projects", "alpine-precision", "plain.html")?.replace?.("undefined", "") || "x.html",
  "<html><body><p>plain</p></body></html>"
);
assert.equal(plain, null, "no Alpine directive -> no AST");

console.log("astgen-alpine-regression: all assertions passed");
