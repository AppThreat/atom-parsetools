// Ember (Glimmer) template support for astgen.
//
// Ember components and route templates are written in Handlebars-like Glimmer
// templates: a whole `.hbs` file, or `<template>...</template>` blocks inside
// the JavaScript of a `.gjs`/`.gts` file - at the top level (a template-only
// component or a route template) or in a class body (the class's template).
// Neither parses as JavaScript, so the file is rewritten into TSX that says the
// same thing and parsed with Babel:
//
//   - a template becomes a function returning a JSX fragment: a class body's
//     template the method `__glimmer_template() { ... }`, any other one the
//     function expression `(function __glimmer_template() { ... })`, and a
//     `.hbs` file `export default function __glimmer_template() { ... }`;
//   - `{{expr}}` is a JSX expression container, `{{{expr}}}` (rendered
//     unescaped) the element `<ember-raw innerHTML={expr} />`;
//   - `@name` (an argument) is `this.args.name`; helpers are calls -
//     `{{format-date @at "short"}}` is `format_date(this.args.at, "short")`,
//     named arguments one object literal argument; `if`/`unless` are
//     conditionals, `array`/`hash` literals;
//   - a component's `@name={{v}}` argument is the JSX attribute `name={v}`;
//   - an element modifier `{{innerHtml this.snippet}}` is the spread attribute
//     `{...innerHtml(undefined, [this.snippet], {})}`: a modifier function is
//     called with the element, its positional and its named arguments;
//   - `{{#if}}`/`{{else}}`/`{{#unless}}` are conditionals, `{{#each xs as |x|}}`
//     `xs.map((x) => ...)`, `{{#let v as |x|}}` a call of `(x) => ...` with `v`,
//     any other block helper a call with a callback of its block params.
//
// Every newline of the file is kept where it is, so line numbers are the
// original ones; columns inside a template are the rewritten text's. The
// rewritten text is returned as the AST's `loweredSource`, which astgen writes
// beside the AST as `source`: node offsets index it, not the file.
//
// Accepted losses: `{{yield}}`, `{{outlet}}`, named blocks' names, `...attributes`,
// `<style>`/`<script>` in templates and comments are dropped.

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

/** Newlines in `text`, as a string of them: what a rewritten span must keep. */
const newlinesOf = (text) => text.replace(/[^\n]/g, "");

/** `text` blanked to spaces, newlines kept. */
const blank = (text) => text.replace(/[^\n]/g, " ");

/** A JavaScript identifier for a helper or component name: `format-date` -> `format_date`. */
const jsName = (name) => name.replace(/[^\w$.]/g, "_");

/** Tokens of a mustache's inside: strings, numbers, parentheses, `key=`, paths and `as |a b|`. */
const tokenize = (text) => {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        j++;
      }
      tokens.push({ kind: "string", text: text.slice(i, j + 1) });
      i = j + 1;
    } else if (c === "(" || c === ")") {
      tokens.push({ kind: c });
      i++;
    } else if (c === "|") {
      let j = text.indexOf("|", i + 1);
      if (j < 0) j = text.length;
      tokens.push({
        kind: "params",
        names: text
          .slice(i + 1, j)
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(jsName)
      });
      i = j + 1;
    } else {
      let j = i;
      while (j < text.length && !/[\s()|]/.test(text[j]) && text[j] !== "=")
        j++;
      const word = text.slice(i, j);
      if (text[j] === "=") {
        tokens.push({ kind: "key", text: word });
        i = j + 1;
      } else {
        tokens.push({ kind: "word", text: word });
        i = j;
      }
    }
  }
  return tokens;
};

/** A path or literal word as JavaScript: `@model.slug` -> `this.args.model.slug`. */
const wordToJs = (word) => {
  if (/^-?\d+(\.\d+)?$/.test(word)) return word;
  if (["true", "false", "null", "undefined"].includes(word)) return word;
  // `this.[key]` / `this.key.[0]` segment syntax
  const path = word.replace(/\.\[([^\]]*)\]/g, (_, k) => `.${k}`);
  if (path.startsWith("@")) {
    return `this.args.${path.slice(1).split(".").map(jsName).join(".")}`;
  }
  return path.split(".").map(jsName).join(".");
};

