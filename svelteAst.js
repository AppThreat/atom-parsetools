// Svelte single-file component support for astgen.
//
// A `.svelte` file mixes a JavaScript/TypeScript `<script>` block with an HTML
// template that uses `{...}` expression tags and `{#if}`/`{#each}`/... logic
// blocks. Neither half parses as the other, so a single Babel parse of the raw
// document cannot work. Instead `svelte/compiler`'s `parse(src, { modern: true })`
// is used purely as a *segmenter*: it returns a tree whose every node carries
// an absolute byte range into the original file. From that tree we produce a
// regular Babel `File` AST in three steps:
//
//   1. Script blocks are parsed by Babel over a masked buffer - a same-length
//      copy of the file where every character outside the script bodies is
//      blanked to a space (newlines preserved). Because nothing moves, the
//      resulting statement offsets are already absolute.
//   2. The template is walked and re-emitted as standard Babel JSX nodes
//      (JSXElement, JSXExpressionContainer, JSXFragment, ...). Zero new node
//      types are introduced, so downstream consumers that understand Babel JSX
//      need no changes.
//   3. Every template expression/pattern/declaration is sub-parsed with Babel
//      from its own source substring and its offsets shifted back into file
//      coordinates.
//
// The result keeps two invariants everywhere:
//
//   * every `start`/`end` is an absolute byte offset into the `.svelte` source
//     and `loc` is rebuilt from those offsets (`loc.start.index === start`), so
//     `src.slice(node.start, node.end)` is always the node's original text;
//   * every emitted `type` is a stock Babel node type.
//
// Synthesized (non-Babel-parsed) nodes additionally carry two additive keys for
// traceability: `svelteKind` (the originating Svelte node type, e.g.
// "EachBlock") and, where meaningful, `svelteName` (e.g. the tag name).
// Consumers ignore unknown keys, so these are safe to emit.
//
// Limitations, by design: `<style>` blocks and HTML comments are dropped, and
// `{@const}` is modelled as an assignment rather than a declaration (see
// docs/ASTGEN.md, "Svelte" for the full list of accepted losses).

import { parse as svelteCompilerParse } from "svelte/compiler";
import { parse as babelParse, parseExpression } from "@babel/parser";

// Identifier substituted for a template expression that Babel could not
// sub-parse. The file is never aborted over one bad expression; the failure is
// recorded in `File.errors` instead.
const UNPARSED_IDENTIFIER_NAME = "__astgen_unparsed";

const TRANSITION_DIRECTIVE_PREFIXES = ["transition", "in", "out"];

// `name_loc` in Svelte's modern AST is a { line, column, character } pair, not
// a plain offset pair; the byte offsets live under `.character`.
const nameLocStart = (node) => node.name_loc?.start?.character ?? node.start;
const nameLocEnd = (node) => node.name_loc?.end?.character ?? node.end;

/** Per-file parse context threaded through all helpers below. */
class SvelteParseContext {
  constructor(file, src, options, errors) {
    this.file = file;
    this.src = src;
    // Babel options for every sub-parse; supplied by the caller so there is a
    // single option set shared with regular JS/TS parsing in astgen.js.
    this.options = options;
    this.errors = errors;
    // Offsets of the first character of every line, for rebuilding `loc`.
    this.lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
  }

  /** { line (1-based), column (0-based), index } for an absolute offset. */
  posOf(offset) {
    const lineStarts = this.lineStarts;
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { line: lo + 1, column: offset - lineStarts[lo], index: offset };
  }

  slice(start, end) {
    return this.src.slice(start, end);
  }

  recordSubParseFailure(message, start, end) {
    this.errors.push({ svelteSubParse: true, message, start, end });
  }

  /** Fresh loc object for a synthesized node spanning [start, end). */
  locBetween(start, end) {
    return { start: this.posOf(start), end: this.posOf(end) };
  }
}

/**
 * Recursively add `delta` to every start/end/range on `node` (in place) and
 * rebuild `loc` from the original file's line index. Value fields such as
 * `extra.raw` or `TemplateElement.value` hold source strings, not offsets, and
 * are left untouched.
 */
const shiftNode = (ctx, node, delta) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      shiftNode(ctx, child, delta);
    }
    return node;
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  if (typeof node.start === "number" && typeof node.end === "number") {
    node.start += delta;
    node.end += delta;
    if (Array.isArray(node.range) && node.range.length === 2) {
      node.range = [node.range[0] + delta, node.range[1] + delta];
    }
    if (node.loc) {
      node.loc = { start: ctx.posOf(node.start), end: ctx.posOf(node.end) };
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") {
      continue;
    }
    shiftNode(ctx, node[key], delta);
  }
  return node;
};

/** Placeholder emitted when a sub-parse fails; keeps ranges sane for consumers. */
const unparsedIdentifier = (ctx, start, end) => ({
  type: "Identifier",
  name: UNPARSED_IDENTIFIER_NAME,
  start,
  end,
  loc: ctx.locBetween(start, end)
});

/**
 * Run a sub-parse, converting any throw into a recorded error plus an
 * `__astgen_unparsed` identifier. One malformed expression costs exactly that
 * expression, never the file.
 */
const guardedSubParse = (ctx, start, end, parseFn) => {
  try {
    return parseFn();
  } catch (err) {
    ctx.recordSubParseFailure(err?.message || String(err), start, end);
    return unparsedIdentifier(ctx, start, end);
  }
};

