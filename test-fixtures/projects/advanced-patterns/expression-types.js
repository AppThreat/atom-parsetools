// Expression Types - Tests for binary, conditional, logical, and call expressions

// Binary expressions
const sum = 10 + 20;
const difference = 100 - 42;
const product = 6 * 7;
const quotient = 100 / 4;
const remainder = 10 % 3;
const powerVal = 2 ** 8;
const concat = "Hello" + " " + "World";
const isGreater = 10 > 5;
const isLess = 3 < 8;
const isGreaterEq = 10 >= 10;
const isLessEq = 5 <= 3;
const isEqual = 5 === 5;
const isNotEqual = 5 !== 3;
const isLooseEqual = 5 == "5";
const isLooseNotEqual = 5 != "3";

// Binary with variables
const a = 10;
const b = 20;
const c = 30;
const sumVars = a + b;
const diffVars = b - a;
const prodVars = a * b;
const quotVars = b / a;
const remVars = b % a;
const powerVars = a ** 2;
const gtr = a > b;
const lss = a < b;
const gte = a >= a;
const lte = a <= b;
const eq = a === 10;
const neq = a !== b;

// Bitwise operations
const andBits = 5 & 3;
const orBits = 5 | 3;
const xorBits = 5 ^ 3;
const notBits = ~5;
const leftShift = 5 << 1;
const rightShift = 8 >> 1;
const unsignedRight = 8 >>> 1;

// Conditional expressions
const positive = 10 > 0 ? "positive" : "non-positive";
const evenOdd = 4 % 2 === 0 ? "even" : "odd";
const sign = 5 > 0 ? 1 : (5 < 0 ? -1 : 0);
const discount = 100 > 50 ? 0.2 : 0.1;
const grade = 85 >= 90 ? "A" : (85 >= 80 ? "B" : (85 >= 70 ? "C" : "D"));

// Nested conditionals
const x = 10;
const y = 20;
const maxVal = x > y ? x : y;
const minVal = x < y ? x : y;
const range = x > 0 ? (x < 100 ? "normal" : "large") : "negative";

// Logical expressions
const bothTrue = true && true;
const eitherTrue = true || false;
const notTrue = !false;
const shortCircuitAnd = true && "value";
const shortCircuitOr = false || "default";
const logicalChain = true && false || true;

// Nullish coalescing
const nullVal = null;
const undefVal = undefined;
const coalesce1 = nullVal ?? "default";
const coalesce2 = undefVal ?? "default";
const coalesce3 = 0 ?? "default";
const coalesce4 = "" ?? "default";
const coalesce5 = false ?? "default";

// Logical assignment
let assignTarget1 = 10;
assignTarget1 &&= 20;
let assignTarget2 = 0;
assignTarget2 ||= 20;
let assignTarget3 = null;
assignTarget3 ??= 20;

// Call expressions - Math
const absVal = Math.abs(-10);
const maxVal2 = Math.max(1, 2, 3);
const minVal2 = Math.min(1, 2, 3);
const roundVal = Math.round(3.14);
const floorVal = Math.floor(3.9);
const ceilVal = Math.ceil(3.1);
const sqrtVal = Math.sqrt(16);
const powVal = Math.pow(2, 8);
const randomVal = Math.random();
const signVal = Math.sign(-5);
const truncVal = Math.trunc(3.7);
const clz32Val = Math.clz32(1);
const imulVal = Math.imul(2, 3);
const cbrtVal = Math.cbrt(27);
const log2Val = Math.log2(8);
const log10Val = Math.log10(100);
const expVal = Math.exp(1);
const logVal = Math.log(10);
const sinVal = Math.sin(Math.PI / 2);
const cosVal = Math.cos(0);
const tanVal = Math.tan(Math.PI / 4);

// Call expressions - String
const upperStr = "hello".toUpperCase();
const lowerStr = "HELLO".toLowerCase();
const slicedStr = "hello".slice(1, 4);
const substrStr = "hello".substring(1, 4);
const subStr = "hello".substr(1, 3);
const trimmedStr = " hello ".trim();
const trimStartStr = " hello ".trimStart();
const trimEndStr = " hello ".trimEnd();
const repeatedStr = "ab".repeat(3);
const includesStr = "hello".includes("ell");
const startsWithStr = "hello".startsWith("hel");
const endsWithStr = "hello".endsWith("lo");
const indexOfStr = "hello".indexOf("l");
const lastIndexOfStr = "hello".lastIndexOf("l");
const replacedStr = "hello".replace("l", "r");
const replacedAllStr = "hello".replaceAll("l", "r");
const splitStr = "a,b,c".split(",");
const charAtStr = "hello".charAt(1);
const charCodeAtStr = "hello".charCodeAt(1);
const paddedStartStr = "5".padStart(3, "0");
const paddedEndStr = "5".padEnd(3, "0");