/** A token stream as one JavaScript expression, `pos` advanced past what it read. */
class ExprReader {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  /** One argument: a literal, a path or a parenthesised sub-expression. */
  value() {
    const t = this.tokens[this.pos++];
    if (!t) return "undefined";
    if (t.kind === "string") return t.text;
    if (t.kind === "(") {
      const inner = this.invocation((k) => k === ")");
      if (this.peek()?.kind === ")") this.pos++;
      return `(${inner})`;
    }
    if (t.kind === "word") return wordToJs(t.text);
    return "undefined";
  }

  /** `head arg... key=value...` up to a token `stop` accepts: a value or a call. */
  invocation(stop = () => false) {
    const done = () =>
      !this.peek() || stop(this.peek().kind) || this.peek().kind === "params";
    if (done()) return "undefined";
    const headToken = this.peek();
    const head = this.value();
    const positional = [];
    const named = [];
    while (!done()) {
      const t = this.peek();
      if (t.kind === "key") {
        this.pos++;
        named.push(`${JSON.stringify(t.text)}: ${this.value()}`);
      } else {
        positional.push(this.value());
      }
    }
    if (positional.length === 0 && named.length === 0) return head;
    if (headToken.kind !== "word") return head;
    return callOf(headToken.text, positional, named);
  }
}

/** A helper invocation as JavaScript. */
const callOf = (name, positional, named) => {
  const hash = named.length ? `{ ${named.join(", ")} }` : undefined;
  switch (name) {
    case "if":
      return `(${positional[0]} ? ${positional[1] ?? "undefined"} : ${positional[2] ?? "undefined"})`;
    case "unless":
      return `(!${positional[0]} ? ${positional[1] ?? "undefined"} : ${positional[2] ?? "undefined"})`;
    case "array":
      return `[${positional.join(", ")}]`;
    case "hash":
      return hash ?? "{}";
    default: {
      const args = hash ? [...positional, hash] : positional;
      return `${wordToJs(name)}(${args.join(", ")})`;
    }
  }
};

/** The inside of a mustache as JavaScript, and the block params it declares. */
const mustacheToJs = (inside) => {
  const tokens = tokenize(inside);
  const reader = new ExprReader(tokens);
  const head = tokens[0]?.kind === "word" ? tokens[0].text : undefined;
  const params = tokens.find((t) => t.kind === "params")?.names ?? [];
  return { reader, head, params, tokens };
};

/** End of the mustache opened at `open` (`{{` or `{{{`): the offset past its closing braces. */
const mustacheEnd = (src, open, triple) => {
  const close = triple ? "}}}" : "}}";
  let i = open + (triple ? 3 : 2);
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (src.startsWith(close, i)) {
      return i + close.length;
    }
    i++;
  }
  return src.length;
};

/** The inside of a mustache, without braces, `~` whitespace control and the block sigils. */
const mustacheInside = (text, triple) => {
  const n = triple ? 3 : 2;
  return text
    .slice(n, text.length - n)
    .replace(/^~/, "")
    .replace(/~$/, "");
};

/** JSX text with the characters JSX reserves escaped. */
const jsxText = (text) =>
  text.replace(
    /[{}<>]/g,
    (c) => ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;" })[c]
  );

/** An element or component name as a JSX name. */
const tagName = (name) => {
  if (name.startsWith(":")) return `ember-block-${name.slice(1)}`;
  if (name.startsWith("@")) return `this.args.${name.slice(1)}`;
  // classic nested invocation `Foo::Bar`
  return name.replace(/::/g, ".");
};

class TemplateLowering {
  constructor(src) {
    this.src = src;
    this.out = [];
    this.blocks = [];
  }

  emit(text) {
    this.out.push(text);
  }

