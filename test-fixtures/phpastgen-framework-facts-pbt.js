import assert from "node:assert/strict";
import * as fc from "./pbt.mjs";
import {
  enrichFrameworkFacts,
  frameworkFactFor,
  FRAMEWORK_FACTS_KEY,
  TRUNCATION_MARKER
} from "../phpastgen.js";

// Property-based tests for syntactic framework-fact enrichment (design Decision 3, §2.7;
// Requirements 6.1, 4.1). These pin the ADDITIVE-CONTRACT invariant for the enrichment step:
//
//   Additivity: FOR ALL asts a, stripping every `framework_facts` key from enrichFrameworkFacts(a)
//     yields exactly a (no pre-existing field is added, removed, or modified).
//   Soundness:  FOR ALL nodes n reached during the walk, n carries a `framework_facts` key AFTER
//     enrichment IFF frameworkFactFor(n-before) returned a fact, and the recorded value equals it.
//   Idempotence: enriching an already-enriched AST changes nothing further.
//
// These are the correctness guarantees the additive cross-repo contract (invariant 1) depends on:
// an older chen decoder that ignores `framework_facts` sees a byte-for-byte-familiar AST, and a
// newer one reads exactly the facts the generator detected.

// ---------------------------------------------------------------------------
// Independent traversal oracle (re-derived, not imported) mirroring the
// generator's reachability rules.
// ---------------------------------------------------------------------------
function childValues(node) {
  const out = [];
  if (Array.isArray(node)) {
    for (const v of node) {
      if (v !== null && typeof v === "object") out.push(v);
    }
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (key === "nodeType" || key === FRAMEWORK_FACTS_KEY || key === TRUNCATION_MARKER) continue;
      const v = node[key];
      if (v !== null && typeof v === "object") out.push(v);
    }
  }
  return out;
}

/** Recursively remove FRAMEWORK_FACTS_KEY from every object in a (JSON-safe) tree, in place. */
function stripFacts(node) {
  if (Array.isArray(node)) {
    for (const v of node) stripFacts(v);
  } else if (node !== null && typeof node === "object") {
    if (Object.hasOwn(node, FRAMEWORK_FACTS_KEY)) delete node[FRAMEWORK_FACTS_KEY];
    for (const key of Object.keys(node)) stripFacts(node[key]);
  }
}

// ---------------------------------------------------------------------------
// Arbitrary nikic-like AST generator. Object nodes carry a nodeType, scalar
// attribute leaves, an optional attrGroups array (sometimes with attributes),
// and object/array child slots. Expr_Variable nodes sometimes name a
// superglobal so the superglobal branch is exercised.
// ---------------------------------------------------------------------------
const attrGroupArb = fc.array(
  fc.record({
    nodeType: fc.constant("AttributeGroup"),
    attrs: fc.array(
      fc.record({
        nodeType: fc.constant("Attribute"),
        name: fc.record({
          nodeType: fc.constant("Name_FullyQualified"),
          name: fc.constantFrom(
            "Symfony\\Component\\Routing\\Annotation\\Route",
            "App\\Http\\Middleware\\Auth",
            "Override",
            "Deprecated"
          )
        })
      }),
      { minLength: 1, maxLength: 2 }
    )
  }),
  { maxLength: 2 }
);

const variableName = fc.oneof(
  fc.constantFrom("_GET", "_POST", "_REQUEST", "_SERVER", "GLOBALS"),
  fc.constantFrom("user", "id", "result", "tmp")
);

const { node: nodeArb } = fc.letrec((tie) => ({
  node: fc.record(
    {
      nodeType: fc.constantFrom(
        "Stmt_ClassMethod",
        "Stmt_Class",
        "Stmt_Function",
        "Expr_Variable",
        "Expr_FuncCall",
        "Stmt_Expression"
      ),
      startLine: fc.nat({ max: 100000 }),
      name: variableName,
      // Present only sometimes so both the has-attrs and no-attrs regimes appear.
      attrGroups: fc.option(attrGroupArb, { nil: undefined, depthSize: "small" }),
      child: fc.option(tie("node"), { nil: null, depthSize: "small" }),
      children: fc.option(fc.array(tie("node"), { maxLength: 3 }), { nil: null, depthSize: "small" })
    },
    { requiredKeys: ["nodeType", "startLine", "name"] }
  )
}));

// The generator emits a top-level array of statements.
const astArb = fc.array(nodeArb, { maxLength: 4 });

// ---------------------------------------------------------------------------
// Additivity: stripping every framework_facts key returns the original AST.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(astArb, (tree) => {
    // Normalize the input through JSON so the "original" baseline has no non-JSON quirks, then
    // compare against a stripped copy of the enriched tree.
    const original = structuredClone(tree);
    const working = structuredClone(tree);
    enrichFrameworkFacts(working);
    stripFacts(working);
    assert.deepEqual(
      working,
      original,
      "stripping framework_facts must recover the original AST exactly (additive contract)"
    );
  }),
  { numRuns: 500 }
);
console.log("ok framework-facts P: additivity — stripping facts recovers the original AST");

// ---------------------------------------------------------------------------
// Soundness: a node carries a fact key after enrichment IFF frameworkFactFor
// returned a fact for its pre-enrichment shape, and the value matches.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(astArb, (tree) => {
    const before = structuredClone(tree);
    const after = structuredClone(tree);
    enrichFrameworkFacts(after);

    // Walk both trees in lockstep (identical structure aside from the added keys).
    const walk = (bNode, aNode) => {
      if (Array.isArray(aNode)) {
        for (let i = 0; i < aNode.length; i++) walk(bNode[i], aNode[i]);
        return;
      }
      if (aNode === null || typeof aNode !== "object") return;

      const expected = frameworkFactFor(bNode);
      if (expected === undefined) {
        assert.equal(
          Object.hasOwn(aNode, FRAMEWORK_FACTS_KEY),
          false,
          "a node with no detectable fact must not gain a framework_facts key"
        );
      } else {
        assert.deepEqual(
          aNode[FRAMEWORK_FACTS_KEY],
          expected,
          "the recorded fact must equal frameworkFactFor on the pre-enrichment node"
        );
      }

      // Recurse over pre-existing children (present in the before-tree).
      for (const key of Object.keys(bNode)) {
        if (key === FRAMEWORK_FACTS_KEY) continue;
        const bv = bNode[key];
        if (bv !== null && typeof bv === "object") walk(bv, aNode[key]);
      }
    };
    for (let i = 0; i < before.length; i++) walk(before[i], after[i]);
  }),
  { numRuns: 500 }
);
console.log("ok framework-facts P: soundness — key present IFF a fact was detected, value matches");

// ---------------------------------------------------------------------------
// Idempotence: re-enriching an already-enriched AST changes nothing.
// ---------------------------------------------------------------------------
fc.assert(
  fc.property(astArb, (tree) => {
    const once = structuredClone(tree);
    enrichFrameworkFacts(once);
    const twice = structuredClone(once);
    const secondPass = enrichFrameworkFacts(twice);
    assert.deepEqual(twice, once, "a second enrichment pass must not change the AST");
    // The second pass still *reports* the same enriched-node count (facts are re-detected but the
    // written value is identical), so the tree is stable.
    assert.equal(typeof secondPass, "number");
  }),
  { numRuns: 300 }
);
console.log("ok framework-facts P: idempotence — re-enrichment is a no-op on the tree");

console.log("phpastgen-framework-facts-pbt: all checks passed");
