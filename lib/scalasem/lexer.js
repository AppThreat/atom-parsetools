// A Scala source lexer for the readers that work from source text: the SemanticDB reader and
// the route DSL readers. Every token carries its 0-based line and its 0-based column counted
// in UTF-16 code units, the unit SemanticDB ranges use, and brackets are matched in one pass.
const TOKEN = {
  IDENT: "ident",
  KEYWORD: "keyword",
  OP: "op",
  BRACKET: "bracket",
  COMMA: "comma",
  SEMI: "semi",
  DOT: "dot",
  STRING: "string",
  INTERP: "interp",
  NUMBER: "number",
  CHAR: "char",
  SYMBOL: "symbol",
  COMMENT: "comment",
  NEWLINE: "newline"
};

const KEYWORDS = new Set([
  "abstract",
  "case",
  "catch",
  "class",
  "def",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "for",
  "forSome",
  "given",
  "if",
  "implicit",
  "import",
  "lazy",
  "match",
  "new",
  "null",
  "object",
  "override",
  "package",
  "private",
  "protected",
  "return",
  "sealed",
  "super",
  "then",
  "this",
  "throw",
  "trait",
  "true",
  "try",
  "type",
  "val",
  "var",
  "while",
  "with",
  "yield"
]);

const OPCHARS = "!#%&*+-/:<=>?@\\^|~";
const isOpChar = (c) => c !== undefined && OPCHARS.includes(c);
const isIdentStart = (c) => c !== undefined && /[\p{L}_$]/u.test(c);
const isIdentPart = (c) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c);
const OPENERS = { "(": ")", "[": "]", "{": "}" };

/**
 * Tokenize Scala source. Whitespace is dropped; newlines are kept, since they end
 * statements. Brackets carry the index of their match in `match`.
 *
 * @param {string} text Source text
 * @returns {Object[]} Tokens `{type, text, line, column, endLine, endColumn, ...}`
 */
export function tokenize(text) {
  const tokens = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;
  const column = () => i - lineStart;
  const newline = () => {
    line += 1;
    lineStart = i;
  };
  // Advance over one character, keeping the line count.
  const step = () => {
    i += 1;
    if (text[i - 1] === "\n") {
      newline();
    }
  };
  const push = (type, start, startLine, startColumn, extra = {}) => {
    tokens.push({
      type,
      text: text.slice(start, i),
      line: startLine,
      column: startColumn,
      endLine: line,
      endColumn: column(),
      ...extra
    });
  };
  while (i < text.length) {
    const c = text[i];
    const start = i;
    const startLine = line;
    const startColumn = column();
    if (c === "\n") {
      i += 1;
      push(TOKEN.NEWLINE, start, startLine, startColumn);
      newline();
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i += 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      push(TOKEN.COMMENT, start, startLine, startColumn);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let depth = 0;
      while (i < text.length) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          step();
          step();
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          step();
          step();
          if (depth === 0) {
            break;
          }
        } else {
          step();
        }
      }
      push(TOKEN.COMMENT, start, startLine, startColumn);
      continue;
    }
    if (c === '"') {
      const value = readString(text, i, step, () => i);
      push(TOKEN.STRING, start, startLine, startColumn, { value });
      continue;
    }
    if (c === "'") {
      // A character literal: 'a', '(', '"', '\n', 'A'. Otherwise a Scala 2 symbol
      // literal, 'name.
      if (text[i + 1] === "\\") {
        step();
        step();
        while (i < text.length && text[i] !== "'" && text[i] !== "\n") {
          step();
        }
        if (text[i] === "'") {
          step();
        }
        push(TOKEN.CHAR, start, startLine, startColumn);
        continue;
      }
      if (text[i + 2] === "'" && text[i + 1] !== "\n") {
        step();
        step();
        step();
        push(TOKEN.CHAR, start, startLine, startColumn);
        continue;
      }
      if (isIdentStart(text[i + 1])) {
        step();
        while (isIdentPart(text[i])) {
          step();
        }
        push(TOKEN.SYMBOL, start, startLine, startColumn);
        continue;
      }
      step();
      push(TOKEN.OP, start, startLine, startColumn);
      continue;
    }
    if (c === "`") {
      step();
      while (i < text.length && text[i] !== "`" && text[i] !== "\n") {
        step();
      }
      if (text[i] === "`") {
        step();
      }
      push(TOKEN.IDENT, start, startLine, startColumn, {
        value: text.slice(start + 1, i - 1)
      });
      continue;
    }
    if (isIdentStart(c)) {
      while (isIdentPart(text[i])) {
        step();
      }
      // `name_+` style identifiers end in an operator after an underscore.
      if (text[i - 1] === "_" && isOpChar(text[i])) {
        while (isOpChar(text[i])) {
          step();
        }
      }
      const word = text.slice(start, i);
      if (text[i] === '"') {
        const interp = readInterpolation(text, i, step, () => i, {
          line: () => line,
          column
        });
        push(TOKEN.INTERP, start, startLine, startColumn, {
          interpolator: word,
          ...interp
        });
        continue;
      }
      push(
        KEYWORDS.has(word) ? TOKEN.KEYWORD : TOKEN.IDENT,
        start,
        startLine,
        startColumn,
        { value: word }
      );
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] || ""))) {
      if (c === "0" && /[xX]/.test(text[i + 1] || "")) {
        step();
        step();
        while (/[0-9a-fA-F_]/.test(text[i] || "")) {
          step();
        }
      } else {
        while (/[0-9_]/.test(text[i] || "")) {
          step();
        }
        if (text[i] === "." && /[0-9]/.test(text[i + 1] || "")) {
          step();
          while (/[0-9_]/.test(text[i] || "")) {
            step();
          }
        }
        if (/[eE]/.test(text[i] || "") && /[0-9+-]/.test(text[i + 1] || "")) {
          step();
          step();
          while (/[0-9]/.test(text[i] || "")) {
            step();
          }
        }
      }
      if (/[lLfFdD]/.test(text[i] || "")) {
        step();
      }
      push(TOKEN.NUMBER, start, startLine, startColumn, {
        value: numberValue(text.slice(start, i))
      });
      continue;
    }
    if (OPENERS[c] || c === ")" || c === "]" || c === "}") {
      step();
      push(TOKEN.BRACKET, start, startLine, startColumn);
      continue;
    }
    if (c === ",") {
      step();
      push(TOKEN.COMMA, start, startLine, startColumn);
      continue;
    }
    if (c === ";") {
      step();
      push(TOKEN.SEMI, start, startLine, startColumn);
      continue;
    }
    if (c === ".") {
      step();
      push(TOKEN.DOT, start, startLine, startColumn);
      continue;
    }
    if (isOpChar(c)) {
      while (
        isOpChar(text[i]) &&
        !(text[i] === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
      ) {
        step();
      }
      push(TOKEN.OP, start, startLine, startColumn, {
        value: text.slice(start, i)
      });
      continue;
    }
    step();
    push(TOKEN.OP, start, startLine, startColumn, { value: c });
  }
  matchBrackets(tokens);
  return tokens;
}

