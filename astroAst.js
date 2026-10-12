// Astro component support for astgen.
//
// An `.astro` file is an optional TypeScript frontmatter fenced by `---` lines,
// which runs on the server for every request (or at build time), followed by an
// HTML-like template with `{expression}` interpolations (which may hold JSX),
// `name={expression}` attributes and directives (`set:html`, `class:list`,
// `client:load`, ...), and `<script>`/`<style>` blocks. Neither half parses as
// the other, so the file is produced the way svelteAst.js produces a Svelte
// component - the same invariants, so chen needs nothing Astro-specific:
//
//   1. The frontmatter and the client `<script>` bodies are parsed by Babel over
//      a masked buffer - a same-length copy of the file where every character
//      outside them is blanked to a space (newlines preserved) - so statement
//      offsets are already absolute.
//   2. The template is scanned and re-emitted as stock Babel JSX nodes
//      (JSXElement, JSXAttribute with a JSXNamespacedName for `set:html`,
//      JSXExpressionContainer, JSXText), one JSXFragment statement appended after
//      the script statements: the template renders after the frontmatter ran.
//   3. Every expression is sub-parsed with Babel from its own source substring
//      and shifted back into file coordinates, so `src.slice(node.start,
//      node.end)` is always the node's original text and `loc` is rebuilt from
//      the offsets.
//
// Synthesized nodes carry an additive `astroKind` key ("Element", "Component",
// "Fragment", "Expression", ...) for traceability; consumers ignore unknown keys.
//
// There is no Astro compiler dependency: the template grammar the scanner needs
// - tags, attributes, `{...}` with JavaScript inside, comments, raw-text
// `<script>`/`<style>` - is small. Accepted losses: `<style>` blocks and HTML
// comments are dropped; a `<script>` that is not JavaScript (`type` other than
// a module/JS type, e.g. JSON-LD) is dropped; HTML's optional end tags are
// closed by the next unmatched closing tag or the end of the file.

import { parse as babelParse, parseExpression } from "@babel/parser";

const UNPARSED_IDENTIFIER_NAME = "__astgen_unparsed";

/** HTML elements that never have content or an end tag. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

/** `<script type="...">` values whose body is JavaScript. */
const JS_SCRIPT_TYPES = new Set([
  "",
  "module",
  "text/javascript",
  "application/javascript",
  "text/typescript",
  "application/typescript"
]);

class AstroParseContext {
  constructor(file, src, options, errors) {
    this.file = file;
    this.src = src;
    this.options = options;
    this.errors = errors;
    this.lineStarts = [0];
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "\n") {
        this.lineStarts.push(i + 1);
      }
    }
    // [start, end) ranges of JavaScript to parse as statements: the frontmatter
    // and the bodies of the client scripts.
    this.scriptRanges = [];
  }

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

  locBetween(start, end) {
    return { start: this.posOf(start), end: this.posOf(end) };
  }

  slice(start, end) {
    return this.src.slice(start, end);
  }

  recordFailure(message, start, end) {
    this.errors.push({ astroSubParse: true, message, start, end });
  }
}

/** Shift every offset of a Babel subtree by `delta` and rebuild `loc`. */
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
    node.loc = ctx.locBetween(node.start, node.end);
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") {
      continue;
    }
    shiftNode(ctx, node[key], delta);
  }
  return node;
};

/** Rebuild `loc` from offsets everywhere (Babel shares position objects). */
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

const unparsedIdentifier = (ctx, start, end) => ({
  type: "Identifier",
  name: UNPARSED_IDENTIFIER_NAME,
  start,
  end,
  loc: ctx.locBetween(start, end)
});

/** Sub-parse the expression at [start, end); a failure costs that expression only. */
const subExpr = (ctx, start, end) => {
  try {
    return shiftNode(ctx, parseExpression(ctx.slice(start, end), ctx.options), start);
  } catch (err) {
    ctx.recordFailure(err?.message || String(err), start, end);
    return unparsedIdentifier(ctx, start, end);
  }
};

const canParseExpression = (ctx, start, end) => {
  try {
    parseExpression(ctx.slice(start, end), ctx.options);
    return true;
  } catch {
    return false;
  }
};

