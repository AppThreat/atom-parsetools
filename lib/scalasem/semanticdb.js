// The SemanticDB reader: decodes the TextDocuments protobuf with a bounded varint reader,
// parses the symbol grammar, and turns one document into the raw facts the TASTy inspector
// produces, in the same shapes. SemanticDB has no trees, so extents and arguments come from
// the source tokens; what each identifier means comes from its occurrence.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { TOKEN, argumentLists, codeTokens, tokenize } from "./lexer.js";
import { listFiles, normaliseSourcePath } from "./util.js";

// The protobuf decoder.

/** One protobuf reader over a buffer; a malformed buffer throws. */
function reader(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let scale = 1;
    for (let k = 0; k < 10; k++) {
      if (pos >= buf.length) {
        throw new Error("truncated varint");
      }
      const b = buf[pos++];
      result += (b & 0x7f) * scale;
      if (!(b & 0x80)) {
        return result;
      }
      scale *= 128;
    }
    throw new Error("varint longer than ten bytes");
  };
  const bytes = () => {
    const length = varint();
    if (length > buf.length - pos) {
      throw new Error("length past the end of the message");
    }
    const out = buf.subarray(pos, pos + length);
    pos += length;
    return out;
  };
  return {
    eof: () => pos >= buf.length,
    field() {
      const key = varint();
      return { no: Math.floor(key / 8), wire: key % 8 };
    },
    varint,
    bytes,
    skip(wire) {
      if (wire === 0) {
        varint();
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 2) {
        bytes();
      } else if (wire === 5) {
        pos += 4;
      } else {
        throw new Error(`unsupported wire type ${wire}`);
      }
      if (pos > buf.length) {
        throw new Error("field past the end of the message");
      }
    }
  };
}

const utf8 = (b) => Buffer.from(b).toString("utf-8");

/** Decode the fields of one message with a handler per field number. */
function decode(buf, handlers) {
  const r = reader(buf);
  while (!r.eof()) {
    const f = r.field();
    const handler = handlers[f.no];
    if (handler && handler.wire === f.wire) {
      handler.read(f.wire === 2 ? r.bytes() : r.varint());
    } else {
      r.skip(f.wire);
    }
  }
}

const message = (read) => ({ wire: 2, read });
const number = (read) => ({ wire: 0, read });

function decodeRange(b) {
  const range = { startLine: 0, startChar: 0, endLine: 0, endChar: 0 };
  decode(b, {
    1: number((v) => (range.startLine = v)),
    2: number((v) => (range.startChar = v)),
    3: number((v) => (range.endLine = v)),
    4: number((v) => (range.endChar = v))
  });
  return range;
}

/** The symbol a Type names, through a type reference or a single type. */
function typeSymbol(b) {
  let symbol;
  decode(b, {
    2: message((ref) =>
      decode(ref, { 2: message((s) => (symbol ??= utf8(s))) })
    ),
    20: message((single) =>
      decode(single, { 2: message((s) => (symbol ??= utf8(s))) })
    )
  });
  return symbol;
}

function scopeSymbols(b) {
  const symbols = [];
  decode(b, {
    1: message((s) => symbols.push(utf8(s))),
    2: message((info) =>
      decode(info, { 1: message((s) => symbols.push(utf8(s))) })
    )
  });
  return symbols;
}

function decodeSignature(b, info) {
  decode(b, {
    1: message((classSignature) =>
      decode(classSignature, {
        2: message((parent) => {
          const symbol = typeSymbol(parent);
          if (symbol) {
            (info.parents ||= []).push(symbol);
          }
        })
      })
    ),
    2: message((methodSignature) =>
      decode(methodSignature, {
        2: message((list) =>
          (info.parameterLists ||= []).push(scopeSymbols(list))
        )
      })
    )
  });
}

function decodeSymbolInformation(b) {
  const info = { kind: 0, properties: 0 };
  decode(b, {
    1: message((s) => (info.symbol = utf8(s))),
    3: number((v) => (info.kind = v)),
    4: number((v) => (info.properties = v)),
    5: message((s) => (info.displayName = utf8(s))),
    13: message((annotation) =>
      decode(annotation, {
        1: message((tpe) => {
          const symbol = typeSymbol(tpe);
          if (symbol) {
            (info.annotations ||= []).push(symbol);
          }
        })
      })
    ),
    17: message((signature) => decodeSignature(signature, info))
  });
  return info;
}

function decodeOccurrence(b) {
  const occ = { role: 0 };
  decode(b, {
    1: message((r) => (occ.range = decodeRange(r))),
    2: message((s) => (occ.symbol = utf8(s))),
    3: number((v) => (occ.role = v))
  });
  return occ;
}