  /** A mustache in element content. */
  contentMustache(start) {
    const src = this.src;
    const triple = src.startsWith("{{{", start);
    const end = mustacheEnd(src, start, triple);
    const text = src.slice(start, end);
    const keep = newlinesOf(text);
    let inside = mustacheInside(text, triple).trim();
    if (inside.startsWith("!")) {
      this.emit(blank(text));
      return end;
    }
    if (triple) {
      const { reader } = mustacheToJs(inside);
      this.emit(`<ember-raw innerHTML={${reader.invocation()}} />${keep}`);
      return end;
    }
    if (inside.startsWith("#")) {
      this.openBlock(inside.slice(1), keep);
      return end;
    }
    if (inside.startsWith("/")) {
      this.closeBlock(keep);
      return end;
    }
    if (/^else\b/.test(inside)) {
      this.elseBlock(inside.slice(4).trim(), keep);
      return end;
    }
    if (inside.startsWith("^")) {
      // inverse section `{{^if}}`: an else branch
      this.elseBlock("", keep);
      return end;
    }
    const { reader, head } = mustacheToJs(inside);
    if (
      head === "yield" ||
      head === "outlet" ||
      (head === "component" && !inside.includes(" "))
    ) {
      this.emit(`{null}${keep}`);
      return end;
    }
    this.emit(`{${reader.invocation()}}${keep}`);
    return end;
  }

  openBlock(inside, keep) {
    const { reader, head, params } = mustacheToJs(inside);
    const ps = params.join(", ");
    reader.pos = 1;
    const args = [];
    while (reader.peek() && reader.peek().kind !== "params") {
      if (reader.peek().kind === "key") {
        reader.pos++;
        reader.value();
      } else {
        args.push(reader.value());
      }
    }
    const subject = args[0] ?? "undefined";
    switch (head) {
      case "if":
        this.emit(`{(${subject}) ? <>${keep}`);
        this.blocks.push({ head, closes: ["</> : null}"] });
        return;
      case "unless":
        this.emit(`{!(${subject}) ? <>${keep}`);
        this.blocks.push({ head, closes: ["</> : null}"] });
        return;
      case "each":
        this.emit(`{(${subject}).map((${ps}) => <>${keep}`);
        this.blocks.push({ head, closes: ["</>)}"] });
        return;
      case "each-in":
        this.emit(`{Object.entries(${subject}).map(([${ps}]) => <>${keep}`);
        this.blocks.push({ head, closes: ["</>)}"] });
        return;
      case "let":
        this.emit(`{((${ps}) => <>${keep}`);
        this.blocks.push({ head, closes: [`</>)(${args.join(", ")})}`] });
        return;
      default:
        this.emit(
          `{${wordToJs(head ?? "block")}(${[...args, ""].join(", ")}(${ps}) => <>${keep}`
        );
        this.blocks.push({ head, closes: ["</>)}"] });
    }
  }

  elseBlock(rest, keep) {
    const block = this.blocks[this.blocks.length - 1];
    if (!block) {
      this.emit(keep);
      return;
    }
    if (block.head === "if" || block.head === "unless") {
      const m = /^if\s+([\s\S]*)$/.exec(rest);
      if (m) {
        const { reader } = mustacheToJs(m[1]);
        this.emit(`</> : (${reader.invocation()}) ? <>${keep}`);
        // the chained branch closes with the same `: null}`
        return;
      }
      this.emit(`</> : <>${keep}`);
      block.closes = ["</>}"];
      return;
    }
    // an `{{else}}` of `each` and the others: the inverse, rendered on its own
    const close = block.closes.pop();
    this.emit(`${close}{<>${keep}`);
    block.closes.push("</>}");
  }

  closeBlock(keep) {
    const block = this.blocks.pop();
    this.emit((block ? block.closes.join("") : "") + keep);
  }