/**
 * Index of the `}` closing the `{` at `open`. A quick scan that knows strings,
 * template literals and comments finds it in the common case; JSX text inside
 * an expression (`{ok && <p>Don't</p>}`) can mislead that scan, so its answer is
 * confirmed by parsing, and otherwise the following `}`s are tried in turn.
 */
const findExpressionEnd = (ctx, open) => {
  const src = ctx.src;
  let depth = 0;
  let i = open;
  const templateDepths = [];
  let scanned = -1;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        j += src[j] === "\\" ? 2 : 1;
      }
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "{") {
          templateDepths.push(depth);
          depth++;
          j += 2;
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
        // the end of a `${...}`: resume inside the template literal
        templateDepths.pop();
        let j = i + 1;
        while (j < src.length && src[j] !== "`") {
          if (src[j] === "\\") {
            j += 2;
            continue;
          }
          if (src[j] === "$" && src[j + 1] === "{") {
            templateDepths.push(depth);
            depth++;
            j += 2;
            i = j;
            break;
          }
          j++;
        }
        if (src[j] === "`") {
          i = j + 1;
        }
        continue;
      }
      if (depth === 0) {
        scanned = i;
        break;
      }
    }
    i++;
  }
  if (scanned !== -1 && canParseExpression(ctx, open + 1, scanned)) {
    return scanned;
  }
  // Fall back to the candidates in order, bounded.
  let candidate = src.indexOf("}", open + 1);
  for (let tries = 0; candidate !== -1 && tries < 64; tries++) {
    const content = ctx.slice(open + 1, candidate).trim();
    if (content === "" || canParseExpression(ctx, open + 1, candidate)) {
      return candidate;
    }
    candidate = src.indexOf("}", candidate + 1);
  }
  return scanned;
};

const jsxIdentifier = (ctx, name, start, end) => ({
  type: "JSXIdentifier",
  name,
  start,
  end,
  loc: ctx.locBetween(start, end)
});

/** `div`, `set:html` (JSXNamespacedName), `Layout.Header` (JSXMemberExpression). */
const jsxName = (ctx, name, start, end) => {
  if (name.includes(":")) {
    const colon = name.indexOf(":");
    return {
      type: "JSXNamespacedName",
      namespace: jsxIdentifier(ctx, name.slice(0, colon), start, start + colon),
      name: jsxIdentifier(ctx, name.slice(colon + 1), start + colon + 1, end),
      start,
      end,
      loc: ctx.locBetween(start, end)
    };
  }
  if (name.includes(".")) {
    const dot = name.lastIndexOf(".");
    return {
      type: "JSXMemberExpression",
      object: jsxName(ctx, name.slice(0, dot), start, start + dot),
      property: jsxIdentifier(ctx, name.slice(dot + 1), start + dot + 1, end),
      start,
      end,
      loc: ctx.locBetween(start, end)
    };
  }
  return jsxIdentifier(ctx, name, start, end);
};

const expressionContainer = (ctx, open, close) => {
  const content = ctx.slice(open + 1, close);
  const trimmed = content.trim();
  const isEmpty =
    trimmed === "" ||
    /^\/\*[\s\S]*\*\/$/.test(trimmed) ||
    /^\/\/[^\n]*$/.test(trimmed);
  const expression = isEmpty
    ? {
        type: "JSXEmptyExpression",
        start: open + 1,
        end: close,
        loc: ctx.locBetween(open + 1, close)
      }
    : subExpr(ctx, open + 1, close);
  return {
    type: "JSXExpressionContainer",
    start: open,
    end: close + 1,
    loc: ctx.locBetween(open, close + 1),
    astroKind: "Expression",
    expression
  };
};

const stringLiteral = (ctx, start, end, value) => ({
  type: "StringLiteral",
  start,
  end,
  loc: ctx.locBetween(start, end),
  value,
  extra: { rawValue: value, raw: ctx.slice(start, end) }
});

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/**
 * The attributes of an opening tag from `pos` (just past the tag name) to its
 * `>`/`/>`. Returns { attributes, end, selfClosing } with `end` just past the
 * tag.
 */
