// Test Fixture: Higher-Order Functions and Generics
// Tests type inference for complex function patterns and generic-like behavior

// === HIGHER-ORDER FUNCTIONS ===
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

function forEach(arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    fn(arr[i], i);
  }
}

function every(arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    if (!fn(arr[i], i)) {
      return false;
    }
  }
  return true;
}

function some(arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    if (fn(arr[i], i)) {
      return true;
    }
  }
  return false;
}

function find(arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    if (fn(arr[i], i)) {
      return arr[i];
    }
  }
  return undefined;
}

function findIndex(arr, fn) {
  for (let i = 0; i < arr.length; i++) {
    if (fn(arr[i], i)) {
      return i;
    }
  }
  return -1;
}

function sortBy(arr, key) {
  return arr.slice().sort((a, b) => {
    if (a[key] < b[key]) return -1;
    if (a[key] > b[key]) return 1;
    return 0;
  });
}

function groupBy(arr, key) {
  return arr.reduce((groups, item) => {
    const group = item[key];
    groups[group] = groups[group] || [];
    groups[group].push(item);
    return groups;
  }, {});
}

function unique(arr, key) {
  const seen = new Set();
  return arr.filter(item => {
    const val = key ? item[key] : item;
    if (seen.has(val)) {
      return false;
    }
    seen.add(val);
    return true;
  });
}

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function zip(...arrays) {
  const result = [];
  const maxLen = Math.max(...arrays.map(a => a.length));
  for (let i = 0; i < maxLen; i++) {
    result.push(arrays.map(a => a[i]));
  }
  return result;
}

function flatten(arr) {
  const result = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      for (const subItem of flatten(item)) {
        result.push(subItem);
      }
    } else {
      result.push(item);
    }
  }
  return result;
}

function flatMap(arr, fn) {
  return flatten(map(arr, fn));
}

// === FUNCTION COMPOSITION ===
function pipe(...fns) {
  return val => fns.reduce((v, f) => f(v), val);
}

function compose(...fns) {
  return val => fns.reduceRight((v, f) => f(v), val);
}

function curry(fn) {
  return function curried(...args) {
    if (args.length >= fn.length) {
      return fn.apply(this, args);
    }
    return function(...moreArgs) {
      return curried.apply(this, args.concat(moreArgs));
    };
  };
}

function memoize(fn) {
  const cache = new Map();
  return function(...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = fn.apply(this, args);
    cache.set(key, result);
    return result;
  };
}

function throttle(fn, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function once(fn) {
  let done = false;
  let result;
  return function(...args) {
    if (!done) {
      result = fn.apply(this, args);
      done = true;
    }
    return result;
  };
}

function retry(fn, retries, delay) {
  return async function(...args) {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn.apply(this, args);
      } catch (error) {
        if (i === retries - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };
}

// === GENERIC-LIKE PATTERNS ===
function identity(val) {
  return val;
}

function first(arr) {
  return arr[0];
}

function last(arr) {
  return arr[arr.length - 1];
}

function head(arr) {
  return arr.length > 0 ? arr[0] : undefined;
}

function tail(arr) {
  return arr.slice(1);
}

function init(arr) {
  return arr.slice(0, arr.length - 1);
}

function reverse(arr) {
  return arr.slice().reverse();
}

function concat(...arrays) {
  return arrays.reduce((acc, arr) => acc.concat(arr), []);
}

function without(arr, ...values) {
  return arr.filter(val => !values.includes(val));
}

function intersection(...arrays) {
  const set = new Set(arrays[0]);
  return arrays.slice(1).reduce((acc, arr) => {
    return acc.filter(val => set.has(val));
  }, arrays[0]);
}

function union(...arrays) {
  return [...new Set(arrays.flat())];
}

function difference(arr, ...others) {
  const othersSet = new Set(others.flat());
  return arr.filter(val => !othersSet.has(val));
}

// === OBJECT UTILITIES ===
function pick(obj, keys) {
  const result = {};
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

function omit(obj, keys) {
  const result = {};
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) {
      result[key] = obj[key];
    }
  }
  return result;
}

function merge(...objects) {
  return objects.reduce((acc, obj) => {
    return { ...acc, ...obj };
  }, {});
}

function deepMerge(...objects) {
  return objects.reduce((acc, obj) => {
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
        if (!acc[key]) {
          acc[key] = {};
        }
        acc[key] = deepMerge(acc[key], obj[key]);
      } else {
        acc[key] = obj[key];
      }
    }
    return acc;
  }, {});
}

function keys(obj) {
  return Object.keys(obj);
}

function values(obj) {
  return Object.values(obj);
}

function entries(obj) {
  return Object.entries(obj);
}

function fromEntries(pairs) {
  return Object.fromEntries(pairs);
}

function mapKeys(obj, fn) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[fn(key, value)] = value;
  }
  return result;
}

function mapValues(obj, fn) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = fn(value, key);
  }
  return result;
}

function filterKeys(obj, fn) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (fn(key, value)) {
      result[key] = value;
    }
  }
  return result;
}

function filterValues(obj, fn) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (fn(value, key)) {
      result[key] = value;
    }
  }
  return result;
}

function invert(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[value] = key;
  }
  return result;
}

function flip(obj) {
  return invert(obj);
}

function assign(...objects) {
  return Object.assign({}, ...objects);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepClone(obj) {
  return structuredClone(obj);
}

function size(obj) {
  return Object.keys(obj).length;
}

function isEmpty(obj) {
  return Object.keys(obj).length === 0;
}

function has(obj, key) {
  return key in obj;
}

function get(obj, path, defaultValue) {
  const keys = path.split(".");
  let result = obj;
  for (const key of keys) {
    if (result === undefined || result === null) {
      return defaultValue;
    }
    result = result[key];
  }
  return result !== undefined ? result : defaultValue;
}

function set(obj, path, value) {
  const keys = path.split(".");
  let result = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!result[keys[i]]) {
      result[keys[i]] = {};
    }
    result = result[keys[i]];
  }
  result[keys[keys.length - 1]] = value;
  return obj;
}

function deleteKey(obj, key) {
  const result = { ...obj };
  delete result[key];
  return result;
}

function renameKey(obj, from, to) {
  const result = { ...obj };
  result[to] = result[from];
  delete result[from];
  return result;
}

function mergeKey(obj, key, value) {
  const result = { ...obj };
  result[key] = value;
  return result;
}