  /** A quoted attribute value with mustaches in it: a template literal. */
  interpolatedValue(value) {
    let out = "";
    let i = 0;
    while (i < value.length) {
      if (value.startsWith("{{", i)) {
        const triple = value.startsWith("{{{", i);
        const end = mustacheEnd(value, i, triple);
        const inside = mustacheInside(value.slice(i, end), triple).trim();
        if (!inside.startsWith("!") && !/^[#/^]|^else\b/.test(inside)) {
          out += "${" + mustacheToJs(inside).reader.invocation() + "}";
        }
        i = end;
      } else {
        const c = value[i];
        out +=
          c === "`" || c === "\\" || c === "$"
            ? "\\" + c
            : c === "\n"
              ? " "
              : c;
        i++;
      }
    }
    return out;
  }

  /** An opening tag at `start` (`<name`): the offset past it. */
  openTag(start) {
    const src = this.src;
    const m = /^<([A-Za-z:@][\w.:@-]*)/.exec(src.slice(start, start + 200));
    const rawName = m[1];
    const name = tagName(rawName);
    const lower = rawName.toLowerCase();
    this.emit(`<${name}`);
    let i = start + m[0].length;
    let selfClosing = false;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        this.emit(c);
        i++;
      } else if (src.startsWith("/>", i)) {
        selfClosing = true;
        i += 2;
        break;
      } else if (c === ">") {
        i++;
        break;
      } else if (src.startsWith("{{", i)) {
        // an element modifier
        const end = mustacheEnd(src, i, false);
        const text = src.slice(i, end);
        const inside = mustacheInside(text, false).trim();
        if (!inside.startsWith("!")) {
          const tokens = tokenize(inside);
          const head = tokens[0]?.kind === "word" ? tokens[0].text : "modifier";
          const reader = new ExprReader(tokens);
          reader.pos = 1;
          const positional = [];
          const named = [];
          while (reader.peek()) {
            const t = reader.peek();
            if (t.kind === "key") {
              reader.pos++;
              named.push(`${JSON.stringify(t.text)}: ${reader.value()}`);
            } else if (t.kind === "params") {
              reader.pos++;
            } else {
              positional.push(reader.value());
            }
          }
          this.emit(
            `{...${wordToJs(head)}(undefined, [${positional.join(", ")}], {${named.join(", ")}})}`
          );
        }
        this.emit(newlinesOf(text));
        i = end;
      } else if (src.startsWith("...attributes", i)) {
        this.emit(" ".repeat("...attributes".length));
        i += "...attributes".length;
      } else if (src.startsWith("as |", i)) {
        const close = src.indexOf("|", i + 4);
        const end = close < 0 ? src.length : close + 1;
        this.emit(blank(src.slice(i, end)));
        i = end;
      } else {
        const am = /^([^\s=/>]+)/.exec(src.slice(i, i + 200));
        if (!am) {
          i++;
          continue;
        }
        let attr = am[1];
        i += attr.length;
        attr = attr.startsWith("@")
          ? jsName(attr.slice(1))
          : attr.replace(/[^\w:-]/g, "_");
        if (src[i] !== "=") {
          this.emit(attr);
          continue;
        }
        i++;
        if (src.startsWith("{{", i)) {
          const triple = src.startsWith("{{{", i);
          const end = mustacheEnd(src, i, triple);
          const text = src.slice(i, end);
          const inside = mustacheInside(text, triple).trim();
          this.emit(
            `${attr}={${mustacheToJs(inside).reader.invocation()}}${newlinesOf(text)}`
          );
          i = end;
        } else if (src[i] === '"' || src[i] === "'") {
          const q = src[i];
          const close = src.indexOf(q, i + 1);
          const end = close < 0 ? src.length : close + 1;
          const value = src.slice(i + 1, end - 1);
          if (value.includes("{{")) {
            this.emit(
              `${attr}={\`${this.interpolatedValue(value)}\`}${newlinesOf(value)}`
            );
          } else {
            this.emit(
              `${attr}="${value.replace(/"/g, "&quot;").replace(/\n/g, " ")}"${newlinesOf(value)}`
            );
          }
          i = end;
        } else {
          const vm = /^[^\s>]+/.exec(src.slice(i, i + 500));
          const value = vm ? vm[0].replace(/\/$/, "") : "";
          this.emit(`${attr}="${value.replace(/"/g, "&quot;")}"`);
          i += value.length;
        }
      }
    }
    const isVoid = VOID_ELEMENTS.has(lower);
    this.emit(selfClosing || isVoid ? " />" : ">");
    if (!selfClosing && (lower === "script" || lower === "style")) {
      const close = src.indexOf(`</${rawName}`, i);
      const end = close < 0 ? src.length : src.indexOf(">", close) + 1;
      this.emit(blank(src.slice(i, close < 0 ? end : close)));
      this.emit(`</${name}>`);
      return end;
    }
    return i;
  }

  lower() {
    const src = this.src;
    let i = 0;
    let text = "";
    const flush = () => {
      if (text) this.emit(jsxText(text));
      text = "";
    };
    while (i < src.length) {
      if (src.startsWith("{{", i)) {
        flush();
        i = this.contentMustache(i);
      } else if (src.startsWith("<!--", i)) {
        flush();
        const close = src.indexOf("-->", i + 4);
        const end = close < 0 ? src.length : close + 3;
        this.emit(blank(src.slice(i, end)));
        i = end;
      } else if (/^<\/[A-Za-z:@]/.test(src.slice(i, i + 3))) {
        flush();
        const close = src.indexOf(">", i);
        const end = close < 0 ? src.length : close + 1;
        const raw = src.slice(i + 2, end - 1).trim();
        if (VOID_ELEMENTS.has(raw.toLowerCase())) {
          this.emit(blank(src.slice(i, end)));
        } else {
          this.emit(`</${tagName(raw)}>${newlinesOf(src.slice(i, end))}`);
        }
        i = end;
      } else if (/^<[A-Za-z:@]/.test(src.slice(i, i + 2))) {
        flush();
        i = this.openTag(i);
      } else {
        text += src[i];
        i++;
      }
    }
    flush();
    // a block left open by a malformed template
    while (this.blocks.length) this.closeBlock("");
    return this.out.join("");
  }
}

