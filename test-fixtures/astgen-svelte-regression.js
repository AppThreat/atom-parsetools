// Svelte regression tests for astgen.
//
// astgen maps `.svelte` single-file components onto Babel AST nodes by using
// the Svelte compiler purely as a segmenter and re-emitting the template as
// standard JSX. The contract these tests pin:
//
//   1. Every emitted node's [start, end) is an absolute byte offset into the
//      original `.svelte` file - `src.slice(start, end)` must reproduce the
//      node's own source text. (Before Svelte support, offsets were relative
//      to the extracted script block and every `code` field downstream was
//      shifted garbage.)
//   2. Every emitted node `type` is a stock Babel node type, so consumers
//      built against Babel JSX need no changes.
//   3. Each Svelte template construct maps onto the documented Babel shape
//      (conditional chains for {#if}, `.map()` calls for {#each}, and so on).
//   4. Type inference covers runes ($state/$derived/$props) via the same
//      virtual-program strategy used for Vue.
//
// The fixture project is test-fixtures/projects/svelte-precision; see its
// README for which component exercises which construct.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputRoot,
  runAstgen,
  readJson,
  countUnresolved,
  expectType,
  loadFixtureSet
} from "./ast-regression-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputRoot = createOutputRoot("atom-parsetools-svelte-");
const fixtureRoot = join(__dirname, "projects", "svelte-precision");

