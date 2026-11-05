// The streamed JSON writer must write exactly what JSON.stringify returns, with astgen's replacer
// and without one, and must never build the whole text as one string. These cases pin its
// agreement with JSON.stringify on the shapes that differ between objects and arrays (left-out
// values, holes, toJSON, boxed primitives, numbers that are not finite), on objects reached twice
// (Babel shares Position and SourceLocation objects; astgen's replacer writes a repeat as
// nothing), on random trees, on a real AST, across the writer's chunk boundary, and on deep
// nesting.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { writeJsonStream } from "../lib/streamJson.js";
import { getCircularReplacer } from "../astgen.js";

const dir = mkdtempSync(join(tmpdir(), "atom-parsetools-stream-json-"));
let count = 0;
const streamed = (value, replacer) => {
  const path = join(dir, `out-${count++}.json`);
  writeJsonStream(path, value, replacer);
  return readFileSync(path, "utf8");
};
const same = (name, value, makeReplacer) => {
  const expected = JSON.stringify(value, makeReplacer?.());
  assert.equal(streamed(value, makeReplacer?.()), expected, name);
  console.log(`ok - ${name}`);
};

try {
  same("objects leave out undefined, functions and symbols; arrays write them as null", {
    a: undefined,
    b: () => 1,
    c: Symbol("s"),
    d: [undefined, () => 1, Symbol("s"), 1],
    e: "kept"
  });
  same("holes in an array are null", [1, , 3]); // eslint-disable-line no-sparse-arrays
  same("numbers that are not finite are null, -0 is 0", [NaN, Infinity, -Infinity, -0, 1e21, 5e-7]);
  same("toJSON runs before the replacer", { when: new Date(0), custom: { toJSON: (k) => `key:${k}` } }, getCircularReplacer);
  same("boxed primitives are unwrapped", [new Number(3), new String("s"), new Boolean(false)]);
  same("strings escape as JSON.stringify escapes them", ["  ", "\ud800", "\"\\\n\t\u0001", "é😀"]);
  same("keys are escaped and keep their order", { "a\"b": 1, 2: "n", z: 2, 1: "m" });
  same("bigint is written as a string by astgen's replacer", { value: 12345678901234567890n }, getCircularReplacer);

  const shared = { line: 1, column: 2 };
  const loc = { start: shared, end: shared };
  same("an object reached twice is left out the second time", { a: { loc }, b: { loc }, c: [shared, shared] }, getCircularReplacer);
  // the same, against the text astgen has always written: a repeat is nothing in an object
  // and null in an array
  assert.equal(
    streamed({ a: { loc }, b: { loc }, c: [shared, shared] }, getCircularReplacer()),
    '{"a":{"loc":{"start":{"line":1,"column":2}}},"b":{},"c":[null,null]}'
  );

  const frozen = Object.freeze({ k: 1 });
  same("a frozen object reached twice is left out too", { a: frozen, b: frozen, c: [frozen] }, getCircularReplacer);

  const ast = parse(
    "import x from 'x';\n// a comment\nexport const f = (a, { b, c }) => x(a, b ?? c, 10n);\nclass K { #p = 1; get q() { return this.#p } }\n",
    { sourceType: "module", plugins: ["typescript"], errorRecovery: true }
  );
  same("a Babel AST with shared positions and comments", { fullName: "f.ts", ast }, getCircularReplacer);

  const big = Array.from({ length: 60000 }, (_, i) => ({ i, s: `value ${i}`, nested: [i, { k: i }] }));
  const bigText = JSON.stringify(big);
  assert.ok(bigText.length > 2 * (1 << 20), "the case crosses the writer's chunk size");
  same("a value larger than several chunks", big);

  // deep nesting: the writer uses an explicit stack, so depth cannot overflow its call stack
  let deep = [];
  const root = deep;
  for (let i = 0; i < 200000; i++) {
    const next = [];
    deep.push(next);
    deep = next;
  }
  assert.equal(streamed(root), `${"[".repeat(200001)}${"]".repeat(200001)}`);
  console.log("ok - nesting 200,000 levels deep");

  // a cycle without a replacer fails like JSON.stringify, and leaves no file behind
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const before = readdirSync(dir).length;
  assert.throws(() => writeJsonStream(join(dir, "cyclic.json"), cyclic), TypeError);
  assert.equal(existsSync(join(dir, "cyclic.json")), false);
  assert.equal(readdirSync(dir).length, before, "no temporary file is left");
  console.log("ok - a cycle throws and leaves no file");

  // random trees, with some subtrees reached twice (a seeded generator, so a failure repeats)
  let seed = 0x2f6b1;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const leaves = [null, undefined, NaN, -0, 0.5, true, false, "", "a\"b", "é", () => 1];
  const gen = (depth) => {
    const pick = depth > 4 ? 0 : rand(3);
    if (pick === 0) {
      return rand(2) ? leaves[rand(leaves.length)] : rand(2000) - 1000;
    }
    const children = Array.from({ length: rand(5) }, () => gen(depth + 1));
    return pick === 1 ? children : Object.fromEntries(children.map((v, i) => [`k${i}`, v]));
  };
  for (let run = 0; run < 300; run++) {
    const items = Array.from({ length: 1 + rand(5) }, () => gen(0));
    const value = { items, again: items[0], also: [items[items.length - 1]] };
    assert.equal(streamed(value, getCircularReplacer()), JSON.stringify(value, getCircularReplacer()));
    assert.equal(streamed({ items }), JSON.stringify({ items }));
  }
  console.log("ok - random trees with repeated subtrees");

  console.log("stream JSON regression tests passed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