/**
 * Rebuild every `loc` on a Babel-parsed tree with fresh position objects.
 * Babel shares position objects between neighbouring nodes (`nodeA.loc.end ===
 * nodeB.loc.start`), and the JSON writer's circular-reference guard drops a
 * repeated object on its second appearance - leaving some nodes with a
 * half-missing `loc` (this also affects plain `.js` output). Rebuilding from
 * the node's own offsets makes the Svelte output fully self-consistent:
 * `loc.start.index === start` and `loc.end.index === end` hold everywhere.
 */
const relocTree = (ctx, node) => {
  if (Array.isArray(node)) {
    for (const child of node) {
      relocTree(ctx, child);
    }
    return;
  }
  if (!node || typeof node !== "object") {
    return;
  }
  if (typeof node.start === "number" && typeof node.end === "number") {
    node.loc = ctx.locBetween(node.start, node.end);
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") {
      continue;
    }
    relocTree(ctx, node[key]);
  }
};

/** Sub-parse a standalone expression such as `count > 10` or `'<b>' + x`. */
const subExpr = (ctx, start, end) =>
  guardedSubParse(ctx, start, end, () =>
    shiftNode(
      ctx,
      parseExpression(ctx.slice(start, end), ctx.options),
      start
    )
  );

/**
 * Sub-parse a binding pattern such as `item`, `{ a, b }` or `[x, ...rest]`.
 * Patterns are not standalone expressions, so the text is embedded as the
 * parameter of a throwaway arrow function; the pattern starts at index 1 of
 * that snippet, hence the `start - 1` shift.
 */
const subPattern = (ctx, start, end) =>
  guardedSubParse(ctx, start, end, () => {
    const fn = babelParse(`(${ctx.slice(start, end)})=>0`, ctx.options);
    return shiftNode(ctx, fn.program.body[0].expression.params[0], start - 1);
  });


// ---------------------------------------------------------------------------
// Source-range helpers for synthesized element structure
// ---------------------------------------------------------------------------

/**
 * End of an element's opening tag (index just past its `>`), derived from the
 * source. Svelte reports the tag-name range and attribute ranges but not the
 * tag boundary itself. Scanning for `>` from the last attribute's end is safe
 * against quoted `>` characters because a quoted value belongs to an attribute
 * node and therefore ends before the scan starts.
 */
const openTagEnd = (ctx, node) => {
  let from = nameLocEnd(node);
  for (const attribute of node.attributes ?? []) {
    if (attribute.end > from) {
      from = attribute.end;
    }
  }
  const gt = ctx.src.indexOf(">", from);
  return gt === -1 ? node.end : gt + 1;
};

/**
 * True for `<br/>` and for unclosed void elements such as `<br>` or
 * `<img src=x>` whose node ends at the opening tag because they have no
 * children and no closing tag.
 */
const isSelfClosing = (ctx, node) => {
  const end = openTagEnd(ctx, node);
  return ctx.src[end - 2] === "/" || end >= node.end;
};