// ---------------------------------------------------------------------------
// Invariant 2, in executable form: the complete set of node types astgen may
// emit for Svelte files. This is the node-type vocabulary of the Babel AST
// (as enumerated by downstream consumers such as chen's BabelAst) - a Svelte
// file must not introduce any type outside it.
// ---------------------------------------------------------------------------
const BABEL_NODE_TYPES = new Set([
  "AnyTypeAnnotation", "ArgumentPlaceholder", "ArrayExpression", "ArrayPattern",
  "ArrayTypeAnnotation", "ArrowFunctionExpression", "AssignmentExpression",
  "AssignmentPattern", "AwaitExpression", "BigIntLiteral", "BinaryExpression",
  "BindExpression", "BlockStatement", "BooleanLiteral",
  "BooleanLiteralTypeAnnotation", "BooleanTypeAnnotation", "BreakStatement",
  "CallExpression", "CatchClause", "ClassAccessorProperty", "ClassBody",
  "ClassDeclaration", "ClassExpression", "ClassImplements", "ClassMethod",
  "ClassPrivateMethod", "ClassPrivateProperty", "ClassProperty",
  "ConditionalExpression", "ContinueStatement", "DebuggerStatement",
  "DecimalLiteral", "DeclareClass", "DeclaredPredicate",
  "DeclareExportAllDeclaration", "DeclareExportDeclaration", "DeclareFunction",
  "DeclareInterface", "DeclareModule", "DeclareModuleExports",
  "DeclareOpaqueType", "DeclareTypeAlias", "DeclareVariable", "Decorator",
  "Directive", "DirectiveLiteral", "DoExpression", "DoWhileStatement",
  "EmptyStatement", "EmptyTypeAnnotation", "EnumBooleanBody",
  "EnumBooleanMember", "EnumDeclaration", "EnumDefaultedMember",
  "EnumNumberBody", "EnumNumberMember", "EnumStringBody", "EnumStringMember",
  "EnumSymbolBody", "ExistsTypeAnnotation", "ExportAllDeclaration",
  "ExportDefaultDeclaration", "ExportDefaultSpecifier",
  "ExportNamedDeclaration", "ExportNamespaceSpecifier", "ExportSpecifier",
  "ExpressionStatement", "File", "ForInStatement", "ForOfStatement",
  "ForStatement", "FunctionDeclaration", "FunctionExpression",
  "FunctionTypeAnnotation", "FunctionTypeParam", "GenericTypeAnnotation",
  "Identifier", "IfStatement", "Import", "ImportAttribute",
  "ImportDeclaration", "ImportDefaultSpecifier", "ImportExpression",
  "ImportNamespaceSpecifier", "ImportSpecifier", "IndexedAccessType",
  "InferredPredicate", "InterfaceDeclaration", "InterfaceExtends",
  "InterfaceTypeAnnotation", "InterpreterDirective",
  "IntersectionTypeAnnotation", "JSXAttribute", "JSXClosingElement",
  "JSXClosingFragment", "JSXElement", "JSXEmptyExpression",
  "JSXExpressionContainer", "JSXFragment", "JSXIdentifier",
  "JSXMemberExpression", "JSXNamespacedName", "JSXOpeningElement",
  "JSXOpeningFragment", "JSXSpreadAttribute", "JSXSpreadChild", "JSXText",
  "LabeledStatement", "LogicalExpression", "MemberExpression", "MetaProperty",
  "MixedTypeAnnotation", "ModuleExpression", "NewExpression", "Noop",
  "NullableTypeAnnotation", "NullLiteral", "NullLiteralTypeAnnotation",
  "NumberLiteral", "NumberLiteralTypeAnnotation", "NumberTypeAnnotation",
  "NumericLiteral", "ObjectExpression", "ObjectMethod", "ObjectPattern",
  "ObjectProperty", "ObjectTypeAnnotation", "ObjectTypeCallProperty",
  "ObjectTypeIndexer", "ObjectTypeInternalSlot", "ObjectTypeProperty",
  "ObjectTypeSpreadProperty", "OpaqueType", "OptionalCallExpression",
  "OptionalIndexedAccessType", "OptionalMemberExpression",
  "ParenthesizedExpression", "PipelineBareFunction",
  "PipelinePrimaryTopicReference", "PipelineTopicExpression", "Placeholder",
  "PrivateName", "Program", "QualifiedTypeIdentifier", "RecordExpression",
  "RegexLiteral", "RegExpLiteral", "RestElement", "RestProperty",
  "ReturnStatement", "SequenceExpression", "SpreadElement", "SpreadProperty",
  "StaticBlock", "StringLiteral", "StringLiteralTypeAnnotation",
  "StringTypeAnnotation", "Super", "SwitchCase", "SwitchStatement",
  "SymbolTypeAnnotation", "TaggedTemplateExpression", "TemplateElement",
  "TemplateLiteral", "ThisExpression", "ThisTypeAnnotation", "ThrowStatement",
  "TopicReference", "TryStatement", "TSAnyKeyword", "TSArrayType",
  "TSAsExpression", "TSBigIntKeyword", "TSBooleanKeyword",
  "TSCallSignatureDeclaration", "TSClassImplements", "TSConditionalType",
  "TSConstructorType", "TSConstructSignatureDeclaration", "TSDeclareFunction",
  "TSDeclareMethod", "TSEnumBody", "TSEnumDeclaration", "TSEnumMember",
  "TSExportAssignment", "TSExpressionWithTypeArguments",
  "TSExternalModuleReference", "TSFunctionType", "TSImportEqualsDeclaration",
  "TSImportType", "TSIndexedAccessType", "TSIndexSignature", "TSInferType",
  "TSInstantiationExpression", "TSInterfaceBody", "TSInterfaceDeclaration",
  "TSInterfaceHeritage", "TSIntersectionType", "TSIntrinsicKeyword",
  "TSLiteralType", "TSMappedType", "TSMethodSignature", "TSModuleBlock",
  "TSModuleDeclaration", "TSNamedTupleMember", "TSNamespaceExportDeclaration",
  "TSNeverKeyword", "TSNonNullExpression", "TSNullKeyword", "TSNumberKeyword",
  "TSObjectKeyword", "TSOptionalType", "TSParameterProperty",
  "TSParenthesizedType", "TSPropertySignature", "TSQualifiedName", "TSRestType",
  "TSSatisfiesExpression", "TSStringKeyword", "TSSymbolKeyword",
  "TSTemplateLiteralType", "TSThisType", "TSTupleType", "TSTypeAliasDeclaration",
  "TSTypeAnnotation", "TSTypeAssertion", "TSTypeCastExpression",
  "TSTypeExpression", "TSTypeLiteral", "TSTypeOperator", "TSTypeParameter",
  "TSTypeParameterDeclaration", "TSTypeParameterInstantiation",
  "TSTypePredicate", "TSTypeQuery", "TSTypeReference", "TSUndefinedKeyword",
  "TSUnionType", "TSUnknownKeyword", "TSVoidKeyword", "TupleExpression",
  "TupleTypeAnnotation", "TypeAlias", "TypeAnnotation", "TypeCastExpression",
  "TypeofTypeAnnotation", "TypeParameter", "TypeParameterDeclaration",
  "TypeParameterInstantiation", "UnaryExpression", "UnionTypeAnnotation",
  "UpdateExpression", "V8IntrinsicIdentifier", "VariableDeclaration",
  "VariableDeclarator", "Variance", "VoidTypeAnnotation", "WhileStatement",
  "WithStatement", "YieldExpression"
]);

