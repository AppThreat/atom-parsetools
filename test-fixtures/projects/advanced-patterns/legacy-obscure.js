// Legacy and Obscure JavaScript Patterns - Fixed
// Tests for less common syntaxes and edge cases

// === LABEL STATEMENTS ===
const labeledResult = (() => {
  let result = 0;
  outerLoop:
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) break outerLoop;
      result++;
    }
  }
  return result;
})();

const labeledContinue = (() => {
  const results = [];
  outer:
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if (j === 2) continue outer;
      results.push(i * 10 + j);
    }
  }
  return results;
})();

// === COMMA OPERATOR ===
const commaResult = (1, 2, 3);
const commaExpression = (() => {
  let a = 0;
  let b = (a++, a++, a++);
  return a;
})();

const commaInFor = (() => {
  const arr = [];
  for (let i = 0, j = 10; i < 5; i++, j--) {
    arr.push(i + j);
  }
  return arr;
})();

// === VOID OPERATOR ===
const voidResult = void 0;
const voidExpr = void (1 + 2);
const voidFunction = void function() { return 42; };

// === DELETE OPERATOR ===
const deleteTarget = { a: 1, b: 2, c: 3 };
const deleteResult = delete deleteTarget.a;
const deleteNested = { nested: { value: 42 } };
const deleteNestedResult = delete deleteNested.nested.value;

// === WITH STATEMENT ===
const withResult = (() => {
  const obj = { x: 10, y: 20 };
  let sum = 0;
  with (obj) {
    sum = x + y;
  }
  return sum;
})();

// === IN OPERATOR ===
const inObj = { a: 1, b: 2, c: 3 };
const inResult = "a" in inObj;
const inArray = [1, 2, 3];
const inArrayResult = "1" in inArray;
const inPrototype = (() => {
  const obj = { __proto__: { inherited: true } };
  return "inherited" in obj;
})();

// === INSTANCEOF OPERATOR ===
const instanceofDate = new Date() instanceof Date;
const instanceofArray = [1, 2, 3] instanceof Array;
const instanceofObject = {} instanceof Object;
const instanceofFunction = function() {} instanceof Function;
const instanceofError = new Error() instanceof Error;
const instanceofRegExp = /test/ instanceof RegExp;
const instanceofMap = new Map() instanceof Map;
const instanceofSet = new Set() instanceof Set;
const instanceofPromise = Promise.resolve() instanceof Promise;

// === PROTOTYPE CHAIN MANIPULATION ===
const protoObj = { base: true };
const childObj = Object.create(protoObj);
childObj.derived = false;
const protoResult = Object.getPrototypeOf(childObj);
const protoChain = Object.getPrototypeOf(protoObj);
const protoHasBase = protoObj.base;
const protoHasDerived = childObj.derived;

// === OBJECT.DEFINEPROPERTY PATTERNS ===
const definedProp = {};
Object.defineProperty(definedProp, "name", {
  value: "defined",
  writable: true,
  enumerable: true,
  configurable: true
});
Object.defineProperty(definedProp, "age", {
  value: 30,
  writable: false,
  enumerable: false,
  configurable: false
});
Object.defineProperty(definedProp, "computed", {
  get: function() { return this.name.toUpperCase(); },
  set: function(val) { this.name = val.toLowerCase(); },
  enumerable: true,
  configurable: true
});
const definedPropDescriptor = Object.getOwnPropertyDescriptor(definedProp, "name");
const definedPropKeys = Object.keys(definedProp);
const definedPropValues = Object.values(definedProp);

// === OBJECT.GETOWNPROPERTYSYMBOLS ===
const symObj = {};
const sym1 = Symbol("first");
const sym2 = Symbol("second");
symObj[sym1] = "value1";
symObj[sym2] = "value2";
const symKeys = Object.getOwnPropertySymbols(symObj);
const symValues = symKeys.map(k => symObj[k]);

