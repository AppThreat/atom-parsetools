// HTML templates for astgen: Alpine.js pages and Angular component templates.
//
// Both are plain `.html` files whose markup carries the framework's bindings as
// attributes - Alpine directives (`x-data`, `x-init`, `x-html`, `x-bind:href`,
// ...), Angular property bindings (`[innerHTML]="expr | pipe"`) - while the
// script behind them lives in a separate module. Neither half parses as the
// other, so - like Svelte and Astro - the file is segmented here and re-emitted
// as a regular Babel `File`:
//
//   * an inline `x-data="{ key: expr }"` object becomes one `var key = expr;`
//     statement per property, sub-parsed at the value's own absolute offsets;
//   * a named `x-data="component"` becomes `var component_data = component();`
//     - a call the recognizers resolve to the `Alpine.data('component', ...)`
//     callback in the script module;
//   * `x-init="stmt"` becomes the statement itself;
//   * an element carrying `x-html`, `x-bind:<attr>`/`:<attr>` or `x-text` is
//     re-emitted as a JSX element with those expressions as attribute values
//     (`x-html="v"` -> `innerHTML={v}`), so the existing template-sink
//     machinery applies unchanged; `x-text` interpolates as text and is inert;
//   * an Angular property binding `[prop]="expr"` is a JSX attribute that keeps
//     its bracketed name (`[innerHTML]={expr}`): Angular sanitises every
//     property binding, so the recognizers must tell it from a raw DOM write.
//     Pipes are calls (`expr | name:arg` -> `name(expr, arg)`), which the
//     recognizers resolve to the pipe class's `transform`. A two-way binding
//     `[(ngModel)]="field"` keeps its raw value: it names the field the control
//     writes.
//
// Every emitted node keeps absolute byte offsets into the original `.html`
// (`loc.start.index === start`), the two invariants of svelteAst.

import { parse as babelParse, parseExpression } from "@babel/parser";

// Directives whose value is an expression rendered into the element.
const EXPR_DIRECTIVES = { "x-html": "innerHTML" };
// Directives whose value is a statement run at init.
const STMT_DIRECTIVES = new Set(["x-init"]);

const attrRegex = (tagText) => {
  const re =
    /((?:x-[\w:.-]+)|(?::[\w:.-]+)|\[\([\w.-]+\)\]|\[[\w.-]+\])\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const out = [];
  let m;
  while ((m = re.exec(tagText)) !== null) {
    const value = m[2] !== undefined ? m[2] : m[3];
    out.push({
      name: m[1],
      value,
      nameStart: m.index,
      // +1 skips the opening quote
      valueStart: m.index + m[0].indexOf(`"${value}`) !== -1
        ? m.index + m[0].indexOf(`"${value}`) + 1
        : m.index + m[0].indexOf(`'${value}'`) + 1
    });
  }
  return out;
};

/** Line starts of the file, for rebuilding `loc`. */
const lineStartsOf = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") starts.push(i + 1);
  }
  return starts;
};

const posOf = (starts, offset) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo], index: offset };
};

const shiftNode = (starts, node, delta) => {
  if (Array.isArray(node)) {
    for (const child of node) node && shiftNode(starts, child, delta);
    return node;
  }
  if (!node || typeof node !== "object") return node;
  if (typeof node.start === "number" && typeof node.end === "number") {
    node.start += delta;
    node.end += delta;
    if (node.loc) {
      node.loc = { start: posOf(starts, node.start), end: posOf(starts, node.end) };
    }
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    shiftNode(starts, node[key], delta);
  }
  return node;
};

/** Parse `text` (a slice of the file at absolute offset `start`) as an expression. */
const subExpression = (ctx, text, start) => {
  try {
    const parsed = parseExpression(`(${text})`, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      plugins: ["typescript", "jsx"]
    });
    // the wrapper parens put the value at offset 1
    return shiftNode(ctx.starts, parsed, start - 1);
  } catch {
    return {
      type: "Identifier",
      name: "__astgen_unparsed",
      start,
      end: start + text.length,
      loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, start + text.length) }
    };
  }
};

/** Parse `text` (a slice of the file at absolute offset `start`) as statements. */
const subStatements = (ctx, text, start) => {
  try {
    const parsed = babelParse(text, {
      sourceType: "unambiguous",
      allowReturnOutsideFunction: true,
      plugins: ["typescript", "jsx"]
    });
    return parsed.program.body.map((s) => shiftNode(ctx.starts, s, start));
  } catch {
    return [];
  }
};

/**
 * The top-level segments of `text` separated by `sep` - not inside quotes or
 * brackets, and for `|` not part of `||` - as [from, to) offsets into `text`.
 */
const splitTopLevel = (text, sep) => {
  const segments = [];
  let depth = 0;
  let quote = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (
      c === sep &&
      depth === 0 &&
      (sep !== "|" || (text[i + 1] !== "|" && text[i - 1] !== "|"))
    ) {
      segments.push([from, i]);
      from = i + 1;
    }
  }
  segments.push([from, text.length]);
  return segments;
};