// ---------------------------------------------------------------------------
// Small AST query helpers
// ---------------------------------------------------------------------------

/** Collect every node (depth-first) satisfying `predicate`. */
function collect(node, predicate, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) {
      collect(child, predicate, out);
    }
    return out;
  }
  if (!node || typeof node !== "object") {
    return out;
  }
  if (typeof node.type === "string" && predicate(node)) {
    out.push(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "loc") {
      continue;
    }
    collect(node[key], predicate, out);
  }
  return out;
}

/** Assert `node`'s range slices `src` to exactly `expected`. */
function expectSlice(src, node, expected, context) {
  const actual = src.slice(node.start, node.end);
  assert.equal(
    actual,
    expected,
    `${context}: expected range to slice to ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} (start=${node.start}, end=${node.end})`
  );
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

function runAstgenOnce(outputDir) {
  runAstgen(fixtureRoot, outputDir);
}

/** Invariant 1 + 2 over every .svelte fixture: types, ranges and loc alignment. */
function assertAstInvariants(fixtures) {
  for (const [relativeName, { code, ast }] of Object.entries(fixtures)) {
    if (!relativeName.endsWith(".svelte")) {
      // Plain .ts fixtures exist for type-inference assertions; their AST
      // shape is covered by the JS/TS regression suites.
      continue;
    }
    const violations = [];
    const visit = (node) => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== "object") {
        return;
      }
      if (typeof node.type === "string") {
        if (!BABEL_NODE_TYPES.has(node.type)) {
          violations.push(`unknown node type "${node.type}"`);
        }
        if (
          !(
            Number.isInteger(node.start) &&
            Number.isInteger(node.end) &&
            node.start >= 0 &&
            node.end >= node.start &&
            node.end <= code.length
          )
        ) {
          violations.push(
            `invalid range on ${node.type}: [${node.start}, ${node.end}) of ${code.length}`
          );
        } else if (
          !node.loc ||
          node.loc.start?.index !== node.start ||
          node.loc.end?.index !== node.end
        ) {
          violations.push(`loc misaligned on ${node.type} at ${node.start}`);
        }
      }
      for (const key of Object.keys(node)) {
        // `loc` is positional metadata; `comments` and the per-node
        // *Comments arrays are trivia. None participate in the Babel node
        // vocabulary consumers dispatch on.
        if (key === "loc" || key.endsWith("Comments")) {
          continue;
        }
        visit(node[key]);
      }
    };
    visit(ast);
    assert.deepEqual(
      violations,
      [],
      `${relativeName} violated AST invariants (first 5): ${JSON.stringify(violations.slice(0, 5))}`
    );
  }
}

/**
 * The core offset regression: script-derived nodes must carry absolute
 * offsets. The classic failure this catches is offsets relative to the
 * extracted script block (shifted by the `<script lang="ts">` prefix).
 */
function assertScriptOffsets(fixtures) {
  const fixture = fixtures["counter-runes.svelte"];
  const importDeclaration = fixture.ast.program.body.find(
    (n) => n.type === "ImportDeclaration"
  );
  assert.ok(importDeclaration, "counter-runes should contain an import");
  expectSlice(
    fixture.code,
    importDeclaration,
    "import { onMount } from 'svelte';",
    "counter-runes import"
  );
  // Offsets must be absolute, i.e. past the opening <script ...> tag.
  assert.ok(
    importDeclaration.start > fixture.code.indexOf("<script"),
    "import offsets must be absolute into the file, not script-relative"
  );

  const moduleFixture = fixtures["module-script.svelte"];
  const exportedConst = collect(moduleFixture.ast, (n) =>
    n.type === "ExportNamedDeclaration" &&
    n.declaration?.type === "VariableDeclaration"
  )[0];
  assert.ok(exportedConst, "module-script should export a const");
  expectSlice(
    moduleFixture.code,
    exportedConst,
    "export const GREETING_PREFIX = 'hello';",
    "module-script export"
  );
  // Both script blocks flatten into one program; nothing from the template
  // leaks into the statement list and vice versa.
  const statementTypes = moduleFixture.ast.program.body.map((n) => n.type);
  assert.ok(
    statementTypes.every((t) => t !== "JSXElement" && t !== "JSXFragment"),
    "template content must not appear as a program statement"
  );
}

