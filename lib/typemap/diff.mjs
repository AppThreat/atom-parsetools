#!/usr/bin/env node
// Type map differ: compares two trees of <relative path>.typemap files per offset.
//
//   node lib/typemap/diff.mjs --baseline DIR --candidate DIR [--src DIR] [--allow FILE]
//        [--samples N] [--json FILE] [--min-agreement PCT] [--reference DIR]
//
// For every offset it reports exact, equal after normalization (which normalizations,
// see canon.mjs), different (with a difference class), baseline-only and candidate-only,
// grouped by node kind. With --src the node kind is read from the source file with the
// TypeScript 6 parser; without it kinds are "unknown". A class that is not on the
// allow-list fails the run (exit status 1), and "unclassified" can never be allow-listed.
//
// --reference names a second tree from the same astgen as the candidate's in TypeScript 6 mode (main
// with ASTGEN_TYPES=ts6). When the baseline is an older astgen, a difference no class names, where
// the candidate's answer equals that reference's for the same key, is `reference-agrees`: astgen's
// own TypeScript 6 path changed since the baseline (its compiler options, its programs per nested
// project), and the native engine agrees with it.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { canon, equalAfterNormalization, stripFunctionParens, topUnionMembers } from "./canon.mjs";

const require = createRequire(import.meta.url);
let tsc;
function loadTsc() {
  if (!tsc) {
    tsc = require("@typescript/typescript6");
  }
  return tsc;
}


// Whether every difference between two strings is the name of a type parameter: the token skeleton
// (everything that is not an identifier) is identical and each differing identifier is a single
// upper case name, optionally with the numeric suffix TypeScript 6 gives a shadowed parameter.
function typeParameterNamesOnly(b, c) {
  const tok = (x) => x.match(/[A-Za-z_$][\w$]*|[^A-Za-z_$]+/g) ?? [];
  const tb = tok(b);
  const tc = tok(c);
  if (tb.length !== tc.length) return false;
  for (let i = 0; i < tb.length; i++) {
    const isId = (t) => /^[A-Za-z_$][\w$]*$/.test(t);
    if (isId(tb[i]) && isId(tc[i])) {
      if (tb[i] === tc[i]) continue;
      // a type parameter as checkers name them: `T`, `R2`, `TResult`, each optionally with the
      // shadow suffix `_1`; or the same name on both sides apart from that suffix
      const param = (t) => TYPE_PARAMETER_NAME.test(t);
      const shadowOf = (x, y) => x.replace(/_\d+$/, "") === y.replace(/_\d+$/, "");
      if (!(param(tb[i]) && param(tc[i])) && !shadowOf(tb[i], tc[i])) return false;
    } else if (tb[i] !== tc[i]) return false;
  }
  return b !== c;
}

// What a checker writes when it has no better answer: a fallback keyword, or an empty or
// exports-only object. Real primitives are answers, not fallbacks.
const FALLBACK_ANSWER = /^(undefined|any|unknown|never|void|this|\{\}|\{ exports: (any|unknown); \})$/;
const isFallback = (x) => FALLBACK_ANSWER.test(x.trim());
// A lone literal, or a single primitive keyword
const BARE_ANSWER = /^(boolean|string|number|object|symbol|bigint|null|-?\d+(\.\d+)?|true|false)$/;
const isLiteralAnswer = (x) => BARE_ANSWER.test(x.trim());

// Both signatures have exactly one parameter named `predicate` (a find/filter style API); the
// comparison then runs on the parameter's union.
function predicateParameters(b, c) {
  const sig = /\(predicate: (.+)\) =>/.exec(b)?.[1];
  const sigC = /\(predicate: (.+)\) =>/.exec(c)?.[1];
  return sig && sigC ? [sig, sigC] : null;
}

// Whether two member types differ only in a way a class names: the pair is classified on its own,
// without the node's context (the difference is inside a type, not at a node), a few levels deep.
function memberDifferenceNamed(v, w, ctx = {}) {
  const depth = (ctx.depth ?? 0) + 1;
  if (depth > 3) return false;
  const all = ["union-order", "object-member-order", "quote-style"];
  if (canon(v, all) === canon(w, all)) return true;
  return classifyDifference(v, w, { externalNames: ctx.externalNames, noNodeModules: ctx.noNodeModules, depth }) !== "unclassified";
}

// The members of an object type by name (canon already ordered them): equal when the same members
// are present and every member whose type differs differs in a way a class names.
function oneMemberDiffers(b, c, ctx) {
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const mb = objectMembers(b);
  const mc = objectMembers(c);
  if (!mb || !mc || mb.size !== mc.size || mb.size < 1) return false;
  let differing = 0;
  for (const [k, v] of mb) {
    if (!mc.has(k)) return false;
    if (mc.get(k) !== v) {
      if (!memberDifferenceNamed(v, mc.get(k), ctx)) return false;
      differing++;
    }
  }
  return differing >= 1;
}


// The inner type of one outer generic wrapper `Name<...>`, or the string unchanged.
function innerOf(s) {
  const m = /^([A-Za-z_$][\w$.]*)</.exec(s.trim());
  if (!m) return s;
  let depth = 0;
  for (let k = m[0].length - 1; k < s.length; k++) {
    if (s[k] === "<") depth++;
    else if (s[k] === ">" && s[k - 1] !== "=") {
      depth--;
      if (depth === 0) return s.slice(m[0].length, k) + s.slice(k + 1);
    }
  }
  return s;
}

// The candidate writes the baseline's element as a union of the precise branches: after stripping
// one matching outer wrapper from both, every member of the candidate's union is the baseline with
// an `any` replaced by a type (or with fewer `any`).
function unionOfRefinements(b, c) {
  let bb = b;
  let cc = c;
  const hb = /^([A-Za-z_$][\w$.]*)</.exec(bb.trim());
  const hc = /^([A-Za-z_$][\w$.]*)</.exec(cc.trim());
  if (hb && hc && hb[1] === hc[1]) {
    bb = innerOf(bb);
    cc = innerOf(cc);
  }
  const members = topUnionMembers(cc);
  if (members.length < 2 || topUnionMembers(bb).length >= members.length) return false;
  const target = stripFunctionParens(bb);
  return members.every((m) => refinesAny(target, stripFunctionParens(m)) || fewerAny(target, stripFunctionParens(m)));
}

// Two unions with the same member count where every pair is equal except object members (the
// instantiated attributes of a model, say), each differing pair in a way a class names.
function unionMemberInstantiated(b, c, ctx) {
  const nb = topUnionMembers(b);
  const nc = topUnionMembers(c);
  if (nb.length !== nc.length || nb.length < 2) return false;
  // members written on both sides are matched first, in any order; what is left must be object
  // members, paired in their order, each pair differing in a way a class names
  const restC = [...nc];
  const restB = [];
  for (const m of nb) {
    const i = restC.indexOf(m);
    if (i >= 0) restC.splice(i, 1);
    else restB.push(m);
  }
  if (restB.length === 0 || restB.length !== restC.length) return false;
  return restB.every((m, i) => m.startsWith("{") && restC[i].startsWith("{") && memberDifferenceNamed(m, restC[i], ctx));
}

// The member names of an object type, in order.
function objectMemberNames(x) {
  const inner = x.trim().replace(/^\{/, "").replace(/\;? \}$/, "");
  return inner.split("; ").map((m) => m.slice(0, m.indexOf(": ")).trim());
}

// The baseline object type's members are a subset of the candidate's by name, the shared members
// equal, and the candidate has at most six more.
function objectMemberSuperset(b, c) {
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const mb = objectMembers(b);
  const mc = objectMembers(c);
  if (!mb || !mc || mb.size >= mc.size) return false;
  for (const [k, v] of mb) {
    if (!mc.has(k) || mc.get(k) !== v) return false;
  }
  return mc.size - mb.size <= 6;
}

// A lone word, or a generic of lone words: what TypeScript 6 writes when it answers with the
// declared default or the widened primitive.
const DEFAULTED = /^(void|undefined|any|unknown|never|boolean|number|string|object|[A-Za-z_$][\w$.]*)$/;
const DEFAULTED_GENERIC = /^[A-Za-z_$][\w$.]*<(void|undefined|any|unknown|never|boolean|number|string|[A-Za-z_$][\w$.]*)(, (void|undefined|any|unknown|never|boolean|number|string|[A-Za-z_$][\w$.]*))*>$/;
const isDefaultedAnswer = (x) => DEFAULTED.test(x.trim()) || DEFAULTED_GENERIC.test(x.trim());

// A bare primitive answer, or a generic of bare primitives
const BARE_PRIMITIVE = /^(void|undefined|any|unknown|never|boolean|number|string|object|symbol|bigint|null)$/;
const defaultedAnswer = (x) =>
  BARE_PRIMITIVE.test(x.trim()) ||
  new RegExp(`^[A-Za-z_$][\\w$.]*<(${BARE_PRIMITIVE.source.slice(2, -2)})(, (void|undefined|any|unknown|never|boolean|number|string|object|symbol|bigint))?>$`).test(x.trim());
// An answer that names a type: a structure, an import, a union, or a capitalized name
const resolvedAnswer = (x) => x.includes('import("') || x.trim().startsWith("{") || x.includes("|") || x.includes("=>") || /^[A-Z]/.test(x.trim());

