// Advanced Function Patterns - Tests for generators, iterators, and advanced function types

// Generator functions
function* numberGenerator() {
  yield 1;
  yield 2;
  yield 3;
  yield 4;
  yield 5;
}

function* rangeGenerator(start, end) {
  for (let i = start; i <= end; i++) {
    yield i;
  }
}

function* stringGenerator() {
  yield "one";
  yield "two";
  yield "three";
}

function* objectGenerator() {
  yield { id: 1, name: "Alice" };
  yield { id: 2, name: "Bob" };
  yield { id: 3, name: "Charlie" };
}

function* fibonacciGenerator(count) {
  let a = 0, b = 1;
  for (let i = 0; i < count; i++) {
    yield a;
    [a, b] = [b, a + b];
  }
}

function* infiniteSequence(start) {
  let current = start;
  while (true) {
    yield current;
    current++;
  }
}

// Async generator functions
async function* asyncNumberGenerator() {
  yield 1;
  yield 2;
  yield 3;
}

async function* asyncRangeGenerator(start, end) {
  for (let i = start; i <= end; i++) {
    yield i;
  }
}

async function* asyncDataGenerator() {
  yield { id: 1, value: "first" };
  yield { id: 2, value: "second" };
  yield { id: 3, value: "third" };
}

// Iterator usage
const numGen = numberGenerator();
const rangeGen = rangeGenerator(1, 10);
const strGen = stringGenerator();
const objGen = objectGenerator();
const fibGen = fibonacciGenerator(10);

// Generator methods
const numGenNext = numGen.next();
const rangeGenNext = rangeGen.next();
const strGenNext = strGen.next();
const objGenNext = objGen.next();

// For-of with generators
const genSum = (() => {
  let sum = 0;
  for (const num of numberGenerator()) {
    sum += num;
  }
  return sum;
})();

const genFiltered = (() => {
  const result = [];
  for (const num of rangeGenerator(1, 10)) {
    if (num > 5) {
      result.push(num);
    }
  }
  return result;
})();

const genMapped = (() => {
  const result = [];
  for (const str of stringGenerator()) {
    result.push(str.toUpperCase());
  }
  return result;
})();

// For-in loops
const objForIn = { a: 1, b: 2, c: 3 };
const keys = [];
const values = [];
for (const key in objForIn) {
  keys.push(key);
  values.push(objForIn[key]);
}

const arrayForIn = [10, 20, 30];
const arrayKeys = [];
for (const idx in arrayForIn) {
  arrayKeys.push(idx);
}

// While loops
const whileResult = (() => {
  let i = 0;
  let sum = 0;
  while (i < 10) {
    sum += i;
    i++;
  }
  return sum;
})();

const whileArray = (() => {
  const arr = [1, 2, 3, 4, 5];
  let i = 0;
  const result = [];
  while (i < arr.length) {
    result.push(arr[i] * 2);
    i++;
  }
  return result;
})();

// Do-while loops
const doWhileResult = (() => {
  let i = 0;
  let sum = 0;
  do {
    sum += i;
    i++;
  } while (i < 10);
  return sum;
})();

// Try-catch-finally patterns
const tryResult = (() => {
  try {
    const parsed = JSON.parse('{"a": 1, "b": 2}');
    return parsed.a;
  } catch (e) {
    return e.message;
  }
})();

const tryArrayResult = (() => {
  try {
    const arr = [1, 2, 3];
    return arr.map(x => x * 2);
  } catch (e) {
    return [];
  }
})();

const tryObjectResult = (() => {
  try {
    const obj = { x: 10, y: 20 };
    return obj.x + obj.y;
  } catch (e) {
    return 0;
  }
})();

// Switch statements
const switchResult = (() => {
  const day = 3;
  switch (day) {
    case 1: return "Monday";
    case 2: return "Tuesday";
    case 3: return "Wednesday";
    case 4: return "Thursday";
    case 5: return "Friday";
    case 6: return "Saturday";
    case 7: return "Sunday";
    default: return "Unknown";
  }
})();

const switchNumber = (() => {
  const value = 42;
  switch (true) {
    case value > 100: return "large";
    case value > 50: return "medium";
    case value > 10: return "small";
    default: return "tiny";
  }
})();

// Closure patterns
const createCounter = (start) => {
  let count = start;
  return {
    get() { return count; },
    increment() { return ++count; },
    decrement() { return --count; },
    reset(newStart) { count = newStart; return count; }
  };
};

const counter = createCounter(0);
const counter10 = createCounter(10);
const counterGet = counter.get();
const counterInc = counter.increment();
const counterDec = counter.decrement();

const createMultiplier = (factor) => {
  return (x) => x * factor;
};

const double = createMultiplier(2);
const triple = createMultiplier(3);
const quadruple = createMultiplier(4);
const doubled = double(10);
const tripled = triple(10);
const quadrupled = quadruple(10);

