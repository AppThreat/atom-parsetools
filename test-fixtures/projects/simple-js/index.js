// Test Fixture: Pure JavaScript Type Inference
// This file contains various JavaScript constructs with known inferred types
// Used to test and measure the accuracy of TypeScript compiler API type inference

// === PRIMITIVE TYPES ===
const str = "hello";
const num = 42;
const bool = true;
const nill = null;
const und = undefined;
const bigint = 100n;
const sym = Symbol("id");

// === LITERAL TYPES ===
const color = "red";
const status = 200;
const flag = true;

// === ARRAYS ===
const numArr = [1, 2, 3];
const strArr = ["a", "b", "c"];
const mixedArr = [1, "two", true];
const nestedArr = [[1, 2], [3, 4]];
const arrOfObjects = [{ id: 1 }, { id: 2 }];

// === OBJECTS ===
const point = { x: 10, y: 20 };
const user = { name: "Alice", age: 30, active: true };
const nestedObj = { a: { b: { c: 1 } } };
const objWithArray = { items: [1, 2, 3] };
const emptyObj = {};

// === FUNCTIONS ===
function add(a, b) {
  return a + b;
}

function greet(name) {
  return "Hello, " + name;
}

function isEven(n) {
  return n % 2 === 0;
}

function noReturn() {
  console.log("side effect");
}

function returnsObject() {
  return { id: 1, name: "test" };
}

function returnsArray() {
  return [1, 2, 3];
}

function returnsNull() {
  return null;
}

function returnsMixed() {
  return Math.random() > 0.5 ? "yes" : 42;
}

// === ARROW FUNCTIONS ===
const multiply = (a, b) => a * b;
const square = x => x * x;
const identity = x => x;
const arrowReturnsObj = () => ({ key: "value" });

// === CLASS ===
class Person {
  constructor(name, age) {
    this.name = name;
    this.age = age;
  }

  getName() {
    return this.name;
  }

  getAge() {
    return this.age;
  }

  isAdult() {
    return this.age >= 18;
  }

  static create(name, age) {
    return new Person(name, age);
  }
}

class Animal {
  constructor(species) {
    this.species = species;
  }

  speak() {
    return `${this.species} makes a sound`;
  }
}

// === MODULE IMPORTS/EXPORTS ===
import { add as addFn } from "./math.js";
const importedStr = "imported";

export const exportedNum = 100;
export function exportedFunc(x) {
  return x * 2;
}

// === DYNAMIC TYPES ===
const dynamicType = Math.random() > 0.5 ? "string" : 42;
const maybeNull = Math.random() > 0.5 ? "value" : null;
const maybeUndefined = Math.random() > 0.5 ? 1 : undefined;

// === DESTRUCTURING ===
const { x: px, y: py } = point;
const [first, second] = numArr;
const { name: userName, age: userAge } = user;

// === SPREAD OPERATOR ===
const spreadObj = { ...point, z: 30 };
const spreadArr = [...numArr, 4];

// === OPTIONAL CHAINING ===
const safeProp = user?.address?.street;
const safeMethod = user?.getName?.();
const safeIndex = numArr?.[0];

// === NULLISH COALESCING ===
const defaultValue = und ?? "default";
const nullDefault = nill ?? "fallback";

// === TERNARY ===
const ternaryStr = true ? "yes" : "no";
const ternaryNum = false ? 1 : 2;

// === PROMISES ===
const promise = new Promise((resolve, reject) => {
  resolve("fulfilled");
});

async function asyncFunc() {
  return "async value";
}

const asyncArrow = async () => 42;

// === MAP/SET ===
const map = new Map();
map.set("key", "value");

const set = new Set();
set.add(1);
set.add(2);

// === REGEX ===
const regex = /pattern/gi;
const regexStr = new RegExp("test", "g");

// === DATE ===
const date = new Date();
const dateStr = new Date("2024-01-01");

// === ERROR ===
const error = new Error("something went wrong");
const typeError = new TypeError("type issue");

// === MATH ===
const mathPi = Math.PI;
const mathRandom = Math.random();

// === STRING METHODS ===
const upperCase = str.toUpperCase();
const substring = str.substring(0, 3);
const splitArr = str.split("");
const replaced = str.replace("h", "H");
const indexOf = str.indexOf("e");
const startsWith = str.startsWith("he");

// === ARRAY METHODS ===
const mapped = numArr.map(x => x * 2);
const filtered = numArr.filter(x => x > 1);
const reduced = numArr.reduce((acc, x) => acc + x, 0);
const found = numArr.find(x => x > 2);
const someResult = numArr.some(x => x > 5);
const everyResult = numArr.every(x => x > 0);
const joined = strArr.join("-");
const indexOfArr = numArr.indexOf(2);
const includes = numArr.includes(2);

// === OBJECT METHODS ===
const keys = Object.keys(user);
const values = Object.values(user);
const entries = Object.entries(user);
const hasProp = Object.hasOwn(user, "name");
const frozen = Object.freeze({ a: 1 });
const sealed = Object.seal({ b: 2 });

// === TYPEOF ===
const typeOfStr = typeof str;
const typeOfNum = typeof num;
const typeOfObj = typeof point;

// === COMPLEX SCENARIOS ===
function processUsers(users) {
  return users.map(u => ({
    ...u,
    displayName: u.name.toUpperCase(),
    isActive: u.active === true
  }));
}

function findUser(users, name) {
  return users.find(u => u.name === name);
}

function groupBy(arr, key) {
  return arr.reduce((groups, item) => {
    const group = item[key];
    groups[group] = groups[group] || [];
    groups[group].push(item);
    return groups;
  }, {});
}

function pipe(...fns) {
  return val => fns.reduce((v, f) => f(v), val);
}

function compose(...fns) {
  return val => fns.reduceRight((v, f) => f(v), val);
}

// === FOR LOOPS ===
let sum = 0;
for (let i = 0; i < 10; i++) {
  sum += i;
}

let forEachSum = 0;
numArr.forEach(x => {
  forEachSum += x;
});

// === WHILE LOOPS ===
let whileCount = 0;
while (whileCount < 5) {
  whileCount++;
}

// === TRY-CATCH ===
function safeParse(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

// === CONDITIONAL STATEMENTS ===
function classify(num) {
  if (num > 0) {
    return "positive";
  } else if (num < 0) {
    return "negative";
  } else {
    return "zero";
  }
}

// === SWITCH ===
function dayName(day) {
  switch (day) {
    case 1:
      return "Monday";
    case 2:
      return "Tuesday";
    default:
      return "Other";
  }
}

// === CLOSURES ===
function counter() {
  let count = 0;
  return {
    increment: () => ++count,
    decrement: () => --count,
    getCount: () => count
  };
}

// === HIGHER-ORDER FUNCTIONS ===
function forEach(arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    fn(arr[i], i);
  }
}

function map(arr, fn) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    result.push(fn(arr[i], i));
  }
  return result;
}

function filter(arr, fn) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (fn(arr[i], i)) {
      result.push(arr[i]);
    }
  }
  return result;
}

function reduce(arr, fn, initial) {
  let acc = initial;
  for (let i = 0; i < arr.length; i++) {
    acc = fn(acc, arr[i], i);
  }
  return acc;
}