/** The trees of a synthetic, limited to the shapes implicit conversions take. */
function decodeTree(b, depth = 0) {
  if (depth > 16) {
    return undefined;
  }
  let tree;
  decode(b, {
    1: message((apply) => {
      tree = { apply: true, arguments: [] };
      decode(apply, {
        1: message((fn) => (tree.function = decodeTree(fn, depth + 1))),
        2: message((arg) => tree.arguments.push(decodeTree(arg, depth + 1)))
      });
    }),
    3: message((id) => {
      tree = {};
      decode(id, { 1: message((s) => (tree.symbol = utf8(s))) });
    }),
    6: message((original) => {
      tree = {};
      decode(original, { 1: message((r) => (tree.range = decodeRange(r))) });
    }),
    7: message((select) => {
      tree = { select: true };
      decode(select, {
        1: message((q) => (tree.qualifier = decodeTree(q, depth + 1))),
        2: message((id) =>
          decode(id, { 1: message((s) => (tree.symbol = utf8(s))) })
        )
      });
    }),
    8: message((typeApply) => {
      decode(typeApply, {
        1: message((fn) => (tree = decodeTree(fn, depth + 1)))
      });
    })
  });
  return tree;
}

function decodeSynthetic(b) {
  const synthetic = {};
  decode(b, {
    1: message((r) => (synthetic.range = decodeRange(r))),
    2: message((t) => (synthetic.tree = decodeTree(t)))
  });
  return synthetic;
}

function decodeTextDocument(b) {
  const doc = { schema: 0, occurrences: [], symbols: [], synthetics: [] };
  decode(b, {
    1: number((v) => (doc.schema = v)),
    2: message((s) => (doc.uri = utf8(s))),
    3: message((s) => (doc.text = utf8(s))),
    5: message((s) => doc.symbols.push(decodeSymbolInformation(s))),
    6: message((s) => doc.occurrences.push(decodeOccurrence(s))),
    11: message((s) => (doc.md5 = utf8(s))),
    12: message((s) => doc.synthetics.push(decodeSynthetic(s)))
  });
  return doc;
}

/**
 * Decode a `.semanticdb` file. A malformed file throws.
 *
 * @param {Buffer} buffer File content
 * @returns {Object[]} Documents `{ uri, text?, symbols, occurrences, synthetics }`
 */
export function decodeTextDocuments(buffer) {
  const documents = [];
  decode(buffer, {
    1: message((doc) => documents.push(decodeTextDocument(doc)))
  });
  return documents;
}

// The symbol grammar.

const KIND = {
  LOCAL: 19,
  FIELD: 20,
  METHOD: 3,
  CONSTRUCTOR: 21,
  MACRO: 6,
  TYPE: 7,
  PARAMETER: 8,
  SELF_PARAMETER: 17,
  TYPE_PARAMETER: 9,
  OBJECT: 10,
  PACKAGE: 11,
  PACKAGE_OBJECT: 12,
  CLASS: 13,
  TRAIT: 14,
  INTERFACE: 18
};
const PROPERTY = {
  ABSTRACT: 0x4,
  FINAL: 0x8,
  SEALED: 0x10,
  IMPLICIT: 0x20,
  LAZY: 0x40,
  CASE: 0x80,
  VAL: 0x400,
  VAR: 0x800,
  GIVEN: 0x10000,
  INLINE: 0x20000
};

/**
 * Split a symbol into its descriptors: `a/b/C#m(+1).(x)` is the package `a`, the package
 * `b`, the type `C`, the method `m` with disambiguator `(+1)` and its parameter `x`.
 *
 * @param {string} symbol
 * @returns {{ kind: string, name: string, disambiguator?: string }[]|undefined}
 */
export function symbolDescriptors(symbol) {
  if (
    !symbol ||
    symbol.startsWith("local") ||
    symbol === "_root_/" ||
    symbol === "_empty_/"
  ) {
    return undefined;
  }
  const descriptors = [];
  let i = 0;
  const readName = () => {
    if (symbol[i] === "`") {
      const end = symbol.indexOf("`", i + 1);
      const name = symbol.slice(i + 1, end < 0 ? symbol.length : end);
      i = end < 0 ? symbol.length : end + 1;
      return name;
    }
    const start = i;
    while (i < symbol.length && !"/.#([".includes(symbol[i])) {
      i += 1;
    }
    return symbol.slice(start, i);
  };
  while (i < symbol.length) {
    if (symbol[i] === "(") {
      const end = symbol.indexOf(")", i);
      descriptors.push({
        kind: "parameter",
        name: symbol.slice(i + 1, end).replaceAll("`", "")
      });
      i = end + 1;
      continue;
    }
    if (symbol[i] === "[") {
      const end = symbol.indexOf("]", i);
      descriptors.push({
        kind: "typeParameter",
        name: symbol.slice(i + 1, end)
      });
      i = end + 1;
      continue;
    }
    const name = readName();
    const marker = symbol[i];
    if (marker === "/") {
      descriptors.push({ kind: "package", name });
      i += 1;
    } else if (marker === "#") {
      descriptors.push({ kind: "type", name });
      i += 1;
    } else if (marker === ".") {
      descriptors.push({ kind: "term", name });
      i += 1;
    } else if (marker === "(") {
      const end = symbol.indexOf(")", i);
      const disambiguator = symbol.slice(i, end + 1);
      i = end + 1;
      if (symbol[i] === ".") {
        i += 1;
      }
      descriptors.push({ kind: "method", name, disambiguator });
    } else {
      descriptors.push({ kind: "term", name });
    }
  }
  return descriptors.filter((d) => d.name !== "_empty_");
}

