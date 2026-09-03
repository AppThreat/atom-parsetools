import assert from "node:assert/strict";
import {
  attributeNames,
  frameworkFactFor,
  enrichFrameworkFacts,
  FRAMEWORK_FACTS_KEY,
  SUPERGLOBAL_NAMES
} from "../phpastgen.js";

// Unit tests for syntactic framework-fact enrichment (design Decision 3, §2.7; Requirements 6.1,
// 4.1). The generator surfaces two syntactic facts already visible in the AST — attribute groups
// (e.g. #[Route(...)]) and PHP superglobal references ($_GET/$_POST/$_REQUEST) — as an additive
// per-node `framework_facts` key. Every check here also pins the additive contract: the key is
// emitted ONLY where a fact holds, and no pre-existing node field is ever mutated.

// ---------------------------------------------------------------------------
// attributeNames: flat list of declared attribute names across all groups.
// ---------------------------------------------------------------------------
{
  const method = {
    nodeType: "Stmt_ClassMethod",
    attrGroups: [
      {
        nodeType: "AttributeGroup",
        attrs: [
          {
            nodeType: "Attribute",
            name: { nodeType: "Name_FullyQualified", name: "Symfony\\Component\\Routing\\Annotation\\Route" }
          }
        ]
      }
    ]
  };
  assert.deepEqual(attributeNames(method), [
    "Symfony\\Component\\Routing\\Annotation\\Route"
  ]);

  // Multiple groups / multiple attrs are flattened in declaration order.
  const multi = {
    nodeType: "Stmt_ClassMethod",
    attrGroups: [
      { nodeType: "AttributeGroup", attrs: [{ name: { name: "Route" } }, { name: { name: "Deprecated" } }] },
      { nodeType: "AttributeGroup", attrs: [{ name: { name: "Override" } }] }
    ]
  };
  assert.deepEqual(attributeNames(multi), ["Route", "Deprecated", "Override"]);

  // Empty / absent attrGroups yields no names.
  assert.deepEqual(attributeNames({ nodeType: "Stmt_Class", attrGroups: [] }), []);
  assert.deepEqual(attributeNames({ nodeType: "Stmt_Class" }), []);
  assert.deepEqual(attributeNames(null), []);
  assert.deepEqual(attributeNames([1, 2]), []);
  console.log("ok framework-facts: attributeNames flattens groups, empty otherwise");
}

// ---------------------------------------------------------------------------
// frameworkFactFor: attribute-group fact.
// ---------------------------------------------------------------------------
{
  const routed = {
    nodeType: "Stmt_ClassMethod",
    attrGroups: [{ attrs: [{ name: { name: "App\\Route" } }] }]
  };
  const fact = frameworkFactFor(routed);
  assert.deepEqual(fact, { attributes: ["App\\Route"] });

  // No attribute groups → no fact at all (so the caller omits the key).
  assert.equal(frameworkFactFor({ nodeType: "Stmt_ClassMethod", attrGroups: [] }), undefined);
  assert.equal(frameworkFactFor({ nodeType: "Stmt_Function" }), undefined);
  console.log("ok framework-facts: attribute-group fact detected, omitted otherwise");
}

// ---------------------------------------------------------------------------
// frameworkFactFor: superglobal fact, with request-source flag.
// ---------------------------------------------------------------------------
{
  const get = { nodeType: "Expr_Variable", name: "_GET" };
  assert.deepEqual(frameworkFactFor(get), { superglobal: "_GET", request: true });

  for (const req of ["_GET", "_POST", "_REQUEST", "_COOKIE", "_FILES"]) {
    assert.deepEqual(frameworkFactFor({ nodeType: "Expr_Variable", name: req }), {
      superglobal: req,
      request: true
    });
  }

  // Ambient superglobals are recorded but flagged request:false.
  for (const ambient of ["_SERVER", "_SESSION", "_ENV", "GLOBALS"]) {
    assert.deepEqual(frameworkFactFor({ nodeType: "Expr_Variable", name: ambient }), {
      superglobal: ambient,
      request: false
    });
  }

  // A plain local variable is not a superglobal → no fact.
  assert.equal(frameworkFactFor({ nodeType: "Expr_Variable", name: "user" }), undefined);
  // A non-variable node named like a superglobal is not matched.
  assert.equal(frameworkFactFor({ nodeType: "Scalar_String", name: "_GET" }), undefined);
  console.log("ok framework-facts: superglobal fact detected with request flag");
}

