// The SemanticDB reader: decodes the TextDocuments protobuf with a hand written varint
// reader, parses the symbol grammar, and turns one document into the same raw facts the
// TASTy inspector produces. Literal arguments and enclosing definitions come from the source
// text through the lexer, because SemanticDB carries neither trees nor body extents.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  TOKEN,
  argumentTokens,
  interpolatedValue,
  stringContent,
  tokenIndex,
  tokenize
} from "./lexer.js";
import { listFiles, normaliseSourcePath } from "./util.js";

/** One protobuf reader over a buffer. */
function reader(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
    }
    return Number(result);
  };
  return {
    eof: () => pos >= buf.length,
    field() {
      const key = varint();
      return { no: key >>> 3, wire: key & 7 };
    },
    varint,
    bytes() {
      const len = varint();
      const out = buf.subarray(pos, pos + len);
      pos += len;
      return out;
    },
    skip(wire) {
      if (wire === 0) this.varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) this.bytes();
      else if (wire === 5) pos += 4;
      else throw new Error(`unsupported wire type ${wire}`);
    }
  };
}

const utf8 = (b) => Buffer.from(b).toString("utf-8");

function decodeRange(b) {
  const r = reader(b);
  const range = { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };
  while (!r.eof()) {
    const f = r.field();
    if (f.wire !== 0) {
      r.skip(f.wire);
    } else if (f.no === 1) {
      range.startLine = r.varint();
    } else if (f.no === 2) {
      range.startChar = r.varint();
    } else if (f.no === 3) {
      range.endLine = r.varint();
    } else if (f.no === 4) {
      range.endChar = r.varint();
    } else {
      r.varint();
    }
  }
  return range;
}

function decodeOccurrence(b) {
  const r = reader(b);
  const occ = { role: 0 };
  while (!r.eof()) {
    const f = r.field();
    if (f.no === 1 && f.wire === 2) {
      occ.range = decodeRange(r.bytes());
    } else if (f.no === 2 && f.wire === 2) {
      occ.symbol = utf8(r.bytes());
    } else if (f.no === 3 && f.wire === 0) {
      occ.role = r.varint();
    } else {
      r.skip(f.wire);
    }
  }
  return occ;
}

function decodeSymbolInformation(b) {
  const r = reader(b);
  const info = { kind: 0, properties: 0 };
  while (!r.eof()) {
    const f = r.field();
    if (f.no === 1 && f.wire === 2) {
      info.symbol = utf8(r.bytes());
    } else if (f.no === 3 && f.wire === 0) {
      info.kind = r.varint();
    } else if (f.no === 4 && f.wire === 0) {
      info.properties = r.varint();
    } else if (f.no === 5 && f.wire === 2) {
      info.displayName = utf8(r.bytes());
    } else if (f.no === 13 && f.wire === 2) {
      info.annotations = (info.annotations || []).concat(utf8(r.bytes()));
    } else if (f.no === 17 && f.wire === 2) {
      info.signature = (info.signature || "") + utf8(r.bytes());
    } else if (f.no === 18 && f.wire === 2) {
      info.access = (info.access || "") + utf8(r.bytes());
    } else if (f.no === 19 && f.wire === 2) {
      info.overriddenSymbols = (info.overriddenSymbols || []).concat(
        utf8(r.bytes())
      );
    } else {
      r.skip(f.wire);
    }
  }
  return info;
}

/** The symbol-like strings inside a raw annotation message: the annotation type. */
function annotationSymbols(raw) {
  const text = Buffer.from(raw).toString("latin1");
  const matches = text.match(/[a-z][a-zA-Z0-9_]*(\/[a-zA-Z0-9_$.]+)+/g) || [];
  return matches;
}

function decodeSynthetic(b) {
  const r = reader(b);
  const synthetic = {};
  while (!r.eof()) {
    const f = r.field();
    if (f.no === 1 && f.wire === 2) {
      synthetic.range = decodeRange(r.bytes());
    } else if (f.no === 2 && f.wire === 2) {
      synthetic.tree = utf8(r.bytes());
    } else {
      r.skip(f.wire);
    }
  }
  return synthetic;
}

