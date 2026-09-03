import assert from "node:assert/strict";
import * as fc from "./pbt.mjs";
import {
  truncateDeep,
  serializerNestingLimit,
  TRUNCATION_MARKER
} from "../phpastgen.js";

// Property-based tests for phpastgen depth truncation (design §2.3.2, §2.11, Requirement 2.6).
//
// Property 6 (P6): Depth-truncation soundness.
//   FOR ALL asts a, depth k: after truncateDeep(a, k)
//     1. no surviving node is deeper than k (the cap holds),
//     2. serialize(truncate(a, k)) SUCCEEDS, and
//     3. the returned count equals the number of cut points (truncation boundaries).
//
// truncateDeep(node, maxDepth) mutates the tree in place and returns the number of truncation
// points. A node reached at depth >= maxDepth whose child-node entries are non-empty is a cut
// point: its child subtrees are detached (object properties deleted / array holes compacted) and,
// on object nodes, `truncated: true` is set. Each such boundary contributes exactly 1 to the
// count. Node depth is 0-based at the root; children are the object/array-valued properties
// (excluding `nodeType` and the truncation marker) plus array elements — the same reachability
// used by the implementation.
//
// **Validates: Requirement 2.6** — Property: P6

// ---------------------------------------------------------------------------
// Independent reachability oracle. Deliberately re-derives child reachability
// (rather than importing the private helper) so the test is an independent
// check of the implementation's traversal contract.
// ---------------------------------------------------------------------------

/** Child AST nodes reachable from `node`, mirroring the generator's traversal rules. */
function childNodes(node) {
  const out = [];
  if (Array.isArray(node)) {
    for (const value of node) {
      if (value !== null && typeof value === "object") {
        out.push(value);
      }
    }
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (key === "nodeType" || key === TRUNCATION_MARKER) {
        continue;
      }
      const value = node[key];
      if (value !== null && typeof value === "object") {
        out.push(value);
      }
    }
  }
  return out;
}

/** Maximum depth of any node in the tree (root = 0). Non-object roots have depth -Infinity. */
function maxNodeDepth(node, depth = 0) {
  if (node === null || typeof node !== "object") {
    return -Infinity;
  }
  let deepest = depth;
  for (const child of childNodes(node)) {
    deepest = Math.max(deepest, maxNodeDepth(child, depth + 1));
  }
  return deepest;
}

/**
 * Independently count the cut points truncateDeep *should* introduce for a fresh copy of `node`
 * under `maxDepth`: a node at depth >= maxDepth that has at least one child-node entry is one cut.
 */
function expectedCutPoints(node, maxDepth, depth = 0) {
  if (node === null || typeof node !== "object") {
    return 0;
  }
  const children = childNodes(node);
  if (depth >= maxDepth) {
    return children.length > 0 ? 1 : 0;
  }
  let count = 0;
  for (const child of children) {
    count += expectedCutPoints(child, maxDepth, depth + 1);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Arbitrary nested tree generator. Produces plain objects/arrays resembling
// nikic AST nodes so both the shallow (no truncation) and deep (many cuts)
// regimes are exercised.
// ---------------------------------------------------------------------------

const leafValue = fc.oneof(
  fc.integer(),
  fc.boolean(),
  fc.string(),
  fc.constant(null)
);

// A node is an object with a `nodeType` tag, a scattering of scalar leaf attributes, and
// object/array-valued child slots. fc.letrec builds arbitrarily deep, arbitrarily wide trees.
const { node: nodeArb } = fc.letrec((tie) => ({
  node: fc.record({
    nodeType: fc.constantFrom(
      "Stmt_Expression",
      "Expr_FuncCall",
      "Expr_BinaryOp_Plus",
      "Stmt_If",
      "Scalar_Int"
    ),
    startLine: fc.nat({ max: 100000 }),
    startFilePos: fc.nat({ max: 1000000 }),
    // Scalar leaf attributes (never counted as child nodes).
    name: fc.string(),
    flags: fc.nat({ max: 255 }),
    // Child slots: an optional single child and an optional list of children. Depth-limited so
    // runs stay bounded while still reaching well past small caps. The absent case is `null`
    // (JSON-representable) rather than `undefined`, so the tree survives a JSON round-trip
    // faithfully; `null`-valued keys are never treated as child nodes by the traversal.
    child: fc.option(tie("node"), { nil: null, depthSize: "small" }),
    children: fc.option(
      fc.array(tie("node"), { maxLength: 3 }),
      { nil: null, depthSize: "small" }
    )
  })
}));

// A maxDepth spanning boundary cases: 1 (root's children cut) through moderate depths that many
// generated trees never reach (no truncation at all).
const maxDepthArb = fc.integer({ min: 1, max: 12 });

// ---------------------------------------------------------------------------
// P6a — Depth cap: no surviving node is deeper than maxDepth.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(nodeArb, maxDepthArb, (tree, maxDepth) => {
    // truncateDeep mutates in place; operate on a deep copy so the original stays intact for the
    // other assertions in this property body.
    const clone = structuredClone(tree);
    truncateDeep(clone, maxDepth);
    const surviving = maxNodeDepth(clone);
    assert.ok(
      surviving <= maxDepth,
      `surviving max depth ${surviving} must not exceed the cap ${maxDepth}`
    );
  }),
  { numRuns: 500 }
);
console.log("ok P6 depth cap: no surviving node deeper than maxDepth");

