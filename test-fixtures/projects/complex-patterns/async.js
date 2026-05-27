// Test Fixture: Async Patterns and Promises
// Tests type inference for async/await, promises, and callback patterns

// === BASIC PROMISES ===
const resolvedPromise = Promise.resolve(42);
const rejectedPromise = Promise.reject(new Error("Error"));
const stringPromise = Promise.resolve("hello");
const objectPromise = Promise.resolve({ id: 1, name: "test" });
const arrayPromise = Promise.resolve([1, 2, 3]);

// === ASYNC FUNCTIONS ===
async function fetchData(url) {
  const response = await fetch(url);
  const data = await response.json();
  return data;
}

async function fetchUser(id) {
  const user = await fetchData(`/api/users/${id}`);
  return { id, ...user };
}

async function fetchUsers(ids) {
  const promises = ids.map(id => fetchUser(id));
  const users = await Promise.all(promises);
  return users;
}

async function fetchWithRetry(url, retries) {
  for (let i = 0; i < retries; i++) {
    try {
      const data = await fetchData(url);
      return { success: true, data };
    } catch (error) {
      if (i === retries - 1) {
        return { success: false, error };
      }
    }
  }
}

async function timeout(promise, ms) {
  const timer = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Timeout")), ms);
  });
  return Promise.race([promise, timer]);
}

async function parallel(tasks) {
  const results = await Promise.all(tasks);
  return results;
}

async function sequential(tasks) {
  const results = [];
  for (const task of tasks) {
    const result = await task;
    results.push(result);
  }
  return results;
}

// === PROMISE COMBINATORS ===
const allPromise = Promise.all([resolvedPromise, stringPromise]);
const allSettledPromise = Promise.allSettled([resolvedPromise, rejectedPromise]);
const racePromise = Promise.race([resolvedPromise, stringPromise]);
const anyPromise = Promise.any([resolvedPromise, rejectedPromise]);

// === CALLBACK PATTERNS ===
function forEach(arr, callback) {
  for (let i = 0; i < arr.length; i++) {
    callback(arr[i], i, arr);
  }
}

function map(arr, callback) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    result.push(callback(arr[i], i, arr));
  }
  return result;
}

function filter(arr, callback) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    if (callback(arr[i], i, arr)) {
      result.push(arr[i]);
    }
  }
  return result;
}

function reduce(arr, callback, initial) {
  let acc = initial;
  for (let i = 0; i < arr.length; i++) {
    acc = callback(acc, arr[i], i, arr);
  }
  return acc;
}

function every(arr, callback) {
  for (let i = 0; i < arr.length; i++) {
    if (!callback(arr[i], i, arr)) {
      return false;
    }
  }
  return true;
}

function some(arr, callback) {
  for (let i = 0; i < arr.length; i++) {
    if (callback(arr[i], i, arr)) {
      return true;
    }
  }
  return false;
}

function find(arr, callback) {
  for (let i = 0; i < arr.length; i++) {
    if (callback(arr[i], i, arr)) {
      return arr[i];
    }
  }
  return undefined;
}

function findIndex(arr, callback) {
  for (let i = 0; i < arr.length; i++) {
    if (callback(arr[i], i, arr)) {
      return i;
    }
  }
  return -1;
}

// === EVENT EMITTER ===
class AsyncEventEmitter {
  constructor() {
    this.events = {};
    this.onceEvents = {};
  }

  on(event, listener) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
    return this;
  }

  off(event, listener) {
    if (this.events[event]) {
      this.events[event] = this.events[event].filter(l => l !== listener);
    }
    return this;
  }

  once(event, listener) {
    const wrapper = (...args) => {
      listener(...args);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  emit(event, ...args) {
    if (this.events[event]) {
      this.events[event].forEach(listener => listener(...args));
    }
    return true;
  }

  listenerCount(event) {
    return (this.events[event] || []).length;
  }

  removeAllListeners(event) {
    if (event) {
      delete this.events[event];
    } else {
      this.events = {};
    }
    return this;
  }
}

// === ASYNC ITERATOR ===
class AsyncIterator {
  constructor(items, delay) {
    this.items = items;
    this.delay = delay || 100;
    this.index = 0;
  }

  async next() {
    if (this.index >= this.items.length) {
      return { done: true, value: undefined };
    }
    await new Promise(resolve => setTimeout(resolve, this.delay));
    const value = this.items[this.index];
    this.index++;
    return { done: false, value };
  }

  async forEach(callback) {
    for (let i = 0; i < this.items.length; i++) {
      await callback(this.items[i], i);
    }
  }

  async map(callback) {
    const results = [];
    for (let i = 0; i < this.items.length; i++) {
      const result = await callback(this.items[i], i);
      results.push(result);
    }
    return results;
  }

  async filter(callback) {
    const results = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const keep = await callback(item, i);
      if (keep) {
        results.push(item);
      }
    }
    return results;
  }

  getRemaining() {
    return this.items.length - this.index;
  }

  isDone() {
    return this.index >= this.items.length;
  }
}

// === QUEUE PATTERN ===
class AsyncQueue {
  constructor(concurrency) {
    this.concurrency = concurrency || 1;
    this.queue = [];
    this.processing = 0;
    this.results = [];
  }

  add(task) {
    this.queue.push(task);
    return this;
  }

  async process(executor) {
    const results = [];
    while (this.queue.length > 0 || this.processing > 0) {
      while (this.processing < this.concurrency && this.queue.length > 0) {
        const task = this.queue.shift();
        this.processing++;
        const result = executor(task);
        if (result instanceof Promise) {
          result.then(r => {
            results.push(r);
            this.processing--;
          });
        } else {
          results.push(result);
          this.processing--;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.results = results;
    return results;
  }

  getSize() {
    return this.queue.length;
  }

  getResults() {
    return this.results;
  }

  clear() {
    this.queue = [];
    this.results = [];
    this.processing = 0;
    return this;
  }
}

// === RETRY PATTERN ===
async function withRetry(fn, options) {
  const maxRetries = options.maxRetries || 3;
  const delay = options.delay || 1000;
  const backoff = options.backoff || 1;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn(attempt);
      return { success: true, result, attempt };
    } catch (error) {
      if (attempt === maxRetries) {
        return { success: false, error, attempt };
      }
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(backoff, attempt - 1)));
    }
  }
}

// === PIPELINE PATTERN ===
async function pipeline(data, ...steps) {
  let result = data;
  for (const step of steps) {
    result = await step(result);
  }
  return result;
}

// === DEBOUNCE/THROTTLE ===
function asyncDebounce(fn, delay) {
  let timer;
  return async function(...args) {
    return new Promise(resolve => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const result = await fn(...args);
        resolve(result);
      }, delay);
    });
  };
}

function asyncThrottle(fn, limit) {
  let inThrottle;
  return async function(...args) {
    if (!inThrottle) {
      inThrottle = true;
      const result = await fn(...args);
      setTimeout(() => (inThrottle = false), limit);
      return result;
    }
  };
}