function decodeDiagnostic(b) {
  const r = reader(b);
  const diagnostic = {};
  while (!r.eof()) {
    const f = r.field();
    if (f.no === 1 && f.wire === 2) {
      diagnostic.range = decodeRange(r.bytes());
    } else if (f.no === 2 && f.wire === 2) {
      diagnostic.severity = r.varint();
    } else if (f.no === 3 && f.wire === 2) {
      diagnostic.message = utf8(r.bytes());
    } else {
      r.skip(f.wire);
    }
  }
  return diagnostic;
}

function decodeTextDocument(b) {
  const r = reader(b);
  const doc = {
    schema: 0,
    occurrences: [],
    symbols: [],
    diagnostics: [],
    synthetics: []
  };
  while (!r.eof()) {
    const f = r.field();
    if (f.no === 1 && f.wire === 0) {
      doc.schema = r.varint();
    } else if (f.no === 2 && f.wire === 2) {
      doc.uri = utf8(r.bytes());
    } else if (f.no === 3 && f.wire === 2) {
      doc.text = (doc.text || "") + utf8(r.bytes());
    } else if (f.no === 5 && f.wire === 2) {
      doc.symbols.push(decodeSymbolInformation(r.bytes()));
    } else if (f.no === 6 && f.wire === 2) {
      doc.occurrences.push(decodeOccurrence(r.bytes()));
    } else if (f.no === 7 && f.wire === 2) {
      doc.diagnostics.push(decodeDiagnostic(r.bytes()));
    } else if (f.no === 10 && f.wire === 0) {
      doc.language = r.varint();
    } else if (f.no === 11 && f.wire === 2) {
      doc.md5 = utf8(r.bytes());
    } else if (f.no === 12 && f.wire === 2) {
      doc.synthetics.push(decodeSynthetic(r.bytes()));
    } else {
      r.skip(f.wire);
    }
  }
  return doc;
}

/**
 * Decode a `.semanticdb` file.
 *
 * @param {Buffer} buffer File content
 * @returns {{ schema: number, uri: string, text?: string, symbols: Object[],
 *   occurrences: Object[], diagnostics: Object[], synthetics: Object[] }[]}
 */
export function decodeTextDocuments(buffer) {
  const r = reader(buffer);
  const documents = [];
  while (!r.eof()) {
    const f = r.field();
    if (f.no === 1 && f.wire === 2) {
      documents.push(decodeTextDocument(r.bytes()));
    } else {
      r.skip(f.wire);
    }
  }
  return documents;
}

/** The symbol kinds of SemanticDB that name a type or value definition. */
const SYMBOL_KIND = {
  1: "class",
  2: "interface",
  3: "trait",
  4: "object",
  5: "package",
  6: "package",
  7: "method",
  8: "val",
  9: "var",
  10: "type",
  11: "param",
  12: "local"
};

/**
 * Parse a SemanticDB symbol into its owner, member name and kind.
 * `a/b/C#m().` is the method m of class a.b.C; `a/b/C.` is the object a.b.C; `local12` is a
 * local value.
 *
 * @param {string} symbol
 * @returns {{ owner: string, name: string, kind: string, path: string[] }|undefined}
 */
