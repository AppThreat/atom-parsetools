// Test Fixture: ES6+ Features
// Tests type inference for modern JavaScript features

// === DESTRUCTURING ===
// Object destructuring
const { name, age } = { name: "Alice", age: 30 };
const { x, y, z = 10 } = { x: 1, y: 2 };
const { a: renamedA } = { a: 1 };
const { nested: { deep } } = { nested: { deep: "value" } };

// Array destructuring
const [first, second, third] = [1, 2, 3];
const [a, b, ...rest] = [1, 2, 3, 4, 5];
const [[nested1, nested2]] = [[1, 2]];

// Mixed destructuring
const { arr: [arrFirst, arrSecond] } = { arr: ["a", "b"] };

// === SPREAD OPERATOR ===
const obj1 = { a: 1, b: 2 };
const obj2 = { ...obj1, c: 3 };
const arr1 = [1, 2];
const arr2 = [...arr1, 3, 4];
const merged = { ...obj1, ...obj2, d: 4 };

// === OPTIONAL CHAINING ===
const obj = { a: { b: { c: 1 } } };
const safe1 = obj?.a;
const safe2 = obj?.a?.b;
const safe3 = obj?.a?.b?.c;
const safeMethod = obj?.a?.b?.toString?.();
const safeArray = [1, 2, 3]?.[0];

// === NULLISH COALESCING ===
const val1 = null ?? "default";
const val2 = undefined ?? "default";
const val3 = "" ?? "default";
const val4 = 0 ?? "default";
const val5 = false ?? "default";

// === LOGICAL ASSIGNMENT ===
let logObj = { a: 1 };
logObj.a ??= 2;
logObj.b ||= "b";
logObj.c &&= "c";

// === PRIVATE CLASS FIELDS ===
class Widget {
  #size = 10;
  #color = "red";
  #visible = true;

  getSize() {
    return this.#size;
  }

  getColor() {
    return this.#color;
  }
}

// === STATIC BLOCKS ===
class Calculator {
  static #instances = [];

  static {
    const initial = new Calculator();
    Calculator.#instances.push(initial);
  }

  static getInstance() {
    return Calculator.#instances[0];
  }
}

// === TOPLEVEL AWAIT ===
async function fetchData() {
  return { data: [1, 2, 3] };
}

const data = await fetchData();
const dataArray = data.data;

// === CLASS FIELDS ===
class Point {
  x = 0;
  y = 0;
  label = "origin";

  constructor(x, y, label) {
    this.x = x;
    this.y = y;
    this.label = label;
  }

  distance() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
}

// === ENUM-LIKE OBJECTS ===
const Days = {
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
  SUNDAY: 7
};

const Status = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected"
});

// === WEAKREF ===
const target = { value: 42 };
const weakRef = new WeakRef(target);
const deref = weakRef.deref();

// === FINALIZATIONREGISTRY ===
const registry = new FinalizationRegistry((value) => {
  console.log(value);
});
registry.register({ a: 1 }, "callback value");

// === ERROR CAUSE ===
try {
  throw new TypeError("Inner error");
} catch (cause) {
  const error = new Error("Outer error");
  error.cause = cause;
}

// === REGEX FEATURES ===
const regexV = /pattern/v;
const regexNames = /\p{Script=Latin}/gu;
const regexSet = /[a-z&&[def]]/v;

// === STRING METHODS ===
const str = "hello world";
const trimmed = str.trimStart();
const trimmedEnd = str.trimEnd();
const replacedAll = str.replaceAll("l", "r");
const isProto = Object.isFrozen({});
const structuredClone = structuredClone({ a: 1 });

// === ARRAY METHODS ===
const arr = [1, 2, 3, 4, 5];
const atResult = arr.at(-1);
const findLast = arr.findLast(x => x > 3);
const findLastIndex = arr.findLastIndex(x => x > 3);
const flat = [[1, 2], [3, [4, 5]]].flat();
const flatDeep = [[1, [2, [3]]]].flat(Infinity);
const toSorted = arr.toSorted();
const toReversed = arr.toReversed();
const toSpliced = arr.toSpliced(1, 2);
const withOp = arr.with(0, 100);

// === MAP/SET METHODS ===
const map = new Map([["a", 1], ["b", 2]]);
const mapKeys = map.keys();
const mapValues = map.values();
const mapEntries = map.entries();
const mapForEach = map.forEach((v, k) => v);

const set = new Set([1, 2, 3]);
const setSize = set.size;
const setHas = set.has(1);

const weakMap = new WeakMap();
const weakSet = new WeakSet();

// === OBJECT METHODS ===
const objEntries = Object.entries({ a: 1, b: 2 });
const objFromEntries = Object.fromEntries([["a", 1], ["b", 2]]);
const objHasOwn = Object.hasOwn({ a: 1 }, "a");
const objGroupBy = Object.groupBy([1, 2, 3], x => x > 1 ? "big" : "small");
const objCreate = Object.create({ proto: "value" });

// === MATH METHODS ===
const mathSign = Math.sign(-10);
const mathTrunc = Math.trunc(10.9);
const mathClz32 = Math.clz32(1);
const mathImul = Math.imul(2, 3);
const mathPow = Math.pow(2, 3);
const mathSqrt = Math.sqrt(16);
const mathCbrt = Math.cbrt(27);
const mathLog2 = Math.log2(8);
const mathLog10 = Math.log10(100);

// === NUMBER METHODS ===
const numIsFinite = Number.isFinite(10);
const numIsInteger = Number.isInteger(10);
const numIsSafeInteger = Number.isSafeInteger(10);
const numToInt32 = Number.parseInt("10");
const numToFloat = Number.parseFloat("10.5");
const numEpsilon = Number.EPSILON;
const numMaxSafe = Number.MAX_SAFE_INTEGER;

// === SYMBOL ===
const sym1 = Symbol("description");
const sym2 = Symbol.for("shared");
const symKeyFor = Symbol.keyFor(sym2);
const symIterator = Symbol.iterator;
const symToString = Symbol.toStringTag;

// === PROXY ===
const targetObj = { value: 1 };
const handler = {
  get(target, prop) {
    return target[prop];
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  }
};
const proxy = new Proxy(targetObj, handler);
const proxyValue = proxy.value;

// === REFLECT ===
const reflectHas = Reflect.has({ a: 1 }, "a");
const reflectGet = Reflect.get({ a: 1 }, "a");
const reflectSet = Reflect.set({ a: 1 }, "a", 2);
const reflectDelete = Reflect.deleteProperty({ a: 1 }, "a");
const reflectApply = Reflect.apply(Math.max, null, [1, 2, 3]);

// === PROMISE METHODS ===
const p1 = Promise.resolve(1);
const p2 = Promise.reject(new Error("err"));
const pAll = Promise.all([p1, p2]);
const pAllSettled = Promise.allSettled([p1, p2]);
const pRace = Promise.race([p1, p2]);
const pAny = Promise.any([p1, p2]);
const pWithResolvers = Promise.withResolvers();

// === ASYNC ITERATOR ===
async function* generate() {
  yield 1;
  yield 2;
  yield 3;
}

const asyncGen = generate();
const asyncNext = asyncGen.next();

// === ITERATOR HELPER ===
const iter = [1, 2, 3];
const iterFrom = Object.iterators?.(iter);