/**
 * The full name of the owner the descriptors before a member make, in the inspector's
 * spelling: packages and classes by name, objects with `$` (`a.b.C$` owns the members of the
 * object `C`).
 */
function ownerFullName(descriptors) {
  return descriptors
    .map((d, index) => {
      if (d.kind === "term" && index < descriptors.length) {
        // A term owning members is an object or a package object.
        return d.name === "package" ? "package$" : `${d.name}$`;
      }
      return d.name;
    })
    .join(".");
}

/**
 * Parse a SemanticDB symbol into the owner and name the inspector would report.
 *
 * @param {string} symbol
 * @returns {{ kind: string, owner: string, name: string, fullName: string,
 *   disambiguator?: string, ownerSymbol?: string }|undefined}
 */
export function parseSymbol(symbol) {
  const descriptors = symbolDescriptors(symbol);
  if (!descriptors?.length) {
    return undefined;
  }
  const last = descriptors[descriptors.length - 1];
  if (last.kind === "parameter" || last.kind === "typeParameter") {
    const method = descriptors.slice(0, -1);
    return {
      kind: last.kind,
      name: last.name,
      owner: memberName(method),
      fullName: `${memberName(method)}.${last.name}`
    };
  }
  const ownerDescriptors = descriptors.slice(0, -1);
  const owner = ownerFullName(ownerDescriptors);
  const name = last.name;
  return {
    kind: last.kind,
    name,
    owner,
    fullName: owner ? `${owner}.${name}` : name,
    ...(last.disambiguator ? { disambiguator: last.disambiguator } : {})
  };
}

function memberName(descriptors) {
  if (!descriptors.length) {
    return "";
  }
  const owner = ownerFullName(descriptors.slice(0, -1));
  const last = descriptors[descriptors.length - 1];
  return owner ? `${owner}.${last.name}` : last.name;
}

// Reading the documents of a module.

/**
 * Read every `.semanticdb` file under a directory. A file that does not decode is skipped.
 *
 * @param {string} dir Directory to walk
 * @returns {Object[]} Decoded documents
 */
export function readSemanticdbDir(dir) {
  const documents = [];
  for (const file of listFiles(dir, ".semanticdb")) {
    try {
      for (const doc of decodeTextDocuments(readFileSync(file))) {
        documents.push({ ...doc, file });
      }
    } catch (_err) {
      // A truncated or foreign file costs only itself.
    }
  }
  return documents;
}

/**
 * The source file of a document, when it is a file inside the project: the uri is relative
 * to the build root, or absolute.
 */
function sourcePathOf(projectDir, uri) {
  const posix = String(uri || "").replaceAll("\\", "/");
  if (!posix) {
    return undefined;
  }
  const candidates = isAbsolute(posix) ? [posix] : [join(projectDir, posix)];
  for (const candidate of candidates) {
    const full = resolve(candidate);
    const rel = relative(projectDir, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      continue;
    }
    try {
      if (existsSync(full) && statSync(full).isFile()) {
        return full;
      }
    } catch (_err) {
      // unreadable
    }
  }
  return undefined;
}

/**
 * Build the raw facts of every document of a module. A document that cannot be read
 * contributes nothing.
 *
 * @param {string} projectDir
 * @param {Object} module Module inventory entry, with `semanticdbDirs`
 * @returns {Map<string, Object>} Facts by project relative source path
 */
export function semanticdbModuleFacts(projectDir, module) {
  const files = new Map();
  for (const dir of module.semanticdbDirs || []) {
    for (const doc of readSemanticdbDir(dir)) {
      let result;
      try {
        result = semanticdbFacts(projectDir, doc);
      } catch (_err) {
        result = undefined;
      }
      if (result && !files.has(result.file)) {
        files.set(result.file, result.facts);
      }
    }
  }
  return files;
}

// Facts of one document.

const ROLE_DEFINITION = 2;
const DEFINITION_KINDS = new Set(["val", "def", "class", "trait", "object"]);

