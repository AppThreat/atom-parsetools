// Normalizations for comparing type strings written by TypeScript 6 and TypeScript 7.
//
// Each normalization has an id, a justification and examples, and the test suite
// (test-fixtures/typemap-diff-regression.js) checks that it equates the positive
// examples and keeps the negative ones apart. A normalization may only equate
// strings that name the same type. Anything that cannot be shown to be the same
// stays a difference and is reported.
//
// The canonical form is made by editing the string in place: it is split into spans at its own
// brackets, only the spans that a normalization reorders are moved and only the quote characters of
// string literals are rewritten, and every other character is kept as written. A normalizer that
// printed the string again from tokens changed the spelling of 15 percent of the corpus's real
// strings with every normalization switched off; this one is tested to change none.

export const NORMALIZATIONS = [
  {
    id: "union-order",
    description: "Members of a union are compared as a set, at any nesting depth.",
    justification:
      "TypeScript 7 orders union members by a stable key and TypeScript 6 by type id, so the same union prints in two orders. The members, and their count, are unchanged.",
    equal: [
      ['"ADMIN" | "USER"', '"USER" | "ADMIN"'],
      ["Promise<string | number>", "Promise<number | string>"],
      ["(z: boolean) => 1 | \"no\"", "(z: boolean) => \"no\" | 1"],
      ["Array<A | B>", "Array<B | A>"],
      ["(x: unknown) => x is B | A", "(x: unknown) => x is A | B"],
      ["[a: string, b?: B | A]", "[a: string, b?: A | B]"]
    ],
    different: [
      ['"ADMIN" | "USER"', '"ADMIN" | "OTHER"'],
      ["string | number", "string | number | boolean"],
      ["(a: string) => number", "(a: number) => string"],
      ["T extends P ? A : B | C", "C | T extends P ? A : B"],
      ["(x: unknown) => x is A | B", "(x: unknown) => B | x is A"],
      ["[a: string, b?: B | A]", "[a: string, A | b?: B]"]
    ]
  },
  {
    id: "object-member-order",
    description:
      "Property members of an object type are compared as a set, ordered by name. Call and construct signatures, and the overloads of one method, keep their order.",
    justification:
      "TypeScript 7 sorts property members of printed object types by a stable key. Overload order is meaningful in both versions, so signatures are not reordered, and members are sorted by name with a stable sort so that a method's overloads stay in order.",
    equal: [
      ["{ b: number; a: string; }", "{ a: string; b: number; }"],
      ["Promise<{ y: 1; x: 2; }>", "Promise<{ x: 2; y: 1; }>"]
    ],
    different: [
      ["{ a: string; }", "{ a: number; }"],
      ["{ (a: string): void; (a: number): void; }", "{ (a: number): void; (a: string): void; }"],
      ["{ foo(a: string): void; foo(a: number): void; }", "{ foo(a: number): void; foo(a: string): void; }"],
      ["{ a: string; }", "{ a: string; b: number; }"]
    ]
  },
  {
    id: "quote-style",
    description: "String literal types are compared by value, not by the quote character.",
    justification:
      "TypeScript 6 printed literal types with double quotes; TypeScript 7 keeps the quote style of the source text. The value is the same.",
    equal: [
      ["'a' | 'b'", '"a" | "b"'],
      ["{ k: 'v'; }", '{ k: "v"; }'],
      ["'it\\'s'", '"it\'s"']
    ],
    different: [
      ["'a'", '"b"'],
      ["'a'", "string"],
      ['"a  b"', '"a b"']
    ]
  },
  {
    id: "typeof-vs-signature",
    description: "`typeof name` in the baseline matches a function type in the candidate.",
    justification:
      "TypeScript 6 printed a JavaScript function as `typeof name`; TypeScript 7 prints its signature. Only a plain `typeof` of a name against a function type is equated, never against any other type, and when sources are available the name must occur in the source text of the node.",
    equal: [
      ["typeof setFromEuler", "(x: number) => void"],
      ["typeof a.b.c", "() => string"]
    ],
    different: [
      ["typeof setFromEuler", "string"],
      ["typeof setFromEuler", "{ a: 1; }"],
      ["typeof import(\"x\")", "(x: number) => void"]
    ]
  },
  {
    id: "typeof-require-alias",
    description:
      "`typeof name` in the baseline matches `typeof import(\"spec\")` in the candidate when the file binds name with `require(\"spec\")`.",
    justification:
      "TypeScript 6 named a required CommonJS module by the local name it was bound to; the native binary names it by its file. Both are the type of the same module object. Only applied with the source text, when the file has `name = require(\"spec\")` and the import path is that specifier (without extension).",
    equal: [],
    different: []
  },
  {
    id: "module-self",
    description:
      "`typeof module.exports` in the baseline matches `typeof import(\"./<this file>\")` in the candidate (also nested), in the file itself.",
    justification:
      "Both name the module object of the file the key is in: TypeScript 6 through `module.exports`, the native binary by the file's own specifier (`.` for an index file). Only applied with the file name, and only to the module the key is in.",
    equal: [],
    different: []
  },
  {
    id: "bom-shift",
    description: "In a file that starts with a byte order mark the candidate offset is the baseline offset plus one.",
    justification:
      "astgen 1.10.6 wrote type map keys without the byte order mark while Babel's node offsets count it, so keys and AST nodes do not join in such files. The native binary counts it. Applied by shifting candidate keys, only for files whose source starts with U+FEFF.",
    equal: [],
    different: []
  }
];