const createAdder = (a) => (b) => a + b;
const add5 = createAdder(5);
const add10 = createAdder(10);
const result5 = add5(3);
const result10 = add10(3);

// Function composition with types
const compose = (f, g) => (x) => f(g(x));
const pipe = (f, g) => (x) => g(f(x));

const doubleFn = (x) => x * 2;
const incrementFn = (x) => x + 1;
const toStringFn = (x) => String(x);
const toNumberFn = (x) => Number(x);

const composed = compose(toStringFn, doubleFn);
const piped = pipe(doubleFn, incrementFn);
const composedResult = composed(21);
const pipedResult = piped(10);

// Memoization pattern
const memoize = (fn) => {
  const cache = new Map();
  return (x) => {
    if (cache.has(x)) return cache.get(x);
    const result = fn(x);
    cache.set(x, result);
    return result;
  };
};

const memoizedFactorial = memoize((n) => n <= 1 ? 1 : n * memoizedFactorial(n - 1));
const memoizedFibonacci = memoize((n) => n <= 1 ? n : memoizedFibonacci(n - 1) + memoizedFibonacci(n - 2));
const memoizedDouble = memoize((x) => x * 2);

const factResult = memoizedFactorial(5);
const fibResult = memoizedFibonacci(10);
const doubleResult = memoizedDouble(21);

// Partial application
const partial = (fn, ...args) => (...moreArgs) => fn(...args, ...moreArgs);

const add = (a, b, c) => a + b + c;
const add1 = partial(add, 1);
const add1And2 = partial(add, 1, 2);
const partialResult1 = add1(2, 3);
const partialResult2 = add1And2(3);

// Currying
const curry3 = (fn) => (a) => (b) => (c) => fn(a, b, c);
const curriedAdd = curry3(add);
const curriedResult = curriedAdd(1)(2)(3);

// Function with rest parameters
const sumAll = (...nums) => nums.reduce((a, b) => a + b, 0);
const concatAll = (...arrs) => arrs.flat();
const maxAll = (...nums) => Math.max(...nums);
const minAll = (...nums) => Math.min(...nums);

const sumResult = sumAll(1, 2, 3, 4, 5);
const concatResult = concatAll([1, 2], [3, 4], [5, 6]);
const maxResult = maxAll(1, 2, 3, 4, 5);
const minResult = minAll(1, 2, 3, 4, 5);

// Function with default parameters
const greet = (name = "World", greeting = "Hello") => `${greeting}, ${name}!`;
const greetResult = greet("Alice", "Hi");

const createPoint = (x = 0, y = 0) => ({ x, y });
const pointResult = createPoint(10, 20);

// Higher-order function patterns
const identity = (x) => x;
const constant = (c) => (x) => c;
const always = (v) => (..._) => v;

const idResult = identity(42);
const constResult = constant(42)(100);
const alwaysResult = always(true)(1, 2, 3);

// Function property access
const funcWithProps = (x) => x * 2;
funcWithProps.default = 10;
funcWithProps.name = "double";
funcWithProps.length = 1;

// Bound functions
const obj = {
  multiplier: 2,
  multiply(x) { return x * this.multiplier; }
};
const boundMultiply = obj.multiply.bind(obj);
const boundResult = boundMultiply(10);

// Apply and call patterns
const maxOfThree = Math.max.call(null, 1, 2, 3);
const minOfThree = Math.min.apply(null, [1, 2, 3]);

// Function constructors
const Fn = new Function("a", "b", "return a + b");
const fnResult = Fn(10, 20);

// IIFE with parameters
const iifeWithParams = ((a, b, c) => a + b + c)(1, 2, 3);
const iifeWithObject = (({ x, y }) => x + y)({ x: 10, y: 20 });
const iifeWithArray = (([a, b]) => a + b)([10, 20]);

// Nested function declarations
function outer(x) {
  function inner(y) {
    return y * 2;
  }
  return inner(x) + 1;
}
const outerResult = outer(10);

// Function expression patterns
const funcExpr = function(x) { return x * 3; };
const funcExprResult = funcExpr(10);

const namedFuncExpr = function named(x) { return x * 4; };
const namedFuncExprResult = namedFuncExpr(10);

// Arrow function patterns
const arrowSingle = x => x * 5;
const arrowMulti = (x, y) => x + y;
const arrowObject = x => ({ value: x });
const arrowArray = x => [x, x * 2, x * 3];

const arrowSingleResult = arrowSingle(10);
const arrowMultiResult = arrowMulti(10, 20);
const arrowObjectResult = arrowObject(10);
const arrowArrayResult = arrowArray(10);

// Function type inference
const isFunction = typeof funcExpr === "function";
const isArrow = typeof arrowSingle === "function";
const isGenerator = typeof numberGenerator === "function";

// Generator type inference
const genType = typeof numGen;
const genSymbol = typeof numGen[Symbol.iterator];