/**
 * Turn one decoded document into the raw facts of its source file, in the inspector's shapes.
 *
 * @param {string} projectDir Absolute project directory
 * @param {Object} doc Decoded TextDocument
 * @returns {{ file: string, facts: Object }|undefined}
 */
export function semanticdbFacts(projectDir, doc) {
  const sourcePath = sourcePathOf(projectDir, doc.uri);
  if (!sourcePath) {
    return undefined;
  }
  const text = readFileSync(sourcePath, "utf-8");
  const tokens = codeTokens(tokenize(text));
  const reading = new DocumentReading(doc, tokens);
  return {
    file: normaliseSourcePath(projectDir, sourcePath),
    facts: {
      definitions: reading.definitions(),
      calls: reading.calls(),
      patterns: [],
      references: reading.references(),
      constants: reading.constants(),
      factsSource: "semanticdb"
    }
  };
}

/** The tokens, occurrences and symbol information of one document, read together. */
class DocumentReading {
  constructor(doc, tokens) {
    this.doc = doc;
    this.tokens = tokens;
    this.infos = new Map(doc.symbols.map((info) => [info.symbol, info]));
    this.tokenAt = new Map();
    tokens.forEach((token, index) => {
      this.tokenAt.set(`${token.line}:${token.column}`, index);
    });
    // The occurrence of a token start: what the identifier there means.
    this.occurrenceAt = new Map();
    for (const occ of doc.occurrences) {
      if (occ.range && occ.symbol) {
        const key = `${occ.range.startLine}:${occ.range.startChar}`;
        if (!this.occurrenceAt.has(key) || occ.role === ROLE_DEFINITION) {
          this.occurrenceAt.set(key, occ);
        }
      }
    }
    this.importRanges = importRanges(tokens);
    this.scopes = this.definitionScopes();
  }

  kindOf(symbol) {
    const info = this.infos.get(symbol);
    const parsed = parseSymbol(symbol);
    if (symbol.startsWith("local")) {
      return info?.kind === KIND.LOCAL &&
        info.properties & (PROPERTY.VAL | PROPERTY.VAR)
        ? "val"
        : "local";
    }
    switch (info?.kind) {
      case KIND.CLASS:
        return "class";
      case KIND.TRAIT:
      case KIND.INTERFACE:
        return "trait";
      case KIND.OBJECT:
      case KIND.PACKAGE_OBJECT:
        return "object";
      case KIND.METHOD:
      case KIND.MACRO:
      case KIND.CONSTRUCTOR:
        return info.properties & (PROPERTY.VAL | PROPERTY.VAR) ? "val" : "def";
      case KIND.FIELD:
        return "val";
      case KIND.PARAMETER:
      case KIND.SELF_PARAMETER:
        return "param";
      case KIND.TYPE_PARAMETER:
      case KIND.TYPE:
        return "type";
      default:
        break;
    }
    if (!parsed) {
      return undefined;
    }
    if (parsed.kind === "method") {
      return "def";
    }
    if (parsed.kind === "type") {
      return "class";
    }
    if (parsed.kind === "parameter") {
      return "param";
    }
    return parsed.kind === "term" ? "object" : parsed.kind;
  }

  /**
   * The definitions of the document with the token extent of each body: a block reaches
   * its closing brace, an expression the end of its statement.
   */
  definitionScopes() {
    const scopes = [];
    for (const occ of this.doc.occurrences) {
      if (occ.role !== ROLE_DEFINITION || !occ.range || !occ.symbol) {
        continue;
      }
      const kind = this.kindOf(occ.symbol);
      if (!DEFINITION_KINDS.has(kind)) {
        continue;
      }
      const index = this.tokenAt.get(
        `${occ.range.startLine}:${occ.range.startChar}`
      );
      if (index === undefined) {
        continue;
      }
      const end = bodyEnd(this.tokens, index, kind);
      scopes.push({ occ, kind, start: index, end });
    }
    return scopes.sort((a, b) => a.start - b.start || b.end - a.end);
  }

  /** The innermost definition whose extent holds a token, by kind. */
  innermost(index, accept = () => true) {
    let best;
    for (const scope of this.scopes) {
      if (scope.start > index) {
        break;
      }
      if (scope.start <= index && index <= scope.end && accept(scope)) {
        best = scope;
      }
    }
    return best;
  }

  /**
   * The definition a call belongs to, as the inspector names it: local values fold into
   * the method around them, and a statement of a template belongs to its class or object.
   */
  enclosing(index) {
    return this.innermost(
      index,
      (scope) => !(scope.kind === "val" && scope.occ.symbol.startsWith("local"))
    );
  }

  callerOf(scope) {
    if (!scope) {
      return undefined;
    }
    const parsed = parseSymbol(scope.occ.symbol);
    if (!parsed) {
      return undefined;
    }
    if (scope.kind === "object") {
      return `${parsed.fullName}$`;
    }
    return parsed.fullName;
  }