const scanAttributes = (ctx, pos) => {
  const src = ctx.src;
  const attributes = [];
  let p = pos;
  while (p < src.length) {
    while (p < src.length && isSpace(src[p])) {
      p++;
    }
    if (src.startsWith("/>", p)) {
      return { attributes, end: p + 2, selfClosing: true };
    }
    if (src[p] === ">") {
      return { attributes, end: p + 1, selfClosing: false };
    }
    if (src[p] === "{") {
      const close = findExpressionEnd(ctx, p);
      if (close === -1) {
        return { attributes, end: src.length, selfClosing: false };
      }
      const inner = ctx.slice(p + 1, close);
      const lead = inner.length - inner.trimStart().length;
      if (inner.trimStart().startsWith("...")) {
        // {...props}
        attributes.push({
          type: "JSXSpreadAttribute",
          start: p,
          end: close + 1,
          loc: ctx.locBetween(p, close + 1),
          argument: subExpr(ctx, p + 1 + lead + 3, close)
        });
      } else {
        // {prop}: shorthand for prop={prop}
        const name = inner.trim();
        const nameStart = p + 1 + lead;
        attributes.push({
          type: "JSXAttribute",
          start: p,
          end: close + 1,
          loc: ctx.locBetween(p, close + 1),
          astroKind: "ShorthandAttribute",
          name: jsxIdentifier(ctx, name, nameStart, nameStart + name.length),
          value: expressionContainer(ctx, p, close)
        });
      }
      p = close + 1;
      continue;
    }
    const nameMatch = /^[^\s=/>"'{}`]+/.exec(src.slice(p, p + 256));
    if (!nameMatch) {
      p++;
      continue;
    }
    const name = nameMatch[0];
    const nameStart = p;
    const nameEnd = p + name.length;
    p = nameEnd;
    let q = p;
    while (q < src.length && isSpace(src[q])) {
      q++;
    }
    let value = null;
    let attrEnd = nameEnd;
    if (src[q] === "=") {
      q++;
      while (q < src.length && isSpace(src[q])) {
        q++;
      }
      const quote = src[q];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, q + 1);
        const end = close === -1 ? src.length : close + 1;
        value = stringLiteral(ctx, q, end, ctx.slice(q + 1, end - 1));
        attrEnd = end;
      } else if (quote === "{") {
        const close = findExpressionEnd(ctx, q);
        const end = close === -1 ? src.length : close;
        value = expressionContainer(ctx, q, end);
        attrEnd = end + 1;
      } else if (quote === "`") {
        // name=`/a/${b}` - a template literal attribute
        let close = q + 1;
        while (close < src.length) {
          if (src[close] === "\\") {
            close += 2;
            continue;
          }
          if (src[close] === "`") {
            break;
          }
          close++;
        }
        const end = Math.min(close + 1, src.length);
        value = {
          type: "JSXExpressionContainer",
          start: q,
          end,
          loc: ctx.locBetween(q, end),
          astroKind: "TemplateAttribute",
          expression: subExpr(ctx, q, end)
        };
        attrEnd = end;
      } else {
        // unquoted value
        let end = q;
        while (end < src.length && !isSpace(src[end]) && src[end] !== ">" && !src.startsWith("/>", end)) {
          end++;
        }
        value = stringLiteral(ctx, q, end, ctx.slice(q, end));
        attrEnd = end;
      }
      p = attrEnd;
    }
    attributes.push({
      type: "JSXAttribute",
      start: nameStart,
      end: attrEnd,
      loc: ctx.locBetween(nameStart, attrEnd),
      name: jsxName(ctx, name, nameStart, nameEnd),
      value
    });
  }
  return { attributes, end: src.length, selfClosing: false };
};

const attributeValue = (attributes, name) => {
  const attribute = attributes.find(
    (a) => a.type === "JSXAttribute" && a.name?.type === "JSXIdentifier" && a.name.name === name
  );
  return attribute?.value?.type === "StringLiteral" ? attribute.value.value : null;
};

const jsxText = (ctx, start, end) => {
  const raw = ctx.slice(start, end);
  return {
    type: "JSXText",
    start,
    end,
    loc: ctx.locBetween(start, end),
    value: raw,
    extra: { rawValue: raw, raw }
  };
};

/**
 * Children from `pos` until the closing tag of an element on `open` (the stack
 * of element names), or the end of the file. Returns { children, end, close }
 * where `close` is the [start, end) of the closing tag that stopped the scan,
 * when it belongs to the innermost open element.
 */