function assertTemplateMapping(fixtures) {
  // -- {#if} / {:else if} / {:else} produce a ConditionalExpression chain ---
  {
    const { code, ast } = fixtures["counter-runes.svelte"];
    const chainDepth = (node) =>
      node.type === "ConditionalExpression" ? 1 + chainDepth(node.alternate) : 0;
    const conditionals = collect(ast, (n) => n.type === "ConditionalExpression");
    const templateChain = conditionals.filter((n) => chainDepth(n) === 2);
    assert.equal(
      templateChain.length,
      1,
      "{:else if} must splice the nested conditional in as the alternate (one chain of depth 2)"
    );
    const chain = templateChain[0];
    expectSlice(code, chain.test, "count > 10", "if test");
    expectSlice(code, chain.alternate.test, "count > 5", "else-if test");
    assert.equal(
      chain.consequent.type,
      "JSXFragment",
      "if consequent maps to a fragment"
    );
    assert.equal(chain.alternate.alternate.type, "JSXFragment", "else maps to a fragment");
  }

  // -- {#each rows as { id, name, score }, index (id)} ----------------------
  {
    const { code, ast } = fixtures["list-each.svelte"];
    const mapCalls = collect(
      ast,
      (n) =>
        n.type === "CallExpression" && n.callee?.property?.name === "map"
    );
    assert.equal(
      mapCalls.length,
      2,
      "outer and nested {#each} both produce .map() calls"
    );
    const outer = mapCalls.find(
      (m) => code.slice(m.callee.object.start, m.callee.object.end) === "rows"
    );
    assert.ok(outer, "outer each maps over `rows`");
    expectSlice(code, outer.callee.object, "rows", "each expression");
    const arrow = outer.arguments[0];
    assert.equal(arrow.type, "ArrowFunctionExpression");
    // destructuring context + index identifier
    assert.equal(arrow.params.length, 2);
    assert.equal(arrow.params[0].type, "ObjectPattern");
    assert.deepEqual(
      arrow.params[0].properties.map((p) => p.key.name),
      ["id", "name", "score"]
    );
    expectSlice(code, arrow.params[0], "{ id, name, score }", "each context");
    assert.equal(arrow.params[1].type, "Identifier");
    assert.equal(arrow.params[1].name, "index");
    // the (key) expression rides as the first child of the arrow's fragment
    const keyChild = arrow.body.children[0];
    assert.equal(keyChild.type, "JSXExpressionContainer");
    expectSlice(code, keyChild, "(id)", "each key");

    // {:else} fallback becomes a sibling fragment, not a conditional branch
    const ul = collect(
      ast,
      (n) => n.type === "JSXElement" && n.svelteName === "ul"
    )[0];
    const meaningful = ul.children.filter(
      (c) => c.type !== "JSXText" || c.value.trim()
    );
    assert.equal(meaningful.length, 2, "each container + fallback sibling");
    assert.equal(meaningful[0].svelteKind, "EachBlock");
    assert.equal(meaningful[1].type, "JSXFragment");
    assert.ok(
      meaningful[1].children.some((c) => c.svelteName === "li"),
      "fallback fragment contains the <li> fallback markup"
    );
  }

  // -- {#await} pending siblings + .then(onFulfilled, onRejected) ----------
  {
    const { code, ast } = fixtures["async-await.svelte"];
    const thenCalls = collect(
      ast,
      (n) =>
        n.type === "CallExpression" && n.callee?.property?.name === "then"
    );
    assert.equal(thenCalls.length, 1);
    expectSlice(
      code,
      thenCalls[0].callee.object,
      "profilePromise",
      "await expression"
    );
    assert.deepEqual(
      thenCalls[0].arguments.map((a) => a.type),
      ["ArrowFunctionExpression", "ArrowFunctionExpression"],
      "then(fn, fn) for the then and catch branches"
    );
    assert.deepEqual(
      thenCalls[0].arguments.map((a) => a.params.map((p) => p.name).join(",")),
      ["profile", "error"],
      "then/catch binding names are arrow parameters"
    );
    // pending markup is emitted as preceding siblings of the container
    const root = collect(ast, (n) => n.type === "ExpressionStatement")[0];
    const children = root.expression.children.filter(
      (c) => c.type !== "JSXText" || c.value.trim()
    );
    const awaitIndex = children.findIndex((c) => c.svelteKind === "AwaitBlock");
    assert.ok(awaitIndex > 0, "await container has preceding siblings");
    assert.equal(children[awaitIndex - 1].type, "JSXElement");
    assert.equal(children[awaitIndex - 1].svelteName, "p");
    assert.match(
      code.slice(
        children[awaitIndex - 1].start,
        children[awaitIndex - 1].end
      ),
      /loading\.\.\./,
      "the preceding sibling is the pending markup"
    );
  }

  // -- {#snippet} + {@render} -----------------------------------------------
  {
    const { code, ast } = fixtures["snippet-render.svelte"];
    const assignment = collect(
      ast,
      (n) => n.type === "AssignmentExpression" && n.left?.name === "row"
    )[0];
    assert.ok(assignment, "snippet becomes an assignment to its name");
    assert.equal(assignment.right.type, "ArrowFunctionExpression");
    assert.equal(assignment.right.params.length, 2);
    expectSlice(code, assignment.right.params[0], "index: number", "snippet param with type");
    const renderCalls = collect(
      ast,
      (n) => n.type === "CallExpression" && n.callee?.name === "row"
    );
    assert.equal(renderCalls.length, 1);
    expectSlice(code, renderCalls[0], "row(i, item)", "render call");
    // the render call is carried by a container tagged as a RenderTag
    const renderContainers = collect(
      ast,
      (n) => n.type === "JSXExpressionContainer" && n.svelteKind === "RenderTag"
    );
    assert.equal(renderContainers.length, 1);
    expectSlice(code, renderContainers[0], "{@render row(i, item)}", "render tag");
  }

  // -- directives become JSXAttributes with namespaced names ----------------
  {
    const { code, ast } = fixtures["legacy-props.svelte"];
    const onClick = collect(
      ast,
      (n) =>
        n.type === "JSXAttribute" &&
        n.name?.type === "JSXNamespacedName" &&
        n.name.namespace.name === "on" &&
        n.name.name.name === "click"
    )[0];
    assert.ok(onClick, "on:click yields a JSXAttribute with a namespaced name");
    // The range must slice to the exact directive text: this is what makes
    // downstream `code` fields read real Svelte source instead of mangled text.
    expectSlice(code, onClick, "on:click={handleClick}", "on:click directive");
    expectSlice(code, onClick.value, "{handleClick}", "on:click handler");
  }

  // -- mixed text/interpolation attribute values ----------------------------
  {
    const { code, ast } = fixtures["void-and-quirks.svelte"];
    const attr = (name) =>
      collect(ast, (n) => n.type === "JSXAttribute" && n.name?.name === name)[0];

    // A mixed value is a JSXExpressionContainer over the whole quoted value
    // wrapping a TemplateLiteral built from the parts - the shape a Babel
    // parse of the equivalent JSX attribute would produce.
    const classAttr = attr("class");
    assert.equal(classAttr.value.type, "JSXExpressionContainer");
    const mixed = classAttr.value.expression;
    assert.equal(mixed.type, "TemplateLiteral");
    expectSlice(
      code,
      classAttr.value,
      '"greeting tone-{tone} name-{name} plain"',
      "mixed value container"
    );
    expectSlice(
      code,
      mixed,
      "greeting tone-{tone} name-{name} plain",
      "mixed value template literal"
    );
    assert.equal(
      mixed.quasis.length,
      mixed.expressions.length + 1,
      "TemplateLiteral quasi/expression arity invariant"
    );
    assert.deepEqual(
      mixed.quasis.map((q) => q.value.raw),
      ["greeting tone-", " name-", " plain"]
    );
    expectSlice(code, mixed.expressions[0], "tone", "interpolated attr expression");

    // Leading, trailing and adjacent interpolations: the literal must include
    // every closing brace (a trailing one used to truncate the range by one).
    expectSlice(code, attr("data-end").value, '"value-{name}"', "trailing container");
    expectSlice(code, attr("data-end").value.expression, "value-{name}", "trailing interpolation");
    expectSlice(code, attr("data-start").value.expression, "{tone}-lead", "leading interpolation");
    const adjacent = attr("data-adjacent").value.expression;
    expectSlice(code, adjacent, "{tone}{name}", "adjacent interpolations");
    assert.equal(
      adjacent.quasis.length,
      adjacent.expressions.length + 1,
      "adjacent-expression arity invariant"
    );
    assert.deepEqual(
      adjacent.quasis.map((q) => q.value.raw),
      ["", "", ""]
    );

    // plain string values include their quotes, matching Babel JSX output
    const noteAttr = attr("data-note");
    assert.equal(noteAttr.value.type, "StringLiteral");
    expectSlice(code, noteAttr.value, '"a > b inside quotes"', "quoted string value");

    // a boolean shorthand attribute maps to a value-less JSXAttribute
    const checked = attr("checked");
    assert.ok(checked, "boolean shorthand attribute survives");
    assert.equal(checked.value, null, "boolean shorthand maps to a null value");
    expectSlice(code, checked, "checked", "boolean shorthand");

    // void elements written unclosed have no closing element and no errors
    const br = collect(ast, (n) => n.type === "JSXElement" && n.svelteName === "br")[0];
    assert.equal(br.closingElement, null, "<br> has no closing element");
    assert.equal(br.openingElement.selfClosing, true, "<br> is self-closing");
    expectSlice(code, br, "<br>", "void element");
    const img = collect(ast, (n) => n.type === "JSXElement" && n.svelteName === "img")[0];
    assert.equal(img.closingElement, null);
    assert.ok(
      img.openingElement.attributes.length >= 2,
      "unclosed <img> keeps its attributes"
    );
    // the quoted `>` in data-note must not have confused the open-tag scan,
    // including across the multi-line attribute list
    const div = collect(ast, (n) => n.type === "JSXElement" && n.svelteName === "div")[0];
    assert.ok(div.closingElement, "div with quoted `>` in attribute closes normally");
    const openTag = code.slice(div.openingElement.start, div.openingElement.end);
    assert.ok(
      openTag.startsWith("<div") && openTag.endsWith(">"),
      "open tag spans the whole multi-line attribute list"
    );
    assert.ok(
      openTag.includes('data-adjacent="{tone}{name}"'),
      "the last attribute of the multi-line list is inside the open tag"
    );
    assert.ok(
      openTag.includes('data-note="a > b inside quotes"'),
      "quoted gt attribute is inside the open tag"
    );
  }

  // -- {@html} sink ----------------------------------------------------------
  {
    const { code, ast } = fixtures["counter-runes.svelte"];
    const htmlTags = collect(
      ast,
      (n) => n.type === "JSXExpressionContainer" && n.svelteKind === "HtmlTag"
    );
    assert.equal(htmlTags.length, 1);
    expectSlice(code, htmlTags[0], "{@html `<strong>${label}</strong>`}", "html tag");
  }

  // -- special elements and the synthesized this={...} attribute ------------
  {
    const { code, ast } = fixtures["special-elements.svelte"];
    const thisAttr = collect(
      ast,
      (n) => n.type === "JSXAttribute" && n.name?.name === "this"
    )[0];
    assert.ok(thisAttr, "svelte:element keeps its dynamic tag as a this attribute");
    assert.equal(thisAttr.svelteKind, "SvelteElement");
    expectSlice(code, thisAttr, "this={tag}", "svelte:element this attr");
    for (const expected of [
      ["svelte:head", "SvelteHead"],
      ["svelte:window", "SvelteWindow"],
      ["svelte:body", "SvelteBody"],
      ["svelte:document", "SvelteDocument"],
      ["svelte:boundary", "SvelteBoundary"]
    ]) {
      const element = collect(
        ast,
        (n) => n.type === "JSXElement" && n.svelteName === expected[0]
      )[0];
      assert.ok(element, `${expected[0]} maps to a JSXElement`);
      assert.equal(element.svelteKind, expected[1]);
      assert.equal(
        element.openingElement.name.type,
        "JSXNamespacedName",
        `${expected[0]} name is namespaced`
      );
    }
    const title = collect(
      ast,
      (n) => n.type === "JSXElement" && n.svelteName === "title"
    )[0];
    assert.ok(title, "<title> inside svelte:head maps to a JSXElement");
    assert.ok(title.closingElement, "<title> has a closing tag");
  }

  // -- every directive form --------------------------------------------------
  {
    const { code, ast } = fixtures["directives.svelte"];
    const expectDirective = (namespace, local, expectedSlice) => {
      const attribute = collect(
        ast,
        (n) =>
          n.type === "JSXAttribute" &&
          n.name?.type === "JSXNamespacedName" &&
          n.name.namespace.name === namespace &&
          n.name.name.name === local
      )[0];
      assert.ok(attribute, `directive ${namespace}:${local} survives`);
      if (expectedSlice) {
        expectSlice(code, attribute, expectedSlice, `${namespace}:${local}`);
      }
      return attribute;
    };
    expectDirective("bind", "value", "bind:value={query}");
    expectDirective("bind", "outerWidth", "bind:outerWidth");
    expectDirective("class", "filled", "class:filled={query.length > 0}");
    expectDirective("style", "color", "style:color={query ? 'red' : 'blue'}");
    expectDirective("use", "tooltip", "use:tooltip={{ text: query }}");
    expectDirective("transition", "fade", "transition:fade={{ duration: 150 }}");
    expectDirective("in", "fly", "in:fly={{ x: 20, duration: 200 }}");
    expectDirective("out", "fly", "out:fly={{ x: -20, duration: 200 }}");
    expectDirective("animate", "flip");
    // modifiers stay part of the directive's source range
    expectDirective(
      "on",
      "change",
      "on:change|preventDefault={() => console.log(panel.id)}"
    );
    const spread = collect(
      ast,
      (n) => n.type === "JSXSpreadAttribute"
    )[0];
    assert.ok(spread, "spread attribute survives");
    expectSlice(code, spread, "{...panels[0]}", "spread attribute");
    const shorthand = collect(
      ast,
      (n) => n.type === "JSXAttribute" && n.name?.name === "visible"
    )[0];
    assert.ok(shorthand, "{value} shorthand attribute survives");
    expectSlice(code, shorthand, "{visible}", "shorthand attribute");
    assert.equal(shorthand.value.type, "JSXExpressionContainer");
    assert.equal(shorthand.value.expression.name, "visible");
  }

  // -- TypeScript in template expressions (lang="ts" components) ------------
  {
    const { code, ast } = fixtures["ts-template.svelte"];
    const asCast = collect(ast, (n) => n.type === "TSAsExpression")[0];
    assert.ok(asCast, "as-cast inside a template expression is re-parsed with TS");
    expectSlice(code, asCast, "note.body as string", "as cast");
    const nonNull = collect(ast, (n) => n.type === "TSNonNullExpression")[0];
    assert.ok(nonNull, "non-null assertion inside a template expression");
    expectSlice(code, nonNull, "note.body!", "non-null");
  }

  // -- {@const} becomes an assignment ----------------------------------------
  {
    const { code, ast } = fixtures["list-each.svelte"];
    const constTag = collect(
      ast,
      (n) => n.type === "JSXExpressionContainer" && n.svelteKind === "ConstTag"
    )[0];
    assert.ok(constTag, "{@const} maps to a container");
    assert.equal(constTag.expression.type, "AssignmentExpression");
    expectSlice(code, constTag.expression.left, "scaled", "const binding");
    expectSlice(
      code,
      constTag.expression.right,
      "score * 10",
      "const initializer"
    );
  }
}