  /** The value parameters of a method in declaration order, every list flattened. */
  parametersOf(symbol) {
    return (this.infos.get(symbol)?.parameterLists || []).flat();
  }

  definitions() {
    const definitions = [];
    for (const scope of this.scopes) {
      const { occ, kind } = scope;
      const parsed = parseSymbol(occ.symbol);
      const info = this.infos.get(occ.symbol);
      const name = parsed?.name ?? info?.displayName;
      if (!name) {
        continue;
      }
      const owner = occ.symbol.startsWith("local")
        ? this.callerOf(this.enclosing(scope.start - 1)) || ""
        : parsed.owner;
      const end = this.tokens[scope.end];
      const flags = flagsOf(info);
      const params = this.parametersOf(occ.symbol)
        .map((p) => parseSymbol(p)?.name)
        .filter(Boolean);
      definitions.push({
        kind,
        name,
        owner,
        ...(parsed ? { sym: parsed.fullName } : {}),
        line: occ.range.startLine + 1,
        column: occ.range.startChar + 1,
        endLine: (end?.endLine ?? occ.range.endLine) + 1,
        ...(flags.length ? { flags } : {}),
        ...(info?.parents?.length
          ? { parents: info.parents.map((p) => typeName(p)).filter(Boolean) }
          : {}),
        ...(params.length ? { params } : {}),
        ...(info?.annotations?.length
          ? {
              annotations: info.annotations
                .map((a) => ({ name: typeName(a) }))
                .filter((a) => a.name)
            }
          : {}),
        ...(parsed?.disambiguator ? { signature: parsed.disambiguator } : {})
      });
    }
    return definitions;
  }

  /** Object member values with a literal right hand side. */
  constants() {
    const constants = [];
    for (const scope of this.scopes) {
      if (scope.kind !== "val" || scope.occ.symbol.startsWith("local")) {
        continue;
      }
      const literal = literalOfDefinition(this.tokens, scope.start, scope.end);
      const parsed = parseSymbol(scope.occ.symbol);
      if (
        literal &&
        parsed &&
        !(this.infos.get(scope.occ.symbol)?.properties & PROPERTY.VAR)
      ) {
        constants.push({
          sym: parsed.fullName,
          ...literal,
          line: scope.occ.range.startLine + 1
        });
      }
    }
    return constants;
  }

  references() {
    const references = [];
    const seen = new Set();
    for (const occ of this.doc.occurrences) {
      if (occ.role === ROLE_DEFINITION || !occ.range || !occ.symbol) {
        continue;
      }
      const parsed = parseSymbol(occ.symbol);
      if (!parsed || parsed.kind === "package" || parsed.kind === "parameter") {
        continue;
      }
      const key = `${occ.range.startLine}:${occ.symbol}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const index = this.tokenAt.get(
        `${occ.range.startLine}:${occ.range.startChar}`
      );
      const kind =
        index !== undefined &&
        this.importRanges.some(([a, b]) => index >= a && index <= b)
          ? "import"
          : parsed.kind === "type"
            ? "type"
            : "term";
      references.push({
        line: occ.range.startLine + 1,
        column: occ.range.startChar + 1,
        symbol: referenceName(occ.symbol, parsed, this.kindOf(occ.symbol)),
        owner: parsed.owner,
        kind
      });
    }
    return references;
  }

  calls() {
    const calls = [];
    const seen = new Set();
    const add = (call) => {
      const key = `${call.line}:${call.column}:${call.owner}.${call.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push(call);
      }
    };
    for (const occ of this.doc.occurrences) {
      if (occ.role === ROLE_DEFINITION || !occ.range || !occ.symbol) {
        continue;
      }
      const index = this.tokenAt.get(
        `${occ.range.startLine}:${occ.range.startChar}`
      );
      if (
        index === undefined ||
        this.importRanges.some(([a, b]) => index >= a && index <= b)
      ) {
        continue;
      }
      const parsed = parseSymbol(occ.symbol);
      if (!parsed) {
        continue;
      }
      const kind = this.kindOf(occ.symbol);
      // `new C(...)` refers to the constructor; `Obj(...)` is the object's apply.
      if (kind === "def" || parsed.kind === "method") {
        add(
          this.callAt(index, parsed.owner, parsed.name, parsed.disambiguator)
        );
      } else if (kind === "object" && this.tokens[index + 1]?.text === "(") {
        add(this.callAt(index, `${parsed.fullName}$`, "apply"));
      }
    }
    for (const synthetic of this.doc.synthetics) {
      const call = this.conversionCall(synthetic);
      if (call) {
        add(call);
      }
    }
    return calls.sort((a, b) => a.line - b.line || a.column - b.column);
  }