// === OBJECT.FREEZE / SEAL / ISFROZEN / ISSEALED ===
const frozenObj = Object.freeze({ a: 1, b: 2 });
const sealedObj = Object.seal({ c: 3, d: 4 });
const isFrozen = Object.isFrozen(frozenObj);
const isSealed = Object.isSealed(sealedObj);
const isExtensible = Object.isExtensible({ e: 5 });
const preventExtensions = Object.preventExtensions({ f: 6 });
const isPrevented = Object.isExtensible(preventExtensions);

// === OBJECT.IS PATTERNS ===
const isNaNResult = Object.is(NaN, NaN);
const isNegativeZero = Object.is(-0, +0);
const isUndefined = Object.is(undefined, undefined);
const isNullResult = Object.is(null, null);
const isStringResult = Object.is("a", "a");
const isNumberResult = Object.is(1, 1);

// === REFLECT API ===
const reflectTarget = { x: 10, y: 20 };
const reflectHas = Reflect.has(reflectTarget, "x");
const reflectGet = Reflect.get(reflectTarget, "x");
const reflectSet = Reflect.set(reflectTarget, "z", 30);
const reflectDelete = Reflect.deleteProperty(reflectTarget, "z");
const reflectOwnKeys = Reflect.ownKeys(reflectTarget);
const reflectPrototypeOf = Reflect.getPrototypeOf(reflectTarget);
const reflectIsExtensible = Reflect.isExtensible(reflectTarget);
const reflectPreventExtensions = Reflect.preventExtensions(reflectTarget);
const reflectIsExtensibleAfter = Reflect.isExtensible(reflectTarget);

// === PROXY PATTERNS ===
const proxyTarget = { a: 1, b: 2 };
const proxyHandler = {
  get(target, prop) {
    return prop in target ? target[prop] : "default";
  },
  set(target, prop, value) {
    target[prop] = value * 2;
    return true;
  },
  has(target, prop) {
    return prop in target;
  },
  deleteProperty(target, prop) {
    delete target[prop];
    return true;
  },
  ownKeys(target) {
    return Object.keys(target);
  },
  getOwnPropertyDescriptor(target, prop) {
    return { value: target[prop], writable: true, enumerable: true, configurable: true };
  }
};
const proxy = new Proxy(proxyTarget, proxyHandler);
const proxyGet = proxy.a;
const proxyHas = "a" in proxy;
const proxyKeys = Object.keys(proxy);

// === WEAKREF PATTERNS ===
const weakRefTarget = { value: 42 };
const weakRef = new WeakRef(weakRefTarget);
const weakRefDeref = weakRef.deref();
const weakRefValue = weakRefDeref?.value;

// === FINALIZATIONREGISTRY PATTERNS ===
const heldValue = { id: 1 };
const registry = new FinalizationRegistry((value) => {
  console.log("Finalized:", value);
});
registry.register(heldValue, heldValue.id);

// === SHAREDARRAYBUFFER AND ATOMICS ===
const sharedBuffer = new SharedArrayBuffer(1024);
const sharedInt32 = new Int32Array(sharedBuffer);
const atomicsLoad = Atomics.load(sharedInt32, 0);
const atomicsStore = Atomics.store(sharedInt32, 0, 42);
const atomicsAdd = Atomics.add(sharedInt32, 0, 10);
const atomicsSubtract = Atomics.subtract(sharedInt32, 0, 5);
const atomicsMax = Atomics.max(sharedInt32, 0, 100);
const atomicsMin = Atomics.min(sharedInt32, 0, 50);
const atomicsAnd = Atomics.and(sharedInt32, 0, 255);
const atomicsOr = Atomics.or(sharedInt32, 0, 128);
const atomicsXor = Atomics.xor(sharedInt32, 0, 64);
const atomicsExchange = Atomics.exchange(sharedInt32, 0, 99);
const atomicsCompareExchange = Atomics.compareExchange(sharedInt32, 0, 99, 100);
const atomicsIsLockFree = Atomics.isLockFree(4);