/** Read a plain or triple quoted string; returns its value with simple escapes resolved. */
function readString(text, at, step, pos) {
  if (text.startsWith('"""', at)) {
    step();
    step();
    step();
    const from = pos();
    while (pos() < text.length && !text.startsWith('"""', pos())) {
      step();
    }
    const value = text.slice(from, pos());
    // A closing run of more than three quotes ends with the last three.
    while (text.startsWith('""""', pos())) {
      step();
    }
    step();
    step();
    step();
    return value;
  }
  step();
  let value = "";
  while (pos() < text.length && text[pos()] !== '"' && text[pos()] !== "\n") {
    if (text[pos()] === "\\") {
      value += unescape(text[pos() + 1]);
      step();
      step();
    } else {
      value += text[pos()];
      step();
    }
  }
  if (text[pos()] === '"') {
    step();
  }
  return value;
}

function unescape(c) {
  return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", 0: "\0" }[c] ?? c ?? "";
}

/**
 * Read an interpolated string after its interpolator: its literal parts and its holes, each
 * hole with its position and, for a plain `$name`, the identifier it names. `$$` is a
 * literal dollar.
 */
function readInterpolation(text, at, step, pos, where) {
  const triple = text.startsWith('"""', at);
  const parts = [];
  const holes = [];
  let part = "";
  const quotes = triple ? 3 : 1;
  for (let q = 0; q < quotes; q++) {
    step();
  }
  const atEnd = () =>
    triple
      ? text.startsWith('"""', pos())
      : text[pos()] === '"' || text[pos()] === "\n";
  while (pos() < text.length && !atEnd()) {
    const c = text[pos()];
    if (c === "\\" && !triple) {
      part += unescape(text[pos() + 1]);
      step();
      step();
      continue;
    }
    if (c !== "$") {
      part += c;
      step();
      continue;
    }
    if (text[pos() + 1] === "$") {
      part += "$";
      step();
      step();
      continue;
    }
    if (text[pos() + 1] === '"') {
      part += '"';
      step();
      step();
      continue;
    }
    parts.push(part);
    part = "";
    const holeLine = where.line();
    const holeColumn = where.column();
    step();
    if (text[pos()] === "{") {
      const from = pos() + 1;
      let depth = 0;
      while (pos() < text.length) {
        const ch = text[pos()];
        if (ch === "{") {
          depth += 1;
        } else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        } else if (ch === '"') {
          readString(text, pos(), step, pos);
          continue;
        }
        step();
      }
      const expression = text.slice(from, pos());
      step();
      const leading = expression.length - expression.trimStart().length;
      holes.push({
        line: holeLine,
        column: holeColumn,
        expression: expression.trim(),
        ...(/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(expression.trim())
          ? { name: expression.trim(), nameColumn: holeColumn + 2 + leading }
          : {})
      });
      continue;
    }
    const from = pos();
    while (isIdentPart(text[pos()]) && text[pos()] !== "$") {
      step();
    }
    holes.push({
      line: holeLine,
      column: holeColumn,
      name: text.slice(from, pos()),
      nameColumn: holeColumn + 1,
      expression: text.slice(from, pos())
    });
  }
  parts.push(part);
  if (triple) {
    while (text.startsWith('""""', pos())) {
      step();
    }
  }
  if (text[pos()] === '"') {
    for (let q = 0; q < quotes; q++) {
      step();
    }
  }
  return { parts, holes, triple };
}