export function parseSymbol(symbol) {
  if (!symbol || symbol === "_empty_" || symbol.startsWith("local")) {
    return undefined;
  }
  const path = symbol.split("/");
  // The curried parameter lists of the grammar, `apply().(uri)`, are not part of the name.
  let last = path[path.length - 1]
    .replace(/(\.[(][^)]*[)])+$/, "")
    .replace(/\.+$/, "");
  // The member separator is the last `#` or `.`: `JdbcBackend#DatabaseFactoryDef#forURL()`
  // is the method forURL of the nested class DatabaseFactoryDef.
  const hash = last.lastIndexOf("#");
  const dot = last.lastIndexOf(".");
  const separator = Math.max(hash, dot);
  if (separator < 0) {
    // A symbol without a member separator names itself: a package has no trailing marker,
    // an object reference ends with a dot.
    const rawLast = path[path.length - 1];
    const isObject = rawLast.endsWith(".") && !rawLast.includes("(");
    return {
      owner: path.slice(0, -1).join(".").replace(/[#$.]/g, "."),
      name: last.replace(/\$$/, ""),
      kind: isObject ? "object" : "package",
      path
    };
  }
  const ownerPath = last.slice(0, separator).replace(/[#$.]/g, ".");
  const memberPart = last.slice(separator + 1);
  if (!memberPart || memberPart.startsWith("(")) {
    // The symbol ends at the separator: it names the class or object itself.
    const segments = ownerPath.split(".").filter(Boolean);
    return {
      owner: segments.slice(0, -1).join("."),
      name: segments[segments.length - 1] || "",
      kind: hash > dot ? "class" : "object",
      path
    };
  }
  const name = memberPart
    .split("(")[0]
    .split("[")[0]
    .replace(/\(\+n\)/, "")
    .replaceAll("`", "");
  const owner = [path.slice(0, -1).join(".").replace(/[#$.]/g, "."), ownerPath]
    .filter(Boolean)
    .join(".");
  const isMethod = memberPart.includes("(");
  return {
    owner: owner || ownerPath,
    name,
    kind: isMethod ? "method" : hash > dot ? "class" : "term",
    path
  };
}

/** The full name of a definition occurrence, the way the report writes owners. */
function ownerName(symbol) {
  return symbol
    .split("/")
    .map((part) => part.replace(/[#$.]/g, "."))
    .join(".")
    .replace(/\.{2,}/g, ".")
    .replace(/\.$/, "");
}

/**
 * Read every `.semanticdb` file under a directory, grouped per source file.
 *
 * @param {string} dir Directory to walk
 * @returns {Object[]} Decoded documents
 */
export function readSemanticdbDir(dir) {
  const documents = [];
  for (const file of listFiles(dir, ".semanticdb")) {
    let decoded;
    try {
      decoded = decodeTextDocuments(readFileSync(file));
    } catch (_err) {
      continue;
    }
    for (const doc of decoded) {
      documents.push({ ...doc, file });
    }
  }
  return documents;
}

/**
 * Resolve the source file of a document: the uri is absolute, relative to the project or a
 * file path with another prefix.
 *
 * @param {string} projectDir
 * @param {string} uri
 * @returns {string|undefined} Absolute path when the source exists
 */
function sourcePathOf(projectDir, uri) {
  const posix = String(uri || "").replaceAll("\\", "/");
  // The uri is absolute, relative to the project, or relative to the module with the
  // source tree in the middle; the source tree marker alone is the last resort.
  const marker = posix.lastIndexOf("src/");
  const candidates = [
    posix,
    marker >= 0 ? posix.slice(marker) : undefined,
    posix.includes("/app/")
      ? posix.slice(posix.lastIndexOf("/app/"))
      : undefined
  ].filter(Boolean);
  for (const candidate of candidates) {
    for (const path of [join(projectDir, candidate), candidate]) {
      if (existsSync(path)) {
        return path;
      }
    }
  }
  return undefined;
}

/**
 * Turn one decoded document into the raw facts of a source file.
 *
 * @param {string} projectDir Absolute project directory
 * @param {Object} doc Decoded TextDocument
 * @returns {{ file: string, facts: Object }|undefined} Facts keyed like the inspector's
 */
export function semanticdbFacts(projectDir, doc) {
  const sourcePath = sourcePathOf(projectDir, doc.uri);
  if (!sourcePath) {
    return undefined;
  }
  const rel = normaliseSourcePath(projectDir, sourcePath);
  const text = existsSync(sourcePath)
    ? readFileSync(sourcePath, "utf-8")
    : doc.text || "";
  const tokens = text ? tokenize(text) : [];
  const { byLine } = tokenIndex(tokens);
  const lines = text.split("\n");
  // The occurrence roles of the schema: 1 is a reference, 2 a definition.
  const ROLE_REFERENCE = 1;
  const ROLE_DEFINITION = 2;
  const defined = new Set();
  const definitionOccurrences = [];
  for (const occ of doc.occurrences) {
    if (occ.role === ROLE_DEFINITION && occ.range) {
      defined.add(occ.symbol);
      definitionOccurrences.push(occ);
    }
  }
  // The enclosing method of a position: the closest definition whose extent contains it.
  // A definition reaches from its line to the line before the next definition that starts
  // at the same or lower column, which is the end of its body for the source layouts the
  // lexer sees.
  const extentEntries = definitionOccurrences
    .map((occ) => ({
      occ,
      parsed: parseSymbol(occ.symbol)
    }))
    .filter((entry) => entry.parsed && entry.parsed.kind !== "package")
    .sort(
      (a, b) =>
        a.occ.range.startLine - b.occ.range.startLine ||
        a.occ.range.startChar - b.occ.range.startChar
    );
  const lastLine = lines.length - 1;
  const extents = extentEntries.map((entry, index) => {
    let end = lastLine;
    for (let j = index + 1; j < extentEntries.length; j++) {
      const next = extentEntries[j].occ.range;
      if (
        next.startLine > entry.occ.range.startLine &&
        next.startChar <= entry.occ.range.startChar
      ) {
        end = next.startLine - 1;
        break;
      }
    }
    return { ...entry, end: Math.max(end, entry.occ.range.startLine) };
  });
  const enclosingBefore = (line, char) => {
    let best;
    for (const entry of extents) {
      const start = entry.occ.range.startLine;
      const column = entry.occ.range.startChar;
      if (
        start < line &&
        (entry.parsed.kind === "method" || entry.parsed.kind === "term") &&
        (!best || start > best.occ.range.startLine)
      ) {
        best = entry;
      }
    }
    return best;
  };
  const enclosingOf = (line) => {
    let best;
    for (const entry of extents) {
      const start = entry.occ.range.startLine;
      if (
        start <= line &&
        line <= entry.end &&
        (entry.parsed.kind === "method" || entry.parsed.kind === "term")
      ) {
        if (!best || entry.occ.range.startLine >= best.occ.range.startLine) {
          best = entry;
        }
      }
    }
    return best;
  };
  // Parameter names of a definition, read from the tokens of its line.
  const paramsOf = (entry) => {
    const line = entry.occ.range.startLine;
    const tokensOfLine = byLine.get(line) || [];
    const open = tokensOfLine.findIndex((t) => t.text === "(");
    if (open < 0) {
      return [];
    }
    const params = [];
    let depth = 0;
    let expectName = true;
    for (let i = open; i < tokensOfLine.length; i++) {
      const token = tokensOfLine[i];
      if (token.text === "(" || token.text === "[") {
        depth += 1;
        continue;
      }
      if (token.text === ")" || token.text === "]") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
        continue;
      }
      if (depth !== 1) {
        continue;
      }
      if (token.text === "," || token.text === ":") {
        expectName = token.text === ",";
        continue;
      }
      if (expectName && token.type === TOKEN.IDENT) {
        params.push(token.text);
        expectName = false;
      }
    }
    return params;
  };
  const paramsByDef = new Map();
  for (const entry of extents) {
    paramsByDef.set(entry.occ.symbol, paramsOf(entry));
  }
  const definitionParams = paramsByDef;
  // Constants: `val X = "literal"` on the definition line. Local values have compiler
  // names; the source name at the position is what arguments reference.
  const constants = [];
  const constantBySym = new Map();
  const constantDefinitions = doc.occurrences.filter(
    (occ) =>
      occ.role === ROLE_DEFINITION &&
      occ.range &&
      occ.range.startLine === occ.range.endLine
  );
  for (const occ of constantDefinitions) {
    const defLine = (byLine.get(occ.range.startLine) || []).filter(
      (t) => t.type !== "ws" && t.type !== "comment"
    );
    const literalIndex = defLine.findIndex(
      (t, index) => t.type === TOKEN.STRING && defLine[index - 1]?.text === "="
    );
    if (literalIndex < 0) {
      continue;
    }
    const value = stringContent(defLine[literalIndex]);
    const nameToken = defLine.find(
      (t, index) =>
        index < literalIndex &&
        t.type === TOKEN.IDENT &&
        t.char >= occ.range.startChar &&
        t.char < occ.range.endChar
    );
    const parsedName = parseSymbol(occ.symbol)?.name;
    const names = [nameToken?.text, parsedName, ownerName(occ.symbol)].filter(
      Boolean
    );
    // A local value belongs to the method around it; values of an object are visible
    // everywhere in the file.
    const enclosing = enclosingBefore(occ.range.startLine, occ.range.startChar);
    const scope =
      enclosing &&
      (enclosing.parsed.kind === "method" ||
        (enclosing.parsed.kind === "term" &&
          enclosing.occ.range.startLine < occ.range.startLine))
        ? `${enclosing.parsed.owner}.${enclosing.parsed.name}`
        : undefined;
    constants.push({
      sym: ownerName(occ.symbol),
      value,
      tpe: "string",
      line: occ.range.startLine + 1
    });
    for (const name of names) {
      if (scope) {
        constantBySym.set(`${scope}.${name}`, value);
      } else {
        constantBySym.set(name, value);
      }
    }
  }
  const resolveHole = (hole) => constantBySym.get(hole.split(".").pop());
  const annotationsBySymbol = new Map();
  for (const info of doc.symbols) {
    if (info.annotations?.length) {
      annotationsBySymbol.set(
        info.symbol,
        info.annotations.flatMap((raw) => annotationSymbols(raw))
      );
    }
  }
  // String literals and identifiers per line, with resolved interpolations: the route DSLs
  // of Scala 2 live on single source lines.
  const lineStrings = [];
  const lineIdents = [];
  for (const token of tokens) {
    if (token.type === TOKEN.STRING) {
      lineStrings.push({
        line: token.line + 1,
        column: token.char + 1,
        value: stringContent(token)
      });
    } else if (token.type === TOKEN.INTERP) {
      const value = interpolatedValue(token, resolveHole);
      if (value !== undefined) {
        lineStrings.push({
          line: token.line + 1,
          column: token.char + 1,
          value
        });
      }
    } else if (token.type === TOKEN.IDENT) {
      lineIdents.push({
        line: token.line + 1,
        column: token.char + 1,
        name: token.text
      });
    }
  }
  const definitions = [];
  const calls = [];
  const references = [];
  const seenRefs = new Set();
  const seenCalls = new Set();
  for (const occ of doc.occurrences) {
    if (!occ.range || !occ.symbol) {
      continue;
    }
    const parsed = parseSymbol(occ.symbol);
    if (!parsed || parsed.kind === "package") {
      continue;
    }
    if (occ.role === ROLE_DEFINITION) {
      definitions.push({
        kind:
          parsed.kind === "method"
            ? "def"
            : ["class", "interface", "trait", "object"].includes(parsed.kind)
              ? parsed.kind === "interface"
                ? "trait"
                : parsed.kind === "class"
                  ? "class"
                  : parsed.kind
              : "val",
        name: parsed.name,
        owner: parsed.owner,
        line: occ.range.startLine + 1,
        endLine: occ.range.endLine + 1,
        column: occ.range.startChar + 1,
        ...(definitionParams.get(occ.symbol)?.length
          ? { params: definitionParams.get(occ.symbol) }
          : {}),
        ...(annotationsBySymbol.get(occ.symbol)?.length
          ? { annotationNames: annotationsBySymbol.get(occ.symbol) }
          : {})
      });
      continue;
    }
    const line = occ.range.startLine;
    // A call of a project method carries the same symbol as its definition; the call fact
    // still counts, the self reference does not.
    const isDefinition = defined.has(occ.symbol);
    // An object referenced with an argument list is an apply call of the object, the sugar
    // the Scala 2 occurrences do not spell out.
    const nextIsArgumentList =
      (parsed.kind === "object" || parsed.kind === "term") &&
      line === occ.range.endLine &&
      argumentTokens(tokens, line, occ.range.endChar).length > 0;
    if (
      nextIsArgumentList &&
      !seenCalls.has(`${line}:${occ.range.startChar}:apply`)
    ) {
      seenCalls.add(`${line}:${occ.range.startChar}:apply`);
      const enclosing = enclosingOf(line);
      calls.push({
        line: line + 1,
        column: occ.range.startChar + 1,
        caller: enclosing
          ? `${enclosing.parsed.owner}.${enclosing.parsed.name}`
          : `${parsed.owner}.${parsed.name}`,
        owner: `${parsed.owner}.${parsed.name}`,
        name: "apply",
        approximate: true
      });
    }
    if (
      parsed.kind === "method" &&
      line === occ.range.endLine &&
      !seenCalls.has(`${line}:${occ.range.startChar}:${occ.symbol}`)
    ) {
      seenCalls.add(`${line}:${occ.range.startChar}:${occ.symbol}`);
      const enclosing = enclosingOf(line);
      const args = argumentTokens(tokens, line, occ.range.endChar);
      const enclosingParams = enclosing
        ? paramsByDef.get(enclosing.occ.symbol)
        : [];
      const scopeKey = enclosing
        ? `${enclosing.parsed.owner}.${enclosing.parsed.name}`
        : undefined;
      const argFacts = args.flatMap((group, index) => {
        const literal = group.find(
          (t) => t.type === TOKEN.STRING || t.type === TOKEN.INTERP
        );
        const number = group.find((t) => t.type === TOKEN.NUMBER);
        const idents = group.filter(
          (t) =>
            t.type === TOKEN.IDENT &&
            /^(Segment|Segments|IntNumber|LongNumber|JavaUUID|Remaining|RemainingPath)$/.test(
              t.text
            )
        );
        // The member of a qualified name is its last identifier: `Argon2Parameters.ARGON2_id`.
        const selected =
          group.length >= 3 &&
          group.at(-2)?.text === "." &&
          group.at(-1)?.type === TOKEN.IDENT
            ? group.at(-1)
            : undefined;
        const bare =
          group.length === 1 && group[0].type === TOKEN.IDENT
            ? group[0]
            : undefined;
        const facts = [];
        if (literal && literal.type === TOKEN.STRING) {
          facts.push({ index, string: stringContent(literal) });
        } else if (literal && literal.type === TOKEN.INTERP) {
          const value = interpolatedValue(literal, resolveHole);
          if (value !== undefined) {
            facts.push({ index, string: value });
          }
        } else if (number) {
          const value = Number(number.text);
          if (Number.isInteger(value)) {
            facts.push({ index, int: value });
          }
        } else if (bare && enclosingParams?.includes(bare.text)) {
          facts.push({
            index,
            param: bare.text,
            paramIndex: enclosingParams.indexOf(bare.text)
          });
        } else if (
          bare &&
          scopeKey &&
          constantBySym.has(`${scopeKey}.${bare.text}`)
        ) {
          facts.push({
            index,
            const: constantBySym.get(`${scopeKey}.${bare.text}`),
            sym: bare.text
          });
        } else if (bare && constantBySym.has(bare.text)) {
          facts.push({
            index,
            const: constantBySym.get(bare.text),
            sym: bare.text
          });
        } else if (selected) {
          if (constantBySym.has(selected.text)) {
            facts.push({
              index,
              const: constantBySym.get(selected.text),
              sym: selected.text
            });
          } else {
            facts.push({
              index,
              ident: selected.text,
              sym: `value.${selected.text}`
            });
          }
        }
        for (const matcher of idents) {
          facts.push({
            index,
            ident: matcher.text,
            sym: `matcher.${matcher.text}`
          });
        }
        return facts;
      });
      const callerName = enclosing
        ? `${enclosing.parsed.owner}.${enclosing.parsed.name}`
        : parsed.owner;
      calls.push({
        line: line + 1,
        column: occ.range.startChar + 1,
        caller: callerName,
        owner: parsed.owner,
        name: parsed.name,
        ...(argFacts.length ? { args: argFacts } : {}),
        approximate: true
      });
    }
    if (isDefinition) {
      continue;
    }
    const key = `${line}:${occ.symbol}`;
    if (seenRefs.has(key)) {
      continue;
    }
    seenRefs.add(key);
    references.push({
      line: line + 1,
      column: occ.range.startChar + 1,
      // The method markers and disambiguators of the grammar are not part of the name the
      // rules match on.
      symbol: ownerName(occ.symbol).replace(/\(+[^)]*\)*$/, ""),
      owner: parsed.owner,
      kind:
        parsed.kind === "class" ||
        parsed.kind === "trait" ||
        parsed.kind === "interface"
          ? "type"
          : "term"
    });
  }
  return {
    file: rel,
    facts: {
      definitions,
      calls,
      patterns: [],
      references,
      constants,
      lineStrings,
      lineIdents,
      factsSource: "semanticdb"
    }
  };
}

/** The last line a call reaches, unknown for SemanticDB facts. */
export const UNKNOWN_EXTENT = Number.MAX_SAFE_INTEGER;

/**
 * Build the raw facts of every document of a module.
 *
 * @param {string} projectDir
 * @param {Object} module Module inventory entry, with `semanticdbDir`
 * @returns {Map<string, Object>} Facts by project relative source path
 */
export function semanticdbModuleFacts(projectDir, module) {
  const files = new Map();
  for (const dir of module.semanticdbDirs || []) {
    for (const doc of readSemanticdbDir(dir)) {
      const result = semanticdbFacts(projectDir, doc);
      if (!result) {
        continue;
      }
      const existing = files.get(result.file);
      if (existing) {
        for (const key of ["definitions", "calls", "references", "constants"]) {
          existing[key].push(...(result.facts[key] || []));
        }
      } else {
        files.set(result.file, result.facts);
      }
    }
  }
  return files;
}