// === MAP/SET ADVANCED PATTERNS ===
const mapWithKeys = new Map([
  ["string", "value"],
  [1, "one"],
  [true, "yes"],
  [null, "nil"],
  [undefined, "und"],
  [Symbol("sym"), "symbol"]
]);
const mapSize = mapWithKeys.size;
const mapHasString = mapWithKeys.has("string");
const mapGetString = mapWithKeys.get("string");
const mapHasNum = mapWithKeys.has(1);
const mapKeys = mapWithKeys.keys();
const mapValues = mapWithKeys.values();
const mapEntries = mapWithKeys.entries();

const setWithValues = new Set([1, "one", true, null, undefined, Symbol("sym")]);
const setSize = setWithValues.size;
const setHas1 = setWithValues.has(1);
const setHasOne = setWithValues.has("one");
const setKeys = setWithValues.keys();
const setValues = setWithValues.values();
const setEntries = setWithValues.entries();

// === WEAKMAP PATTERNS ===
const weakMap = new WeakMap();
const wmKey1 = { name: "first" };
const wmKey2 = { name: "second" };
weakMap.set(wmKey1, { value: 1 });
weakMap.set(wmKey2, { value: 2 });
const wmHas1 = weakMap.has(wmKey1);
const wmGet1 = weakMap.get(wmKey1);
const wmGet2 = weakMap.get(wmKey2);

// === WEAKSET PATTERNS ===
const weakSet = new WeakSet();
const wsItem1 = { id: 1 };
const wsItem2 = { id: 2 };
weakSet.add(wsItem1);
weakSet.add(wsItem2);
const wsHas1 = weakSet.has(wsItem1);
const wsHas2 = weakSet.has(wsItem2);

// === STRUCTURED CLONE ===
const cloneSource = { a: 1, b: [2, 3], c: { d: 4 } };
const cloneResult = structuredClone(cloneSource);
const cloneArray = structuredClone([1, 2, 3]);
const cloneDate = structuredClone(new Date());
const cloneRegex = structuredClone(/test/gi);

// === GLOBALTHIS ===
const globalThisResult = globalThis;
const globalThisConstructor = globalThis.constructor;
const globalThisName = globalThis.constructor.name;

// === ARGUMENTS OBJECT ===
const argsResult = (() => {
  function sumArgs() {
    let sum = 0;
    for (let i = 0; i < arguments.length; i++) {
      sum += arguments[i];
    }
    return sum;
  }
  return sumArgs(1, 2, 3, 4, 5);
})();

const argsLength = (() => {
  function getArgsLength() {
    return arguments.length;
  }
  return getArgsLength(1, 2, 3);
})();

// === FUNCTION.PROTOTYPE MANIPULATION ===
function BaseClass(name) {
  this.name = name;
}
BaseClass.prototype.greet = function() {
  return "Hello, " + this.name;
};

function DerivedClass(name, age) {
  BaseClass.call(this, name);
  this.age = age;
}
DerivedClass.prototype = Object.create(BaseClass.prototype);
DerivedClass.prototype.constructor = DerivedClass;
DerivedClass.prototype.introduce = function() {
  return this.greet() + ". Age: " + this.age;
};

const baseInstance = new BaseClass("Alice");
const derivedInstance = new DerivedClass("Bob", 30);
const baseGreet = baseInstance.greet();
const derivedIntroduce = derivedInstance.introduce();
const derivedGreet = derivedInstance.greet();

// === DYNAMIC PROPERTIES ===
const dynamicProps = {};
dynamicProps["key1"] = "value1";
dynamicProps["key2"] = "value2";
dynamicProps[Symbol.for("shared")] = "shared";
const dynamicKeys = Object.keys(dynamicProps);
const dynamicSymbols = Object.getOwnPropertySymbols(dynamicProps);

// === COMPUTED PROPERTY NAMES ===
const computed1 = "prop";
const computed2 = Symbol("sym");
const computedObj = {
  [computed1]: "value1",
  [computed2]: "value2",
  ["dynamic" + "Key"]: "value3",
  [10 + 20]: "value4",
  [true ? "a" : "b"]: "value5"
};
const computedKeys = Object.keys(computedObj);

