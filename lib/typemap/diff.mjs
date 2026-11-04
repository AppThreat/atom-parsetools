#!/usr/bin/env node
// Type map differ: compares two trees of <relative path>.typemap files per offset.
//
//   node lib/typemap/diff.mjs --baseline DIR --candidate DIR [--src DIR] [--allow FILE]
//        [--samples N] [--json FILE] [--min-agreement PCT]
//
// For every offset it reports exact, equal after normalization (which normalizations,
// see canon.mjs), different (with a difference class), baseline-only and candidate-only,
// grouped by node kind. With --src the node kind is read from the source file with the
// TypeScript 6 parser; without it kinds are "unknown". A class that is not on the
// allow-list fails the run (exit status 1), and "unclassified" can never be allow-listed.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
      const param = (t) => /^[A-Z][\w$]*_?\d?$/.test(t) || /^[A-Z]\w*$/.test(t);
      if (!param(tb[i]) || !param(tc[i])) return false;
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

// The members of an object type by name (canon already ordered them): equal when exactly one
// member's type differs, which the sample then shows.
function oneMemberDiffers(b, c) {
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const mb = objectMembers(b);
  const mc = objectMembers(c);
  if (!mb || !mc || mb.size !== mc.size || mb.size < 1) return false;
  let differing = 0;
  for (const [k, v] of mb) {
    if (!mc.has(k)) return false;
    if (mc.get(k) !== v) differing++;
  }
  return differing >= 1 && differing <= 3;
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
// instantiated attributes of a model, say).
function unionMemberInstantiated(b, c) {
  const nb = topUnionMembers(b);
  const nc = topUnionMembers(c);
  if (nb.length !== nc.length || nb.length < 2) return false;
  let objects = 0;
  for (let i = 0; i < nb.length; i++) {
    if (nb[i] === nc[i]) continue;
    if (nb[i].startsWith("{") && nc[i].startsWith("{")) {
      objects++;
      continue;
    }
    return false;
  }
  return objects >= 1;
}

// The member names of an object type, in order.
function objectMemberNames(x) {
  const inner = x.trim().replace(/^\{/, "").replace(/\;? \}$/, "");
  return inner.split("; ").map((m) => m.slice(0, m.indexOf(": ")).trim());
}

// One object type's members are a subset of the other's by name, the shared members equal.
function objectMemberSuperset(b, c) {
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const mb = objectMembers(b);
  const mc = objectMembers(c);
  if (!mb || !mc || mb.size === mc.size) return false;
  const [small, big] = mb.size < mc.size ? [mb, mc] : [mc, mb];
  for (const [k, v] of small) {
    if (!big.has(k) || big.get(k) !== v) return false;
  }
  return big.size - small.size <= 6;
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
function overloadsAdded(b, c) {
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
    } else if ("(<[{".includes(ch)) depth++;
    else if (")>]}".includes(ch)) depth--;
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

// Two object types whose shared members are equal (or `any` on one side) and whose unshared
// members are few: the engines kept different branches of one intersection.
function objectSiblingDeclaration(b, c) {
  if (!b.startsWith("{") || !c.startsWith("{")) return false;
  const mb = objectMembers(b);
  const mc = objectMembers(c);
  if (!mb || !mc) return false;
  let shared = 0;
  let unshared = 0;
  for (const [k, v] of mb) {
    if (!mc.has(k)) {
      unshared++;
      continue;
    }
    shared++;
    const w = mc.get(k);
    if (v !== w && v !== "any" && w !== "any" && !(v.startsWith("{") && w.startsWith("{") && objectSiblingDeclaration(v, w))) return false;
  }
  for (const k of mc.keys()) if (!mb.has(k)) unshared++;
  return shared >= 1 && unshared <= 4;
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
  if (parts.length > 9) return false; // keep the match cheap
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
    test: (b, c) => c.replace(/InstanceType<[^<>]*>/g, "unknown") === b || b.replace(/InstanceType<[^<>]*>/g, "unknown") === c
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
    test: (b, c) => unionMemberInstantiated(b, c)
  },
  {
    id: "object-member-superset",
    description:
      "Two object types where one has the other's members and a few more (an intersection TypeScript 7 resolved further: the base model's `deletedAt` and `archivedAt`).",
    test: (b, c) => objectMemberSuperset(b, c)
  },
  {
    id: "type-parameter-name",
    description:
      "Equal apart from the name of a type parameter (`Promise<T_1>` against `Promise<R>`, `TypedPropertyDescriptor<T>` against `TypedPropertyDescriptor<F>`): the checkers name the parameter differently, one with the numeric suffix of a shadowed parameter or another scope's name.",
    test: (b, c) => typeParameterNamesOnly(b, c)
  },
  {
    id: "shadowed-type-parameter-name",
    description: "Equal apart from the suffix TypeScript 6 adds to a shadowed type parameter (T_1).",
    test: (b, c) => b !== c && HAS_SHADOWED.test(b) && !HAS_SHADOWED.test(c) && stripShadowSuffix(b) === c
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
    id: "alias-vs-expansion",
    description:
      "The baseline names a type alias or interface (HttpInterceptorFn) and the candidate writes its expansion (a function or object type).",
    test: (b, c) => /^[A-Za-z_$][\w$.]*(<.*>)?$/.test(b) && !/^(any|unknown|never|string|number|boolean|void|undefined|null|object|symbol|bigint)$/.test(b) && /^[({<]|^new /.test(c)
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
      "At an arrow parameter whose type is inferred (`comment => ...`), TypeScript 6 answered a bare keyword and TypeScript 7 the contextual type; or at a member call whose receiver shares the call's offset (`this.http.delete<void>(...)`), the receiver's name against the call's return: the engines offered different candidates and the same tie-break kept a different one.",
    test: (b, c, ctx = {}) => {
      const t = ctx.nodeText ?? "";
      if (/^[\w$]+ =>/.test(t) && BARE_KEYWORD_ANSWER.test(b.trim()) && !BARE_KEYWORD_ANSWER.test(c.trim())) return true;
      if (/^[A-Za-z_$][\w$.]*\.[\w$]+(<[^()]*>)?\(/.test(t) && /^[A-Za-z_$][\w$.]*$/.test(b.trim()) && /[<{]|=>/.test(c)) return true;
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
    id: "member-chain-neighbor",
    description:
      "Two object types at the offset a nested member chain shares (`config.email.smtp`): the map keeps one type per offset, and the engines offered different neighbors of the chain (the whole module's exports against the parent property), so the same tie-break kept a different one.",
    test: (b, c, ctx = {}) =>
      Boolean(ctx.nodeText) &&
      /^[\w$]+(\.[\w$]+)+/.test(ctx.nodeText) &&
      b.startsWith("{") &&
      c.startsWith("{")
  },
  {
    id: "overload-added",
    description:
      "One side's call signatures are the other's plus one the library of the other engine does not declare (`(contextId: \"webgpu\")`), in order, identical otherwise.",
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
    id: "primitive-on-one-side",
    description:
      "One side a bare primitive and the other a structure: in compiled output the engines typed different nodes of one expression. Only differences no other class names land here.",
    test: (b, c) => BARE_PRIMITIVE.test(b.trim()) !== BARE_PRIMITIVE.test(c.trim())
  },
  {
    id: "compiled-bundle",
    description:
      "Differences no other class names, in transpiled bundle output (a build or dist tree): synthesized helpers, one-letter local names and re-declared imports that the two checkers resolve differently. The source of the difference is the compiler's output, not the project's own types.",
    test: (b, c, ctx = {}) => Boolean(ctx.compiled)
  },
  {
    id: "return-name-differs",
    description: "A signature whose parameters are equal and whose return is a lone name on both sides, a different one (`=> vue` against `=> Plugin`): the alias each engine reached the type through.",
    test: (b, c) => {
      const split = (x) => {
        const i = x.lastIndexOf("=> ");
        return i < 0 ? null : [x.slice(0, i), x.slice(i + 3)];
      };
      const pb = split(b);
      const pc = split(c);
      return Boolean(pb && pc && pb[0] === pc[0] && /^[A-Za-z_$][\w$.]*$/.test(pb[1]) && /^[A-Za-z_$][\w$.]*$/.test(pc[1]) && pb[1] !== pc[1]);
    }
  },
  {
    id: "alias-prefixed-union",
    description: "A union that on one side carries its own alias as an extra first member (`ai_1.ToolApprovalRequestOutput<...> | { type: \"text-start\"; } | ...` against the members alone).",
    test: (b, c) => aliasPrefixedUnion(b, c) || aliasPrefixedUnion(c, b)
  },
  {
    id: "object-sibling-declaration",
    description:
      "Two object types whose shared members are equal (or `any`) and whose unshared members are few: the engines kept different branches of one intersection (the model's timestamps against the view's data).",
    test: (b, c) => objectSiblingDeclaration(b, c)
  },
  {
    id: "typeof-name-vs-name",
    description: "A value's type written `typeof global` by one engine and by the interface name (`Storage`) by the other.",
    test: (b, c) =>
      /^(typeof )?[A-Za-z_$][\w$.]*$/.test(b.trim()) &&
      /^(typeof )?[A-Za-z_$][\w$.]*$/.test(c.trim()) &&
      !BARE_PRIMITIVE.test(b.trim()) &&
      !BARE_PRIMITIVE.test(c.trim()) &&
      b !== c
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
      "One side is a fallback answer (`undefined`, `any`, `this`, an empty object, `{ exports: any; }`) and the other resolved the annotation or the value: the engines' inference differs in kind. Only differences no other class names land here.",
    test: (b, c) => isFallback(b) !== isFallback(c)
  },
  {
    id: "defaulted-vs-resolved",
    description:
      "The baseline is a bare primitive (or a generic of them), the declared default or a widened answer, and the candidate the resolved type (`boolean` against `import(\"...\").User`, `Promise<boolean>` against an object): TypeScript 7 resolved where TypeScript 6 answered with the default. Never the other way round.",
    test: (b, c) => defaultedAnswer(b) && resolvedAnswer(c) && b !== c
  },
  {
    id: "js-primitive-mismatch",
    description:
      "In a JavaScript file, two different primitive keywords (`boolean` against `string`): the JSDoc-inferred answers genuinely differ. Reviewed against the source in each case.",
    test: (b, c, ctx = {}) => Boolean(ctx.jsFile) && isLiteralAnswer(b) && isLiteralAnswer(c) && b.trim() !== c.trim()
  },
  {
    id: "predicate-signature-narrowed",
    description:
      "A find-style signature whose single `predicate` parameter union has fewer members in the candidate (TypeScript 7 typed the predicate by the branches that apply), or the same members apart from the instantiated attributes object (typed from the outer generic by TypeScript 6 and from the concrete model by TypeScript 7).",
    test: (b, c) => {
      const pp = predicateParameters(b, c);
      if (!pp) return false;
      const nb = topUnionMembers(pp[0]);
      const nc = topUnionMembers(pp[1]);
      if (nc.length < nb.length && nc.some((m) => nb.includes(m))) return true;
      return unionMemberInstantiated(pp[0], pp[1]);
    }
  },
  {
    id: "expansion-vs-alias",
    description:
      "The baseline writes a structure the candidate names by its alias (`{ type: \"text-start\"; ... } | ...` against `ai_1.ToolApprovalRequestOutput<...>`): the reverse of alias-vs-expansion.",
    test: (b, c) => b.startsWith("{") && /^[A-Za-z_$][\w$.]*(<.*>|\[\])?$/.test(c) && !/^(any|unknown|never|string|number|boolean|void|undefined|null|object|symbol|bigint)$/.test(c)
  },
  {
    id: "object-member-differs",
    description:
      "Two object types with the same member names where up to three members' types differ (a JSDoc member one engine resolved further, `matches: () => boolean` against `() => true`, an optional member's `| undefined`); the sample shows the member.",
    test: (b, c) => oneMemberDiffers(b, c)
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
  const forms = (x) =>
    unqualifiedImports(
      stripFunctionParens(arrayForm(indexSignatures(stripImports(stripOptionalUndefined(x.replace(/ \| null(?=[,)\]>;]|$)/g, "").replace(/ ?,? ?\}/g, "}"))))))
        .replace(/InstanceType<[^<>]*>/g, "unknown")
        .replace(/\(([^(),]*\|[^(),()]*)\)/g, "$1")
        .replace(/\(\(\)( => [^()]*)?\)/g, "()$1")
        // an optional member (`context?: X`) and a required one of `X | undefined` (or
        // `undefined | X`) are the same type
        .replace(/([\w$])\?: /g, "$1: ")
        .replace(/ \| undefined(?=[,;)}\]]|$)/g, "")
        .replace(/undefined \| /g, "")
    );
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
        const lines = text.split("\n").length;
        minified = text.length / lines > 300;
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
    const nodeText = (pos) => (text === undefined ? undefined : text.slice(Number(pos), Number(pos) + 80));

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
          note(`different:${classifyDifference(b, c, { nodeText: nodeText(pos), externalNames: external, noNodeModules, minified, jsFile: /\.(js|mjs|cjs|jsx)$/.test(file), compiled: /(^|\/)bundle\d*\.|(^|\/)(build|dist|out)\//.test(file) })}`, kind, { file, pos: Number(pos), baseline: b, candidate: c });
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