const scanChildren = (ctx, pos, open) => {
  const src = ctx.src;
  const children = [];
  let p = pos;
  while (p < src.length) {
    if (src.startsWith("<!--", p)) {
      const close = src.indexOf("-->", p + 4);
      p = close === -1 ? src.length : close + 3;
      continue;
    }
    if (src.startsWith("</", p)) {
      const m = /^<\/\s*([^\s>]*)\s*>/.exec(src.slice(p, p + 256));
      const name = m ? m[1] : "";
      const end = m ? p + m[0].length : p + 2;
      if (open.length && open[open.length - 1] === name) {
        return { children, end, close: [p, end] };
      }
      if (open.includes(name)) {
        // closes an outer element: this one ends here, unclosed
        return { children, end: p, close: null };
      }
      p = end; // a stray closing tag
      continue;
    }
    if (src.startsWith("<!", p) || src.startsWith("<?", p)) {
      // <!DOCTYPE html>, <?xml ...?>
      const close = src.indexOf(">", p);
      p = close === -1 ? src.length : close + 1;
      continue;
    }
    if (src[p] === "<" && /[A-Za-z>]/.test(src[p + 1] ?? "")) {
      const element = scanElement(ctx, p, open);
      children.push(element);
      p = element.end;
      continue;
    }
    if (src[p] === "{") {
      const close = findExpressionEnd(ctx, p);
      if (close === -1) {
        children.push(jsxText(ctx, p, src.length));
        p = src.length;
        continue;
      }
      children.push(expressionContainer(ctx, p, close));
      p = close + 1;
      continue;
    }
    let end = p + 1;
    while (end < src.length && src[end] !== "<" && src[end] !== "{") {
      end++;
    }
    children.push(jsxText(ctx, p, end));
    p = end;
  }
  return { children, end: src.length, close: null };
};

const scanElement = (ctx, start, open) => {
  const src = ctx.src;
  const nameMatch = /^[A-Za-z][\w.:-]*/.exec(src.slice(start + 1, start + 257));
  const name = nameMatch ? nameMatch[0] : "";
  const nameStart = start + 1;
  const nameEnd = nameStart + name.length;
  const { attributes, end: openEnd, selfClosing } = scanAttributes(ctx, nameEnd);
  const lower = name.toLowerCase();
  const isComponent = /^[A-Z]/.test(name) || name.includes(".");
  const kind = name === "" ? "Fragment" : isComponent ? "Component" : "Element";

  let children = [];
  let end = openEnd;
  let closeRange = null;
  if (!selfClosing && (lower === "script" || lower === "style")) {
    // raw text: up to the matching end tag
    const closeRe = new RegExp(`</${lower}\\s*>`, "i");
    const m = closeRe.exec(src.slice(openEnd));
    const bodyEnd = m ? openEnd + m.index : src.length;
    end = m ? bodyEnd + m[0].length : src.length;
    closeRange = m ? [bodyEnd, end] : null;
    if (lower === "script" && JS_SCRIPT_TYPES.has((attributeValue(attributes, "type") ?? "").toLowerCase())) {
      ctx.scriptRanges.push([openEnd, bodyEnd]);
    }
  } else if (!selfClosing && !VOID_ELEMENTS.has(lower)) {
    const scanned = scanChildren(ctx, openEnd, [...open, name]);
    children = scanned.children;
    end = scanned.end;
    closeRange = scanned.close;
  }

  const element = {
    type: name === "" ? "JSXFragment" : "JSXElement",
    start,
    end,
    loc: ctx.locBetween(start, end),
    astroKind: kind,
    children
  };
  if (name === "") {
    element.openingFragment = {
      type: "JSXOpeningFragment",
      start,
      end: openEnd,
      loc: ctx.locBetween(start, openEnd)
    };
    element.closingFragment = {
      type: "JSXClosingFragment",
      start: closeRange ? closeRange[0] : end,
      end,
      loc: ctx.locBetween(closeRange ? closeRange[0] : end, end)
    };
    return element;
  }
  element.openingElement = {
    type: "JSXOpeningElement",
    start,
    end: openEnd,
    loc: ctx.locBetween(start, openEnd),
    astroKind: kind,
    name: jsxName(ctx, name, nameStart, nameEnd),
    attributes,
    selfClosing: selfClosing || (!closeRange && children.length === 0)
  };
  element.closingElement = closeRange
    ? {
        type: "JSXClosingElement",
        start: closeRange[0],
        end: closeRange[1],
        loc: ctx.locBetween(closeRange[0], closeRange[1]),
        name: jsxName(
          ctx,
          name,
          closeRange[0] + 2,
          closeRange[0] + 2 + name.length
        )
      }
    : null;
  return element;
};