  /** A call fact for the callee token at `index`, with its argument lists. */
  callAt(index, owner, name, signature) {
    const token = this.tokens[index];
    // Scala 2 places the constructor of `new C[T](...)` on its argument list.
    const lists = argumentLists(
      this.tokens,
      token.text === "(" ? index - 1 : index
    );
    const scope = this.enclosing(index);
    const caller = this.callerOf(scope);
    const parameters = scope ? this.parametersOf(scope.occ.symbol) : [];
    const args = [];
    // An interpolator such as `uri"..."` takes the interpolation as its argument.
    if (token.type === TOKEN.INTERP) {
      args.push({
        index: 0,
        parts: this.interpolationParts(token, parameters)
      });
    }
    let position = 0;
    for (const list of lists) {
      for (const arg of list.args) {
        // A block argument is code, a function or a by-name route, not a value.
        if (this.tokens[list.open].text === "(") {
          args.push(...this.argumentFacts(arg, position, parameters, scope));
        }
        position += 1;
      }
    }
    const last = lists.length
      ? this.tokens[lists[lists.length - 1].close]
      : token;
    const callerParsed = scope ? parseSymbol(scope.occ.symbol) : undefined;
    const recv = this.receiverOf(index);
    return {
      line: token.line + 1,
      column: token.column + 1,
      endLine: last.endLine + 1,
      endColumn: last.endColumn + 1,
      ...(caller ? { caller } : {}),
      ...(callerParsed?.disambiguator
        ? { callerSignature: callerParsed.disambiguator }
        : {}),
      owner,
      name,
      ...(signature ? { signature } : {}),
      ...(recv ? { recv } : {}),
      ...(args.length ? { args } : {})
    };
  }

  /** The local value or parameter a call is selected on: `md.digest(...)`. */
  receiverOf(index) {
    const dot = this.tokens[index - 1];
    const target = this.tokens[index - 2];
    if (dot?.type !== TOKEN.DOT || target?.type !== TOKEN.IDENT) {
      return undefined;
    }
    const occ = this.occurrenceAt.get(`${target.line}:${target.column}`);
    if (!occ?.symbol) {
      return undefined;
    }
    const kind = this.kindOf(occ.symbol);
    if (kind !== "val" && kind !== "param" && kind !== "local") {
      return undefined;
    }
    return {
      ident: target.value ?? target.text,
      sym: parseSymbol(occ.symbol)?.fullName ?? occ.symbol
    };
  }

  /** An implicit conversion the compiler applied: `"users"` turned into a path matcher. */
  conversionCall(synthetic) {
    const tree = synthetic.tree;
    if (!tree?.apply || !tree.function?.symbol || tree.arguments.length !== 1) {
      return undefined;
    }
    const range = tree.arguments[0]?.range;
    const parsed = parseSymbol(tree.function.symbol);
    if (!range || !parsed || parsed.kind !== "method") {
      return undefined;
    }
    const start = this.tokenAt.get(`${range.startLine}:${range.startChar}`);
    if (start === undefined) {
      return undefined;
    }
    let end = start;
    while (
      end + 1 < this.tokens.length &&
      (this.tokens[end + 1].line < range.endLine ||
        (this.tokens[end + 1].line === range.endLine &&
          this.tokens[end + 1].column < range.endChar))
    ) {
      end += 1;
    }
    const scope = this.enclosing(start);
    const parameters = scope ? this.parametersOf(scope.occ.symbol) : [];
    const range0 = [];
    for (let k = start; k <= end; k++) {
      range0.push(k);
    }
    const args = this.argumentFacts(range0, 0, parameters, scope);
    const caller = this.callerOf(scope);
    return {
      line: range.startLine + 1,
      column: range.startChar + 1,
      endLine: range.endLine + 1,
      endColumn: range.endChar + 1,
      ...(caller ? { caller } : {}),
      owner: parsed.owner,
      name: parsed.name,
      ...(args.length ? { args } : {})
    };
  }

