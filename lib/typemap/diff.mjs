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
import { equalAfterNormalization } from "./canon.mjs";

const require = createRequire(import.meta.url);
let tsc;
function loadTsc() {
  if (!tsc) {
    tsc = require("@typescript/typescript6");
  }
  return tsc;
}

// ---- difference classes, in the order they are tried ----

const IMPORT_RE = /import\("[^"]*"\)/g;
const stripImports = (s) => s.replace(IMPORT_RE, 'import("")');

const PARAM_LIST = /^[A-Za-z_$][\w$.]*<[A-Z]\w*(, [A-Z]\w*)*>$/;
const refHead = (s) => /^([A-Za-z_$][\w$.]*)</.exec(s)?.[1];
const hasAny = (s) => /\bany\b/.test(s);
// `typeof` outside string literals
const hasTypeof = (s) => /\btypeof\b/.test(s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'));
const stripShadowSuffix = (s) => s.replace(/\b([A-Za-z_$][\w$]*)_\d+\b/g, "$1");
const stripParens = (s) => s.replace(/[()]/g, "");
const hasDeferred = (s) => / extends infer /.test(s) || /\[P in /.test(s) || /\bextends\b.*\?.*:/.test(s);

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
    id: "shadowed-type-parameter-name",
    description: "Equal apart from the suffix TypeScript 6 adds to a shadowed type parameter (T_1).",
    test: (b, c) => b !== c && stripShadowSuffix(b) === stripShadowSuffix(c)
  },
  {
    id: "parenthesization",
    description: "Equal apart from parentheses around a function type.",
    test: (b, c) => b !== c && stripParens(b) === stripParens(c)
  },
  {
    id: "declared-vs-instantiated-reference",
    description:
      "A generic reference written with its type parameters (Promise<T>) in one tree and instantiated (Promise<any>, Promise<string>) in the other.",
    test: (b, c) => Boolean(refHead(b)) && refHead(b) === refHead(c) && PARAM_LIST.test(b) !== PARAM_LIST.test(c)
  },
  {
    id: "undefined-member",
    description: "Equal apart from `| undefined`.",
    test: (b, c) => b !== c && b.replace(/ \| undefined/g, "") === c.replace(/ \| undefined/g, "")
  },
  {
    id: "typeof-vs-structure",
    description:
      "The baseline names a value with `typeof` (typeof import(\"./m\"), typeof module.exports, typeof morgan) and the candidate writes the structure of that value's type.",
    test: (b, c) => hasTypeof(b) && !hasTypeof(c)
  },
  {
    id: "structure-vs-typeof",
    description: "The candidate names a value with `typeof` where the baseline wrote a structure.",
    test: (b, c) => hasTypeof(c) && !hasTypeof(b)
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
    id: "length-limit",
    description: "One side is at or over the 4,096 character limit.",
    test: (b, c) => b.length >= 4096 || c.length >= 4096
  }
];

function classifyDifference(b, c, ctx) {
  for (const k of DIFFERENCE_CLASSIFIERS) {
    try {
      if (k.test(b, c, ctx)) return k.id;
    } catch {
      // a classifier that throws does not classify
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
    let bom = false;
    if (options.src) {
      const sp = join(options.src, file);
      if (existsSync(sp)) {
        text = readFileSync(sp, "utf8");
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
        const ids = b === c ? [] : equalAfterNormalization(b, c, { nodeText: nodeText(pos) });
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
          note(`different:${classifyDifference(b, c, { nodeText: nodeText(pos), externalNames: external, noNodeModules })}`, kind, { file, pos: Number(pos), baseline: b, candidate: c });
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
 * how many entries the class may have, so a class cannot grow unnoticed.
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
    const entry = listed.get(id);
    // A normalization (canon.mjs) is reviewed in code and tested; it needs no entry, but an entry
    // may bound how many keys it equates.
    if (id.startsWith("normalized:") && !entry) continue;
    if (!entry) {
      problems.push({ problem: "class is not on the allow-list", id, count: cls.count, samples: cls.samples });
    } else if (entry.max !== undefined && cls.count > entry.max) {
      problems.push({ problem: `class exceeds its allowed maximum of ${entry.max}`, id, count: cls.count, samples: cls.samples });
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