// zod's compat aliases carry a `$` the re-export drops
const dollarCompat = (x) => x.replace(/\$([A-Z]\w*)/g, "$1");
// `typeof X<...>` with the instantiation dropped
const typeofPlain = (x) =>
  x.replace(/typeof (import\("[^"]*"\)\.)?([A-Za-z_$][\w$.]*)<[^<>()>]*>/g, "typeof $1$2");


// A bare keyword answer
const BARE_KEYWORD_ANSWER = /^(void|undefined|any|unknown|never|boolean|number|string|object|symbol|bigint)$/;

// One side's call signatures are the other's plus one extra, in order.
// A lone call signature written as an arrow (`(text: string) => any`) as a one-member signature set
// (`{ (text: string): any; }`), so it compares with an overload set; anything else as it is.
function asSignatureSet(x) {
  const t = x.trim();
  if (t.startsWith("{")) return t;
  const m = /^(<[^()]*>)?\(/.exec(t);
  if (!m) return t;
  let depth = 0;
  for (let i = m[0].length - 1; i < t.length; i++) {
    const ch = t[i];
    if ("([{<".includes(ch)) depth++;
    else if (")]}>".includes(ch) && !(ch === ">" && t[i - 1] === "=")) depth--;
    if (depth === 0) {
      if (!t.startsWith(" => ", i + 1)) return t;
      return `{ ${t.slice(0, i + 1)}: ${t.slice(i + 5)}; }`;
    }
  }
  return t;
}

function overloadsAdded(b, c) {
  b = asSignatureSet(b);
  c = asSignatureSet(c);
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const sigs = (x) => splitMembers(x).filter((m) => m.startsWith("(") || m.startsWith("<"));
  const sb = sigs(b);
  const sc = sigs(c);
  if (sb.length === sc.length || Math.abs(sb.length - sc.length) !== 1) return false;
  const [short, long] = sb.length < sc.length ? [sb, sc] : [sc, sb];
  let i = 0;
  for (const m of long) {
    if (i < short.length && short[i] === m) i++;
  }
  return i === short.length;
}

// The members of an object type's body, split at the top level only (a nested object's own `;`
// separators are not member boundaries).
function splitMembers(x) {
  const inner = x.trim().replace(/^\{ ?/, "").replace(/;? ?\}$/, "");
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === "\\") i++;
        i++;
      }
    } else if ("([{".includes(ch) || (ch === "<" && inner[i + 1] !== "=")) depth++;
    // the `>` of an arrow `=>` closes nothing
    else if (")]}".includes(ch) || (ch === ">" && inner[i - 1] !== "=")) depth--;
    else if ((ch === ";" || ch === ",") && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((m) => m.trim()).filter(Boolean);
}

// An object type's members as a name-to-type map, `readonly` and `?` aside.
function objectMembers(x) {
  const out = new Map();
  for (const m of splitMembers(x)) {
    const i = m.indexOf(": ");
    if (i < 0) return null;
    out.set(m.slice(0, i).trim().replace(/^readonly /, ""), m.slice(i + 2));
  }
  return out;
}


// A union written with its own alias as an extra first member
function aliasPrefixedUnion(b, c) {
  const lone = (m) => /^[A-Za-z_$][\w$.]*(<.*>)?$/.test(m.trim());
  const nb = topUnionMembers(b);
  const nc = topUnionMembers(c);
  if (nb.length < 1 || nc.length !== nb.length + 1) return false;
  const extra = nc.filter((m) => lone(m) && !nb.includes(m));
  if (extra.length !== 1) return false;
  const rest = nc.filter((m) => m !== extra[0]);
  return rest.length === nb.length && rest.every((m, i) => m === nb[i]);
}


// A mapped record written keyed by the enum's members (`[UnfurlResourceType.URL]:`) on one side and
// by its values (`url:`) on the other, the same number of members.
function enumKeyedRecord(b, c) {
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const enumKeyed = (x) => splitMembers(x).filter((m) => /^\[[A-Za-z_$][\w$.]*\.[A-Za-z_$][\w$.]*\]/.test(m)).length;
  const plainKeyed = (x) => splitMembers(x).filter((m) => /^[A-Za-z_$][\w$]*\??:/.test(m)).length;
  const be = enumKeyed(b) + enumKeyed(c);
  if (be < 2 || !(enumKeyed(b) === 0 || enumKeyed(c) === 0)) return false;
  return Math.abs(plainKeyed(b) + enumKeyed(b) - (plainKeyed(c) + enumKeyed(c))) === 0;
}

// Whether a source file is a minifier's output: lines averaging over 300 characters, or lines over
// 120 characters in a file where more than a fifth of the identifiers are one or two characters long (an Angular or
// esbuild chunk keeps a line per statement group, so the line length alone misses it).
export function looksMinified(text) {
  const lines = text.split("\n").length;
  const avg = text.length / lines;
  if (avg > 300) return true;
  if (avg <= 120) return false;
  const ids = text.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [];
  if (ids.length < 200) return false;
  // hand-written source in the corpus stays under 0.15, bundler chunks start above 0.25
  return ids.filter((x) => x.length <= 2).length / ids.length > 0.2;
}

// A type parameter as checkers name it: `T`, `R2`, `TResult`, or any name with the shadow suffix
// TypeScript 6 gives a type parameter (`InitializeRet_1`).
const TYPE_PARAMETER_NAME = /^([A-Z]\d*|T[A-Z][A-Za-z\d]*)(_\d+)?$|^[A-Z][\w$]*_\d+$/;

// Whether the two strings differ only in identifiers where the baseline has a type parameter and the
// candidate a capitalized type name: the declaration's parameters against the arguments or defaults
// they were instantiated with, anywhere in the type.
function parametersInstantiated(b, c) {
  const tok = (x) => x.match(/[A-Za-z_$][\w$]*|[^A-Za-z_$]+/g) ?? [];
  const tb = tok(b);
  const tc = tok(c);
  if (tb.length !== tc.length || b === c) return false;
  const isId = (t) => /^[A-Za-z_$][\w$]*$/.test(t);
  for (let i = 0; i < tb.length; i++) {
    if (tb[i] === tc[i]) continue;
    if (!(isId(tb[i]) && isId(tc[i]))) return false;
    if (!TYPE_PARAMETER_NAME.test(tb[i]) || !/^[A-Z]/.test(tc[i])) return false;
  }
  return true;
}

// The arguments of one generic reference `Name<a, b>` split at the top level, or null when the
// string is not a single such reference.
function genericArguments(s) {
  const t = s.trim();
  // a head is a name, or a type reached through its module: import("ai").ToolApprovalRequestOutput<...>
  const m = /^([A-Za-z_$][\w$.]*|import\("[^"]*"\)(?:\.[\w$]+)*)</.exec(t);
  if (!m || !t.endsWith(">")) return null;
  const inner = t.slice(m[0].length, -1);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      i++;
      while (i < inner.length && inner[i] !== q) {
        if (inner[i] === "\\") i++;
        i++;
      }
    } else if ("([{".includes(ch) || (ch === "<" && inner[i - 1] !== "=")) depth++;
    else if (")]}".includes(ch) || (ch === ">" && inner[i - 1] !== "=")) {
      depth--;
      if (depth < 0) return null; // the reference closed before the end: `A<x> | B<y>`
    } else if (ch === "," && depth === 0) {
      out.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(inner.slice(start).trim());
  return { head: m[1], args: out };
}

// ---- difference classes, in the order they are tried ----

// An import("...") path cut down to the module it names: its last segment without an extension, or the
// directory for an index file. Two paths that reach the same package entry or module this way differ
// only in how the version resolved it; a different module is never equated.
const IMPORT_RE = /import\("([^"]*)"\)/g;
const moduleOf = (spec) => {
  let segs = spec.replace(/\\/g, "/").replace(/(\.d)?\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, "").split("/").filter(Boolean);
  // a path through node_modules names the package after the last such segment
  const nm = segs.lastIndexOf("node_modules");
  if (nm >= 0) segs = segs.slice(nm + 1);
  while (segs.length > 1 && (segs[segs.length - 1] === "index" || /^(dist|lib|src|esm|cjs|commonjs|types|build)$/.test(segs[segs.length - 1]))) segs.pop();
  return segs.pop() ?? "";
};
const stripImports = (s) => s.replace(IMPORT_RE, (_, spec) => `import("${moduleOf(spec)}")`);

const PARAM_LIST = /^[A-Za-z_$][\w$.]*<[A-Z]\w*(, [A-Z]\w*)*>$/;
const refHead = (s) => /^([A-Za-z_$][\w$.]*)</.exec(s)?.[1];
const hasAny = (s) => /\bany\b/.test(s);

// The same array type printed `T[]` by one checker and `Array<T>` by the other: every trailing
// bracket pair is rewritten into the generic form, innermost elements first, one nesting level of
// brackets inside the element at a time. Only used to recognise a difference: the test is equality
// of the whole rewritten strings, so a pair the rules cannot rewrite simply stays unclassified.
export function arrayForm(s) {
  let out = s;
  for (let guard = 0; guard < 200; guard++) {
    const next = out
      .replace(/([A-Za-z_$][\w$.]*|"[^"]*"|'[^']*')\[\]/g, "Array<$1>")
      .replace(/\(([^()]*)\)\[\]/g, "Array<$1>")
      .replace(/\(((?:[^()]|\([^()]*\))*)\)\[\]/g, "Array<$1>")
      .replace(/([A-Za-z_$][\w$.]*)<([^<>]*)>\[\]/g, "Array<$1<$2>>")
      .replace(/([A-Za-z_$][\w$.]*)<((?:[^<>]|<[^<>]*>)*)>\[\]/g, "Array<$1<$2>>")
      .replace(/\[([^\[\]]*)\]\[\]/g, "Array<[$1]>");
    if (next === out) break;
    out = next;
  }
  return out;
}

// A union with a member written twice (TypeScript 6 printed a duplicate the printer of 7 collapses):
// the members as a set, in their written order.
const dedupeUnion = (s) => {
  const parts = topUnionMembers(s);
  if (parts.length < 2) return s;
  const seen = new Set();
  const kept = parts.filter((m) => (seen.has(m) ? false : (seen.add(m), true)));
  return kept.length === parts.length ? s : kept.join(" | ");
};

// Whether every member of `narrow` also appears in `wide` (both unions, as sets)
const unionSubset = (narrow, wide) => {
  const n = new Set(topUnionMembers(narrow));
  const w = new Set(topUnionMembers(wide));
  return n.size < w.size && [...n].every((m) => w.has(m));
};

// `import("path").Name` cut to `Name`: the same symbol reached through its declaring file on one
// side and by the local name on the other.
const unqualifiedImports = (s) => s.replace(/import\("[^"]*"\)\.([A-Za-z_$][\w$.]*)/g, "$1");

// `Record<K, V>` written as an index signature `{ [x: K]: V; }` (a simple key: string, number, or
// their union): both sides in the index-signature form.
const indexSignatures = (s) => {
  let out = s;
  for (let guard = 0; guard < 50; guard++) {
    const i = out.indexOf("Record<");
    if (i < 0) break;
    let depth = 1; // inside the `<` of Record<
    let split = -1;
    let end = -1;
    for (let k = i + "Record<".length; k < out.length; k++) {
      const ch = out[k];
      const opens = "([{".includes(ch) || (ch === "<" && out[k + 1] !== "=");
      const closes = ")]}".includes(ch) || (ch === ">" && out[k - 1] !== "=");
      if (opens) depth++;
      else if (closes) {
        depth--;
        if (depth === 0) {
          end = k;
          break;
        }
      } else if (ch === "," && depth === 1 && split < 0) split = k;
    }
    if (end < 0 || split < 0) return s; // no top-level comma: not a two-argument Record
    const key = out.slice(i + "Record<".length, split).trim();
    if (!/^(string|number)( \\| (string|number))?$/.test(key)) return s;
    out = out.slice(0, i) + `{ [x: ${key}]: ${out.slice(split + 1, end).trim()}; }` + out.slice(end + 1);
  }
  return out;
};
// T_1 for a shadowed type parameter: an upper case name, as type parameters are written
const SHADOWED = /\b([A-Z][\w$]*)_\d+\b/g;
const HAS_SHADOWED = /\b[A-Z][\w$]*_\d+\b/;
const stripShadowSuffix = (s) => s.replace(SHADOWED, "$1");
// `| undefined` as the last member of the whole type or of an optional member's type
const stripOptionalUndefined = (s) => {
  const top = topUnionMembers(s);
  const whole = top.length > 1 && top.includes("undefined") ? top.filter((m) => m !== "undefined").join(" | ") : s;
  return whole.replace(/(\?: [^;{}]*?) \| undefined(?=;)/g, "$1");
};
const TYPEOF_VALUE = /^typeof (import\("[^"]*"\)|[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*)$/;
const TYPEOF_IMPORT = /^typeof import\("[^"]*"\)$/;
const hasDeferred = (s) => / extends infer /.test(s) || /\[P in /.test(s) || /\bextends\b.*\?.*:/.test(s);

// Whether `precise` is `general` with some `any` replaced by other types: every `any` of `general` is a
// hole that matches a balanced piece of `precise`, the rest must be equal, and at least one hole is not `any`.
export function refinesAny(general, precise, word = "any") {
  const re = new RegExp(`\\b${word}\\b`);
  if (general === precise || !re.test(general)) return false;
  const parts = general.split(new RegExp(`\\b${word}\\b`));
  if (parts.length > 9) {
    // A compiled bundle can carry dozens of `any` in one type (an AI SDK tool table). The
    // backtracking match below is too dear there, so the parts are matched in order without
    // backtracking: every part of `general` must occur in `precise` exactly and in order, and the
    // pieces between them (the holes) must be balanced. That is the same contract, decided greedily;
    // a pair only the backtracking match could line up stays unclassified.
    const holes = [];
    let at = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const found = precise.indexOf(parts[pi], at);
      if (found < 0) return false;
      if (pi === 0 && parts[0] !== "" && found !== 0) return false;
      if (pi < parts.length - 1) {
        const hole = precise.slice(at, found);
        if (pi === 0 && hole !== "") return false;
        let depth = 0;
        for (const ch of hole) {
          if ("(<[{".includes(ch)) depth++;
          else if (")>]}".includes(ch)) depth--;
          if (depth < 0) return false;
        }
        if (depth !== 0) return false;
        holes.push(hole);
      } else if (found + parts[pi].length !== precise.length) return false;
      at = found + parts[pi].length;
    }
    return holes.some((h) => h.trim() !== word);
  }
  const holes = [];
  const match = (pi, at) => {
    if (pi === parts.length - 1) return precise.slice(at) === parts[pi] ? true : false;
    if (!precise.startsWith(parts[pi], at)) return false;
    let i = at + parts[pi].length;
    let depth = 0;
    for (let j = i; j < precise.length; j++) {
      const ch = precise[j];
      if ("(<[{".includes(ch)) depth++;
      else if (")>]}".includes(ch)) {
        if (depth === 0) {
          if (j > i) {
            holes.push(precise.slice(i, j));
            if (match(pi + 1, j)) return true;
            holes.pop();
          }
          return false;
        }
        depth--;
      }
      if (depth === 0 && j + 1 > i) {
        holes.push(precise.slice(i, j + 1));
        if (match(pi + 1, j + 1)) return true;
        holes.pop();
      }
    }
    return false;
  };
  return match(0, 0) && holes.some((h) => h.trim() !== word);
}

const words = (s) => new Set(s.match(/[A-Za-z_$][\w$]*/g) ?? []);
const countAny = (s) => (s.match(/\bany\b/g) ?? []).length;

// The candidate has fewer `any` than the baseline and keeps every other name the baseline uses: a more
// precise type, in a shape refinesAny cannot line up (an `any` became a union, say).
function fewerAny(b, c) {
  if (countAny(c) >= countAny(b)) return false;
  const cw = words(c);
  return [...words(b)].every((w) => w === "any" || cw.has(w));
}

// s with every Readonly<...> wrapper removed (balanced)
function stripReadonly(s) {
  let out = s;
  for (let i = out.indexOf("Readonly<"); i >= 0; i = out.indexOf("Readonly<")) {
    let depth = 0;
    let j = i + "Readonly".length;
    for (; j < out.length; j++) {
      if (out[j] === "<") depth++;
      else if (out[j] === ">" && --depth === 0) break;
    }
    if (j >= out.length) return out;
    out = out.slice(0, i) + out.slice(i + "Readonly<".length, j) + out.slice(j + 1);
  }
  return out;
}

// `readonly` modifiers and Readonly<...> wrappers removed
const stripReadonlyAll = (s) => stripReadonly(s).replace(/\breadonly /g, "");

// `name(args): R;` written as the property `name: (args) => R;`
const methodsAsProperties = (s) => s.replace(/([{;]\s*)([A-Za-z_$][\w$]*)(\??)(\([^()]*\)): ([^;{}]+);/g, "$1$2$3: $4 => $5;");

// every qualified name cut down to its last segment
const qualifierDropped = (s) => s.replace(/\b(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)\b/g, "$1");

// a.b.c.D cut down to a.D: the same declaration reached through another namespace path
const qualifierEnds = (s) => s.replace(/\b([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)+\.([A-Za-z_$][\w$]*)\b/g, "$1.$2");

// the member names of every object type replaced by one placeholder, the members then sorted: an object
// keyed by enum members written as `[Enum.Member]` on one side and by their values on the other
function anonymizedMembers(s) {
  const t = s.replace(/(^|[{;]\s*)(?:readonly\s+)?(?:\[[A-Za-z_$][\w$.]*\]|"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)(\??:)/g, "$1_$2");
  return t.replace(/\{([^{}]*)\}/g, (_, body) => `{${body.split(";").map((m) => m.trim()).filter(Boolean).sort().join("; ")}}`);
}

// parameter names replaced by one placeholder: `(maxLength: number)` and `(targetLength: number)` meet
const anonymizeParams = (s) => s.replace(/([(,]\s*(?:\.\.\.)?)[A-Za-z_$][\w$]*(\??:)/g, "$1_$2");

/** Names a file imports from a package (not a relative path or an alias such as @/). */
export function externalImportNames(text) {
  const names = new Set();
  const re = /import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+)(\s*,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mod = m[3];
    if (mod.startsWith(".") || mod.startsWith("@/") || mod.startsWith("~/") || mod.startsWith("#")) continue;
    for (const n of (m[1] + (m[2] ?? "")).match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (n !== "type" && n !== "as") names.add(n);
    }
  }
  const req = /(?:const|let|var)\s+(\{[^}]*\}|\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = req.exec(text)) !== null) {
    if (m[2].startsWith(".")) continue;
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(n);
  }
  return names;
}

/**
 * Classifiers are tried in order; the first that fires names the class. ctx = { nodeText?,
 * externalNames?, noNodeModules? }. A classifier must not claim two types are the same; it only
 * names a recognised kind of difference. Whether a class is acceptable is the allow-list's call.
 */
export const DIFFERENCE_CLASSIFIERS = [
  {
    id: "same-offset-neighbor",
    description:
      "The key is shared by nested nodes that start at one offset (`profile.username === user?.username` and `profile`), and the candidate's own .typespans give another of them the baseline's type, or a type that differs from it in a way a class names: the engines differ only in which node the start-offset map kept. chen reads the .typespans of a native run, so it sees each node's own type.",
    test: (b, c, ctx = {}) => {
      const n = ctx.neighbors ?? [];
      if (n.length < 2) return false;
      const all = ["union-order", "object-member-order", "quote-style"];
      const cb = canon(b, all);
      const cc = canon(c, all);
      if (!n.some((v) => canon(v, all) === cc)) return false;
      // the baseline's type is the candidate's for another of the nodes, or differs from it in a way
      // a class names (a module's structure against `typeof import("./config")`)
      return n.some((v) => canon(v, all) !== cc && (canon(v, all) === cb || memberDifferenceNamed(b, v, ctx)));
    }
  },
  {
    id: "import-specifier",
    description: "The same type with a different import(\"...\") path.",
    test: (b, c) => b.includes('import("') && b !== c && stripImports(b) === stripImports(c)
  },
  {
    id: "import-wrapped-name",
    description:
      "The same name, written through its declaring file on one side (`import(\"../lib/cli/cliOptions\").OptionsWarning[]`) and plain on the other: TypeScript 7 resolves a JSDoc type reference in JavaScript to the file it came from and prints the path.",
    test: (b, c) =>
      (b.includes('import("') && !c.includes('import("') && (unqualifiedImports(b) === c || qualifierDropped(unqualifiedImports(b)) === qualifierDropped(c))) ||
      (c.includes('import("') && !b.includes('import("') && (unqualifiedImports(c) === b || qualifierDropped(unqualifiedImports(c)) === qualifierDropped(b)))
  },
  {
    id: "reexported-entry-point",
    description:
      "The same name through a different package entry (`import(\"playwright-core\").Locator` against `import(\"@playwright/test\").Locator`): one engine reached the type through a re-export shim.",
    test: (b, c) => b !== c && b.includes('import("') && c.includes('import("') && unqualifiedImports(b) === unqualifiedImports(c)
  },
  {
    id: "dollar-alias",
    description: "Equal apart from the `$` of a compatibility alias (`zod_1.z.core.$RefinementCtx` against `zod_1.RefinementCtx`) and the namespace path to it.",
    test: (b, c) => b !== c && b.includes("$") !== c.includes("$") && (dollarCompat(b) === dollarCompat(c) || qualifierDropped(dollarCompat(b)) === qualifierDropped(dollarCompat(c)) || qualifierEnds(dollarCompat(b)) === qualifierEnds(dollarCompat(c)))
  },
  {
    id: "typeof-instantiated",
    description: "`typeof X` against `typeof X<arguments>`: one engine kept the generic reference in the typeof, the other instantiated it.",
    test: (b, c) => b !== c && b.includes("typeof ") && c.includes("typeof ") && typeofPlain(b) === typeofPlain(c)
  },
  {
    id: "generic-instantiated-to-unknown",
    description: "TypeScript 7 evaluated `InstanceType<P>` of an unresolved parameter to `unknown` where TypeScript 6 kept the reference.",
    test: (b, c) => {
      // `unknown | null` is `unknown`: the evaluated parameter absorbs the rest of its union
      const evaluated = (x) => x.replace(/InstanceType<[^<>]*>/g, "unknown").replace(/\bunknown \| null\b|\bnull \| unknown\b/g, "unknown");
      return (b.includes("InstanceType<") && evaluated(b) === c) || (c.includes("InstanceType<") && evaluated(c) === b);
    }
  },
  {
    id: "indexed-access-evaluated",
    description: "An indexed access one engine kept (`RouteMapGeneric[Name][\"params\"]`) and the other evaluated to its members.",
    test: (b, c) => /\]\"\[|\]\[/.test(b) !== /\]\"\[|\]\[/.test(c) && (/\]\[/.test(b) ? c.startsWith("{") || c.startsWith("Array<") : b.startsWith("{") || b.startsWith("Array<"))
  },
  {
    id: "return-literal-narrowed",
    description: "A function type whose `boolean` return one engine narrowed to its literal (`() => boolean` against `() => true`).",
    test: (b, c) => c.replace(/=> (true|false)\b/g, "=> boolean") === b || b.replace(/=> (true|false)\b/g, "=> boolean") === c
  },
  {
    id: "union-of-refinements",
    description:
      "The candidate writes the baseline's type as a union of precise branches (`Promise<any>` against `Promise<Array<any>> | Promise<void | ComplaintModel>`): every member is the baseline with an `any` replaced.",
    test: (b, c) => unionOfRefinements(b, c)
  },
  {
    id: "union-member-instantiated",
    description:
      "The same union members apart from object members that are the instantiated attributes of a model (a find predicate's partial, typed from the outer generic by TypeScript 6 and from the concrete model by TypeScript 7).",
    test: (b, c, ctx) => unionMemberInstantiated(b, c, ctx)
  },
  {
    id: "object-member-superset",
    description:
      "The candidate's object type has the baseline's members and a few more (an intersection TypeScript 7 resolved further: the base model's `deletedAt` and `archivedAt`). Never the other way round: members the candidate lost stay unclassified.",
    test: (b, c) => objectMemberSuperset(b, c)
  },
  {
    id: "shadowed-type-parameter-name",
    description: "Equal apart from the suffix TypeScript 6 adds to a shadowed type parameter (T_1).",
    test: (b, c) => b !== c && HAS_SHADOWED.test(b) && !HAS_SHADOWED.test(c) && stripShadowSuffix(b) === c
  },
  {
    id: "type-parameter-name",
    description:
      "Equal apart from the name of a type parameter (`Promise<T_1>` against `Promise<R>`, `TypedPropertyDescriptor<T>` against `TypedPropertyDescriptor<F>`): the checkers name the parameter differently, one with the numeric suffix of a shadowed parameter or another scope's name. Both names must be written as type parameters are (a capital letter with optional digits, a `T`-prefixed name, or one name and the same name with a shadow suffix), so `Promise<User>` against `Promise<Order>` is not equated.",
    test: (b, c) => typeParameterNamesOnly(b, c)
  },
  {
    id: "type-parameter-instantiated",
    description:
      "Equal apart from type parameters the baseline writes by name and the candidate instantiates with a type (`FormGroup<TControl>` against `FormGroup<AuthForm>`, `{ type: T; ... }` against `{ type: Hook; ... }`), anywhere in the type. Never the other way round.",
    test: (b, c) => parametersInstantiated(b, c)
  },
  {
    id: "declaration-type-parameter-spelling",
    description:
      "The same generic reference whose type arguments are lone names on both sides, every differing name one the same file's own declarations introduce (a type parameter, its constraint or its default: `Authenticator<InitializeRet, AuthenticateRet, AuthorizeRet, AuthorizeOptions>` against `Authenticator<X, Y, Z, AuthenticateOptions>` in a declaration file the project vendors, which spells the reference both ways): each engine printed the spelling it resolved. Needs --src.",
    test: (b, c, ctx = {}) => {
      const params = ctx.typeParameters;
      if (!params || params.size === 0) return false;
      const gb = genericArguments(b);
      const gc = genericArguments(c);
      if (!gb || !gc || gb.head !== gc.head || gb.args.length !== gc.args.length || gb.args.length < 2) return false;
      let differing = 0;
      for (let i = 0; i < gb.args.length; i++) {
        if (gb.args[i] === gc.args[i]) continue;
        const lone = (x) => /^[A-Za-z_$][\w$]*(_\d+)?$/.test(x.trim());
        if (!lone(gb.args[i]) || !lone(gc.args[i])) return false;
        if (!params.has(gb.args[i].replace(/_\d+$/, "")) || !params.has(gc.args[i].replace(/_\d+$/, ""))) return false;
        differing++;
      }
      return differing >= 1;
    }
  },
  {
    id: "evaluated-to-object",
    description:
      "The baseline prints a function type where the candidate prints `object`: TypeScript 7 evaluated a conditional mapped type such as lodash's `PartialShallow<T>` (`T[P] extends object ? object : T[P]`), whose function members are objects, where TypeScript 6 kept the member's declared type. Never the other way round.",
    test: (b, c) => c.trim() === "object" && (/=>/.test(b) || /^\{ ?\(/.test(b.trim()))
  },
  {
    id: "return-value-name",
    description:
      "A signature with equal parameters whose return the baseline prints as a lower-case value name (`=> vue`, the binding the plugin was imported under) and the candidate as a type name (`=> Plugin`). Never the other way round.",
    test: (b, c) => {
      const i = b.lastIndexOf("=> ");
      const j = c.lastIndexOf("=> ");
      return i > 0 && j > 0 && b.slice(0, i) === c.slice(0, j) && /^[a-z_$][\w$]*$/.test(b.slice(i + 3)) && /^[A-Z][\w$.]*(<.*>)?$/.test(c.slice(j + 3));
    }
  },
  {
    id: "signature-parts-differ",
    description:
      "Two function signatures whose parameter lists and return each either agree or differ in a way another class names (`(url: Array<UrlSegment>) => UrlMatchResult` against `(url: Array<UrlSegment>) => { consumed: UrlSegment[]; ... }`, an alias the candidate expanded in the return): the difference sits inside the signature, not between the functions. A pair the mere-spelling normalisations would equate stays for the spelling-combination fallthrough.",
    test: (b, c, ctx) => {
      // run on the mere-spelling forms: a pair those equate has no difference left to name here
      // and belongs to the spelling-combination fallthrough
      b = spellingForms(b);
      c = spellingForms(c);
      if (b === c) return false;
      const part = (x) => {
        const m = /^(<[^()]*>)?\((.*)\) => /.exec(x);
        if (!m) return null;
        const i = x.lastIndexOf("=> ");
        return { params: m[2], ret: x.slice(i + 3) };
      };
      const pb = part(b);
      const pc = part(c);
      if (!pb || !pc) return false;
      // the parameter lists, split at top-level commas, compared pairwise like object members
      const split = (s) => {
        const out = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if ("([{<".includes(ch)) depth++;
          else if (")]}>".includes(ch)) depth--;
          else if (ch === "," && depth === 0) {
            out.push(s.slice(start, i));
            start = i + 1;
          }
        }
        out.push(s.slice(start));
        return out.map((x) => x.trim()).filter(Boolean);
      };
      const bb = split(pb.params);
      const bc = split(pc.params);
      if (bb.length !== bc.length) return false;
      let differing = 0;
      for (let i = 0; i < bb.length; i++) {
        if (bb[i] === bc[i]) continue;
        const tb = bb[i].slice(bb[i].indexOf(": ") + 2);
        const tc = bc[i].slice(bc[i].indexOf(": ") + 2);
        if (!memberDifferenceNamed(tb, tc, ctx)) return false;
        differing++;
      }
      if (pb.ret !== pc.ret) {
        if (!memberDifferenceNamed(pb.ret, pc.ret, ctx)) return false;
        differing++;
      }
      return differing >= 1;
    }
  },
  {
    id: "function-typeof-vs-signature",
    description:
      "A JavaScript function the baseline names `typeof f` and the candidate prints as its signature (`typeof swapBuffers` against `() => void`), as documented for native type maps. Never the other way round.",
    test: (b, c) => /^typeof [A-Za-z_$][\w$]*$/.test(b.trim()) && /^(<[^>]*>)?\(.*\) => /.test(c.trim())
  },
  {
    id: "parenthesization",
    description: "Equal apart from parentheses around a function type in a type argument or union position.",
    test: (b, c) => b !== c && stripFunctionParens(b) === stripFunctionParens(c)
  },
  {
    id: "array-form",
    description: "The same array type as `T[]` on one side and `Array<T>` on the other (a predicate's `this is S[]` against `this is Array<S>`).",
    test: (b, c) => b !== c && b.includes("[]") !== c.includes("[]") && arrayForm(b) === arrayForm(c)
  },
  {
    id: "duplicate-union-member",
    description: "A union that prints one member twice on one side (`X | X` against `X`): the members as a set are equal.",
    test: (b, c) => b !== c && dedupeUnion(b) === dedupeUnion(c) && dedupeUnion(b) !== b
  },
  {
    id: "union-member-swapped",
    description:
      "The same union with all members equal as a set except one on each side (`typeof ReactiveFormsModule` against `typeof FormsModule`): at a component's `imports` array literal the engines kept a different element's type out of the union.",
    test: (b, c) => {
      let ub = b;
      let uc = c;
      // a union under one matching generic wrapper (`Array<...>`) is the same question
      const gb = genericArguments(b);
      const gc = genericArguments(c);
      if (gb && gc && gb.head === gc.head && gb.args.length === 1 && gc.args.length === 1) {
        ub = gb.args[0];
        uc = gc.args[0];
      }
      const lone = (m) => /^(typeof )?[A-Za-z_$][\w$.]*$/.test(m.trim());
      const nb = topUnionMembers(ub).map((m) => m.trim());
      const nc = topUnionMembers(uc).map((m) => m.trim());
      if (nb.length !== nc.length || nb.length < 3) return false;
      const sb = new Set(nb);
      const sc = new Set(nc);
      const ob = nb.filter((m) => !sc.has(m));
      const oc = nc.filter((m) => !sb.has(m));
      return ob.length === 1 && oc.length === 1 && lone(ob[0]) && lone(oc[0]);
    }
  },
  {
    id: "union-narrowed",
    description:
      "The candidate union has only members of the baseline union: TypeScript 7 typed a contextually typed parameter (an observable predicate) by the branches that apply, TypeScript 6 printed the whole union.",
    test: (b, c) => unionSubset(c, b)
  },
  {
    id: "declared-vs-instantiated-reference",
    description:
      "A generic reference written with its type parameters (Promise<T>) in one tree and instantiated (Promise<any>, Promise<string>) in the other.",
    test: (b, c) => Boolean(refHead(b)) && refHead(b) === refHead(c) && PARAM_LIST.test(b) !== PARAM_LIST.test(c)
  },
  {
    id: "undefined-member",
    description: "Equal apart from `| undefined` as the last member of the type or of an optional member's type.",
    test: (b, c) => b !== c && stripOptionalUndefined(b) === stripOptionalUndefined(c)
  },
  {
    id: "typeof-alias-vs-import",
    description:
      "The baseline names a required module by the local alias (typeof morgan) and the candidate by its file (typeof import(\"./config/morgan\")).",
    test: (b, c) => TYPEOF_VALUE.test(b) && !TYPEOF_IMPORT.test(b) && TYPEOF_IMPORT.test(c)
  },
  {
    id: "typeof-vs-structure",
    description:
      "The whole baseline type names a value with `typeof` (typeof import(\"./m\"), typeof module.exports) and the candidate writes the structure of an object type.",
    test: (b, c) => TYPEOF_VALUE.test(b) && c.startsWith("{")
  },
  {
    id: "module-object",
    description:
      "The CommonJS `module` object: the baseline writes its exports as `typeof module.exports` and the candidate writes their structure.",
    test: (b, c) => b === "{ exports: typeof module.exports; }" && c.startsWith("{ exports: {")
  },
  {
    id: "structure-vs-typeof",
    description: "The whole candidate type names a value with `typeof` where the baseline wrote the structure of an object type.",
    test: (b, c) => TYPEOF_VALUE.test(c) && b.startsWith("{")
  },
  {
    id: "deferred-vs-evaluated",
    description: "A conditional or mapped type left unevaluated on one side (infer, [P in K]) and evaluated on the other.",
    test: (b, c) => hasDeferred(b) !== hasDeferred(c)
  },
  {
    id: "unresolved-external-type",
    description:
      "The project has no node_modules, and a name the file imports from a package occurs in the node text or in either type: the engines answer differently for a type they cannot resolve.",
    test: (b, c, ctx = {}) =>
      Boolean(ctx.noNodeModules) &&
      [...(ctx.externalNames ?? [])].some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(`${ctx.nodeText ?? ""} ${b} ${c}`))
  },
  {
    id: "default-type-argument-printed",
    description:
      "The same generic reference where one side also prints the type arguments the declaration defaults (`MatTableDataSource<ProductTableEntry>` against `MatTableDataSource<ProductTableEntry, MatPaginator>`): the leading arguments are equal and only trailing defaulted ones are added.",
    test: (b, c) => {
      const gb = genericArguments(b);
      const gc = genericArguments(c);
      if (!gb || !gc || gb.head !== gc.head || gb.args.length === gc.args.length) return false;
      const [short, long] = gb.args.length < gc.args.length ? [gb.args, gc.args] : [gc.args, gb.args];
      return short.length >= 1 && short.every((a, i) => a.trim() === long[i].trim());
    }
  },
  {
    id: "mapped-over-any-evaluated",
    description:
      "The baseline names a generic alias whose argument returns `any` (`QueryConfig<() => any>`, an alias of `Omit<ReturnType<T>, \"queryKey\" | \"queryFn\">`) and the candidate writes what that evaluates to, a mapped type over `any`: `{ [x: string]: any; [x: number]: any; [x: symbol]: any; }`. Both are `any` in every member.",
    test: (b, c) => {
      const g = genericArguments(b);
      if (!g || !c.trim().startsWith("{")) return false;
      // the members as a set: the differ compares canonical forms, whose member order is sorted
      const members = splitMembers(c).map((m) => m.trim()).sort().join("; ");
      return members === "[x: number]: any; [x: string]: any; [x: symbol]: any" && g.args.some((a) => /=> any$/.test(a.trim()) || a.trim() === "any");
    }
  },
  {
    id: "alias-vs-expansion",
    description:
      "The baseline names a type alias or interface by a bare name (HttpInterceptorFn, Routes) and the candidate writes its expansion: a function or object type, or the generic reference it resolves to (`Array<import(\"@angular/router\").Route>`). A recursive alias expanded to a union whose every member refers back to it (`Extension` against `ReadonlyArray<Extension> | { extension: Extension; }`) lands here too. A baseline that already carries type arguments never lands here.",
    test: (b, c) => {
      if (!/^[A-Za-z_$][\w$.]*$/.test(b) || /^(any|unknown|never|string|number|boolean|void|undefined|null|object|symbol|bigint)$/.test(b)) return false;
      if (/^[({<]|^new /.test(c) || genericArguments(c) !== null) return true;
      // a recursive alias expanded to its union, each member of which refers back to the alias
      // (`Extension` against `ReadonlyArray<Extension> | { extension: Extension; }`)
      const members = topUnionMembers(c).map((m) => m.trim());
      const self = new RegExp(`(^|[^\\w$.])${b.replace(/[.$]/g, "\\$&")}(?![\\w$])`);
      return members.length >= 2 && members.every((m) => m !== b && self.test(m));
    }
  },
  {
    id: "candidate-refines-any",
    description:
      "The candidate is the baseline with one or more `any` replaced by a type (`Promise<any>` against `Promise<Array<User>>`): the native binary knows more.",
    test: (b, c) => refinesAny(b, c)
  },
  {
    id: "candidate-refines-unknown",
    description: "The candidate is the baseline with one or more `unknown` replaced by a type.",
    test: (b, c) => refinesAny(b, c, "unknown")
  },
  {
    id: "candidate-fewer-any",
    description:
      "The candidate has fewer `any` than the baseline and keeps every other name in it (an `any` became a union or a wider structure).",
    test: (b, c) => fewerAny(b, c)
  },
  {
    id: "readonly-wrapper",
    description: "Equal apart from `Readonly<...>` wrappers or `readonly` modifiers that one side keeps.",
    test: (b, c) => b !== c && stripReadonlyAll(b) === stripReadonlyAll(c)
  },
  {
    id: "record-vs-index-signature",
    description:
      "A mapped record as `Record<string, T>` on one side and as the index signature `{ [x: string]: T; }` on the other.",
    test: (b, c) => b !== c && indexSignatures(b) === indexSignatures(c)
  },
  {
    id: "record-literal-keys-expanded",
    description:
      "A mapped record keyed by a union of string literals, written as `Record<\"a\" | \"b\", V>` on one side and expanded to its member list on the other (`{ a: V; b: V; }`, with the checker's own `... N more ...` elision where it printed only some): the engines stop evaluating mapped types at different points, and every member the expansion does show carries the record's value type.",
    test: (b, c) => {
      const gb = genericArguments(b);
      if (!gb || gb.head !== "Record" || gb.args.length !== 2 || !c.startsWith("{")) return false;
      const keys = topUnionMembers(gb.args[0]).map((m) => m.trim());
      if (keys.length < 2 || !keys.every((m) => /^['"][^'"]*['"]$/.test(m))) return false;
      const value = gb.args[1];
      const unquote = (m) => m.replace(/^['"]|['"]$/g, "");
      const wanted = new Set(keys.map(unquote));
      let shown = 0;
      let elided = 0;
      for (const m of splitMembers(c)) {
        const more = /^(\.\.\. (\d+) more \.\.\.)$/.exec(m);
        if (more) {
          elided += Number(more[2]);
          continue;
        }
        const i = m.indexOf(": ");
        if (i < 0) return false;
        if (!wanted.has(m.slice(0, i).trim()) || m.slice(i + 2) !== value) return false;
        shown++;
      }
      return shown >= 1 && shown + elided >= keys.length;
    }
  },
  {
    id: "qualifier-path",
    description:
      "Equal apart from the namespace path to a qualified name (`zod_1.z.core.$ZodStringParams` against `zod_1.core.$ZodStringParams`).",
    test: (b, c) => b !== c && /\.[A-Za-z_$][\w$]*\./.test(b + c) && qualifierEnds(b) === qualifierEnds(c)
  },
  {
    id: "enum-member-keys",
    description:
      "The same object members, keyed by enum members (`[TeamPreference.SeamlessEdit]`) on one side and by their values (`seamlessEdit`) on the other.",
    test: (b, c) => b !== c && /\[[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$.]*\]\??:/.test(b + c) && anonymizedMembers(b) === anonymizedMembers(c)
  },
  {
    id: "method-vs-property",
    description: "A member written as a method (`reset(): void`) on one side and as a property of function type (`reset: () => void`) on the other.",
    test: (b, c) => b !== c && methodsAsProperties(b) === methodsAsProperties(c)
  },
  {
    id: "qualifier-dropped",
    description: "Equal apart from a namespace qualifier one side writes (`express.Response` against `Response`).",
    test: (b, c) => b !== c && qualifierDropped(b) === qualifierDropped(c)
  },
  {
    id: "parameter-names",
    description:
      "Equal apart from the names of parameters (`(maxLength: number)` against `(targetLength: number)`, as the library declarations of the two versions name them).",
    test: (b, c) => b !== c && anonymizeParams(b) === anonymizeParams(c)
  },
  {
    id: "baseline-refines-any",
    description: "The baseline is the candidate with one or more `any` replaced by a type: the native binary knows less.",
    test: (b, c) => refinesAny(c, b)
  },
  {
    id: "recursion-elided",
    description:
      "The candidate writes `...` for a recursive type that the baseline wrote out (or cut with `any`) one level further.",
    test: (b, c) => /(: |=> |<)\.\.\.(;|,|>| \|)/.test(c) && !/(: |=> |<)\.\.\.(;|,|>| \|)/.test(b)
  },
  {
    id: "any-on-one-side",
    description: "One side mentions `any` and the other does not.",
    test: (b, c) => hasAny(b) !== hasAny(c)
  },
  {
    id: "literal-vs-widened",
    description: "A literal type against its widened primitive.",
    test: (b, c) => {
      const literal = { string: /^["'].*["']$/, number: /^-?\d+(\.\d+)?$/, boolean: /^(true|false)$/ };
      return Object.entries(literal).some(([p, re]) => (b === p && re.test(c)) || (c === p && re.test(b)));
    }
  },
  {
    id: "promise-wrapping",
    description: "Equal apart from a Promise<...> wrapper.",
    test: (b, c) => b === `Promise<${c}>` || c === `Promise<${b}>`
  },
  {
    id: "contextual-answer",
    description:
      "At an arrow parameter whose type is inferred (`comment => ...`), TypeScript 6 answered a bare keyword and TypeScript 7 the contextual type; at a member call whose receiver shares the call's offset (`this.http.delete<void>(...)`), the receiver's name against the call's return; or at a comparison whose left operand shares its offset (`THREE.CopyShader === undefined`), the operand's structure against the comparison's `boolean`: the engines offered different candidates and the same tie-break kept a different one.",
    test: (b, c, ctx = {}) => {
      const t = ctx.nodeText ?? "";
      if (/^[\w$]+ =>/.test(t) && BARE_KEYWORD_ANSWER.test(b.trim()) && !BARE_KEYWORD_ANSWER.test(c.trim())) return true;
      if (/^[A-Za-z_$][\w$.]*\.[\w$]+(<[^()]*>)?\(/.test(t) && /^[A-Za-z_$][\w$.]*$/.test(b.trim()) && /[<{]|=>/.test(c)) return true;
      if (/^[A-Za-z_$][\w$.]*\s*[!=]==?\s/.test(t) && c.trim() === "boolean" && /[|{]/.test(b)) return true;
      return false;
    }
  },
  {
    id: "module-vs-alias",
    description:
      "The CommonJS module's type written as the module (`import(\"./api.11ty\")`, `typeof import(\"./api.11ty\")`) on one side and as the local alias name (`Docs`) on the other.",
    test: (b, c) => {
      const moduleType = /^typeof import\("[^"]*"\)$|^import\("[^"]*"\)$/;
      const alias = /^(typeof )?[A-Za-z_$][\w$.]*$/;
      return (moduleType.test(b.trim()) && alias.test(c.trim())) || (moduleType.test(c.trim()) && alias.test(b.trim()));
    }
  },
  {
    id: "overload-added",
    description:
      "One side's call signatures are the other's plus one the library of the other engine does not declare (`(contextId: \"webgpu\")`, JSON.parse's `context: { source?: string; }`), in order, identical otherwise; a lone signature printed as an arrow counts as a set of one.",
    test: (b, c) => overloadsAdded(b, c)
  },
  {
    id: "class-structure-vs-signature",
    description:
      "A class value typed by its constructor's signature (`(c: any) => L`) by TypeScript 6 and by its structure (`{ (c: any): void; prototype: { ... } }`) by TypeScript 7, in a compiled polyfill.",
    test: (b, c) =>
      (c.replace(/\?/g, "").startsWith("{ (") && c.includes("prototype") && (b.includes("=>") || b.includes("typeof"))) ||
      (b.replace(/\?/g, "").startsWith("{ (") && b.includes("prototype") && (c.includes("=>") || c.includes("typeof")))
  },
  {
    id: "rest-parameter-dropped",
    description: "Equal apart from a rest parameter one side keeps in the signature (`...args: Array<any>`).",
    test: (b, c) => b.replace(/, \.\.\.[\w$]+: Array<any>/g, "") === c || c.replace(/, \.\.\.[\w$]+: Array<any>/g, "") === b
  },
  {
    id: "alias-prefixed-union",
    description: "A union that on one side carries its own alias as an extra first member (`ai_1.ToolApprovalRequestOutput<...> | { type: \"text-start\"; } | ...` against the members alone).",
    test: (b, c) => aliasPrefixedUnion(b, c) || aliasPrefixedUnion(c, b)
  },
  {
    id: "typeof-name-vs-name",
    description: "A value's type written `typeof global` by one engine and by the interface name (`Storage`) by the other.",
    test: (b, c) =>
      /^typeof [A-Za-z_$][\w$.]*$/.test(b.trim()) !== /^typeof [A-Za-z_$][\w$.]*$/.test(c.trim()) &&
      /^(typeof )?[A-Za-z_$][\w$.]*$/.test(b.trim()) &&
      /^(typeof )?[A-Za-z_$][\w$.]*$/.test(c.trim()) &&
      !BARE_PRIMITIVE.test(b.trim()) &&
      !BARE_PRIMITIVE.test(c.trim()) &&
      b.trim() !== "this" &&
      c.trim() !== "this"
  },
  {
    id: "enum-keyed-record",
    description:
      "A mapped record keyed by the enum's members (`[UnfurlResourceType.URL]: ...`) on one side and by its values (`url: ...`) on the other, the values instantiated differently per member.",
    test: (b, c) => enumKeyedRecord(b, c)
  },
  {
    id: "this-vs-literal",
    description: "The baseline says `this` (a polymorphic this type) and the candidate the literal the expression produces (`1`, `true`): compiled JavaScript class fields.",
    test: (b, c) => b.trim() === "this" && isLiteralAnswer(c)
  },
  {
    id: "bare-fallback-answer",
    description:
      "The baseline is a fallback answer (`undefined`, `any`, `this`, an empty object, `{ exports: any; }`) and the candidate resolved the annotation or the value. Never the other way round: a candidate that falls back where the baseline resolved stays unclassified.",
    test: (b, c) => isFallback(b) && !isFallback(c)
  },
  {
    id: "defaulted-vs-resolved",
    description:
      "The baseline is a bare primitive (or a generic of them), the declared default or a widened answer, and the candidate the resolved type (`boolean` against `import(\"...\").User`, `Promise<boolean>` against an object): TypeScript 7 resolved where TypeScript 6 answered with the default. Never the other way round.",
    test: (b, c) => defaultedAnswer(b) && resolvedAnswer(c) && b !== c
  },
  {
    id: "predicate-signature-narrowed",
    description:
      "A find-style signature whose single `predicate` parameter union has fewer members in the candidate (TypeScript 7 typed the predicate by the branches that apply), or the same members apart from the instantiated attributes object (typed from the outer generic by TypeScript 6 and from the concrete model by TypeScript 7).",
    test: (b, c, ctx) => {
      const pp = predicateParameters(b, c);
      if (!pp) return false;
      const nb = topUnionMembers(pp[0]);
      const nc = topUnionMembers(pp[1]);
      if (nc.length < nb.length && nc.some((m) => nb.includes(m))) return true;
      return unionMemberInstantiated(pp[0], pp[1], ctx);
    }
  },
  {
    id: "object-member-differs",
    description:
      "Two object types with the same member names where the members whose types differ each differ in a way another class names (a JSDoc member one engine resolved further, `matches: () => boolean` against `() => true`); the sample shows the object.",
    test: (b, c, ctx) => oneMemberDiffers(b, c, ctx)
  },
  {
    id: "typeof-alias-name",
    description: "Both name a module namespace with `typeof`, through the alias each engine's import binding got (`typeof node_stream_1.promises` against `typeof promises_1`).",
    test: (b, c) =>
      TYPEOF_VALUE.test(b) &&
      TYPEOF_VALUE.test(c) &&
      b !== c &&
      b.split(" ").pop().split(".").pop().replace(/_\d+$/, "") === c.split(" ").pop().split(".").pop().replace(/_\d+$/, "")
  },
  {
    id: "generic-argument-differs",
    description:
      "The same generic reference (`AsyncIterable<TextStreamPart<...>>`) whose differing type arguments each differ in a way another class names.",
    test: (b, c, ctx) => {
      const gb = genericArguments(b);
      const gc = genericArguments(c);
      if (!gb || !gc || gb.head !== gc.head || gb.args.length !== gc.args.length) return false;
      let differing = 0;
      for (let i = 0; i < gb.args.length; i++) {
        if (gb.args[i] === gc.args[i]) continue;
        if (!memberDifferenceNamed(gb.args[i], gc.args[i], ctx)) return false;
        differing++;
      }
      return differing >= 1;
    }
  },
  {
    id: "expansion-vs-alias",
    description:
      "The baseline writes a structure the candidate names by its generic alias (`{ type: \"text-start\"; ... } | ...` against `ai_1.ToolApprovalRequestOutput<...>`): the reverse of alias-vs-expansion.",
    test: (b, c) => (b.startsWith("{") || topUnionMembers(b).length > 1) && genericArguments(c) !== null
  },
  {
    id: "return-promise-of-imported-name",
    description:
      "The same function signature whose return is `Promise<X>` against `Promise<Y>`, where X and Y are names the file imports from a package: a call of a method the receiver's class does not declare (`this.articleService.delete(...)`), for which each engine built its answer from a name the file imports (`Get` against `Request`).",
    test: (b, c, ctx = {}) => {
      const sig = (x) => /\) => Promise<([A-Za-z_$][\w$]*)>$/.exec(x.trim());
      const pb = sig(b);
      const pc = sig(c);
      if (!pb || !pc || pb[1] === pc[1]) return false;
      if (b.slice(0, b.lastIndexOf("=> Promise<")) !== c.slice(0, c.lastIndexOf("=> Promise<"))) return false;
      const names = ctx.externalNames;
      return Boolean(names) && names.has(pb[1]) && names.has(pc[1]);
    }
  },
  {
    id: "computed-key-assignment",
    description:
      "At a computed member assignment in compiled CommonJS (`exports.preconditionResults['https://...'] = reachable`), TypeScript 6 keyed the assigned property's value type at the key literal's offset and TypeScript 7 the literal's own type (`boolean` against `string`).",
    test: (b, c, ctx = {}) =>
      Boolean(ctx.nodeText && /^\[?['"][^'"]*['"]\]\s*=/.test(ctx.nodeText)) && BARE_ANSWER.test(b.trim()) && BARE_ANSWER.test(c.trim()) && b !== c
  },
  {
    id: "nested-package-copy",
    description:
      "The file sits in a nested project with its own node_modules (juice-shop's `frontend/`), it imports a package whose nested copy has another version than the root copy (rxjs 7.8.2 against 6.6.7, ethers 5.8.0 against 6.17.0), and both answers name that package, through `import(\"<package>\")` or the name the file binds it to: each engine resolved another copy, so the answers differ by the package's version (`ethers.AbstractProvider` against `ethers.providers.BaseProvider`, rxjs 6 and rxjs 7 overloads of `combineLatest`). Needs --src.",
    test: (b, c, ctx = {}) => {
      const copies = ctx.nestedPackageCopies;
      if (!copies || b === c) return false;
      for (const [pkg, copy] of copies) {
        if (copy.root && namesPackage(b, pkg, copy.locals) && namesPackage(c, pkg, copy.locals)) return true;
      }
      return false;
    }
  },
  {
    id: "nested-only-package",
    description:
      "The file sits in a nested project with its own node_modules and imports a package only that project installs (juice-shop's `frontend/` and `@codemirror/state`, `@angular/router`); the candidate's answer names that package, through `import(\"<package>\")` or a name the file binds from it, and the baseline's does not: the baseline typed the file from the root program, where the package does not resolve (`ChangeDetectionStrategy` against `import(\"@codemirror/state\").Extension`). Never the other way round. Needs --src.",
    test: (b, c, ctx = {}) => {
      const copies = ctx.nestedPackageCopies;
      if (!copies || b === c) return false;
      for (const [pkg, copy] of copies) {
        if (!copy.root && namesPackage(c, pkg, copy.locals) && !namesPackage(b, pkg, copy.locals)) return true;
      }
      return false;
    }
  },

  {
    id: "minified-source",
    description:
      "The file is minified (an average line over 300 characters): names are one letter and reused across scopes, and the two checkers resolve them differently. Only differences no other class names land here.",
    test: (b, c, ctx = {}) => Boolean(ctx.minified)
  },
  {
    id: "length-limit",
    description: "One side is at or over the 4,096 character limit.",
    test: (b, c) => b.length >= 4096 || c.length >= 4096
  }
];

// Whether a type string names a package: `import("pkg")`, `import("pkg/sub")`, or one of the names the
// file binds from it as a whole name (`ethers.providers.X`, `MatTableDataSource<...>`), never as the
// tail of a longer name or a member (`myethers.X`, `a.Extension`).
function namesPackage(x, pkg, locals) {
  if (x.includes(`import("${pkg}")`) || x.includes(`import("${pkg}/`)) return true;
  return locals.some((l) => new RegExp(`(^|[^\\w$.])${l.replace(/\$/g, "\\$")}(?![\\w$])`).test(x));
}

// The version of a package installed under a node_modules directory, or undefined.
const versionCache = new Map();
function installedVersion(nodeModules, pkg) {
  const key = `${nodeModules}\0${pkg}`;
  if (!versionCache.has(key)) {
    let version;
    try {
      version = JSON.parse(readFileSync(join(nodeModules, pkg, "package.json"), "utf8")).version;
    } catch {
      version = undefined;
    }
    versionCache.set(key, version);
  }
  return versionCache.get(key);
}

// The packages a file imports whose copy in the file's nested project has another version than the
// root copy, or that only the nested project installs, as a map from package name to the local
// names the file binds it to and the two versions (root undefined when the root does not install
// it). A file outside any nested project, or one without --src, has none.
export function packageCopiesFor(src, file, text) {
  const copies = new Map();
  if (!src || file.includes("node_modules/")) return copies;
  const root = resolve(src);
  let nested;
  let dir = resolve(dirname(join(src, file)));
  while (dir !== root && dir.startsWith(root)) {
    if (existsSync(join(dir, "node_modules"))) {
      nested = join(dir, "node_modules");
      break;
    }
    dir = dirname(dir);
  }
  if (!nested) return copies;
  const re = /import\s+(?:type\s+)?(\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)(\s*,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) {
    const spec = m[3];
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    const parts = spec.split("/");
    const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const there = installedVersion(nested, pkg);
    const atRoot = installedVersion(join(root, "node_modules"), pkg);
    if (!there || there === atRoot) continue;
    const locals = (m[1] + (m[2] ?? "")).replace(/\b(as|type)\b/g, " ").match(/[A-Za-z_$][\w$]*/g) ?? [];
    const seen = copies.get(pkg)?.locals ?? [];
    copies.set(pkg, { locals: [...new Set([...seen, ...locals])], nested: there, root: atRoot });
  }
  return copies;
}

// The mere spelling normalisations of the spelling-combination fallthrough, as a function on one
// string (see classifyDifference): a classifier that would fire only because these spellings differ
// leaves the pair to the fallthrough instead.
const spellingForms = (x) =>
  unqualifiedImports(
    stripFunctionParens(arrayForm(indexSignatures(stripImports(stripOptionalUndefined(x.replace(/ [\w$]+\?: never;/g, "").replace(/ ?,? ?\}/g, "}"))))))
      .replace(/InstanceType<[^<>]*>/g, "unknown")
      .replace(/\(([^(),]*\|[^(),()]*)\)/g, "$1")
      .replace(/\(\(\)( => [^()]*)?\)/g, "()$1")
      // an optional member (`context?: X`) and a required one of `X | undefined` (or
      // `undefined | X`) are the same type
      .replace(/([\w$])\?: /g, "$1: ")
      .replace(/ \| undefined(?=[,;)}\]]|$)/g, "")
      .replace(/undefined \| /g, "")
  );

function classifyDifference(rawB, rawC, ctx) {
  // classes are named on the canonical forms, so that white space (TypeScript 6 kept the line breaks of a
  // JSDoc type literal) and member order do not hide the difference that matters
  const all = ["union-order", "object-member-order", "quote-style"];
  const b = canon(rawB, all);
  const c = canon(rawC, all);
  for (const k of DIFFERENCE_CLASSIFIERS) {
    try {
      if (k.test(b, c, ctx)) return k.id;
    } catch {
      // a classifier that throws does not classify
    }
  }
  // a pair can differ in more than one spelling at once (an optional member's `| undefined` next to
  // a name reached through its file): with every mere spelling normalised away, the one remaining
  // difference is named by its class
  const forms = spellingForms;
  if (forms(b) !== b || forms(c) !== c) {
    const fb = forms(b);
    const fc = forms(c);

    if (fb === fc) return "spelling-combination";
    {
      for (const k of DIFFERENCE_CLASSIFIERS) {
        try {
          if (k.test(fb, fc, ctx)) return `${k.id}+spelling`;
        } catch {
          // a classifier that throws does not classify
        }
      }
    }
  }
  if (ctx.referenceValue !== undefined && (rawC === ctx.referenceValue || equalAfterNormalization(ctx.referenceValue, rawC) !== undefined)) {
    return "reference-agrees";
  }
  return "unclassified";
}

// ---- reading trees ----

function listTypemaps(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".typemap")) out.set(relative(root, p).split("\\").join("/").slice(0, -".typemap".length), p);
    }
  };
  walk(root);
  return out;
}

// ---- node kinds ----

// kindsFor maps the offset of every node start to the kind of the outermost node that
// starts there. Offsets are UTF-16 units of the text without a byte order mark, the unit
// TypeScript 6 used for the baseline.
function scriptKindFor(ts, file) {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function kindsFor(text, file) {
  const ts = loadTsc();
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const kinds = new Map();
  const visit = (n) => {
    if (n.kind !== ts.SyntaxKind.SyntaxList) {
      const s = n.getStart(sf);
      if (!kinds.has(s) && n.kind !== ts.SyntaxKind.ExpressionStatement) kinds.set(s, ts.SyntaxKind[n.kind]);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return { kinds, sf };
}

// ---- the differ ----

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/**
 * Compare two trees. Returns the report object.
 * options: { baseline, candidate, src?, samples?, candidateCountsBom? }
 * candidateCountsBom: the candidate's keys count a leading byte order mark (the native binary does,
 * astgen 1.10.6 does not); keys of such files are moved back before comparing and reported as bom-shift.
 */
export function diffTrees(options) {
  const samplesMax = options.samples ?? 3;
  // Without node_modules the engines cannot resolve package types; classify those differences as such.
  const noNodeModules = options.src ? !existsSync(join(options.src, "node_modules")) : false;
  const base = listTypemaps(options.baseline);
  const cand = listTypemaps(options.candidate);
  const reference = options.reference ? listTypemaps(options.reference) : undefined;
  const files = [...new Set([...base.keys(), ...cand.keys()])].sort();
  const classes = new Map(); // key -> { count, kinds: Map, samples: [] }
  const totals = { exact: 0, normalized: 0, different: 0, baselineOnly: 0, candidateOnly: 0, keys: 0 };
  const byKind = new Map(); // kind -> counts
  const filesOnly = { baseline: [], candidate: [] };

  const note = (cls, kind, sample) => {
    let c = classes.get(cls);
    if (!c) {
      c = { count: 0, kinds: new Map(), samples: [] };
      classes.set(cls, c);
    }
    c.count++;
    bump(c.kinds, kind);
    if (c.samples.length < samplesMax) c.samples.push(sample);
  };
  const kindCount = (kind, field) => {
    let k = byKind.get(kind);
    if (!k) {
      k = { exact: 0, normalized: 0, different: 0, baselineOnly: 0, candidateOnly: 0 };
      byKind.set(kind, k);
    }
    k[field]++;
  };

  for (const file of files) {
    const bp = base.get(file);
    const cp = cand.get(file);
    const bm = bp ? JSON.parse(readFileSync(bp, "utf8")) : {};
    const rp = reference?.get(file);
    const rm = rp ? JSON.parse(readFileSync(rp, "utf8")) : undefined;
    let cm = cp ? JSON.parse(readFileSync(cp, "utf8")) : {};
    if (!bp) filesOnly.candidate.push(file);
    if (!cp) filesOnly.baseline.push(file);

    // the source file, when available: node kinds, node text and the byte order mark
    let text;
    let minified = false;
    let bom = false;
    if (options.src) {
      const sp = join(options.src, file);
      if (existsSync(sp)) {
        text = readFileSync(sp, "utf8");
        minified = looksMinified(text);
        if (text.charCodeAt(0) === 0xfeff) {
          bom = true;
          text = text.slice(1);
        }
      }
    }
    const baseOnlyBomShift = bom && cp && options.candidateCountsBom === true;
    if (baseOnlyBomShift) {
      // the candidate counts the byte order mark: move its keys back to the baseline's scale
      const shifted = {};
      for (const [k, v] of Object.entries(cm)) shifted[String(Number(k) - 1)] = v;
      cm = shifted;
    }
    let kinds;
    const ensureKinds = () => {
      if (kinds === undefined) kinds = text === undefined ? null : kindsFor(text, file).kinds;
      return kinds;
    };
    const kindOf = (pos) => ensureKinds()?.get(Number(pos)) ?? "unknown";
    const external = text === undefined ? undefined : externalImportNames(text);
    // The packages this file imports whose copy in the file's nested project (a directory below
    // --src with its own node_modules, juice-shop's frontend/) has another version than the root
    // copy, each with the local names the file binds it to: the evidence the nested-package-copy
    // class needs.
    const nestedPackageCopies = text === undefined ? undefined : packageCopiesFor(options.src, file, text);
    // The names the file's own declarations introduce inside `<...>` (type parameters, their
    // constraints and defaults): the vocabulary a declaration's generics take in this file, for the
    // declaration-type-parameter-spelling class.
    let typeParams;
    if (text === undefined) {
      typeParams = undefined;
    } else {
      typeParams = new Set();
      for (const m of text.matchAll(/<([^<>]*)>/g)) {
        for (const part of m[1].split(",")) {
          for (const name of part.split(/[\s=]+/)) {
            if (/^[A-Z]\w*$/.test(name) && !["Array", "Promise", "Readonly", "Record"].includes(name)) typeParams.add(name);
          }
        }
      }
    }
    const nodeText = (pos) => (text === undefined ? undefined : text.slice(Number(pos), Number(pos) + 80));
    // The candidate's .typespans, when it wrote them: the type of every node by its extent, so a key
    // the start-offset map shares between nested nodes (`a.b === c` and `a`) can be checked against
    // what the candidate gave each of them. Read only when a difference needs it.
    let spansByStart;
    const neighbors = (pos) => {
      if (spansByStart === undefined) {
        spansByStart = null;
        const sp = cp ? cp.replace(/\.typemap$/, ".typespans") : undefined;
        if (sp && existsSync(sp)) {
          spansByStart = new Map();
          for (const [k, v] of Object.entries(JSON.parse(readFileSync(sp, "utf8")))) {
            const start = Number(k.slice(0, k.indexOf(":"))) - (baseOnlyBomShift ? 1 : 0);
            if (!spansByStart.has(start)) spansByStart.set(start, []);
            spansByStart.get(start).push(v);
          }
        }
      }
      return spansByStart?.get(Number(pos)) ?? [];
    };

    const positions = new Set([...Object.keys(bm), ...Object.keys(cm)]);
    for (const pos of positions) {
      totals.keys++;
      const b = bm[pos];
      const c = cm[pos];
      if (b !== undefined && c !== undefined) {
        if (b === c && !baseOnlyBomShift) {
          totals.exact++;
          kindCount(kindOf(pos), "exact");
          continue;
        }
        const ids = b === c ? [] : equalAfterNormalization(b, c, { nodeText: nodeText(pos), fileText: text, file });
        if (ids !== undefined) {
          const all = baseOnlyBomShift ? ["bom-shift", ...ids] : ids;
          totals.normalized++;
          const kind = kindOf(pos);
          kindCount(kind, "normalized");
          note(`normalized:${all.join("+")}`, kind, { file, pos: Number(pos), baseline: b, candidate: c });
        } else {
          totals.different++;
          const kind = kindOf(pos);
          kindCount(kind, "different");
          note(`different:${classifyDifference(b, c, { nodeText: nodeText(pos), externalNames: external, noNodeModules, minified, neighbors: neighbors(pos), typeParameters: typeParams, nestedPackageCopies, referenceValue: rm?.[pos] })}`, kind, { file, pos: Number(pos), baseline: b, candidate: c });
        }
      } else if (b !== undefined) {
        totals.baselineOnly++;
        const kind = kindOf(pos);
        kindCount(kind, "baselineOnly");
        note(`baseline-only:${kind}`, kind, { file, pos: Number(pos), baseline: b });
      } else {
        totals.candidateOnly++;
        const kind = kindOf(pos);
        kindCount(kind, "candidateOnly");
        note(`candidate-only:${kind}`, kind, { file, pos: Number(pos), candidate: c });
      }
    }
  }

  const agree = totals.exact + totals.normalized;
  return {
    totals: { ...totals, agreementPercent: totals.keys ? Number(((100 * agree) / totals.keys).toFixed(2)) : 100 },
    files: { baseline: base.size, candidate: cand.size, baselineOnly: filesOnly.baseline, candidateOnly: filesOnly.candidate },
    byKind: Object.fromEntries([...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    classes: Object.fromEntries(
      [...classes.entries()]
        .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
        .map(([k, v]) => [k, { count: v.count, kinds: Object.fromEntries(v.kinds), samples: v.samples }])
    )
  };
}

// ---- the allow-list ----

/**
 * allow-list file:
 *   { "version": 1, "classes": [ { "id": "normalized:union-order", "reason": "...", "reviewer": "...", "max": 20000 } ] }
 * `id` is a class key from the report (`different:...`, `baseline-only:<kind>`,
 * `candidate-only:<kind>`, or `normalized:...` to bound a normalization). `max` (optional) bounds
 * how many entries the class may have and `maxShare` (optional) the class's share of all keys, so a
 * class cannot grow unnoticed.
 * "different:unclassified" cannot be listed.
 */
export function checkAllowList(report, allow) {
  const problems = [];
  const listed = new Map();
  for (const entry of allow?.classes ?? []) {
    if (entry.id === "different:unclassified") {
      problems.push({ problem: "different:unclassified cannot be allow-listed" });
      continue;
    }
    if (!entry.reason || !entry.reviewer) {
      problems.push({ problem: `allow-list entry ${entry.id} needs a reason and a reviewer` });
      continue;
    }
    listed.set(entry.id, entry);
  }
  for (const [id, cls] of Object.entries(report.classes)) {
    // `<class>+spelling` is the class after the mere spelling normalisations, bounded as the class
    const entry = listed.get(id) ?? listed.get(id.replace(/\+spelling$/, ""));
    // A normalization (canon.mjs) is reviewed in code and tested; it needs no entry, but an entry
    // may bound how many keys it equates.
    if (id.startsWith("normalized:") && !entry) continue;
    if (!entry) {
      problems.push({ problem: "class is not on the allow-list", id, count: cls.count, samples: cls.samples });
    } else if (entry.max !== undefined && cls.count > entry.max) {
      problems.push({ problem: `class exceeds its allowed maximum of ${entry.max}`, id, count: cls.count, samples: cls.samples });
    } else if (entry.maxShare !== undefined && report.totals.keys > 0 && cls.count / report.totals.keys > entry.maxShare) {
      problems.push({
        problem: `class exceeds its allowed share of ${entry.maxShare} of all keys`,
        id,
        count: cls.count,
        samples: cls.samples
      });
    }
  }
  return problems;
}

// ---- command line ----

function parseArgs(argv) {
  const o = { samples: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--baseline") o.baseline = resolve(next());
    else if (a === "--candidate") o.candidate = resolve(next());
    else if (a === "--src") o.src = resolve(next());
    else if (a === "--allow") o.allow = resolve(next());
    else if (a === "--json") o.json = resolve(next());
    else if (a === "--samples") o.samples = Number(next());
    else if (a === "--candidate-counts-bom") o.candidateCountsBom = true;
    else if (a === "--min-agreement") o.minAgreement = Number(next());
    else if (a === "--reference") o.reference = resolve(next());
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.baseline || !o.candidate) throw new Error("--baseline and --candidate are required");
  return o;
}

function formatReport(r) {
  const t = r.totals;
  const lines = [];
  lines.push(`keys ${t.keys}: exact ${t.exact}, normalized ${t.normalized}, different ${t.different}, baseline-only ${t.baselineOnly}, candidate-only ${t.candidateOnly}; agreement ${t.agreementPercent}%`);
  lines.push(`files: baseline ${r.files.baseline}, candidate ${r.files.candidate}, only in baseline ${r.files.baselineOnly.length}, only in candidate ${r.files.candidateOnly.length}`);
  lines.push("classes:");
  for (const [id, c] of Object.entries(r.classes)) {
    lines.push(`  ${String(c.count).padStart(8)}  ${id}`);
    for (const s of c.samples.slice(0, 2)) {
      lines.push(`            ${s.file}:${s.pos}${s.baseline !== undefined ? `  baseline: ${String(s.baseline).slice(0, 100)}` : ""}${s.candidate !== undefined ? `  candidate: ${String(s.candidate).slice(0, 100)}` : ""}`);
    }
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const report = diffTrees(o);
  const allow = o.allow ? JSON.parse(readFileSync(o.allow, "utf8")) : { classes: [] };
  const problems = checkAllowList(report, allow);
  if (o.minAgreement !== undefined && report.totals.agreementPercent < o.minAgreement) {
    problems.push({ problem: `agreement ${report.totals.agreementPercent}% is below ${o.minAgreement}%` });
  }
  report.problems = problems;
  if (o.json) writeFileSync(o.json, JSON.stringify(report, null, 2));
  console.log(formatReport(report));
  if (problems.length) {
    console.error(`FAIL: ${problems.length} problem(s)`);
    for (const p of problems) console.error(" ", JSON.stringify(p).slice(0, 400));
    process.exit(1);
  }
}