/**
 * A file the Svelte parser rejects outright must still produce an AST via the
 * masked-script fallback. Because the fallback parses a position-preserving
 * buffer, its statement offsets are absolute: they must slice to the exact
 * script source text, not to text shifted by the script prologue the legacy
 * concatenating fallback produced. The failure is recorded on `errors`.
 */
// The template statement must be the LAST element of `program.body`, regardless of
// what precedes `<script>` in the file.
//
// The root fragment's first child is whatever text sits before `<script>`, so a single
// leading newline gives it start=0. Ordering `program.body` by offset then places the
// template ahead of every script statement, which inverts the control flow a consumer
// builds from it (entry -> template -> script) and means no script-side definition
// reaches a template use. Every Svelte template dataflow query silently returns
// nothing. A component's markup renders after its instance script has run, so the
// template belongs last.
function assertTemplateStatementIsLast(fixtures) {
  for (const [relativeName, fixture] of Object.entries(fixtures)) {
    if (!relativeName.endsWith(".svelte")) {
      continue;
    }
    const body = fixture.ast.program.body;
    const templateIndexes = body
      .map((statement, index) => [statement, index])
      .filter(
        ([statement]) =>
          statement.type === "ExpressionStatement" &&
          statement.expression?.type === "JSXFragment"
      )
      .map(([, index]) => index);
    if (templateIndexes.length === 0) {
      continue;
    }
    assert.equal(
      templateIndexes.length,
      1,
      `${relativeName} should emit exactly one template statement`
    );
    assert.equal(
      templateIndexes[0],
      body.length - 1,
      `${relativeName} template statement must be last in program.body, ` +
        `found at index ${templateIndexes[0]} of ${body.length}`
    );
    // and the script statements before it stay in source order
    const scriptStarts = body.slice(0, -1).map((statement) => statement.start);
    const sorted = [...scriptStarts].sort((a, b) => a - b);
    assert.deepEqual(
      scriptStarts,
      sorted,
      `${relativeName} script statements should keep source order`
    );
  }
}