/** A template's markup as a JSX fragment expression. */
export const lowerTemplate = (markup) =>
  `<>${new TemplateLowering(markup).lower()}</>`;

/** A whole `.hbs` file as TSX. */
export const lowerHbs = (code) =>
  `export default function __glimmer_template() { return ${lowerTemplate(code)}; }`;

/** Brace depth at the start of each `<template>` block of a `.gjs`/`.gts` file, the script outside
 * the blocks scanned with strings, template literals and comments skipped. */
const templateBlocks = (code) => {
  const blocks = [];
  let depth = 0;
  // the open braces' owners: `class` bodies and everything else
  const owners = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (
      code.startsWith("<template>", i) ||
      /^<template[\s>]/.test(code.slice(i, i + 10))
    ) {
      const openEnd = code.indexOf(">", i) + 1;
      const close = code.indexOf("</template>", openEnd);
      const end = close < 0 ? code.length : close + "</template>".length;
      blocks.push({
        start: i,
        bodyStart: openEnd,
        bodyEnd: close < 0 ? code.length : close,
        end,
        inClass: owners[owners.length - 1] === "class"
      });
      i = end;
    } else if (code.startsWith("//", i)) {
      const nl = code.indexOf("\n", i);
      i = nl < 0 ? code.length : nl;
    } else if (code.startsWith("/*", i)) {
      const close = code.indexOf("*/", i + 2);
      i = close < 0 ? code.length : close + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      i = j + 1;
    } else if (c === "{") {
      const before = code.slice(Math.max(0, i - 300), i);
      owners.push(/\bclass\b[^{};()]*$/.test(before) ? "class" : "other");
      depth++;
      i++;
    } else if (c === "}") {
      owners.pop();
      depth--;
      i++;
    } else {
      i++;
    }
  }
  return blocks;
};

/** A `.gjs`/`.gts` file as TSX: each `<template>` block a function returning its markup. */
export const lowerGjs = (code) => {
  let out = "";
  let last = 0;
  for (const block of templateBlocks(code)) {
    const before = code.slice(last, block.start);
    out += before;
    const body = lowerTemplate(code.slice(block.bodyStart, block.bodyEnd));
    const fn = `__glimmer_template() { return ${body}; }`;
    // a statement of its own needs a `;` before it, or the previous line calls it
    const inExpression = /(\bdefault|\breturn|[=(,:?]|=>)\s*$/.test(out);
    out += block.inClass
      ? fn
      : inExpression
        ? `(function ${fn})`
        : `;(function ${fn})`;
    last = block.end;
  }
  return out + code.slice(last);
};

/** The file as TSX, for a Glimmer template file; undefined for any other file. */
export const lowerEmberFile = (file, code) => {
  if (file.endsWith(".hbs")) return lowerHbs(code);
  if (file.endsWith(".gjs") || file.endsWith(".gts")) return lowerGjs(code);
  return undefined;
};