// Call expressions - Array
const arr1 = [1, 2, 3];
const arr2 = ["a", "b", "c"];
const pushed = [1, 2].push(3);
const popped = [1, 2, 3].pop();
const shifted = [1, 2, 3].shift();
const unshifted = [1, 2].unshift(0);
const concatenated = [1, 2].concat([3, 4]);
const joined = [1, 2, 3].join("-");
const sliced = [1, 2, 3, 4].slice(1, 3);
const indexed = [1, 2, 3].indexOf(2);
const lastIdx = [1, 2, 3, 2].lastIndexOf(2);
const contains = [1, 2, 3].includes(2);
const flattened = [[1, 2], [3, 4]].flat();
const flatDeep = [[1, [2, [3]]]].flat(2);
const sorted = [3, 1, 2].toSorted();
const reversed = [1, 2, 3].toReversed();
const arrayWith = [1, 2, 3].with(1, 99);
const arrFind = [1, 2, 3].find(x => x > 1);
const arrFindIdx = [1, 2, 3].findIndex(x => x > 1);
const arrFindLast = [1, 2, 3, 2].findLast(x => x > 1);
const arrFindLastIdx = [1, 2, 3, 2].findLastIndex(x => x > 1);
const arrAt = [1, 2, 3].at(-1);
const arrSome = [1, 2, 3].some(x => x > 2);
const arrEvery = [1, 2, 3].every(x => x > 0);

// Function call return types
const len = Array.isArray([1, 2, 3]);
const isArray = Array.isArray([1]);
const isString = typeof "hello" === "string";
const isNumber = typeof 42 === "number";
const isBool = typeof true === "boolean";
const isObject = typeof {} === "object";
const isFunc = typeof function() {} === "function";

// Constructor calls
const date1 = new Date();
const date2 = new Date(2024, 0, 1);
const date3 = new Date("2024-01-01");
const regex1 = new RegExp("test");
const regex2 = new RegExp("test", "gi");
const err1 = new Error("message");
const err2 = new TypeError("type error");
const err3 = new RangeError("range error");
const err4 = new ReferenceError("ref error");
const err5 = new SyntaxError("syntax error");
const map1 = new Map();
const set1 = new Set();
const weakMap1 = new WeakMap();
const weakSet1 = new WeakSet();
const arrBuf = new ArrayBuffer(8);
const uint8 = new Uint8Array(8);
const int32 = new Int32Array(4);
const float64 = new Float64Array(2);
const dataView = new DataView(new ArrayBuffer(8));
const promise1 = new Promise((resolve) => resolve(1));
const promise2 = Promise.resolve(42);
const promise3 = Promise.reject(new Error("fail"));
const promiseAll = Promise.all([1, 2, 3]);
const promiseAny = Promise.any([1, 2, 3]);
const promiseRace = Promise.race([1, 2, 3]);
const promiseSettled = Promise.allSettled([1, 2, 3]);

// Template literals
const tmpl1 = `Hello, World`;
const name = "Alice";
const age = 30;
const tmpl2 = `Name: ${name}, Age: ${age}`;
const tmpl3 = `Sum: ${10 + 20}`;
const tmpl4 = `${"hello".toUpperCase()}`;
const tmpl5 = `Array: ${[1, 2, 3].join(", ")}`;
const tmpl6 = `Obj: ${JSON.stringify({ a: 1, b: 2 })}`;

// Tagged template literals
const tagResult = String.raw`Hello\nWorld`;

// Complex expression chains
const complex1 = Math.max(1, 2, 3) + Math.min(4, 5, 6);
const complex2 = "hello".toUpperCase().charAt(0);
const complex3 = [1, 2, 3].map(x => x * 2).reduce((a, b) => a + b);
const complex4 = { a: 1, b: 2 }.constructor.name;
const complex5 = new Date().getFullYear();
const complex6 = JSON.parse('{"a": 1}').a;

// Expression with side effects
let counter = 0;
const incResult = (counter++);
const decResult = (++counter);
const assignResult = (counter = 10);
const commaResult = (1, 2, 3);
const voidResult = void 0;

// Type narrowing expressions
const maybeString = "hello";
const narrowed = typeof maybeString === "string" ? maybeString.toUpperCase() : maybeString;

// Type guard expressions
const value = 42;
const isNum = typeof value === "number";
const isStr = typeof value === "string";
const isObj = typeof value === "object";
const isFunc2 = typeof value === "function";
const isInstance = value instanceof Number;
const isArray2 = value instanceof Array;
const isError = value instanceof Error;
const isDate = value instanceof Date;
const isRegExp = value instanceof RegExp;
const isMap = value instanceof Map;
const isSet = value instanceof Set;

// Safe navigation patterns
const safeProp = user?.name;
const safeMethod = user?.toString?.();
const safeIndex = [1, 2, 3]?.[0];
const safeChain = user?.address?.city;

// Optional chaining with expressions
const safeComputed = user?.["name"];
const safeCall = user?.toString?.();
const safeOptional = user?.address?.coords?.lat;

// Expression statements
void "unused";
delete globalThis.temp;
typeof undefined;
void 0;

// IIFE patterns
const iifeResult = ((x) => x * 2)(10);
const iifeObj = ((a, b) => ({ sum: a + b, diff: a - b }))(10, 3);
const iifeVoid = ((x) => { console.log(x); })(42);

// Spread in expressions
const spreadArr = [...[1, 2], ...[3, 4], 5];
const spreadObj = { ...{ a: 1 }, ...{ b: 2 }, c: 3 };
const spreadCall = Math.max(...[1, 2, 3]);

// Rest patterns
const [first, ...rest] = [1, 2, 3, 4];
const { a: aVal, ...restObj } = { a: 1, b: 2, c: 3 };

// Destructuring with defaults
const { x: xVal = 10, y: yVal = 20 } = { x: 5 };
const [p1 = 1, p2 = 2, p3 = 3] = [10];
const { nested: { deep = "default" } = {} } = { nested: {} };