/** `text.slice(from, to)` without its surrounding whitespace, and where that starts. */
const trimmedSlice = (text, from, to) => {
  const raw = text.slice(from, to);
  const lead = raw.length - raw.trimStart().length;
  return [raw.trim(), from + lead];
};

/**
 * Parse an Angular binding value, lowering pipes to calls: `expr | name` becomes
 * `name(expr)` and `expr | name:arg1` becomes `name(expr, arg1)`. Every segment is
 * parsed at its own absolute offset, so every emitted node keeps its file
 * coordinates.
 */
const pipeExpression = (ctx, text, start) => {
  const segments = splitTopLevel(text, "|");
  const [headText, headAt] = trimmedSlice(text, ...segments[0]);
  let acc = subExpression(ctx, headText, start + headAt);
  for (const [from, to] of segments.slice(1)) {
    const parts = splitTopLevel(text.slice(from, to), ":");
    const [name, nameAt] = trimmedSlice(text, from + parts[0][0], from + parts[0][1]);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    const args = parts
      .slice(1)
      .map(([a, b]) => trimmedSlice(text, from + a, from + b))
      .filter(([argText]) => argText.length > 0)
      .map(([argText, argAt]) => subExpression(ctx, argText, start + argAt));
    acc = {
      type: "CallExpression",
      callee: identifier(ctx, name, start + nameAt, start + nameAt + name.length),
      arguments: [acc, ...args],
      optional: false,
      start: acc.start,
      end: start + to,
      loc: { start: posOf(ctx.starts, acc.start), end: posOf(ctx.starts, start + to) }
    };
  }
  return acc;
};

const identifier = (ctx, name, start, end) => ({
  type: "Identifier",
  name,
  start,
  end,
  loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, end) }
});

const varDeclaration = (ctx, name, valueExpr, start, end) => ({
  type: "VariableDeclaration",
  kind: "var",
  declarations: [
    {
      type: "VariableDeclarator",
      id: identifier(ctx, name, start, start + name.length),
      init: valueExpr,
      start,
      end,
      loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, end) }
    }
  ],
  start,
  end,
  loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, end) }
});

const jsxAttribute = (ctx, name, valueExpr, start, end) => ({
  type: "JSXAttribute",
  name: {
    type: "JSXIdentifier",
    name,
    start,
    end: start + name.length,
    loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, start + name.length) }
  },
  value: {
    type: "JSXExpressionContainer",
    expression: valueExpr,
    start: valueExpr.start - 1,
    end: valueExpr.end + 1,
    loc: { start: posOf(ctx.starts, valueExpr.start - 1), end: posOf(ctx.starts, valueExpr.end + 1) }
  },
  start,
  end,
  loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, end) }
});

const jsxElement = (ctx, tag, attributes, start, end) => ({
  type: "JSXElement",
  openingElement: {
    type: "JSXOpeningElement",
    name: {
      type: "JSXIdentifier",
      name: tag,
      start,
      end: start + 1 + tag.length,
      loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, start + 1 + tag.length) }
    },
    attributes,
    selfClosing: true,
    start,
    end,
    loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, end) }
  },
  closingElement: null,
  children: [],
  start,
  end,
  loc: { start: posOf(ctx.starts, start), end: posOf(ctx.starts, end) }
});

/**
 * Convert one `.html` file to a Babel File. Returns null when the file carries
 * no Alpine directive and no Angular binding (a plain page stays unparsed).
 */
