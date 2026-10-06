// A Scala source lexer, shared by the SemanticDB reader: string literals, interpolated
// strings, comments, braces and the token matching the argument extraction needs.
const TOKEN = {
  WS: "ws",
  COMMENT: "comment",
  IDENT: "ident",
  NUMBER: "number",
  STRING: "string",
  INTERP: "interp",
  CHAR: "char",
  OP: "op",
  KEYWORD: "keyword",
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
  "extends",
  "false",
  "final",
  "finally",
  "for",
  "forSome",
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

const INTERPOLATORS = new Set(["s", "f", "raw", "uri", "sql", "p", "xml", "js"]);

/**
 * Tokenize Scala source. Every token carries its 0-based line and character position.
 *
 * @param {string} text Source text
 * @returns {{type: string, text: string, line: number, char: number, holes?: string[]}[]}
 */
export function tokenize(text) {
  const tokens = [];
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[A-Za-z0-9_$]/.test(c);
  let line = 0;
  let char = 0;
  let i = 0;
  const push = (type, value, holes) => {
    tokens.push({ type, text: value, line, char, ...(holes ? { holes } : {}) });
  };
  const pushAt = (atLine, atChar, type, value, holes) => {
    tokens.push({ type, text: value, line: atLine, char: atChar, ...(holes ? { holes } : {}) });
  };
  const advance = (count) => {
    for (let k = 0; k < count; k++) {
      if (text[i] === "\n") {
        line += 1;
        char = 0;
      } else {
        char += 1;
      }
      i += 1;
    }
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      push(TOKEN.NEWLINE, c);
      advance(1);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      const atLine = line;
      const atChar = char;
      const start = i;
      while (i < text.length && /[ \t\r]/.test(text[i])) {
        i += 1;
        char += 1;
      }
      pushAt(atLine, atChar, TOKEN.WS, text.slice(start, i));
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let start = i;
      while (i < text.length && text[i] !== "\n") {
        advance(1);
      }
      tokens.push({
        type: TOKEN.COMMENT,
        text: text.slice(start, i),
        line: tokens.length && tokens.at(-1)?.type === TOKEN.NEWLINE ? line : line,
        char: char - (i - start)
      });
      // The comment text spans back; correct the recorded start.
      const last = tokens.at(-1);
      last.char = char - (i - start);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const startLine = line;
      const startChar = char;
      let start = i;
      let depth = 0;
      do {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          advance(2);
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          advance(2);
        } else {
          advance(1);
        }
      } while (i < text.length && depth > 0);
      tokens.push({
        type: TOKEN.COMMENT,
        text: text.slice(start, i),
        line: startLine,
        char: startChar
      });
      continue;
    }
    if (c === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      const startLine = line;
      const startChar = char;
      const start = i;
      advance(3);
      while (i < text.length && !(text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"')) {
        advance(1);
      }
      advance(3);
      tokens.push({
        type: TOKEN.STRING,
        text: text.slice(start, i),
        line: startLine,
        char: startChar
      });
      continue;
    }
    if (c === '"') {
      const startLine = line;
      const startChar = char;
      const start = i;
      advance(1);
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") {
        if (text[i] === "\\") {
          advance(2);
        } else {
          advance(1);
        }
      }
      advance(1);
      tokens.push({
        type: TOKEN.STRING,
        text: text.slice(start, i),
        line: startLine,
        char: startChar
      });
      continue;
    }
    if (c === "'" && (isIdentStart(text[i + 1]) || text[i + 1] === "\\")) {
      const startLine = line;
      const startChar = char;
      const start = i;
      advance(1);
      while (i < text.length && text[i] !== "'" && text[i] !== "\n") {
        if (text[i] === "\\") {
          advance(2);
        } else {
          advance(1);
        }
      }
      advance(1);
      tokens.push({
        type: TOKEN.CHAR,
        text: text.slice(start, i),
        line: startLine,
        char: startChar
      });
      continue;
    }
    if (isIdentStart(c)) {
      // An interpolated string starts when an interpolator identifier is followed by quotes.
      let start = i;
      let startLine = line;
      let startChar = char;
      while (i < text.length && isIdentPart(text[i])) {
        advance(1);
      }
      const word = text.slice(start, i);
      const afterWs = text[i] === '"' || (word.length === 1 && INTERPOLATORS.has(word));
      if (afterWs && INTERPOLATORS.has(word) && text[i] === '"') {
        const holes = [];
        advance(1);
        while (i < text.length && text[i] !== '"' && text[i] !== "\n") {
          if (text[i] === "\\") {
            advance(2);
          } else if (text[i] === "$" && isIdentStart(text[i + 1] || "")) {
            let hole = i;
            advance(1);
            while (i < text.length && isIdentPart(text[i])) {
              advance(1);
            }
            holes.push(text.slice(hole + 1, i));
          } else if (text[i] === "$" && text[i + 1] === "{") {
            const holeStart = i;
            let depth = 0;
            do {
              if (text[i] === "{") depth += 1;
              else if (text[i] === "}") depth -= 1;
              advance(1);
            } while (i < text.length && depth > 0);
            holes.push(text.slice(holeStart + 2, i - 1));
          } else {
            advance(1);
          }
        }
        advance(1);
        tokens.push({
          type: TOKEN.INTERP,
          text: text.slice(start, i),
          line: startLine,
          char: startChar,
          holes
        });
        continue;
      }
      pushAt(startLine, startChar, KEYWORDS.has(word) ? TOKEN.KEYWORD : TOKEN.IDENT, word);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const atLine = line;
      const atChar = char;
      const start = i;
      while (i < text.length && /[0-9a-fA-FxX._eElLuUdDfF]/.test(text[i])) {
        if ((text[i] === "e" || text[i] === "E") && !/[0-9+-]/.test(text[i + 1] || "")) {
          break;
        }
        advance(1);
      }
      pushAt(atLine, atChar, TOKEN.NUMBER, text.slice(start, i));
      continue;
    }
    if ("(){}[]".includes(c) || /[+\-*/=:<>&|!?.@#%,;^~]/.test(c)) {
      push(TOKEN.OP, c);
      advance(1);
      continue;
    }
    push(TOKEN.OP, c);
    advance(1);
  }
  return tokens;
}