/** [bodyStart, bodyEnd, templateStart] of the `---` fenced frontmatter, or null. */
const frontmatterRange = (src) => {
  const open = /^﻿?[ \t\r\n]*---[ \t]*\r?\n/.exec(src);
  if (!open) {
    return null;
  }
  const bodyStart = open[0].length;
  const closeRe = /^---[ \t]*$/gm;
  closeRe.lastIndex = bodyStart;
  const close = closeRe.exec(src);
  if (!close) {
    return null;
  }
  const lineEnd = src.indexOf("\n", close.index);
  return [bodyStart, close.index, lineEnd === -1 ? src.length : lineEnd + 1];
};

/** A same-length copy of `src` with everything outside `ranges` blanked (newlines kept). */
const maskOutside = (src, ranges) => {
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] === "\n" || src[i] === "\r" ? src[i] : " ";
  }
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      out[i] = src[i];
    }
  }
  return out.join("");
};

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

/**
 * Parse an `.astro` component into a Babel `File` AST.
 *
 * @param {string} file absolute path, used for sourceFilename
 * @param {string} src the file's content
 * @param {object} options Babel parser options shared with astgen.js (JSX and
 *   TypeScript enabled)
 */
export const parseAstroFile = (file, src, options) => {
  const babelOptions = { ...options, sourceFilename: file };
  const errors = [];
  const ctx = new AstroParseContext(file, src, babelOptions, errors);

  const frontmatter = frontmatterRange(src);
  if (frontmatter) {
    ctx.scriptRanges.push([frontmatter[0], frontmatter[1]]);
  }
  const templateStart = frontmatter ? frontmatter[2] : 0;
  const { children } = scanChildren(ctx, templateStart, []);

  // Frontmatter and client scripts: one parse of the masked buffer. They are
  // different scopes at runtime (server and browser); flattened here.
  const scriptFile = babelParse(maskOutside(src, ctx.scriptRanges), babelOptions);
  if (Array.isArray(scriptFile.errors)) {
    errors.push(...scriptFile.errors);
  }
  const statements = scriptFile.program.body;
  relocTree(ctx, statements);

  const body = [...statements].sort((a, b) => a.start - b.start);
  const hasTemplateContent = children.some(
    (child) => !(child.type === "JSXText" && child.value.trim() === "")
  );
  if (hasTemplateContent) {
    const start = children[0].start;
    const end = children[children.length - 1].end;
    body.push({
      type: "ExpressionStatement",
      start,
      end,
      loc: ctx.locBetween(start, end),
      expression: {
        type: "JSXFragment",
        start,
        end,
        loc: ctx.locBetween(start, end),
        astroKind: "Template",
        openingFragment: {
          type: "JSXOpeningFragment",
          start,
          end: start,
          loc: ctx.locBetween(start, start)
        },
        closingFragment: {
          type: "JSXClosingFragment",
          start: end,
          end,
          loc: ctx.locBetween(end, end)
        },
        children
      }
    });
  }
  return assembleFile(ctx, src, body);
};

/**
 * Fallback when the template scan throws: the frontmatter alone, over a masked
 * buffer, with the failure recorded on `File.errors`.
 */
export const parseAstroFrontmatterOnly = (file, src, options, parseErrorMessage) => {
  const babelOptions = { ...options, sourceFilename: file };
  const errors = [];
  const ctx = new AstroParseContext(file, src, babelOptions, errors);
  const frontmatter = frontmatterRange(src);
  const ranges = frontmatter ? [[frontmatter[0], frontmatter[1]]] : [];
  const scriptFile = babelParse(maskOutside(src, ranges), babelOptions);
  if (Array.isArray(scriptFile.errors)) {
    errors.push(...scriptFile.errors);
  }
  errors.push({ astroParse: true, message: parseErrorMessage });
  const statements = scriptFile.program.body;
  relocTree(ctx, statements);
  return assembleFile(ctx, src, statements);
};