  /**
   * The facts of one argument, in the inspector's shapes: a literal, an interpolation, a
   * parameter of the enclosing method, a constant, another value, or a call whose own
   * arguments are literals.
   */
  argumentFacts(range, index, parameters, scope) {
    let tokens = range.map((k) => this.tokens[k]);
    let offset = 0;
    // A named argument: `uri = "..."`.
    if (
      tokens.length > 2 &&
      tokens[0].type === TOKEN.IDENT &&
      tokens[1].text === "="
    ) {
      tokens = tokens.slice(2);
      offset = 2;
    }
    if (!tokens.length) {
      return [];
    }
    const first = tokens[0];
    if (isFunction(tokens)) {
      return [];
    }
    if (tokens.length === 1 || isAscribed(tokens)) {
      if (first.type === TOKEN.STRING) {
        return [{ index, string: first.value }];
      }
      if (first.type === TOKEN.NUMBER && first.value !== undefined) {
        return [
          {
            index,
            ...(Number.isSafeInteger(first.value) ? { int: first.value } : {})
          }
        ];
      }
      if (first.type === TOKEN.INTERP) {
        return [{ index, parts: this.interpolationParts(first, parameters) }];
      }
      if (first.text === "true" || first.text === "false") {
        return [{ index, boolean: first.text === "true" }];
      }
    }
    // A name or a qualified name: the occurrence of its last identifier says what it is.
    if (tokens.every((t) => t.type === TOKEN.IDENT || t.type === TOKEN.DOT)) {
      const last = tokens[tokens.length - 1];
      const occ = this.occurrenceAt.get(`${last.line}:${last.column}`);
      if (occ?.symbol && this.kindOf(occ.symbol) === "def") {
        // `body.getBytes` is a call of its own, not a value.
        return [];
      }
      const value = this.valueOf(last, parameters);
      return value ? [{ index, ...value }] : [];
    }
    // A call whose own arguments are literals: `toCString("...")`, `Uri("...")`. The call
    // has to be the whole argument.
    let callee = range[offset];
    while (
      this.tokens[callee + 1]?.type === TOKEN.DOT &&
      this.tokens[callee + 2]?.type === TOKEN.IDENT
    ) {
      callee += 2;
    }
    const parsed = this.occurrenceSymbol(this.tokens[callee]);
    const lists = argumentLists(this.tokens, callee);
    if (
      parsed &&
      lists.length &&
      lists[lists.length - 1].close === range[range.length - 1]
    ) {
      const literals = lists
        .flatMap((list) => list.args)
        .map((arg) => this.tokens[arg[0]])
        .filter((t) => t.type === TOKEN.STRING)
        .map((t) => t.value);
      if (literals.length) {
        return [{ index, call: parsed.fullName, args: literals }];
      }
    }
    return [];
  }

  occurrenceSymbol(token) {
    const occ = token && this.occurrenceAt.get(`${token.line}:${token.column}`);
    return occ ? parseSymbol(occ.symbol) : undefined;
  }

  /** What an identifier argument is, by its occurrence. */
  valueOf(token, parameters) {
    const occ = this.occurrenceAt.get(`${token.line}:${token.column}`);
    if (!occ?.symbol) {
      return undefined;
    }
    const name = token.value ?? token.text;
    const position = parameters.indexOf(occ.symbol);
    if (position >= 0) {
      return { param: name, paramIndex: position };
    }
    const scope = this.scopes.find(
      (s) => s.occ.symbol === occ.symbol && s.occ.role === ROLE_DEFINITION
    );
    if (
      scope?.kind === "val" &&
      !(this.infos.get(occ.symbol)?.properties & PROPERTY.VAR)
    ) {
      const literal = literalOfDefinition(this.tokens, scope.start, scope.end);
      if (literal?.tpe === "string" || literal?.tpe === "int") {
        const parsed = parseSymbol(occ.symbol);
        return {
          const: literal.value,
          sym: parsed?.fullName ?? name,
          ...(occ.symbol.startsWith("local")
            ? { defLine: scope.occ.range.startLine + 1 }
            : {})
        };
      }
    }
    const parsed = parseSymbol(occ.symbol);
    return { ident: name, sym: parsed?.fullName ?? name };
  }

  /** The pieces of an interpolation: literal parts, and each hole by what it names. */
  interpolationParts(token, parameters) {
    const pieces = [];
    token.parts.forEach((part, i) => {
      pieces.push(part);
      const hole = token.holes[i];
      if (!hole) {
        return;
      }
      if (!hole.name) {
        pieces.push({});
        return;
      }
      const at = { line: hole.line, column: hole.nameColumn, value: hole.name };
      const value = this.valueOf(at, parameters);
      if (value?.const !== undefined) {
        pieces.push({ const: value.const, sym: value.sym });
      } else if (value?.param !== undefined) {
        pieces.push({ param: value.param, paramIndex: value.paramIndex });
      } else {
        pieces.push({ ident: hole.name });
      }
    });
    return pieces;
  }
}

/** A definition's extent: the token that ends its body. */
function bodyEnd(tokens, index, kind) {
  let i = index + 1;
  // Type parameters, parameter lists, a result type or an extends clause come first; the
  // body is a brace block, or for a value or method an expression after `=`.
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.text === "{" && token.match !== undefined) {
      return kind === "val" || kind === "def"
        ? expressionEnd(tokens, i, tokens[index])
        : token.match;
    }
    if (
      (token.text === "(" || token.text === "[") &&
      token.match !== undefined
    ) {
      i = token.match + 1;
      continue;
    }
    if (token.text === "=" && (kind === "val" || kind === "def")) {
      return expressionEnd(tokens, i + 1, tokens[index]);
    }
    if (
      token.type === TOKEN.KEYWORD &&
      [
        "def",
        "val",
        "var",
        "class",
        "object",
        "trait",
        "case",
        "import"
      ].includes(token.text)
    ) {
      return i - 1;
    }
    if (token.text === "}" || token.text === ")" || token.text === "]") {
      return i - 1;
    }
    i += 1;
  }
  return tokens.length - 1;
}