function assertBrokenTemplateFallback(fixtures) {
  const { code, ast } = fixtures["broken-template.svelte"];
  assert.ok(ast.program, "fallback still emits a program");
  const exported = ast.program.body.find(
    (n) => n.type === "ExportNamedDeclaration"
  );
  assert.ok(exported, "fallback keeps the script statements");
  expectSlice(
    code,
    exported,
    "export let seed = 1;",
    "fallback export statement"
  );
  const fn = ast.program.body.find((n) => n.type === "FunctionDeclaration");
  assert.ok(fn, "fallback keeps the function declaration");
  expectSlice(
    code,
    fn.body,
    "{\n    return seed * 2;\n  }",
    "fallback function body"
  );
  assert.ok(
    ast.errors.some((e) => e?.svelteParse === true),
    "the svelte parse failure is recorded on errors"
  );
}

/** Rune type inference through the virtual program + rune shims. */
function assertTypeInference(fixtures) {
  const counter = fixtures["counter-runes.svelte"];
  expectType(counter, "count = $state", "number");
  expectType(counter, "doubled = $derived", "number");
  expectType(counter, "banner = $derived", '"big" | "small"');
  expectType(counter, "increment", "() => void");
  // $props() destructuring against an interface declared in the component
  expectType(counter, "initial = 0", "number");
  expectType(counter, "label = 'Counter'", "string");

  const legacy = fixtures["legacy-props.svelte"];
  expectType(legacy, "total = items.length", "number");
  expectType(legacy, "handleClick", "() => void");

  // plain typed helpers in sibling TypeScript files keep full fidelity
  const api = fixtures["api-client.ts"];
  expectType(
    api,
    "formatRows",
    "(rows: Array<Row>) => string"
  );
  const types = fixtures["types.ts"];
  expectType(types, "id: string", "string");

  // typemap hygiene: unresolved ratio must stay low across the project
  const svelteFiles = Object.keys(fixtures).filter((name) =>
    name.endsWith(".svelte")
  );
  let totalEntries = 0;
  let unresolved = 0;
  for (const name of svelteFiles) {
    if (name === "broken-template.svelte") {
      continue;
    }
    totalEntries += Object.keys(fixtures[name].typemap).length;
    unresolved += countUnresolved(fixtures[name].typemap);
  }
  assert.ok(
    totalEntries >= 150,
    `Svelte typemap coverage dropped below threshold: ${totalEntries}`
  );
  assert.ok(
    unresolved / Math.max(totalEntries, 1) < 0.2,
    `Svelte unresolved type ratio is too high: ${unresolved}/${totalEntries}`
  );
}

try {
  runAstgenOnce(outputRoot);

  const fixtureNames = readdirSync(fixtureRoot).filter(
    (name) => /\.(svelte|ts)$/.test(name)
  );
  // Template-heavy components legitimately carry only a handful of script
  // bindings, so the per-file floor is low; aggregate coverage is asserted in
  // assertTypeInference instead.
  const fixtures = loadFixtureSet(fixtureRoot, outputRoot, fixtureNames, 5);

  assertAstInvariants(fixtures);
  assertScriptOffsets(fixtures);
  assertTemplateMapping(fixtures);
  assertTemplateStatementIsLast(fixtures);
  assertBrokenTemplateFallback(fixtures);
  assertTypeInference(fixtures);

  console.log("astgen Svelte regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