/**
 * Strings with the canonical form they must be written in (all three normalizations on). Asserting the
 * spelling itself, and not only that two spellings meet, keeps a respelling bug from passing: both sides
 * of a comparison would be spelled wrongly the same way.
 */
export const CANONICAL_FORMS = [
  ["Array<string>", "Array<string>"],
  ["Map<string, number>", "Map<string, number>"],
  ["A<B<C>>", "A<B<C>>"],
  ["Foo[]", "Foo[]"],
  ["[a, b]", "[a, b]"],
  ["(a: string, b: number) => void", "(a: string, b: number) => void"],
  ["new (x: string) => Foo", "new (x: string) => Foo"],
  ["{ (a: string): void; b: string; }", "{ (a: string): void; b: string; }"],
  ["{ z: number; (a: string): void; (a: number): void; b: string; }", "{ (a: string): void; (a: number): void; b: string; z: number; }"],
  ["Promise<'b' | 'a'>", 'Promise<"a" | "b">'],
  ["import(\"x\").Foo", "import(\"x\").Foo"],
  ["typeof f", "typeof f"],
  ["T extends U ? X : Y", "T extends U ? X : Y"],
  ["T extends (infer R)[] ? R : never", "T extends (infer R)[] ? R : never"],
  ["a & b | c", "a & b | c"],
  ["{}", "{}"],
  ["{ a: 'x' | 'y'; }", '{ a: "x" | "y"; }'],
  ["{ [k: string]: B | A; }", "{ [k: string]: A | B; }"],
  ["{ readonly a: 2 | 1; }", "{ readonly a: 1 | 2; }"],
  ["({ feature }: { feature: any; }) => boolean", "({ feature }: { feature: any; }) => boolean"],
  ["(x: B | A) => D | C", "(x: A | B) => C | D"],
  ["T extends string ? \"b\" | \"a\" : number", "T extends string ? \"b\" | \"a\" : number"],
  ["(x: unknown) => x is B | A", "(x: unknown) => x is A | B"],
  ["(x: unknown) => asserts x is B | A", "(x: unknown) => asserts x is A | B"],
  ["[a: string, b?: B | A]", "[a: string, b?: A | B]"],
  ["{ z(): void; foo(a: string): void; foo(a: number): void; }", "{ foo(a: string): void; foo(a: number): void; z(): void; }"],
  ['"a  b" | "c"', '"a  b" | "c"']
];

const OPENERS = { "(": ")", "<": ">", "[": "]", "{": "}" };
const CLOSERS = new Set([")", ">", "]", "}"]);

// Index of the end of the string literal that starts at i (the closing quote), or the last index.
function literalEnd(s, i) {
  const q = s[i];
  let j = i + 1;
  while (j < s.length && s[j] !== q) {
    if (s[j] === "\\") j++;
    j++;
  }
  return Math.min(j, s.length - 1);
}

function unquoteLiteral(raw) {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) out += body[++i];
    else out += body[i];
  }
  return out;
}

// Rewrites 'a' as "a" (keeping the value), and leaves "a" and `a` alone.
function requote(raw) {
  if (raw[0] !== "'") return raw;
  return JSON.stringify(unquoteLiteral(raw));
}

/**
 * Splits s at the top level (outside brackets and literals) at each character in `seps`, returning the
 * pieces and the separators between them, exactly as written. `=>` is not a separator for `>`.
 */