/**
 * The content of a string token, without the quotes.
 *
 * @param {Object} token A STRING token
 * @returns {string}
 */
export function stringContent(token) {
  const text = token.text;
  if (text.startsWith('"""')) {
    return text.slice(3, -3);
  }
  return text.slice(1, -1);
}

/**
 * The literal value of one string or interpolated token, with `$hole` references resolved
 * through a lookup, or undefined when a hole stays unresolved.
 *
 * @param {Object} token A STRING or INTERP token
 * @param {Function} resolve Called with a hole name
 * @returns {string|undefined}
 */
export function interpolatedValue(token, resolve) {
  if (token.type === TOKEN.STRING) {
    return stringContent(token);
  }
  const body = token.text.slice(token.text.indexOf('"') + 1, token.text.lastIndexOf('"'));
  let result = "";
  let rest = body;
  const holes = [...(token.holes || [])];
  while (rest.length) {
    const dollar = rest.indexOf("$");
    if (dollar < 0) {
      result += rest;
      break;
    }
    result += rest.slice(0, dollar);
    const hole = holes.shift();
    const value = hole !== undefined ? resolve(hole) : undefined;
    if (value === undefined) {
      return undefined;
    }
    result += value;
    const after = rest.slice(dollar + 1);
    // Skip the hole spelling: an identifier or a brace block.
    rest = after.startsWith("{")
      ? after.slice(after.indexOf("}") + 1)
      : after.replace(/^[A-Za-z_$][A-Za-z0-9_$]*/, "");
  }
  return result;
}

/**
 * Index the tokens of a file by line for position lookups.
 *
 * @param {Object[]} tokens
 * @returns {{ byLine: Map, positions: Map }}
 */
export function tokenIndex(tokens) {
  const byLine = new Map();
  const positions = new Map();
  for (const token of tokens) {
    if (!byLine.has(token.line)) {
      byLine.set(token.line, []);
    }
    byLine.get(token.line).push(token);
    positions.set(`${token.line}:${token.char}`, token);
  }
  return { byLine, positions };
}

/**
 * The argument token groups of a call: the tokens between the opening parenthesis after a
 * position and its match, split at the top level commas.
 *
 * @param {Object[]} tokens All tokens of the file
 * @param {number} line 0-based line of the call
 * @param {number} char 0-based character of the call
 * @returns {Object[][]} Token groups, one per argument
 */
export function argumentTokens(tokens, line, char) {
  const at = (t) => `${t.line}:${t.char}`;
  // Find the token that starts the call, then the parenthesis that opens the arguments.
  let start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].line === line && tokens[i].char >= char) {
      start = i;
      break;
    }
  }
  if (start < 0) {
    return [];
  }
  let i = start;
  // Skip the callee and any type argument list.
  let seenName = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.type === TOKEN.WS || token.type === TOKEN.COMMENT) {
      i += 1;
      continue;
    }
    if (token.type === TOKEN.IDENT || token.type === TOKEN.KEYWORD) {
      seenName += 1;
      i += 1;
      continue;
    }
    if (token.text === "." || token.text === "`") {
      i += 1;
      continue;
    }
    // A type argument list sits between the callee and its arguments.
    if (token.text === "[") {
      let depth = 0;
      while (i < tokens.length) {
        if (tokens[i].text === "[") depth += 1;
        if (tokens[i].text === "]") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
      continue;
    }
    break;
  }
  if (!tokens[i] || tokens[i].text !== "(") {
    return [];
  }
  // Collect until the matching close.
  const groups = [[]];
  let depth = 0;
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === TOKEN.WS || token.type === TOKEN.COMMENT) {
      continue;
    }
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      depth += 1;
      if (depth === 1 && token.text === "(") {
        continue;
      }
    }
    if (token.text === ")" || token.text === "]" || token.text === "}") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
    if (depth === 1 && token.text === ",") {
      groups.push([]);
      continue;
    }
    if (depth >= 1) {
      groups.at(-1).push(token);
    }
  }
  return groups.filter((group) => group.length);
}

export { TOKEN };
