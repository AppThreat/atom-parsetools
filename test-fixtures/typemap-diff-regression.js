import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIFFERENCE_CLASSIFIERS,
  checkAllowList,
  diffTrees
} from "../lib/typemap/diff.mjs";
import { NORMALIZATIONS, canon, equalAfterNormalization } from "../lib/typemap/canon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "typemap-diff-"));
let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n${err.stack}`);
  }
};

function tree(name, files) {
  const dir = join(root, name);
  for (const [rel, map] of Object.entries(files)) {
    const p = join(dir, `${rel}.typemap`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof map === "string" ? map : JSON.stringify(map));
  }
  return dir;
}
function srcTree(name, files) {
  const dir = join(root, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

// ---- normalizations: each one equates its positive examples and keeps the negative ones apart ----

for (const n of NORMALIZATIONS) {
  test(`normalization ${n.id} has a description, a justification and examples`, () => {
    assert.ok(n.description && n.justification);
    if (n.id !== "bom-shift") {
      assert.ok(n.equal.length > 0 && n.different.length > 0, "needs positive and negative examples");
    }
  });
  for (const [a, b] of n.equal) {
    test(`normalization ${n.id} equates ${a} and ${b}`, () => {
      const ids = equalAfterNormalization(a, b);
      assert.ok(ids && ids.length > 0, `not equated: ${JSON.stringify(ids)}`);
      assert.ok(ids.includes(n.id), `expected ${n.id} among ${ids}`);
      assert.deepEqual(equalAfterNormalization(a, a), []);
    });
  }
  for (const [a, b] of n.different) {
    test(`normalization ${n.id} keeps ${a} and ${b} apart`, () => {
      assert.equal(equalAfterNormalization(a, b), undefined);
    });
  }
}

test("typeof is only equated with a function type, and only when the name is in the node text", () => {
  assert.deepEqual(equalAfterNormalization("typeof f", "(a: number) => void", { nodeText: "f(1)" }), ["typeof-vs-signature"]);
  assert.equal(equalAfterNormalization("typeof f", "(a: number) => void", { nodeText: "g(1)" }), undefined);
  assert.equal(equalAfterNormalization("typeof f", "number | (() => void)", {}), undefined);
});

test("canon does not merge distinct unions that share a prefix", () => {
  assert.notEqual(canon('"a" | "b" | "c"', ["union-order"]), canon('"a" | "b"', ["union-order"]));
  assert.equal(canon('"b" | "a"', ["union-order"]), canon('"a" | "b"', ["union-order"]));
});

// ---- the differ ----

test("identical trees: no differences, all exact", () => {
  const a = tree("same-a", { "x.ts": { 0: "number", 5: "string" }, "d/y.ts": { 3: "boolean" } });
  const b = tree("same-b", { "x.ts": { 0: "number", 5: "string" }, "d/y.ts": { 3: "boolean" } });
  const r = diffTrees({ baseline: a, candidate: b });
  assert.equal(r.totals.keys, 3);
  assert.equal(r.totals.exact, 3);
  assert.equal(r.totals.agreementPercent, 100);
  assert.deepEqual(r.classes, {});
  assert.deepEqual(checkAllowList(r, { classes: [] }), []);
});

test("counts exact, normalized, different and one-sided keys separately", () => {
  const a = tree("cnt-a", { "x.ts": { 0: "number", 1: '"a" | "b"', 2: "string", 3: "only-a" } });
  const b = tree("cnt-b", { "x.ts": { 0: "number", 1: '"b" | "a"', 2: "number", 4: "only-b" } });
  const r = diffTrees({ baseline: a, candidate: b });
  assert.deepEqual(
    [r.totals.exact, r.totals.normalized, r.totals.different, r.totals.baselineOnly, r.totals.candidateOnly],
    [1, 1, 1, 1, 1]
  );
  assert.equal(r.totals.agreementPercent, 40);
  assert.ok(r.classes["normalized:union-order"]);
  assert.ok(r.classes["different:unclassified"]);
});

test("a file present on one side only is reported and its keys are one-sided", () => {
  const a = tree("one-a", { "x.ts": { 0: "number" }, "gone.ts": { 0: "string" } });
  const b = tree("one-b", { "x.ts": { 0: "number" }, "new.ts": { 0: "string" } });
  const r = diffTrees({ baseline: a, candidate: b });
  assert.deepEqual(r.files.baselineOnly, ["gone.ts"]);
  assert.deepEqual(r.files.candidateOnly, ["new.ts"]);
  assert.equal(r.totals.baselineOnly, 1);
  assert.equal(r.totals.candidateOnly, 1);
});

test("node kinds come from the source and group the counts", () => {
  const src = srcTree("kind-src", { "k.ts": "const x = 1;\nfoo(2);\n" });
  const a = tree("kind-a", { "k.ts": { 6: "number", 13: "string" } });
  const b = tree("kind-b", { "k.ts": { 6: "string", 13: "string" } });
  const r = diffTrees({ baseline: a, candidate: b, src });
  assert.equal(r.byKind.Identifier?.different ?? r.byKind.VariableDeclaration?.different, 1);
  assert.ok(Object.keys(r.byKind).every((k) => k !== "unknown"), JSON.stringify(r.byKind));
});

test("every sample carries file, offset and both strings", () => {
  const a = tree("smp-a", { "x.ts": { 7: "number" } });
  const b = tree("smp-b", { "x.ts": { 7: "string" } });
  const r = diffTrees({ baseline: a, candidate: b });
  const s = r.classes["different:unclassified"].samples[0];
  assert.deepEqual(s, { file: "x.ts", pos: 7, baseline: "number", candidate: "string" });
});

test("difference classes: each classifier fires on its example and not on a plain difference", () => {
  const cases = {
    "import-specifier": ['import("./a").T', 'import("./b").T'],
    "declared-vs-instantiated-reference": ["Promise<T>", "Promise<any>"],
    "undefined-member": ["string | undefined", "string"],
    "any-on-one-side": ["Foo<any>", "Foo<string>"],
    "literal-vs-widened": ['"a"', "string"],
    "promise-wrapping": ["string", "Promise<string>"]
  };
  for (const k of DIFFERENCE_CLASSIFIERS) {
    if (k.id === "length-limit") continue;
    const [b, c] = cases[k.id];
    assert.ok(k.test(b, c), `${k.id} should fire on ${b} / ${c}`);
    assert.ok(!k.test("number", "string"), `${k.id} must not fire on number / string`);
  }
});

// ---- the allow-list ----

const diffOf = () => {
  const a = tree(`al-a-${Math.random()}`, { "x.ts": { 0: "Promise<T>", 1: "number", 2: '"a" | "b"' } });
  const b = tree(`al-b-${Math.random()}`, { "x.ts": { 0: "Promise<any>", 1: "string", 2: '"b" | "a"' } });
  return diffTrees({ baseline: a, candidate: b });
};

test("an unlisted class fails", () => {
  const problems = checkAllowList(diffOf(), { classes: [] });
  const ids = problems.map((p) => p.id).sort();
  assert.deepEqual(ids, ["different:declared-vs-instantiated-reference", "different:unclassified"]);
});

test("a listed class passes, unclassified can never be listed", () => {
  const entry = (id) => ({ id, reason: "r", reviewer: "x" });
  const problems = checkAllowList(diffOf(), {
    classes: [entry("different:declared-vs-instantiated-reference"), entry("different:unclassified")]
  });
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /cannot be allow-listed/.test(p.problem)));
  assert.ok(problems.some((p) => p.id === "different:unclassified"));
});

test("an entry needs a reason and a reviewer", () => {
  const problems = checkAllowList(diffOf(), { classes: [{ id: "different:declared-vs-instantiated-reference" }] });
  assert.ok(problems.some((p) => /needs a reason and a reviewer/.test(p.problem)));
});

test("max bounds a class", () => {
  const r = diffOf();
  const ok = checkAllowList(r, {
    classes: [{ id: "different:declared-vs-instantiated-reference", reason: "r", reviewer: "x", max: 1 }]
  }).filter((p) => p.id !== "different:unclassified");
  assert.deepEqual(ok, []);
  const bad = checkAllowList(r, {
    classes: [{ id: "different:declared-vs-instantiated-reference", reason: "r", reviewer: "x", max: 0 }]
  }).filter((p) => p.id === "different:declared-vs-instantiated-reference");
  assert.equal(bad.length, 1);
});

test("a normalization can be bounded with an entry", () => {
  const r = diffOf();
  const problems = checkAllowList(r, { classes: [{ id: "normalized:union-order", reason: "r", reviewer: "x", max: 0 }] });
  assert.ok(problems.some((p) => p.id === "normalized:union-order"));
});

// ---- byte order mark ----

test("candidate keys that count a byte order mark are moved back, and reported as bom-shift", () => {
  const src = srcTree("bom-src", { "b.ts": "\uFEFFconst a = 1;\n" });
  const a = tree("bom-a", { "b.ts": { 6: "number" } });
  const b = tree("bom-b", { "b.ts": { 7: "number" } });
  const without = diffTrees({ baseline: a, candidate: b, src });
  assert.equal(without.totals.exact, 0, "without the option the shift is a real difference");
  const withOpt = diffTrees({ baseline: a, candidate: b, src, candidateCountsBom: true });
  assert.equal(withOpt.totals.normalized, 1);
  assert.ok(withOpt.classes["normalized:bom-shift"]);
});

test("the option does nothing for a file without a byte order mark", () => {
  const src = srcTree("nobom-src", { "b.ts": "const a = 1;\n" });
  const a = tree("nobom-a", { "b.ts": { 6: "number" } });
  const b = tree("nobom-b", { "b.ts": { 6: "number" } });
  const r = diffTrees({ baseline: a, candidate: b, src, candidateCountsBom: true });
  assert.equal(r.totals.exact, 1);
});

// ---- the fixtures: TypeScript 6 output against the native expected maps ----

const rules = join(here, "..", "native", "testdata", "typemap", "rules");
const allowList = JSON.parse(readFileSync(join(here, "typemap-allow.json"), "utf8"));

test("native fixture maps against TypeScript 6 output: only reviewed classes", () => {
  const baseline = join(rules, "baseline-ts6", "src");
  const expected = join(rules, "expected");
  const cand = join(root, "native-rules", "src");
  cpSync(expected, cand, { recursive: true });
  const r = diffTrees({ baseline, candidate: cand, src: join(rules, "src") });
  assert.ok(r.totals.keys > 600, `keys: ${r.totals.keys}`);
  assert.ok(r.totals.agreementPercent >= 99, `agreement ${r.totals.agreementPercent}`);
  assert.deepEqual(checkAllowList(r, allowList), []);
  assert.ok(r.classes["normalized:union-order"], "the union order class is expected on these fixtures");
});

test("two copies of the same maps have no differences", () => {
  const a = join(root, "copy-a");
  const b = join(root, "copy-b");
  cpSync(join(rules, "expected"), a, { recursive: true });
  cpSync(join(rules, "expected"), b, { recursive: true });
  const r = diffTrees({ baseline: a, candidate: b, src: join(rules, "src") });
  assert.equal(r.totals.exact, r.totals.keys);
  assert.deepEqual(r.classes, {});
});

rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("typemap differ tests passed");
