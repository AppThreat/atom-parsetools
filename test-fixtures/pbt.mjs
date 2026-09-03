// Minimal, dependency-free replacement for the subset of the fast-check property-based-testing
// API used by the phpastgen `*-pbt.js` suites: constant, constantFrom, boolean, nat, integer,
// string, uint8Array, array, record, oneof, option, letrec, property, asyncProperty, assert, plus
// the chainable `.map`/`.filter` used on a couple of arbitraries.
//
// This intentionally is not a general-purpose PBT library — it implements exactly the combinators
// and semantics (recursive `letrec` with depth-bounded termination, weighted `oneof`, `record`
// with optional keys) the existing tests need, so their invariants keep being exercised against
// the same shape of randomized input as before, without a third-party dependency. There is no
// shrinker: a failure reports the run index, seed, and generated input instead.

// ---------------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic per run index so a failure is reproducible from the
// seed printed in the failure message.
// ---------------------------------------------------------------------------------------------
class Random {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  nextUint32() {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A float in [0, 1). */
  nextFloat() {
    return this.nextUint32() / 0x100000000;
  }

  /** An integer in [min, max] (inclusive on both ends). */
  nextInt(min, max) {
    if (max < min) {
      [min, max] = [max, min];
    }
    const span = max - min + 1;
    return min + Math.floor(this.nextFloat() * span);
  }

  nextBool(pTrue = 0.5) {
    return this.nextFloat() < pTrue;
  }
}

// ---------------------------------------------------------------------------------------------
// Arbitrary: a composable value generator. `generate(rnd, depth)` produces one value; `depth`
// tracks recursion through `letrec`-tied self-references so recursive structures terminate.
// ---------------------------------------------------------------------------------------------
class Arbitrary {
  constructor(generate) {
    this.generate = generate;
  }

  map(fn) {
    return new Arbitrary((rnd, depth) => fn(this.generate(rnd, depth)));
  }

  filter(predicate, maxTries = 1000) {
    return new Arbitrary((rnd, depth) => {
      for (let i = 0; i < maxTries; i++) {
        const value = this.generate(rnd, depth);
        if (predicate(value)) {
          return value;
        }
      }
      throw new Error(
        "Arbitrary.filter: exceeded max tries to satisfy predicate"
      );
    });
  }
}

export function constant(value) {
  return new Arbitrary(() => value);
}

export function constantFrom(...values) {
  if (values.length === 0) {
    throw new Error("constantFrom requires at least one value");
  }
  return new Arbitrary((rnd) => values[rnd.nextInt(0, values.length - 1)]);
}

export function boolean() {
  return new Arbitrary((rnd) => rnd.nextBool());
}

export function nat(opts = {}) {
  const max = opts.max ?? 0x7fffffff;
  return new Arbitrary((rnd) => rnd.nextInt(0, max));
}

export function integer(opts = {}) {
  const min = opts.min ?? -1_000_000;
  const max = opts.max ?? 1_000_000;
  return new Arbitrary((rnd) => rnd.nextInt(min, max));
}

const PRINTABLE_ASCII = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i)
);

/**
 * A full-range unicode code point, excluding the surrogate range (0xd800-0xdfff, which are not
 * valid standalone code points) so `String.fromCodePoint` always succeeds. Used for the
 * "grapheme" string unit so full-unicode (including astral-plane) text is exercised.
 */
function randomCodePoint(rnd) {
  let cp;
  do {
    cp = rnd.nextInt(0, 0x10ffff);
  } while (cp >= 0xd800 && cp <= 0xdfff);
  return cp;
}

/**
 * One "binary" string unit: an arbitrary UTF-16 code unit (0x0000-0xffff), including lone
 * surrogates. `Buffer.from(str, "utf-8")` maps unpaired surrogates to U+FFFD, so this always
 * yields valid UTF-8 bytes on encode — it exists to stress that path, not to produce invalid text.
 */
function randomCodeUnit(rnd) {
  return String.fromCharCode(rnd.nextInt(0, 0xffff));
}

/**
 * `opts.unit` selects the alphabet: `"binary"` (arbitrary UTF-16 code units), `"grapheme"`
 * (full-unicode code points), another arbitrary (each character drawn from it), or omitted
 * (printable ASCII).
 */
export function string(opts = {}) {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? 10;
  const unit = opts.unit;
  return new Arbitrary((rnd, depth) => {
    const length = rnd.nextInt(minLength, maxLength);
    let out = "";
    for (let i = 0; i < length; i++) {
      if (unit === "binary") {
        out += randomCodeUnit(rnd);
      } else if (unit === "grapheme") {
        out += String.fromCodePoint(randomCodePoint(rnd));
      } else if (unit instanceof Arbitrary) {
        out += unit.generate(rnd, depth);
      } else {
        out += PRINTABLE_ASCII[rnd.nextInt(0, PRINTABLE_ASCII.length - 1)];
      }
    }
    return out;
  });
}