function splitTop(s, seps) {
  const parts = [];
  const between = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = literalEnd(s, i);
    } else if (c === "=" && s[i + 1] === ">") {
      i++;
    } else if (c in OPENERS) {
      depth++;
    } else if (CLOSERS.has(c)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && seps.includes(c)) {
      parts.push(s.slice(start, i));
      between.push(c);
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return { parts, between };
}

// The `=>` of a function type at the top level of s, or -1.
function topArrow(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = literalEnd(s, i);
    else if (c === "=" && s[i + 1] === ">" && depth === 0) return i;
    else if (c === "=" && s[i + 1] === ">") i++;
    else if (c in OPENERS) depth++;
    else if (CLOSERS.has(c)) depth = Math.max(0, depth - 1);
  }
  return -1;
}

// s with every character inside brackets or string literals replaced by a space, so that a regular
// expression only sees the top level.
function topLevelOnly(s) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const e = literalEnd(s, i);
      out += " ".repeat(e - i + 1);
      i = e;
    } else if (c === "=" && s[i + 1] === ">") {
      out += depth === 0 ? "=>" : "  ";
      i++;
    } else if (c in OPENERS) {
      out += depth === 0 ? c : " ";
      depth++;
    } else if (CLOSERS.has(c)) {
      depth = Math.max(0, depth - 1);
      out += depth === 0 ? c : " ";
    } else {
      out += depth === 0 ? c : " ";
    }
  }
  return out;
}

// A conditional type at the top level (`A extends B ? X : Y`). Its `?` and `:` bind more loosely than
// `|`, so its top level is never sorted as a union.
const isTopConditional = (s) => /(^|\s)extends\s/.test(topLevelOnly(s));

// The `x is` or `asserts x is` that starts a type predicate, or "".
const PREDICATE = /^\s*(?:asserts\s+)?(?:this|[A-Za-z_$][\w$]*)\s+is\s/;

/** Rewrites the groups inside s (bracketed spans and string literals) and returns s with them replaced. */
function rewriteInner(s, opts) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const e = literalEnd(s, i);
      const raw = s.slice(i, e + 1);
      out += opts.quotes && c === "'" ? requote(raw) : raw;
      i = e;
    } else if (c === "=" && s[i + 1] === ">") {
      out += "=>";
      i++;
    } else if (c in OPENERS) {
      // find the matching closer
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth > 0; j++) {
        const d = s[j];
        if (d === '"' || d === "'" || d === "`") j = literalEnd(s, j);
        else if (d === "=" && s[j + 1] === ">") j++;
        else if (d in OPENERS) depth++;
        else if (CLOSERS.has(d)) depth--;
      }
      const inner = s.slice(i + 1, j - 1);
      out += c + rewriteGroup(c, inner, opts) + (depth === 0 ? s[j - 1] : "");
      i = j - 1;
    } else {
      out += c;
    }
  }
  return out;
}

// Leading and trailing white space of a piece, kept as written.
function trimParts(p) {
  const lead = /^\s*/.exec(p)[0];
  const trail = /\s*$/.exec(p.slice(lead.length))[0];
  return [lead, p.slice(lead.length, p.length - trail.length), trail];
}