function numberValue(text) {
  const clean = text.replace(/_/g, "").replace(/[lLfFdD]$/, "");
  const value = /^0[xX]/.test(clean)
    ? Number.parseInt(clean, 16)
    : Number(clean);
  return Number.isFinite(value) ? value : undefined;
}

/** Record the index of the matching bracket of every bracket, in one pass. */
function matchBrackets(tokens) {
  const stack = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== TOKEN.BRACKET) {
      continue;
    }
    if (OPENERS[token.text]) {
      stack.push(index);
      continue;
    }
    // A stray closer ends nothing; an unbalanced opener keeps no match.
    for (let s = stack.length - 1; s >= 0; s--) {
      if (OPENERS[tokens[stack[s]].text] === token.text) {
        const open = stack[s];
        stack.length = s;
        tokens[open].match = index;
        token.match = open;
        break;
      }
    }
  }
}

/**
 * The tokens that carry code, without comments and newlines, with their brackets matched
 * within this list.
 *
 * @param {Object[]} tokens
 * @returns {Object[]}
 */
export function codeTokens(tokens) {
  const code = tokens
    .filter((t) => t.type !== TOKEN.COMMENT && t.type !== TOKEN.NEWLINE)
    .map(({ match: _match, ...token }) => token);
  matchBrackets(code);
  return code;
}

/**
 * Index tokens by position: the token that starts at a line and column, and the tokens
 * of a line.
 *
 * @param {Object[]} tokens
 * @returns {{ at: (line: number, column: number) => number|undefined, byLine: Map }}
 */
export function tokenIndex(tokens) {
  const starts = new Map();
  const byLine = new Map();
  tokens.forEach((token, index) => {
    starts.set(`${token.line}:${token.column}`, index);
    if (!byLine.has(token.line)) {
      byLine.set(token.line, []);
    }
    byLine.get(token.line).push(index);
  });
  return {
    at: (line, column) => starts.get(`${line}:${column}`),
    byLine
  };
}

/**
 * The argument lists that follow position `index` in a token list: type arguments are
 * skipped, and every `(...)` or `{...}` group that follows directly is one list. Each list
 * is split at its top level commas.
 *
 * @param {Object[]} tokens Code tokens with matched brackets
 * @param {number} index Index of the last token of the callee
 * @returns {{ open: number, close: number, args: number[][] }[]} Token index ranges
 */
export function argumentLists(tokens, index) {
  const lists = [];
  let i = index + 1;
  if (tokens[i]?.text === "[" && tokens[i].match !== undefined) {
    i = tokens[i].match + 1;
  }
  while (
    tokens[i] &&
    (tokens[i].text === "(" || tokens[i].text === "{") &&
    tokens[i].match !== undefined &&
    tokens[i].line === tokens[i - 1].endLine
  ) {
    const open = i;
    const close = tokens[i].match;
    const args = [];
    let current = [];
    for (let k = open + 1; k < close; k++) {
      const token = tokens[k];
      if (token.type === TOKEN.COMMA) {
        args.push(current);
        current = [];
        continue;
      }
      current.push(k);
      if (token.type === TOKEN.BRACKET && token.match > k) {
        for (let j = k + 1; j <= token.match; j++) {
          current.push(j);
        }
        k = token.match;
      }
    }
    if (current.length) {
      args.push(current);
    }
    lists.push({ open, close, args });
    i = close + 1;
  }
  return lists;
}

export { TOKEN };