/**
 * The last token of an expression that starts at `i`: a brace block ends at its match; a
 * plain expression ends where the next statement starts, a line that begins at or left of
 * the definition and does not continue the expression.
 */
function expressionEnd(tokens, i, definition) {
  let end = i;
  for (let k = i; k < tokens.length; k++) {
    const token = tokens[k];
    if (
      token.type === TOKEN.BRACKET &&
      token.match !== undefined &&
      token.match > k
    ) {
      end = token.match;
      k = token.match;
      continue;
    }
    if (
      token.type === TOKEN.BRACKET &&
      (token.match === undefined || token.match < k)
    ) {
      return end;
    }
    const previous = tokens[k - 1];
    const startsLine = previous && token.line > previous.endLine;
    if (startsLine && k > i) {
      const continues =
        token.type === TOKEN.DOT ||
        previous.type === TOKEN.OP ||
        previous.type === TOKEN.COMMA ||
        previous.text === "=" ||
        (token.type === TOKEN.OP && !["@"].includes(token.text)) ||
        token.column > definition.column;
      if (!continues) {
        return end;
      }
    }
    if (token.type === TOKEN.SEMI && token.line === tokens[end]?.line) {
      return end;
    }
    end = k;
  }
  return end;
}

/** The literal a value definition is set to, when its right hand side is one literal. */
function literalOfDefinition(tokens, start, end) {
  let i = start + 1;
  while (i <= end && tokens[i].text !== "=") {
    if (tokens[i].match !== undefined && tokens[i].match > i) {
      i = tokens[i].match;
    }
    i += 1;
  }
  const value = tokens[i + 1];
  if (!value || i + 1 !== end) {
    return undefined;
  }
  if (value.type === TOKEN.STRING) {
    return { value: value.value, tpe: "string" };
  }
  if (value.type === TOKEN.NUMBER && Number.isSafeInteger(value.value)) {
    return { value: value.value, tpe: "int" };
  }
  return undefined;
}

/** An anonymous function: a `=>` outside any bracket of the argument. */
function isFunction(tokens) {
  let depth = 0;
  for (const token of tokens) {
    if (token.type === TOKEN.BRACKET) {
      depth += "([{".includes(token.text) ? 1 : -1;
    } else if (depth === 0 && token.text === "=>") {
      return true;
    }
  }
  return false;
}

/** `x: T` or `x: _*` around a single value. */
function isAscribed(tokens) {
  return tokens.length >= 3 && tokens[1].text === ":";
}

/** The token ranges of import statements. */
function importRanges(tokens) {
  const ranges = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== "import" || tokens[i].type !== TOKEN.KEYWORD) {
      continue;
    }
    let end = i;
    for (let k = i + 1; k < tokens.length; k++) {
      if (tokens[k].text === "{" && tokens[k].match !== undefined) {
        end = tokens[k].match;
        k = tokens[k].match;
        continue;
      }
      if (
        tokens[k].line > tokens[end].endLine &&
        tokens[k].type !== TOKEN.DOT
      ) {
        break;
      }
      if (tokens[k].type === TOKEN.SEMI) {
        break;
      }
      end = k;
    }
    ranges.push([i, end]);
    i = end;
  }
  return ranges;
}

function flagsOf(info) {
  if (!info) {
    return [];
  }
  // The flags the inspector reports, so both readers describe a definition the same way.
  const flags = [];
  for (const [flag, bit] of [
    ["final", PROPERTY.FINAL],
    ["implicit", PROPERTY.IMPLICIT],
    ["lazy", PROPERTY.LAZY],
    ["case", PROPERTY.CASE],
    ["given", PROPERTY.GIVEN],
    ["inline", PROPERTY.INLINE]
  ]) {
    if (info.properties & bit) {
      flags.push(flag);
    }
  }
  if (info.kind === KIND.OBJECT) {
    flags.push("module");
  }
  return flags;
}

/** The full name of a type symbol: `scala/App#` is `scala.App`. */
function typeName(symbol) {
  return parseSymbol(symbol)?.fullName;
}

/** The symbol of a reference in the inspector's spelling. */
function referenceName(symbol, parsed, kind) {
  if (kind === "object" && parsed.kind === "term") {
    return parsed.fullName;
  }
  return parsed.fullName;
}

/** The last line a call reaches, unknown for SemanticDB facts. */
export const UNKNOWN_EXTENT = Number.MAX_SAFE_INTEGER;
