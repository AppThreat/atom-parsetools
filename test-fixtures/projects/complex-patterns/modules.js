// Test Fixture: Module Patterns and Imports
// Tests type inference for module resolution and cross-file type tracking

// === EXPORTED CONSTANTS ===
export const APP_NAME = "MyApp";
export const VERSION = "1.0.0";
export const MAX_RETRIES = 3;
export const TIMEOUT_MS = 5000;
export const DEFAULT_LOCALE = "en-US";

// === EXPORTED TYPES (via JSDoc-like patterns) ===
export const StatusCodes = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  SERVER_ERROR: 500
};

export const HttpMethods = {
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE"
};

// === EXPORTED FUNCTIONS ===
export function createId() {
  return Math.random().toString(36).substring(2);
}

export function formatDate(date) {
  return date.toISOString().split("T")[0];
}

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function debounce(fn, delay) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function throttle(fn, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
  }
  };
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function flatten(arr) {
  return arr.reduce((acc, val) => {
    return acc.concat(Array.isArray(val) ? flatten(val) : val);
  }, []);
}

export function groupBy(arr, key) {
  return arr.reduce((groups, item) => {
    const group = item[key];
    groups[group] = groups[group] || [];
    groups[group].push(item);
    return groups;
  }, {});
}

export function unique(arr, key) {
  return arr.filter((item, index) => {
    const keyVal = key ? item[key] : item;
    return arr.findIndex(i => (key ? i[key] : i) === keyVal) === index;
  });
}

export function pipe(...fns) {
  return val => fns.reduce((v, f) => f(v), val);
}

export function compose(...fns) {
  return val => fns.reduceRight((v, f) => f(v), val);
}

// === EXPORTED CLASSES ===
export class ApiClient {
  constructor(baseUrl, timeout) {
    this.baseUrl = baseUrl;
    this.timeout = timeout || 5000;
    this.headers = { "Content-Type": "application/json" };
    this.interceptors = [];
  }

  setHeader(key, value) {
    this.headers[key] = value;
    return this;
  }

  setHeaders(headers) {
    Object.assign(this.headers, headers);
    return this;
  }

  addInterceptor(interceptor) {
    this.interceptors.push(interceptor);
    return this;
  }

  async get(endpoint) {
    const url = `${this.baseUrl}/${endpoint}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers
    });
    return response.json();
  }

  async post(endpoint, data) {
    const url = `${this.baseUrl}/${endpoint}`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(data)
    });
    return response.json();
  }

  async put(endpoint, data) {
    const url = `${this.baseUrl}/${endpoint}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(data)
    });
    return response.json();
  }

  async delete(endpoint) {
    const url = `${this.baseUrl}/${endpoint}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: this.headers
    });
    return response.json();
  }

  async request(method, endpoint, data) {
    const url = `${this.baseUrl}/${endpoint}`;
    const response = await fetch(url, {
      method,
      headers: this.headers,
      body: data ? JSON.stringify(data) : undefined
    });
    return response.json();
  }
}

export class Cache {
  constructor(maxSize, ttl) {
    this.maxSize = maxSize || 100;
    this.ttl = ttl || 3600;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() - entry.timestamp > this.ttl * 1000) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      this.store.delete(firstKey);
    }
    this.store.set(key, { value, timestamp: Date.now() });
    return this;
  }

  has(key) {
    return this.store.has(key);
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
    return this;
  }

  size() {
    return this.store.size;
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0,
      size: this.store.size,
      maxSize: this.maxSize
    };
  }
}

export class Validator {
  constructor() {
    this.errors = [];
    this.rules = {};
  }

  required(value, field) {
    if (value === null || value === undefined || value === "") {
      this.errors.push({ field, message: `${field} is required` });
      return false;
    }
    return true;
  }

  minLength(value, field, min) {
    if (value.length < min) {
      this.errors.push({ field, message: `${field} must be at least ${min} characters` });
      return false;
    }
    return true;
  }

  maxLength(value, field, max) {
    if (value.length > max) {
      this.errors.push({ field, message: `${field} must be at most ${max} characters` });
      return false;
    }
    return true;
  }

  email(value, field) {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!regex.test(value)) {
      this.errors.push({ field, message: `${field} must be a valid email` });
      return false;
    }
    return true;
  }

  number(value, field) {
    if (typeof value !== "number" || isNaN(value)) {
      this.errors.push({ field, message: `${field} must be a number` });
      return false;
    }
    return true;
  }

  min(value, field, min) {
    if (value < min) {
      this.errors.push({ field, message: `${field} must be at least ${min}` });
      return false;
    }
    return true;
  }

  max(value, field, max) {
    if (value > max) {
      this.errors.push({ field, message: `${field} must be at most ${max}` });
      return false;
    }
    return true;
  }

  validate(data, rules) {
    this.errors = [];
    for (const [field, fieldRules] of Object.entries(rules)) {
      for (const rule of fieldRules) {
        if (typeof rule === "function") {
          rule(data[field], field);
        }
      }
    }
    return {
      valid: this.errors.length === 0,
      errors: this.errors
    };
  }

  getErrors() {
    return this.errors;
  }

  clearErrors() {
    this.errors = [];
    return this;
  }
}