// ---------------------------------------------------------------------------
// frameworkFactFor: a node can carry BOTH facts under distinct keys.
// ---------------------------------------------------------------------------
{
  // Contrived but valid: a variable-shaped node that also declares attributes.
  const both = {
    nodeType: "Expr_Variable",
    name: "_POST",
    attrGroups: [{ attrs: [{ name: { name: "Sensitive" } }] }]
  };
  assert.deepEqual(frameworkFactFor(both), {
    attributes: ["Sensitive"],
    superglobal: "_POST",
    request: true
  });
  console.log("ok framework-facts: both facts coexist under distinct keys");
}

// ---------------------------------------------------------------------------
// enrichFrameworkFacts: additive walk over a realistic AST.
// ---------------------------------------------------------------------------
{
  // Deep-freeze-then-compare approach: snapshot the AST, enrich, and assert the only differences
  // are the added framework_facts keys.
  const ast = [
    {
      nodeType: "Stmt_Class",
      attributes: { startLine: 1 },
      name: { nodeType: "Identifier", name: "C" },
      attrGroups: [],
      stmts: [
        {
          nodeType: "Stmt_ClassMethod",
          attributes: { startLine: 2 },
          name: { nodeType: "Identifier", name: "index" },
          attrGroups: [{ attrs: [{ name: { name: "App\\Route" } }] }],
          stmts: [
            {
              nodeType: "Stmt_Expression",
              expr: {
                nodeType: "Expr_ArrayDimFetch",
                var: { nodeType: "Expr_Variable", name: "_GET" },
                dim: { nodeType: "Scalar_String", value: "id" }
              }
            },
            {
              nodeType: "Stmt_Expression",
              expr: { nodeType: "Expr_Variable", name: "localVar" }
            }
          ]
        }
      ]
    }
  ];

  const enriched = enrichFrameworkFacts(ast);
  assert.equal(enriched, 2, "the routed method and the $_GET variable are enriched");

  const method = ast[0].stmts[0];
  assert.deepEqual(method[FRAMEWORK_FACTS_KEY], { attributes: ["App\\Route"] });

  const getVar = method.stmts[0].expr.var;
  assert.deepEqual(getVar[FRAMEWORK_FACTS_KEY], { superglobal: "_GET", request: true });

  // Pre-existing fields on enriched nodes are untouched.
  assert.equal(method.nodeType, "Stmt_ClassMethod");
  assert.deepEqual(method.attrGroups, [{ attrs: [{ name: { name: "App\\Route" } }] }]);
  assert.equal(getVar.nodeType, "Expr_Variable");
  assert.equal(getVar.name, "_GET");

  // The class (empty attrGroups) and the local variable carry NO fact key.
  assert.equal(Object.hasOwn(ast[0], FRAMEWORK_FACTS_KEY), false, "class with empty attrGroups is not enriched");
  const localVar = method.stmts[1].expr;
  assert.equal(Object.hasOwn(localVar, FRAMEWORK_FACTS_KEY), false, "a local variable is not enriched");

  console.log("ok framework-facts: enrichment is additive and precisely targeted");
}

// ---------------------------------------------------------------------------
// enrichFrameworkFacts: an AST with no framework facts is left entirely alone.
// ---------------------------------------------------------------------------
{
  const plain = [
    {
      nodeType: "Stmt_Function",
      attrGroups: [],
      stmts: [{ nodeType: "Stmt_Expression", expr: { nodeType: "Expr_Variable", name: "x" } }]
    }
  ];
  const before = JSON.stringify(plain);
  const count = enrichFrameworkFacts(plain);
  assert.equal(count, 0, "a fact-free AST enriches zero nodes");
  assert.equal(JSON.stringify(plain), before, "a fact-free AST is byte-for-byte unchanged");
  console.log("ok framework-facts: fact-free AST unchanged (additive invariant)");
}

// ---------------------------------------------------------------------------
// enrichFrameworkFacts: cycle tolerance (defensive; nikic ASTs are trees).
// ---------------------------------------------------------------------------
{
  const a = { nodeType: "Expr_Variable", name: "_REQUEST" };
  const b = { nodeType: "Stmt_Expression", expr: a };
  a.parent = b; // introduce a cycle
  const count = enrichFrameworkFacts([b]);
  assert.equal(count, 1, "the superglobal is enriched exactly once despite the cycle");
  assert.deepEqual(a[FRAMEWORK_FACTS_KEY], { superglobal: "_REQUEST", request: true });
  console.log("ok framework-facts: cyclic graph terminates and enriches once");
}

// Sanity: the documented superglobal set covers the request-borne trio called out in the design.
for (const req of ["_GET", "_POST", "_REQUEST"]) {
  assert.equal(SUPERGLOBAL_NAMES.has(req), true, `${req} must be a recognized superglobal`);
}

console.log("phpastgen-framework-facts: all checks passed");