export function uint8Array(opts = {}) {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? 50;
  return new Arbitrary((rnd) => {
    const length = rnd.nextInt(minLength, maxLength);
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = rnd.nextInt(0, 255);
    }
    return out;
  });
}

export function array(arb, opts = {}) {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? 10;
  return new Arbitrary((rnd, depth) => {
    const length = rnd.nextInt(minLength, maxLength);
    return Array.from({ length }, () => arb.generate(rnd, depth));
  });
}

/**
 * `opts.requiredKeys`, when given, names the keys that are always present; every other key is
 * included only about half the time (entirely omitted, not just `undefined`, the rest of the
 * time) — fast-check's optional-record-key behavior. Without `opts`, every key is always present,
 * which is the common case in these tests.
 */
export function record(shape, opts = {}) {
  const keys = Object.keys(shape);
  const requiredKeys = opts.requiredKeys ?? keys;
  return new Arbitrary((rnd, depth) => {
    const out = {};
    for (const key of keys) {
      if (requiredKeys.includes(key) || rnd.nextBool(0.5)) {
        out[key] = shape[key].generate(rnd, depth);
      }
    }
    return out;
  });
}

/**
 * Accepts a mix of plain arbitraries and `{ weight, arbitrary }` entries (fast-check's weighted
 * `oneof` form); plain arbitraries get weight 1.
 */
export function oneof(...args) {
  const items = args.map((a) =>
    a instanceof Arbitrary ? { weight: 1, arbitrary: a } : a
  );
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  return new Arbitrary((rnd, depth) => {
    let r = rnd.nextFloat() * total;
    for (const item of items) {
      if (r < item.weight) {
        return item.arbitrary.generate(rnd, depth);
      }
      r -= item.weight;
    }
    return items[items.length - 1].arbitrary.generate(rnd, depth);
  });
}

/**
 * `arb`'s value, or `nil`. The probability of `nil` grows with recursion depth (as tracked
 * through `letrec`'s `tie`) and is forced to 1 past `MAX_DEPTH`, so self-referential arbitraries
 * built with `letrec` always terminate regardless of how deeply the caller composes them, while
 * still reaching moderately deep/wide structures often enough to stress depth-sensitive code.
 */
const MAX_DEPTH = 20;
export function option(arb, opts = {}) {
  const nil = Object.hasOwn(opts, "nil") ? opts.nil : null;
  return new Arbitrary((rnd, depth = 0) => {
    const pNil = depth >= MAX_DEPTH ? 1 : Math.min(1, 0.12 + depth * 0.06);
    if (rnd.nextFloat() < pNil) {
      return nil;
    }
    return arb.generate(rnd, depth + 1);
  });
}

/**
 * Builds a set of mutually (and self-) referential arbitraries. `builder(tie)` returns an object
 * of named arbitraries; `tie(name)` returns a lazy reference to another entry of that same
 * object, resolved at generation time (after every entry exists), so direct or mutual recursion
 * is safe even though the entries are defined in one pass.
 */
export function letrec(builder) {
  const result = {};
  const tie = (name) =>
    new Arbitrary((rnd, depth) => result[name].generate(rnd, depth));
  Object.assign(result, builder(tie));
  return result;
}

export function property(...args) {
  const predicate = args[args.length - 1];
  const arbs = args.slice(0, -1);
  return { arbs, predicate, isAsync: false };
}

export function asyncProperty(...args) {
  const predicate = args[args.length - 1];
  const arbs = args.slice(0, -1);
  return { arbs, predicate, isAsync: true };
}

function jsonReplacer(_key, value) {
  return value instanceof Uint8Array ? Array.from(value) : value;
}

/**
 * Runs `property.predicate` over `opts.numRuns` (default 100) freshly generated inputs, each with
 * its own seed. On failure the thrown error is re-wrapped with the run index, seed, and generated
 * input so the failure is reproducible without a shrinker. Returns a Promise for an
 * `asyncProperty` (callers `await` it); runs synchronously and returns `undefined` otherwise —
 * matching how these tests call `fc.assert`, with or without `await`.
 */
export function assert(property, opts = {}) {
  const numRuns = opts.numRuns ?? 100;

  const runOne = (i) => {
    const seed = ((Date.now() ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0) || 1;
    const rnd = new Random(seed);
    const values = property.arbs.map((arb) => arb.generate(rnd, 0));
    return { seed, values };
  };

  const describeFailure = (i, seed, values, err) =>
    new Error(
      `Property failed on run ${i}/${numRuns} (seed ${seed}) with input ` +
        `${JSON.stringify(values, jsonReplacer)}: ${err.message}`,
      { cause: err }
    );

  if (property.isAsync) {
    return (async () => {
      for (let i = 0; i < numRuns; i++) {
        const { seed, values } = runOne(i);
        try {
          await property.predicate(...values);
        } catch (err) {
          throw describeFailure(i, seed, values, err);
        }
      }
    })();
  }

  for (let i = 0; i < numRuns; i++) {
    const { seed, values } = runOne(i);
    try {
      property.predicate(...values);
    } catch (err) {
      throw describeFailure(i, seed, values, err);
    }
  }
}