// ---------------------------------------------------------------------------
// P6b — Serialization: the truncated tree still serializes to JSON, and within
// the serializer nesting budget derived from maxDepth.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(nodeArb, maxDepthArb, (tree, maxDepth) => {
    const clone = structuredClone(tree);
    truncateDeep(clone, maxDepth);
    // JSON.stringify must succeed (no cycles, no dangling references after truncation).
    const serialized = JSON.stringify(clone);
    assert.equal(typeof serialized, "string", "truncated tree must serialize to a JSON string");
    assert.deepEqual(
      JSON.parse(serialized),
      clone,
      "serialized truncated tree must round-trip through JSON"
    );
    // The surviving nesting must sit within the serializer budget derived from the cap.
    const budget = serializerNestingLimit(maxDepth);
    assert.ok(
      maxNodeDepth(clone) < budget,
      `surviving nesting must fit the serializer budget ${budget}`
    );
  }),
  { numRuns: 500 }
);
console.log("ok P6 serialization: truncated tree serializes within nesting budget");

// ---------------------------------------------------------------------------
// P6c — Count soundness: the returned count equals the number of cut points,
// independently computed against a pristine copy of the input.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(nodeArb, maxDepthArb, (tree, maxDepth) => {
    const expected = expectedCutPoints(structuredClone(tree), maxDepth);
    const clone = structuredClone(tree);
    const actual = truncateDeep(clone, maxDepth);
    assert.equal(
      actual,
      expected,
      `returned truncation count ${actual} must equal the ${expected} cut points`
    );

    // A cut boundary on an object node is tagged truncated: true and, having had its children
    // detached, exposes no reachable child nodes. Every object node so tagged is a genuine cut.
    let taggedBoundaries = 0;
    const seen = new Set();
    const stack = [clone];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === null || typeof current !== "object" || seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (!Array.isArray(current) && current.truncated === true) {
        taggedBoundaries += 1;
        assert.equal(
          childNodes(current).length,
          0,
          "a truncated object boundary must have no surviving child nodes"
        );
      }
      for (const child of childNodes(current)) {
        stack.push(child);
      }
    }
    // Object boundaries are a subset of all cut points (array boundaries carry no marker), so the
    // tagged count never exceeds the returned count.
    assert.ok(
      taggedBoundaries <= actual,
      `tagged object boundaries ${taggedBoundaries} cannot exceed total cuts ${actual}`
    );
  }),
  { numRuns: 500 }
);
console.log("ok P6 count soundness: returned count equals number of cut points");

// ---------------------------------------------------------------------------
// P6d — Concrete regression anchors covering the boundary and no-op regimes.
// ---------------------------------------------------------------------------
{
  // A three-level chain root -> child -> grandchild. maxDepth = 1 cuts the root's descendants:
  // the single boundary is the root (depth 0 >= 1? no) ... at depth 1 the child is the boundary.
  const chain = {
    nodeType: "Stmt_Expression",
    child: {
      nodeType: "Expr_FuncCall",
      child: { nodeType: "Scalar_Int", value: 1 }
    }
  };
  const clone = structuredClone(chain);
  const cuts = truncateDeep(clone, 1);
  assert.equal(cuts, 1, "maxDepth=1 chain has exactly one cut point (the depth-1 child)");
  assert.equal(clone.child.truncated, true, "the depth-1 child is marked as a boundary");
  assert.ok(!Object.hasOwn(clone.child, "child"), "the boundary child's descendants are detached");
  assert.equal(maxNodeDepth(clone), 1, "no surviving node is deeper than the cap");
  assert.equal(typeof JSON.stringify(clone), "string", "truncated chain serializes");
  console.log("ok P6 concrete: shallow-cap chain truncates to one boundary");
}
{
  // A tree entirely within the cap must be left untouched: zero cuts, identical shape.
  const shallow = {
    nodeType: "Stmt_If",
    startLine: 1,
    children: [{ nodeType: "Scalar_Int", value: 2 }]
  };
  const clone = structuredClone(shallow);
  const cuts = truncateDeep(clone, 10);
  assert.equal(cuts, 0, "a tree within the cap has zero cut points");
  assert.deepEqual(clone, shallow, "a within-cap tree is left unchanged");
  console.log("ok P6 concrete: within-cap tree is untouched");
}

console.log("phpastgen-truncation-pbt: all checks passed");