export const parseHtmlFile = (file, code, options) => {
  const starts = lineStartsOf(code);
  const ctx = { file, starts, options };
  const statements = [];
  const jsxElements = [];
  // named x-data scopes by offset, for qualifying bare reads in expressions
  const namedScopes = [];

  const tagRegex = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagRegex.exec(code)) !== null) {
    const tagStart = match.index;
    const tag = match[1];
    const attrs = attrRegex(match[2]);
    if (attrs.length === 0) continue;
    const hasDirective = attrs.some(
      (a) =>
        a.name.startsWith("x-") ||
        a.name.startsWith(":") ||
        a.name.startsWith("[")
    );
    if (!hasDirective) continue;

    for (const attr of attrs) {
      const attrAbs = tagStart + 1 + tag.length + attr.valueStart;
      if (attr.name === "x-data") {
        const value = attr.value.trim();
        if (value.startsWith("{")) {
          // inline state object: one variable per property, at its own offsets
          const obj = subExpression(ctx, attr.value, attrAbs);
          if (obj.type === "ObjectExpression") {
            for (const prop of obj.properties) {
              if (prop.type !== "ObjectProperty") continue;
              const key =
                prop.key.type === "Identifier" ? prop.key.name : prop.key.extra?.rawValue;
              if (!key) continue;
              statements.push(varDeclaration(ctx, key, prop.value, prop.start, prop.end));
            }
          }
        } else if (/^[A-Za-z_$][\w$]*$/.test(value)) {
          const dataVar = `${value}_data`;
          statements.push(
            varDeclaration(
              ctx,
              dataVar,
              {
                type: "CallExpression",
                callee: identifier(ctx, value, attrAbs, attrAbs + value.length),
                arguments: [],
                optional: false,
                start: attrAbs,
                end: attrAbs + value.length + 2,
                loc: {
                  start: posOf(starts, attrAbs),
                  end: posOf(starts, attrAbs + value.length + 2)
                }
              },
              attrAbs,
              attrAbs + value.length
            )
          );
          namedScopes.push({ offset: attrAbs, name: value });
        }
      } else if (STMT_DIRECTIVES.has(attr.name)) {
        statements.push(...subStatements(ctx, attr.value, attrAbs));
      }
    }

    // the element's rendered expressions
    const jsxAttrs = [];
    const raw = [];
    const attrBase = tagStart + 1 + tag.length;
    for (const attr of attrs) {
      const attrAbs = attrBase + attr.valueStart;
      const nameAbs = attrBase + attr.nameStart;
      let attrName = null;
      if (EXPR_DIRECTIVES[attr.name]) {
        attrName = EXPR_DIRECTIVES[attr.name];
      } else if (attr.name.startsWith("x-bind:")) {
        attrName = attr.name.slice("x-bind:".length);
      } else if (attr.name.startsWith(":")) {
        attrName = attr.name.slice(1);
      } else if (attr.name === "x-text") {
        attrName = "x-text";
      } else if (attr.name.startsWith("[(")) {
        // a two-way binding writes the component field with what the user typed;
        // its raw value names the field
        raw.push(attr);
        continue;
      } else if (attr.name.startsWith("[")) {
        // an Angular property binding keeps its brackets: the framework sanitises
        // it, which the recognizers need to know
        attrName = attr.name;
      }
      if (!attrName || !attr.value.trim()) continue;
      let expr = attr.name.startsWith("[")
        ? pipeExpression(ctx, attr.value, attrAbs)
        : subExpression(ctx, attr.value, attrAbs);
      // a bare identifier that no inline state defined refers to the nearest
      // named component's state: `highlighted` -> `search_data.highlighted`
      if (expr.type === "Identifier" && !statements.some((s) =>
        s.type === "VariableDeclaration" &&
        s.declarations.some((d) => d.id.name === expr.name)
      )) {
        let scope = null;
        for (const s of namedScopes) {
          if (s.offset < attrAbs) scope = s;
        }
        if (scope) {
          expr = {
            type: "MemberExpression",
            object: identifier(ctx, `${scope.name}_data`, expr.start, expr.start),
            property: identifier(ctx, expr.name, expr.start, expr.end),
            computed: false,
            optional: false,
            start: expr.start,
            end: expr.end,
            loc: expr.loc
          };
        }
      }
      jsxAttrs.push(jsxAttribute(ctx, attrName, expr, nameAbs, attrAbs + attr.value.length));
    }
    for (const attr of raw) {
      const abs = attrBase + attr.nameStart;
      const valueAt = attrBase + attr.valueStart;
      jsxAttrs.push({
        type: "JSXAttribute",
        name: {
          type: "JSXIdentifier",
          name: attr.name,
          start: abs,
          end: abs + attr.name.length,
          loc: { start: posOf(ctx.starts, abs), end: posOf(ctx.starts, abs + attr.name.length) }
        },
        value: {
          type: "StringLiteral",
          value: attr.value,
          start: valueAt - 1,
          end: valueAt + attr.value.length + 1,
          loc: {
            start: posOf(ctx.starts, valueAt - 1),
            end: posOf(ctx.starts, valueAt + attr.value.length + 1)
          }
        },
        start: abs,
        end: valueAt + attr.value.length + 1,
        loc: {
          start: posOf(ctx.starts, abs),
          end: posOf(ctx.starts, valueAt + attr.value.length + 1)
        }
      });
    }
    if (jsxAttrs.length > 0) {
      const tagEnd = tagStart + match[0].length;
      jsxElements.push(jsxElement(ctx, tag, jsxAttrs, tagStart, tagEnd));
    }
  }

  if (statements.length === 0 && jsxElements.length === 0) return null;

  if (jsxElements.length > 0) {
    const first = jsxElements[0];
    const last = jsxElements[jsxElements.length - 1];
    statements.push({
      type: "ExpressionStatement",
      expression: {
        type: "JSXFragment",
        openingFragment: {
          type: "JSXOpeningFragment",
          attributes: [],
          selfClosing: false,
          start: first.start,
          end: first.start + 1,
          loc: {
            start: posOf(starts, first.start),
            end: posOf(starts, first.start + 1)
          }
        },
        closingFragment: {
          type: "JSXClosingFragment",
          start: last.end - 1,
          end: last.end,
          loc: {
            start: posOf(starts, last.end - 1),
            end: posOf(starts, last.end)
          }
        },
        children: jsxElements,
        start: first.start,
        end: last.end,
        loc: { start: first.loc.start, end: last.loc.end }
      },
      start: first.start,
      end: last.end,
      loc: { start: first.loc.start, end: last.loc.end }
    });
  }

  return {
    type: "File",
    program: {
      type: "Program",
      body: statements,
      sourceType: "module",
      start: 0,
      end: code.length,
      loc: { start: posOf(starts, 0), end: posOf(starts, code.length) }
    },
    comments: [],
    tokens: [],
    errors: []
  };
};