/** Range of the closing tag (`</div>`), or null for self-closing/void elements. */
const closeTagRange = (ctx, node) => {
  const openEnd = openTagEnd(ctx, node);
  if (isSelfClosing(ctx, node) || node.end <= openEnd) {
    return null;
  }
  // An element with children ends exactly at its closing tag's `>`. Scanning
  // backwards for `</` alone is not enough: the next sibling's closing tag can
  // start precisely at this element's end, so each candidate is validated by
  // requiring its `>` to land on node.end - 1.
  let lt = ctx.src.lastIndexOf("</", node.end - 1);
  while (lt >= openEnd) {
    const gt = ctx.src.indexOf(">", lt);
    if (gt === node.end - 1) {
      return { start: lt, end: node.end };
    }
    lt = ctx.src.lastIndexOf("</", lt - 1);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Map a tag/attribute name onto Babel JSX name nodes:
 *   "div"            -> JSXIdentifier
 *   "svelte:head"    -> JSXNamespacedName(svelte, head)
 *   "Foo.Bar"        -> JSXMemberExpression(Foo, Bar)
 * Offsets come from the source so every part spans its real text; chen never
 * visits these nodes, but keeping ranges honest costs nothing.
 */
const jsxName = (ctx, name, start, end) => {
  const identifier = (idName, s, e) => ({
    type: "JSXIdentifier",
    name: idName,
    start: s,
    end: e,
    loc: ctx.locBetween(s, e)
  });
  if (name.includes(":")) {
    const [namespaceName, localName] = name.split(":");
    const colon = ctx.src.indexOf(":", start);
    const namespaceEnd =
      colon === -1 || colon >= end ? start + namespaceName.length : colon;
    const localStart = namespaceEnd + 1;
    return {
      type: "JSXNamespacedName",
      namespace: identifier(namespaceName, start, namespaceEnd),
      name: identifier(localName, localStart, Math.max(localStart, end)),
      start,
      end,
      loc: ctx.locBetween(start, end)
    };
  }
  if (name.includes(".")) {
    const lastDot = name.lastIndexOf(".");
    const dot = ctx.src.lastIndexOf(".", end - 1);
    const objectEnd = dot <= start || dot >= end ? start + lastDot : dot;
    return {
      type: "JSXMemberExpression",
      object: jsxName(ctx, name.slice(0, lastDot), start, objectEnd),
      property: identifier(name.slice(lastDot + 1), objectEnd + 1, end),
      start,
      end,
      loc: ctx.locBetween(start, end)
    };
  }
  return identifier(name, start, end);
};

// ---------------------------------------------------------------------------
// Attributes and directives
// ---------------------------------------------------------------------------

/**
 * Map an attribute/directive value onto the `value` of a Babel JSXAttribute.
 *
 * Svelte shapes: `true` (boolean shorthand), a single node (ExpressionTag for
 * `{expr}`), or an array of Text/ExpressionTag parts (mixed content such as
 * class="a {b} c", or a plain quoted string which arrives as [Text]).
 */
const mapAttributeValue = (ctx, value, valueStart, valueEnd) => {
  if (value === true || value == null) {
    return null;
  }
  if (!Array.isArray(value)) {
    if (value.type === "ExpressionTag") {
      return expressionTagContainer(ctx, value, value.expression);
    }
    if (value.type === "Text") {
      return stringLiteralForText(ctx, value, value.start, value.end);
    }
    return subExpr(ctx, value.start, value.end);
  }
  if (value.length === 1 && value[0].type === "Text") {
    return stringLiteralForText(ctx, value[0], valueStart, valueEnd);
  }
  if (value.length === 1 && value[0].type === "ExpressionTag") {
    return expressionTagContainer(ctx, value[0], value[0].expression);
  }
  // Mixed text/interpolation: a JSXExpressionContainer over the whole (quoted)
  // value wrapping a TemplateLiteral built from the parts - the shape a Babel
  // parse of the equivalent JSX attribute would produce.
  const [regionStart, regionEnd] = trimmedValueRange(ctx, valueStart, valueEnd);
  const template = mixedValueTemplateLiteral(ctx, value);
  return {
    type: "JSXExpressionContainer",
    start: regionStart,
    end: regionEnd,
    loc: ctx.locBetween(regionStart, regionEnd),
    expression: template
  };
};

/**
 * The attribute value's own region: after the `=`, trimmed of surrounding
 * whitespace, so a quoted value keeps both quotes (`class="a"` -> `"a"`) the
 * way Babel's own attribute values do.
 */
const trimmedValueRange = (ctx, valueStart, valueEnd) => {
  let start = valueStart;
  let end = valueEnd;
  while (start < end && /\s/.test(ctx.src[start])) {
    start++;
  }
  while (end > start && /\s/.test(ctx.src[end - 1])) {
    end--;
  }
  return [start, end];
};

/** A plain quoted value as a StringLiteral spanning the trimmed value region. */
const stringLiteralForText = (ctx, text, regionStart, regionEnd) => {
  const [start, end] = trimmedValueRange(ctx, regionStart, regionEnd);
  return {
    type: "StringLiteral",
    value: text.data,
    start,
    end,
    loc: ctx.locBetween(start, end)
  };
};

/**
 * Build the TemplateLiteral for a mixed text/expression attribute value. Babel
 * requires `quasis.length === expressions.length + 1`, so empty zero-width
 * quasis are inserted where two expressions are adjacent and at the head/tail
 * when the value starts/ends with an expression.
 */
const mixedValueTemplateLiteral = (ctx, parts) => {
  const expressions = [];
  const quasis = [];
  for (const part of parts) {
    if (part.type === "Text") {
      if (quasis.length === expressions.length) {
        // No quasi is pending (start of the value, or an expression was just
        // pushed): this Text opens a new quasi.
        quasis.push(templateElement(ctx, part.data, part.start, part.end, false));
      } else if (part.data.length > 0) {
        // Svelte can split text runs (e.g. around decoded entities); merge the
        // run into the trailing quasi so the arity invariant holds.
        const previous = quasis[quasis.length - 1];
        previous.value = {
          raw: previous.value.raw + part.data,
          cooked: previous.value.cooked + part.data
        };
        previous.end = part.end;
        previous.loc = ctx.locBetween(previous.start, part.end);
      }
    } else if (part.type === "ExpressionTag") {
      if (quasis.length === expressions.length) {
        // Two adjacent expressions (or a leading one): insert an empty
        // separator quasi at this position.
        quasis.push(templateElement(ctx, "", part.start, part.start, false));
      }
      expressions.push(subExpr(ctx, part.expression.start, part.expression.end));
    }
  }
  if (quasis.length === expressions.length) {
    // The value ends with an expression: close with an empty tail quasi. Its
    // position - and the literal's overall end - is the last *part*'s end (an
    // ExpressionTag's end includes its closing `}`); using the inner
    // expression's end would truncate the literal by one character.
    const at = parts[parts.length - 1].end;
    quasis.push(templateElement(ctx, "", at, at, false));
  }
  quasis[quasis.length - 1].tail = true;
  const start = quasis[0].start;
  const end = parts[parts.length - 1].end;
  return {
    type: "TemplateLiteral",
    quasis,
    expressions,
    start,
    end,
    loc: ctx.locBetween(start, end)
  };
};

const templateElement = (ctx, raw, start, end, tail) => ({
  type: "TemplateElement",
  start,
  end,
  tail,
  value: { raw, cooked: raw },
  loc: ctx.locBetween(start, end)
});

/**
 * A JSXExpressionContainer that spans a `{...}` tag's brace range and wraps the
 * sub-parsed inner expression. `tag` supplies the outer range (which for
 * shorthand attributes is narrower than the braces themselves); `expression`
 * supplies the inner range.
 */
const expressionTagContainer = (ctx, tag, expression) => {
  const inner = subExpr(ctx, expression.start, expression.end);
  return {
    type: "JSXExpressionContainer",
    start: tag.start,
    end: tag.end,
    loc: ctx.locBetween(tag.start, tag.end),
    expression: inner
  };
};

/** Container whose range is exactly the braces around [start, end). */
const bracedContainer = (ctx, expressionNode, start, end) => ({
  type: "JSXExpressionContainer",
  start,
  end,
  loc: ctx.locBetween(start, end),
  expression: expressionNode
});

/** Zero-width node at `offset` - for invented identifiers and markers. */
const zeroWidth = (ctx, offset, fields) => ({
  start: offset,
  end: offset,
  loc: ctx.locBetween(offset, offset),
  ...fields
});

/**
 * Directives (`on:click={h}`, `bind:value={q}`, ...) become JSXAttributes whose
 * name is a JSXNamespacedName, which Babel's JSX parser produces natively for
 * `on:click`-style names. Unlike the Vue masking path nothing is rewritten, so
 * the attribute's [start, end) slices to the directive's exact source text -
 * including modifiers such as `on:click|preventDefault`.
 */
const mapDirective = (ctx, node) => {
  const prefix = directivePrefix(ctx, node);
  const nameStart = node.start;
  const colon = ctx.src.indexOf(":", nameStart);
  // The local name stops at the first modifier pipe, `=`, `{` or whitespace.
  const afterColon = ctx.slice(colon + 1, node.end);
  const stop = afterColon.search(/[\s={|]/);
  const nameEnd =
    stop === -1 ? colon + 1 + node.name.length : colon + 1 + stop;
  const name = {
    type: "JSXNamespacedName",
    namespace: {
      type: "JSXIdentifier",
      name: prefix,
      start: nameStart,
      end: colon,
      loc: ctx.locBetween(nameStart, colon)
    },
    name: {
      type: "JSXIdentifier",
      name: node.name,
      start: colon + 1,
      end: nameEnd,
      loc: ctx.locBetween(colon + 1, nameEnd)
    },
    start: nameStart,
    end: nameEnd,
    loc: ctx.locBetween(nameStart, nameEnd)
  };
  return {
    type: "JSXAttribute",
    start: node.start,
    end: node.end,
    loc: ctx.locBetween(node.start, node.end),
    svelteKind: node.type,
    name,
    value: directiveValue(ctx, node)
  };
};

/**
 * `transition:`/`in:`/`out:` share one Svelte node type; the actual keyword is
 * only in the source text, so read it back rather than guessing.
 */
const directivePrefix = (ctx, node) => {
  if (node.type === "TransitionDirective") {
    for (const prefix of TRANSITION_DIRECTIVE_PREFIXES) {
      if (ctx.src.startsWith(prefix, node.start)) {
        return prefix;
      }
    }
  }
  return {
    OnDirective: "on",
    BindDirective: "bind",
    ClassDirective: "class",
    StyleDirective: "style",
    UseDirective: "use",
    AnimateDirective: "animate",
    LetDirective: "let"
  }[node.type];
};

const directiveValue = (ctx, node) => {
  if (node.type === "LetDirective") {
    // `let:` values are binding patterns (`let:item`, `let:{a, b}`).
    if (!node.expression) {
      return null;
    }
    return bracedContainer(
      ctx,
      subPattern(ctx, node.expression.start, node.expression.end),
      node.expression.start - 1,
      node.expression.end + 1
    );
  }
  if (node.type === "StyleDirective") {
    // StyleDirective keeps its payload in `value`, with the same shapes an
    // Attribute value can have.
    return mapAttributeValue(ctx, node.value, nameLocEnd(node) + 1, node.end);
  }
  if (!node.expression) {
    return null;
  }
  return bracedContainer(
    ctx,
    subExpr(ctx, node.expression.start, node.expression.end),
    node.expression.start - 1,
    node.expression.end + 1
  );
};

/** `Attribute` -> JSXAttribute; `SpreadAttribute` -> JSXSpreadAttribute. */
const mapAttribute = (ctx, node) => {
  if (node.type === "SpreadAttribute") {
    return {
      type: "JSXSpreadAttribute",
      start: node.start,
      end: node.end,
      loc: ctx.locBetween(node.start, node.end),
      svelteKind: "SpreadAttribute",
      argument: subExpr(ctx, node.expression.start, node.expression.end)
    };
  }
  if (node.type === "AttachTag") {
    // `{@attach fn}` rides along in the attributes array in Svelte's AST.
    const name = zeroWidth(ctx, node.start, {
      type: "JSXIdentifier",
      name: "attach"
    });
    return {
      type: "JSXAttribute",
      start: node.start,
      end: node.end,
      loc: ctx.locBetween(node.start, node.end),
      svelteKind: "AttachTag",
      name,
      value: node.expression
        ? bracedContainer(
            ctx,
            subExpr(ctx, node.expression.start, node.expression.end),
            node.start,
            node.end
          )
        : null
    };
  }
  if (node.type === "Attribute") {
    return {
      type: "JSXAttribute",
      start: node.start,
      end: node.end,
      loc: ctx.locBetween(node.start, node.end),
      svelteKind: "Attribute",
      name: jsxName(ctx, node.name, nameLocStart(node), nameLocEnd(node)),
      value: mapAttributeValue(ctx, node.value, nameLocEnd(node) + 1, node.end)
    };
  }
  return mapDirective(ctx, node);
};

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/**
 * Every element-like Svelte node (`RegularElement`, `Component`, `SlotElement`,
 * `TitleElement`, `SvelteHead`, `SvelteWindow`, `SvelteBody`,
 * `SvelteDocument`, `SvelteFragment`, `SvelteSelf`, `SvelteBoundary`,
 * `SvelteOptions`, `SvelteElement`, `SvelteComponent`) maps to a JSXElement.
 */
const mapElement = (ctx, node) => {
  const attributes = node.attributes?.map((a) => mapAttribute(ctx, a)) ?? [];
  // `<svelte:element this={...}>` and `<svelte:component this={...}>` keep their
  // dynamic tag outside `attributes`; surface it as a `this` attribute so the
  // expression is not lost.
  const dynamicThis = node.type === "SvelteElement" ? node.tag : node.type === "SvelteComponent" ? node.expression : null;
  if (dynamicThis) {
    attributes.unshift(thisAttribute(ctx, node, dynamicThis));
  }
  const openEnd = openTagEnd(ctx, node);
  const closeRange = closeTagRange(ctx, node);
  const children = (node.fragment?.nodes ?? [])
    .map((child) => mapChild(ctx, child))
    .flat()
    .filter(Boolean);
  return {
    type: "JSXElement",
    start: node.start,
    end: node.end,
    loc: ctx.locBetween(node.start, node.end),
    svelteKind: node.type,
    svelteName: node.name,
    openingElement: {
      type: "JSXOpeningElement",
      start: node.start,
      end: openEnd,
      loc: ctx.locBetween(node.start, openEnd),
      svelteKind: node.type,
      svelteName: node.name,
      name: jsxName(ctx, node.name, nameLocStart(node), nameLocEnd(node)),
      attributes,
      selfClosing: isSelfClosing(ctx, node)
    },
    closingElement: closeRange
      ? {
          type: "JSXClosingElement",
          start: closeRange.start,
          end: closeRange.end,
          loc: ctx.locBetween(closeRange.start, closeRange.end),
          svelteKind: node.type,
          svelteName: node.name,
          name: jsxName(ctx, node.name, closeRange.start + 2, closeRange.end - 1)
        }
      : null,
    children
  };
};

/** Synthesized `this={expr}` attribute for svelte:element / svelte:component. */
const thisAttribute = (ctx, node, expression) => {
  const openEnd = openTagEnd(ctx, node);
  const nameStart = nameLocEnd(node);
  const thisIndex = ctx.slice(nameStart, openEnd).indexOf("this");
  const attrStart = thisIndex === -1 ? nameStart : nameStart + thisIndex;
  const attrEnd = expression.end + 1;
  return {
    type: "JSXAttribute",
    start: attrStart,
    end: attrEnd,
    loc: ctx.locBetween(attrStart, attrEnd),
    svelteKind: node.type,
    name: {
      type: "JSXIdentifier",
      name: "this",
      start: attrStart,
      end: attrStart + (thisIndex === -1 ? 0 : 4),
      loc: ctx.locBetween(attrStart, attrStart + (thisIndex === -1 ? 0 : 4))
    },
    value: bracedContainer(
      ctx,
      subExpr(ctx, expression.start, expression.end),
      expression.start - 1,
      expression.end + 1
    )
  };
};

// ---------------------------------------------------------------------------
// Template children
// ---------------------------------------------------------------------------

/**
 * Map one template child onto Babel JSX. Returns a node, an array of nodes
 * (blocks that emit siblings), or null for dropped content (comments).
 */
const mapChild = (ctx, node) => {
  switch (node.type) {
    case "Text":
      return {
        type: "JSXText",
        value: node.data,
        start: node.start,
        end: node.end,
        loc: ctx.locBetween(node.start, node.end)
      };
    case "Comment":
      // HTML comments carry no code semantics; dropped by design.
      return null;
    case "ExpressionTag":
      return { ...expressionTagContainer(ctx, node, node.expression), svelteKind: "ExpressionTag" };
    case "HtmlTag":
      return {
        ...expressionTagContainer(ctx, node, node.expression),
        svelteKind: "HtmlTag"
      };
    case "RenderTag":
      return {
        type: "JSXExpressionContainer",
        start: node.start,
        end: node.end,
        loc: ctx.locBetween(node.start, node.end),
        svelteKind: "RenderTag",
        expression: node.expression
          ? subExpr(ctx, node.expression.start, node.expression.end)
          : zeroWidth(ctx, node.start, { type: "JSXEmptyExpression" })
      };
    case "DebugTag":
      return debugTagContainer(ctx, node);
    case "ConstTag":
      return constTagContainer(ctx, node);
    case "IfBlock":
      return ifBlockContainer(ctx, node);
    case "EachBlock":
      return eachBlockNodes(ctx, node);
    case "AwaitBlock":
      return awaitBlockNodes(ctx, node);
    case "KeyBlock":
      return keyBlockNodes(ctx, node);
    case "SnippetBlock":
      return snippetBlockContainer(ctx, node);
    default:
      // Remaining child types are the element-like nodes (and any future
      // element kind, which still has a name and a fragment).
      if (node.fragment || node.name_loc) {
        return mapElement(ctx, node);
      }
      return null;
  }
};

/**
 * `{@debug a, b}` -> a container over a SequenceExpression of the identifiers
 * (or the bare identifier when there is only one).
 */
const debugTagContainer = (ctx, node) => {
  const identifiers = node.identifiers ?? [];
  const start = identifiers[0]?.start ?? node.start;
  const end = identifiers[identifiers.length - 1]?.end ?? node.end;
  const parsed = identifiers.map((i) => subExpr(ctx, i.start, i.end));
  const expression =
    parsed.length > 1
      ? {
          type: "SequenceExpression",
          expressions: parsed,
          start,
          end,
          loc: ctx.locBetween(start, end)
        }
      : parsed[0] ?? zeroWidth(ctx, node.start, { type: "JSXEmptyExpression" });
  return {
    type: "JSXExpressionContainer",
    start: node.start,
    end: node.end,
    loc: ctx.locBetween(node.start, node.end),
    svelteKind: "DebugTag",
    expression
  };
};

/**
 * `{@const label = expr}` -> a container over `pattern = expr`. A declaration
 * is not legal in a JSX child position, so the binding is modelled as an
 * assignment; the trade-off (the binding looks like an implicit global
 * downstream) is documented in docs/ASTGEN.md.
 */
const constTagContainer = (ctx, node) => {
  const declaration = node.declaration;
  const declarator = declaration?.declarations?.[0];
  if (!declarator) {
    return null;
  }
  return {
    type: "JSXExpressionContainer",
    start: node.start,
    end: node.end,
    loc: ctx.locBetween(node.start, node.end),
    svelteKind: "ConstTag",
    expression: {
      type: "AssignmentExpression",
      operator: "=",
      start: declaration.start,
      end: declaration.end,
      loc: ctx.locBetween(declaration.start, declaration.end),
      left: subPattern(ctx, declarator.id.start, declarator.id.end),
      right: subExpr(ctx, declarator.init.start, declarator.init.end)
    }
  };
};

/**
 * `{#if test}A{:else if t2}B{:else}C{/if}` -> a container over a chain of
 * ConditionalExpressions. An `{:else if}` alternate holds exactly one nested
 * IfBlock; that block's conditional is spliced in directly so the chain is a
 * proper `a ? ... : b ? ... : ...` nesting rather than a fragment wrapper.
 */
const ifBlockContainer = (ctx, node) => ({
  type: "JSXExpressionContainer",
  start: node.start,
  end: node.end,
  loc: ctx.locBetween(node.start, node.end),
  svelteKind: "IfBlock",
  expression: ifBlockConditional(ctx, node)
});

const ifBlockConditional = (ctx, node) => {
  let alternate;
  const alternateNodes = node.alternate?.nodes ?? [];
  const nestedElseIf =
    alternateNodes.length === 1 &&
    alternateNodes[0].type === "IfBlock" &&
    alternateNodes[0].elseif === true;
  if (!node.alternate) {
    alternate = zeroWidth(ctx, node.end, { type: "NullLiteral" });
  } else if (nestedElseIf) {
    alternate = ifBlockConditional(ctx, alternateNodes[0]);
  } else {
    alternate = fragmentToJsx(ctx, node.alternate, node.end);
  }
  return {
    type: "ConditionalExpression",
    start: node.test.start,
    end: node.end,
    loc: ctx.locBetween(node.test.start, node.end),
    test: subExpr(ctx, node.test.start, node.test.end),
    consequent: fragmentToJsx(ctx, node.consequent, node.start),
    alternate
  };
};

/**
 * `{#each list as item, i (key)}body{:else}fallback{/each}` ->
 * a `list.map((item, i) => body)` container. The `{:else}` fallback is
 * deliberately emitted as a second sibling fragment rather than folded into a
 * conditional: re-using `list` in a conditional test would sub-parse the same
 * expression twice and double-count its identifiers downstream.
 *
 * `node.index` is a plain string in Svelte's AST; its source range is located
 * by searching between the context pattern and the key/group end.
 */
const eachBlockNodes = (ctx, node) => {
  const mapCall = {
    type: "CallExpression",
    start: node.expression.start,
    end: node.end,
    loc: ctx.locBetween(node.expression.start, node.end),
    callee: {
      type: "MemberExpression",
      computed: false,
      object: subExpr(ctx, node.expression.start, node.expression.end),
      property: zeroWidth(ctx, node.expression.end, {
        type: "Identifier",
        name: "map"
      }),
      start: node.expression.start,
      end: node.expression.end,
      loc: ctx.locBetween(node.expression.start, node.expression.end)
    },
    arguments: [eachArrowFunction(ctx, node)]
  };
  const container = {
    type: "JSXExpressionContainer",
    start: node.start,
    end: node.end,
    loc: ctx.locBetween(node.start, node.end),
    svelteKind: "EachBlock",
    expression: mapCall
  };
  return node.fallback ? [container, fragmentToJsx(ctx, node.fallback, node.end)] : container;
};

const eachArrowFunction = (ctx, node) => {
  const params = [subPattern(ctx, node.context.start, node.context.end)];
  if (node.index) {
    params.push(eachIndexIdentifier(ctx, node));
  }
  const body = fragmentToJsx(ctx, node.body, node.start);
  // The `(key)` expression becomes the first child of the arrow's fragment so
  // its identifiers stay reachable without polluting the map() signature.
  if (node.key) {
    body.children.unshift(
      bracedContainer(
        ctx,
        subExpr(ctx, node.key.start, node.key.end),
        node.key.start - 1,
        node.key.end + 1
      )
    );
  }
  return {
    type: "ArrowFunctionExpression",
    start: node.context.start,
    end: node.end,
    loc: ctx.locBetween(node.context.start, node.end),
    id: null,
    async: false,
    generator: false,
    params,
    body,
    expression: false
  };
};

const eachIndexIdentifier = (ctx, node) => {
  const searchEnd = node.key ? node.key.start : node.end;
  const region = ctx.slice(node.context.end, searchEnd);
  const match = new RegExp(
    `[,\\s]${node.index.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s({]|[,\\s]${node.index.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
  ).exec(region);
  if (match) {
    const start = node.context.end + match.index + 1;
    const end = start + node.index.length;
    return {
      type: "Identifier",
      name: node.index,
      start,
      end,
      loc: ctx.locBetween(start, end)
    };
  }
  return zeroWidth(ctx, node.context.end, {
    type: "Identifier",
    name: node.index
  });
};

/**
 * `{#await expr}pending{:then value}then{:catch error}catch{/await}` ->
 * the pending children emitted as plain preceding siblings (they are static
 * DOM), followed by a container over `expr.then(onFulfilled, onRejected?)`.
 * A `NullLiteral` keeps the rejection handler in argument position when only
 * `{:catch}` is present.
 */
const awaitBlockNodes = (ctx, node) => {
  const pendingChildren = (node.pending?.nodes ?? [])
    .map((child) => mapChild(ctx, child))
    .flat()
    .filter(Boolean);
  const argumentsList = [];
  if (node.then) {
    argumentsList.push(awaitHandler(ctx, node.value, node.then, node));
  } else if (node.catch) {
    argumentsList.push(zeroWidth(ctx, node.end, { type: "NullLiteral" }));
  }
  if (node.catch) {
    argumentsList.push(awaitHandler(ctx, node.error, node.catch, node));
  }
  const call = {
    type: "CallExpression",
    start: node.expression.start,
    end: node.end,
    loc: ctx.locBetween(node.expression.start, node.end),
    callee: {
      type: "MemberExpression",
      computed: false,
      object: subExpr(ctx, node.expression.start, node.expression.end),
      property: zeroWidth(ctx, node.expression.end, {
        type: "Identifier",
        name: "then"
      }),
      start: node.expression.start,
      end: node.expression.end,
      loc: ctx.locBetween(node.expression.start, node.expression.end)
    },
    arguments: argumentsList
  };
  const container = {
    type: "JSXExpressionContainer",
    start: node.start,
    end: node.end,
    loc: ctx.locBetween(node.start, node.end),
    svelteKind: "AwaitBlock",
    expression: call
  };
  return [...pendingChildren, container];
};

const awaitHandler = (ctx, pattern, fragment, owner) => ({
  type: "ArrowFunctionExpression",
  start: pattern?.start ?? fragment.nodes[0]?.start ?? owner.start,
  end: fragment.end ?? owner.end,
  loc: ctx.locBetween(
    pattern?.start ?? fragment.nodes[0]?.start ?? owner.start,
    fragment.end ?? owner.end
  ),
  id: null,
  async: false,
  generator: false,
  params: pattern ? [subPattern(ctx, pattern.start, pattern.end)] : [],
  body: fragmentToJsx(ctx, fragment, owner.start),
  expression: false
});

/**
 * `{#key expr}fragment{/key}` -> the key expression container followed by the
 * fragment as a sibling, mirroring how the each-block fallback is emitted.
 */
const keyBlockNodes = (ctx, node) => [
  bracedContainer(
    ctx,
    subExpr(ctx, node.expression.start, node.expression.end),
    node.expression.start - 1,
    node.expression.end + 1
  ),
  fragmentToJsx(ctx, node.fragment, node.start)
];

/**
 * `{#snippet name(params)}body{/snippet}` -> an assignment of an arrow function
 * to the snippet's name, so the name binding and the closure body are both
 * visible downstream.
 */
const snippetBlockContainer = (ctx, node) => ({
  type: "JSXExpressionContainer",
  start: node.start,
  end: node.end,
  loc: ctx.locBetween(node.start, node.end),
  svelteKind: "SnippetBlock",
  svelteName: node.expression?.name,
  expression: {
    type: "AssignmentExpression",
    operator: "=",
    start: node.expression.start,
    end: node.end,
    loc: ctx.locBetween(node.expression.start, node.end),
    left: {
      type: "Identifier",
      name: node.expression.name,
      start: node.expression.start,
      end: node.expression.end,
      loc: ctx.locBetween(node.expression.start, node.expression.end)
    },
    right: {
      type: "ArrowFunctionExpression",
      start: node.expression.start,
      end: node.end,
      loc: ctx.locBetween(node.expression.start, node.end),
      id: null,
      async: false,
      generator: false,
      params: (node.parameters ?? []).map((p) =>
        subPattern(ctx, p.start, p.end)
      ),
      body: fragmentToJsx(ctx, node.body, node.start),
      expression: false
    }
  }
});

/**
 * A Svelte fragment (a list of sibling template nodes) becomes a JSXFragment
 * spanning its first..last mapped child. Empty fragments get a zero-width
 * range at `fallbackOffset` (the enclosing block's start/end) so consumers
 * never see an unset position. Takes already-mapped children so a fragment is
 * never mapped twice (sub-parses have side effects on the error list).
 */
const jsxFragmentFromChildren = (ctx, children, fallbackOffset) => {
  const start = children.length
    ? children[0].start
    : (fallbackOffset ?? 0);
  const end = children.length
    ? children[children.length - 1].end
    : (fallbackOffset ?? 0);
  return {
    type: "JSXFragment",
    start,
    end,
    loc: ctx.locBetween(start, end),
    svelteKind: "Fragment",
    openingFragment: {
      type: "JSXOpeningFragment",
      start,
      end: start,
      loc: ctx.locBetween(start, start),
      svelteKind: "Fragment"
    },
    closingFragment: {
      type: "JSXClosingFragment",
      start: end,
      end,
      loc: ctx.locBetween(end, end),
      svelteKind: "Fragment"
    },
    children
  };
};

const fragmentToJsx = (ctx, fragment, fallbackOffset) =>
  jsxFragmentFromChildren(
    ctx,
    (fragment?.nodes ?? [])
      .map((child) => mapChild(ctx, child))
      .flat()
      .filter(Boolean),
    fallbackOffset
  );

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

/**
 * Build the masked buffer for script parsing: a same-length copy of the file
 * where only the script bodies keep their bytes. Newlines survive so line
 * numbers are preserved for every other region.
 */
const maskedScriptBuffer = (root, src) => {
  const buffer = src.replace(/[^\r\n]/g, " ").split("");
  for (const script of [root.instance, root.module].filter(Boolean)) {
    const content = script.content;
    for (let i = content.start; i < content.end; i++) {
      buffer[i] = src[i];
    }
  }
  return buffer.join("");
};

/**
 * Parse a `.svelte` source into a Babel `File` AST with absolute offsets.
 * Throws if `svelte/compiler` cannot segment the file (the caller falls back
 * to the legacy masking parser) or if the script buffer cannot be parsed.
 *
 * @param {string} file absolute path, used for sourceFilename
 * @param {string} src file content
 * @param {object} options Babel parser options shared with astgen.js
 */
const assembleFile = (ctx, src, body) => ({
  type: "File",
  start: 0,
  end: src.length,
  loc: { start: ctx.posOf(0), end: ctx.posOf(src.length) },
  errors: ctx.errors,
  comments: [],
  program: {
    type: "Program",
    start: 0,
    end: src.length,
    loc: { start: ctx.posOf(0), end: ctx.posOf(src.length) },
    sourceType: "module",
    interpreter: null,
    directives: [],
    body
  }
});

export const parseSvelteFile = (file, src, options) => {
  const root = svelteCompilerParse(src, {
    modern: true,
    filename: file
  });
  const babelOptions = { ...options, sourceFilename: file };
  const errors = [];
  const ctx = new SvelteParseContext(file, src, babelOptions, errors);

  // Step A: script statements via one Babel parse of the masked buffer. Both
  // the instance and module scripts land in the same Program, flattened; the
  // distinction is lost and documented.
  const scriptFile = babelParse(maskedScriptBuffer(root, src), babelOptions);
  if (Array.isArray(scriptFile.errors)) {
    errors.push(...scriptFile.errors);
  }
  const scriptStatements = scriptFile.program.body;
  relocTree(ctx, scriptStatements);

  // Step B: the template as one JSXFragment expression statement appended
  // after the scripts; body is sorted by start because `<script>` may legally
  // follow the markup. A template with no mapped content (or whitespace text
  // only) contributes nothing.
  const templateChildren = (root.fragment?.nodes ?? [])
    .map((child) => mapChild(ctx, child))
    .flat()
    .filter(Boolean);
  const hasTemplateContent = templateChildren.some(
    (child) => !(child.type === "JSXText" && child.value.trim() === "")
  );
  // Script statements keep source order among themselves; the template statement is
  // always appended last, never sorted in by offset.
  //
  // A component's markup renders after its instance script has run - Svelte hoists the
  // script regardless of where the `<script>` tag sits textually - so "template last" is
  // the execution order. Sorting by offset instead was actively wrong: the root fragment's
  // first child is whatever text precedes `<script>`, so a single leading newline gave the
  // template statement start=0 and placed it ahead of every script statement. Downstream
  // that inverts the CFG (method entry -> template -> script), which means no script-side
  // definition reaches a template use and every template dataflow query silently returns
  // nothing.
  const body = [...scriptStatements].sort((a, b) => a.start - b.start);
  if (hasTemplateContent) {
    const start = templateChildren[0].start;
    const end = templateChildren[templateChildren.length - 1].end;
    body.push({
      type: "ExpressionStatement",
      start,
      end,
      loc: ctx.locBetween(start, end),
      expression: jsxFragmentFromChildren(ctx, templateChildren, 0)
    });
  }

  return assembleFile(ctx, src, body);
};

/**
 * Fallback for files `svelte/compiler` rejects outright: parse only the script
 * blocks, over a position-preserving masked buffer (every byte outside the
 * `<script>` contents blanked to a space, newlines kept - the same masking
 * astgen.js applies to build virtual type sources). Because nothing moves, the
 * statement offsets are absolute byte positions into the original file, so a
 * scanner keeps correct line numbers for the script even though the template
 * is unrecoverable. The whole-file failure is recorded on `File.errors`.
 *
 * @param {string} file absolute path, used for sourceFilename
 * @param {string} src original file content (for loc computation)
 * @param {string} maskedSource same-length buffer with script contents verbatim
 * @param {object} options Babel parser options shared with astgen.js
 * @param {string} parseErrorMessage the svelte/compiler failure to record
 */
export const parseSvelteScriptBuffer = (
  file,
  src,
  maskedSource,
  options,
  parseErrorMessage
) => {
  const babelOptions = { ...options, sourceFilename: file };
  const errors = [];
  const ctx = new SvelteParseContext(file, src, babelOptions, errors);
  const scriptFile = babelParse(maskedSource, babelOptions);
  if (Array.isArray(scriptFile.errors)) {
    errors.push(...scriptFile.errors);
  }
  errors.push({ svelteParse: true, message: parseErrorMessage });
  const statements = scriptFile.program.body;
  relocTree(ctx, statements);
  return assembleFile(ctx, src, statements);
};