// === OBJECT LITERAL SHORTHAND ===
const x = 10;
const y = 20;
const z = 30;
const shorthandObj = { x, y, z };
const shorthandKeys = Object.keys(shorthandObj);
const shorthandValues = Object.values(shorthandObj);

// === METHOD SHORTHAND ===
const methodObj = {
  name: "method",
  getName() { return this.name; },
  setName(n) { this.name = n; return this; },
  toString() { return this.name; }
};
const methodName = methodObj.getName();

// === GETTER/SETTER IN OBJECT LITERALS ===
const getterSetterObj = {
  _value: 42,
  get value() { return this._value; },
  set value(v) { this._value = v; },
  get doubled() { return this._value * 2; },
  get isPositive() { return this._value > 0; }
};
const getterValue = getterSetterObj.value;
const getterDoubled = getterSetterObj.doubled;
const getterIsPositive = getterSetterObj.isPositive;

// === SYMBOL.ITERATOR IMPLEMENTATION ===
const customIterable = {
  data: [1, 2, 3, 4, 5],
  [Symbol.iterator]() {
    let index = 0;
    const data = this.data;
    return {
      next() {
        if (index < data.length) {
          return { value: data[index++], done: false };
        }
        return { value: undefined, done: true };
      }
    };
  }
};
const iterableResult = [...customIterable];
const iterableArray = Array.from(customIterable);

// === SYMBOL.TOSTRING_TAG ===
const taggedObj = {
  [Symbol.toStringTag]: "CustomObject",
  value: 42
};
const taggedResult = Object.prototype.toString.call(taggedObj);

// === REGEXP ADVANCED PATTERNS ===
const regexUnicode = /\p{Emoji}/u;
const regexTest = regexUnicode.test("A");

// === STRING ADVANCED METHODS ===
const strMatchAll = [..."abcabc".matchAll(/ab/g)];

// === ERROR CAUSE PATTERN ===
const errorWithCause = new Error("Outer error", { cause: new Error("Inner error") });
const errorCause = errorWithCause.cause;
const errorCauseMessage = errorCause?.message;

// === BIGINT OPERATIONS ===
const bigInt1 = 100n;
const bigInt2 = 200n;
const bigIntSum = bigInt1 + bigInt2;
const bigIntDiff = bigInt2 - bigInt1;
const bigIntProd = bigInt1 * bigInt2;
const bigIntQuot = bigInt2 / bigInt1;
const bigIntRem = bigInt2 % bigInt1;
const bigIntPow = bigInt1 ** 2;
const bigIntNeg = -bigInt1;

// === NUMBER ADVANCED METHODS ===
const numberIsFinite = Number.isFinite(42);
const numberIsInteger = Number.isInteger(42);
const numberIsSafeInteger = Number.isSafeInteger(42);
const numberIsNaN = Number.isNaN(42);
const numberEpsilon = Number.EPSILON;
const numberMaxSafe = Number.MAX_SAFE_INTEGER;
const numberMinSafe = Number.MIN_SAFE_INTEGER;

// === MATH ADVANCED METHODS ===
const mathSign = Math.sign(-5);
const mathTrunc = Math.trunc(3.7);
const mathClz32 = Math.clz32(1);
const mathImul = Math.imul(2, 3);
const mathCbrt = Math.cbrt(27);
const mathLog2 = Math.log2(8);
const mathLog10 = Math.log10(100);
const mathLog1p = Math.log1p(1);
const mathExpM1 = Math.expm1(1);
const mathSinh = Math.sinh(1);
const mathCosh = Math.cosh(1);
const mathTanh = Math.tanh(1);
const mathAsinh = Math.asinh(1);
const mathAcosh = Math.acosh(1);
const mathAtanh = Math.atanh(0.5);
const mathHypot = Math.hypot(3, 4);