// Reorders the pieces of a union, keeping each piece's own spacing in its new place.
function sortPieces(pieces, between, sep) {
  const cores = pieces.map((p) => trimParts(p)[1]);
  const order = cores.map((c, i) => [c, i]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // the spacing around the separators stays where it was; only the cores move
  return pieces.map((p, i) => {
    const [lead, , trail] = trimParts(p);
    return lead + cores[order[i][1]] + trail;
  }).reduce((acc, p, i) => acc + p + (i < between.length ? sep : ""), "");
}

/** Normalizes the text between a pair of brackets. */
function rewriteGroup(open, inner, opts) {
  if (open === "{") return rewriteObjectBody(inner, opts);
  // type arguments, parameters, tuple elements: each comma separated piece is a type (or `name: type`)
  const { parts, between } = splitTop(inner, [","]);
  // parameters and labelled tuple elements are `name: type` like an object member; type arguments are plain types
  const pieces = parts.map((p) => (open === "(" || open === "[" ? rewriteMember(p, opts) : rewriteType(p, opts)));
  return pieces.reduce((acc, p, i) => acc + p + (i < between.length ? "," : ""), "");
}

/** A property or signature member list: `a: A; b: B;` */
function rewriteObjectBody(inner, opts) {
  const { parts, between } = splitTop(inner, [";", ","]);
  const members = parts.map((p) => rewriteMember(p, opts));
  if (opts.objectOrder) {
    // call, construct and index-signature-like members keep their place at the front, in order;
    // property members are sorted
    const nonEmpty = members.map((m, i) => ({ m, i, sep: between[i] ?? "" })).filter((x) => trimParts(x.m)[1] !== "");
    const isSignature = (m) => /^(\(|<|new\s*[(<])/.test(trimParts(m)[1]);
    const sigs = nonEmpty.filter((x) => isSignature(x.m));
    // by name, with a stable sort: the overloads of one method keep their order
    const props = nonEmpty.filter((x) => !isSignature(x.m)).sort((a, b) => {
      const x = memberName(a.m);
      const y = memberName(b.m);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const ordered = [...sigs, ...props];
    // keep the separators and the spacing of the slots as they were; move the member text only
    const slots = nonEmpty.map((x) => x);
    let out = "";
    let k = 0;
    for (let i = 0; i < members.length; i++) {
      if (trimParts(members[i])[1] === "") {
        out += members[i];
      } else {
        const [lead, , trail] = trimParts(members[i]);
        out += lead + trimParts(ordered[k++].m)[1] + trail;
      }
      if (i < between.length) out += between[i];
    }
    void slots;
    return out;
  }
  return members.reduce((acc, p, i) => acc + p + (i < between.length ? between[i] : ""), "");
}

// The name of a property or method member: `readonly a?: T` is `a`, `foo(x): T` is `foo`, `[k: K]: T`
// and `"q": T` are the bracketed or quoted name as written.
function memberName(m) {
  const core = trimParts(m)[1].replace(/^(readonly|get|set)\s+/, "");
  const q = core[0];
  if (q === '"' || q === "'" || q === "`") return core.slice(0, literalEnd(core, 0) + 1);
  if (q === "[") {
    const { parts } = splitTop(core, ["?", ":"]);
    return parts[0];
  }
  return /^[^?:(<\s]*/.exec(core)[0];
}

// `name: type` (also `name?: type`, `readonly name: type`, `[k: K]: type`): the colon after the name is
// not a union boundary; the type behind it can be a union.
function rewriteMember(member, opts) {
  const { parts, between } = splitTop(member, [":"]);
  if (between.length === 0) return rewriteType(member, opts);
  // a conditional type's colon is not a property colon
  if (/\s\?(\s|$)/.test(parts[0])) return rewriteType(member, opts);
  const head = rewriteInner(parts[0], opts);
  const rest = member.slice(parts[0].length + 1);
  return head + ":" + rewriteType(rest, opts);
}

/** Normalizes one type: a union is sorted, the pieces are normalized inside. */
function rewriteType(t, opts) {
  const pred = PREDICATE.exec(t);
  if (pred) return pred[0] + rewriteType(t.slice(pred[0].length), opts);
  const arrow = topArrow(t);
  // a conditional type's branches may hold a function type, so its `extends` is looked for before the arrow
  if (isTopConditional(arrow >= 0 ? t.slice(0, arrow) : t)) return rewriteInner(t, opts);
  if (arrow >= 0) {
    // function type: the parameters before the arrow keep their order; both sides are normalized inside
    return rewriteType(t.slice(0, arrow), opts, true) + "=>" + rewriteType(t.slice(arrow + 2), opts);
  }
  const { parts, between } = splitTop(t, ["|"]);
  const pieces = parts.map((p) => rewriteIntersection(p, opts));
  if (parts.length > 1 && opts.unionOrder) return sortPieces(pieces, between, "|");
  return pieces.reduce((acc, p, i) => acc + p + (i < between.length ? "|" : ""), "");
}

function rewriteIntersection(t, opts) {
  const { parts, between } = splitTop(t, ["&"]);
  return parts.map((p) => rewriteInner(p, opts)).reduce((acc, p, i) => acc + p + (i < between.length ? "&" : ""), "");
}

/** The canonical form of a type string with the given normalizations on (ids from NORMALIZATIONS). */
export function canon(s, ids) {
  const opts = {
    unionOrder: ids.includes("union-order"),
    objectOrder: ids.includes("object-member-order"),
    quotes: ids.includes("quote-style")
  };
  return collapseSpaces(rewriteType(s, opts));
}

// Runs of white space become one space, except inside string literals, where they are part of the value.
function collapseSpaces(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const e = literalEnd(s, i);
      out += s.slice(i, e + 1);
      i = e;
    } else if (/\s/.test(c)) {
      if (!out.endsWith(" ")) out += " ";
    } else {
      out += c;
    }
  }
  return out.trim();
}

/** The members of a union at the top level of s, trimmed (one member when s is not a union). */
export function topUnionMembers(s) {
  return splitTop(s, ["|"]).parts.map((p) => p.trim());
}

/**
 * s with the parentheses removed that wrap a whole function type in a type argument list or a
 * union position (`Meta<(<E>(a: E) => any)>`). Parentheses that change what a type means, such as
 * those before `[]`, are kept.
 */
export function stripFunctionParens(s) {
  let out = s;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== "(") continue;
      const before = out.slice(0, i).trimEnd();
      if (!(before === "" || /[<,|]$/.test(before))) continue;
      let depth = 0;
      let j = i;
      for (; j < out.length; j++) {
        const c = out[j];
        if (c === '"' || c === "'" || c === "`") j = literalEnd(out, j);
        else if (c === "=" && out[j + 1] === ">") j++;
        else if (c in OPENERS) depth++;
        else if (CLOSERS.has(c) && --depth === 0) break;
      }
      if (j >= out.length) break;
      const inner = out.slice(i + 1, j);
      const after = out.slice(j + 1).trimStart();
      if ((after === "" || /^[>,|]/.test(after)) && topArrow(inner) >= 0) {
        out = out.slice(0, i) + inner + out.slice(j + 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

const TYPEOF_NAME = /^typeof [A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function isFunctionType(s) {
  const arrow = topArrow(s);
  if (arrow < 1) return false;
  const head = s.slice(0, arrow).trim();
  const params = /^(new\s*|abstract\s+new\s*)?(<[^>]*>)?\s*\(/.test(head);
  return params && splitTop(s, ["|"]).parts.length === 1;
}

const TYPEOF_IMPORT_SPEC = /^typeof import\("([^"]+)"\)$/;
const stripExt = (spec) => spec.replace(/(\.d)?\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether `typeof name` and `typeof import("spec")` name the same module: the file binds name with
// require of that specifier (with or without the extension).
// How the native binary names the module of `file` from inside it: "./name", or "." for an index file.
function selfSpecifiers(file) {
  const base = file.split(/[\\/]/).pop().replace(/(\.d)?\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "");
  return base === "index" ? [".", "./index"] : [`./${base}`];
}

export function isRequireAlias(baseline, candidate, fileText) {
  const m = TYPEOF_NAME.exec(baseline);
  const imp = TYPEOF_IMPORT_SPEC.exec(candidate);
  if (!m || !imp || baseline.includes(".")) return false;
  const name = baseline.slice("typeof ".length);
  const re = new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(name)}\\s*=\\s*require\\(\\s*(['"])([^'"]+)\\1\\s*\\)`, "g");
  for (const r of fileText.matchAll(re)) {
    if (stripExt(r[2]) === stripExt(imp[1])) return true;
  }
  return false;
}

// Returns the list of normalization ids needed to make baseline and candidate equal,
// [] when they are already identical, or undefined when they differ.
export function equalAfterNormalization(baseline, candidate, ctx = {}) {
  if (baseline === candidate) return [];
  const sets = [
    ["quote-style"],
    ["union-order"],
    ["object-member-order"],
    ["union-order", "object-member-order"],
    ["quote-style", "union-order"],
    ["quote-style", "object-member-order"],
    ["quote-style", "union-order", "object-member-order"]
  ];
  // the smallest set that makes them equal is the one reported
  for (const ids of sets) {
    if (canon(baseline, ids) === canon(candidate, ids)) return ids;
  }
  if (ctx.fileText !== undefined && isRequireAlias(baseline, candidate, ctx.fileText)) return ["typeof-require-alias"];
  if (ctx.file !== undefined && baseline.includes("typeof module.exports")) {
    for (const self of selfSpecifiers(ctx.file)) {
      const b = baseline.split("typeof module.exports").join(`typeof import("${self}")`);
      if (b === candidate) return ["module-self"];
      for (const ids of sets) if (canon(b, ids) === canon(candidate, ids)) return ["module-self", ...ids];
    }
  }
  if (TYPEOF_NAME.test(baseline) && isFunctionType(candidate)) {
    const last = baseline.split(".").pop().replace("typeof ", "");
    if (ctx.nodeText === undefined || ctx.nodeText.includes(last)) return ["typeof-vs-signature"];
  }
  return undefined;
}