// === DATE ADVANCED PATTERNS ===
const dateNow = Date.now();
const dateParse = Date.parse("2024-01-01");
const dateUTC = Date.UTC(2024, 0, 1);
const dateFromTime = new Date(Date.now());
const dateGetYear = dateFromTime.getFullYear();
const dateGetMonth = dateFromTime.getMonth();
const dateGetDate = dateFromTime.getDate();
const dateGetDay = dateFromTime.getDay();
const dateGetHours = dateFromTime.getHours();
const dateGetMinutes = dateFromTime.getMinutes();
const dateGetSeconds = dateFromTime.getSeconds();
const dateGetMs = dateFromTime.getMilliseconds();
const dateISOString = dateFromTime.toISOString();
const dateLocaleString = dateFromTime.toLocaleString();

// === JSON ADVANCED PATTERNS ===
const jsonString = JSON.stringify({ a: 1, b: 2 });
const jsonObject = JSON.parse('{"a": 1, "b": 2}');
const jsonRevive = JSON.parse('{"a": 1}', (k, v) => typeof v === "number" ? v * 2 : v);
const jsonReplacer = JSON.stringify({ a: 1, b: 2 }, (k, v) => k === "b" ? undefined : v);

// === URI ENCODING/DECODING ===
const uriEncoded = encodeURIComponent("hello world");
const uriDecoded = decodeURIComponent(uriEncoded);
const uriComponent = encodeURI("https://example.com/path?query=value");
const uriDecomponent = decodeURI(uriComponent);

// === EVAL PATTERNS ===
const evalResult = eval("1 + 2");
const evalExpr = eval("2 * 3");

// === CONSTRUCTOR FUNCTIONS ===
function OldStyle(x, y) {
  this.x = x;
  this.y = y;
  this.sum = function() { return this.x + this.y; };
}
OldStyle.prototype.product = function() { return this.x * this.y; };
const oldStyle = new OldStyle(3, 4);
const oldStyleSum = oldStyle.sum();
const oldStyleProduct = oldStyle.product();

// === FUNCTION BINDING ===
const boundFn = function(x, y) { return x + y; }.bind(null, 10);
const boundResult = boundFn(20);

const boundMethod = {
  multiplier: 2,
  multiply(x) { return x * this.multiplier; }
};
const boundMultiply = boundMethod.multiply.bind(boundMethod);
const boundMultiplyResult = boundMultiply(10);

// === FUNCTION APPLY/CALL ===
const applyResult = Math.max.apply(null, [1, 2, 3]);
const callResult = Math.max.call(null, 1, 2, 3);

// === IIFE VARIANTS ===
const iifeVoid = void function() { return 42; }();
const iifePlus = +function() { return 42; }();
const iifeMinus = -function() { return 42; }();
const iifeNot = !function() { return 42; }();
const iifeTilde = ~function() { return 42; }();
const iifeParen = (function() { return 42; })();
const iifeArrow = ((() => 42)());

// === BITWISE PATTERNS ===
const bitAnd = 5 & 3;
const bitOr = 5 | 3;
const bitXor = 5 ^ 3;
const bitNot = ~5;
const bitLeft = 5 << 1;
const bitRight = 8 >> 1;
const bitUnsigned = 8 >>> 1;
const bitMask = 255 & 0xFF;
const bitSet = 5 | 1;
const bitClear = 5 & ~1;
const bitToggle = 5 ^ 1;
const bitTest = 5 & 1;

// === TYPE CONVERSION PATTERNS ===
const toNumber = Number("42");
const toBool = Boolean("true");
const toString = String(42);
const toInt = parseInt("42px");
const toFloat = parseFloat("42.5px");
const toObject = Object(null);
const toArray = Array.from("123");

// === TYPEOF PATTERNS ===
const typeofString = typeof "hello";
const typeofNumber = typeof 42;
const typeofBoolean = typeof true;
const typeofUndefined = typeof undefined;
const typeofNull = typeof null;
const typeofObject = typeof {};
const typeofArray = typeof [];
const typeofFunction = typeof function() {};
const typeofSymbol = typeof Symbol();
const typeofBigInt = typeof 42n;
