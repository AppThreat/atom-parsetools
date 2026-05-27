// Object Patterns - Tests for object literal properties and property access types

// Basic object literals with typed properties
const user = {
  id: 1,
  name: "Alice",
  email: "alice@example.com",
  active: true,
  score: 95.5,
  tags: ["admin", "user"],
  address: {
    street: "123 Main St",
    city: "Springfield",
    zip: "62701",
    coords: {
      lat: 39.7817,
      lng: -89.647
    }
  }
};

// Object with method properties
const calculator = {
  add(a, b) { return a + b; },
  subtract(a, b) { return a - b; },
  multiply(a, b) { return a * b; },
  divide(a, b) { return a / b; },
  remainder(a, b) { return a % b; },
  power(a, b) { return Math.pow(a, b); }
};

// Object with computed properties
const prefix = "user";
const dynamicKeys = {
  [prefix + "Id"]: 1,
  [prefix + "Name"]: "Bob",
  ["max" + "Length"]: 100,
  [10 + 20]: "thirty"
};

// Object destructuring with renaming
const { id: userId, name: userName, email: userEmail } = user;
const { address: { street: userStreet, city: userCity } } = user;
const { add, subtract, multiply } = calculator;

// Property access chains
const userName2 = user.name;
const userCity2 = user.address.city;
const userLat = user.address.coords.lat;
const userTags = user.tags;
const firstTag = user.tags[0];

// Object methods
const userKeys = Object.keys(user);
const userValues = Object.values(user);
const userEntries = Object.entries(user);
const userHasId = Object.hasOwn(user, "id");
const frozenUser = Object.freeze(user);
const sealedUser = Object.seal(user);
const userPrototype = Object.getPrototypeOf(user);
const userConstructor = Object.getPrototypeOf(user).constructor;

// Object creation patterns
const createdObj = Object.create({ base: true });
const mergedObj = Object.assign({}, { a: 1 }, { b: 2 });
const shallowClone = { ...user };
const deepCloneLike = JSON.parse(JSON.stringify(user));

// Object with symbol keys
const symId = Symbol("id");
const symName = Symbol("name");
const symbolObj = {
  [symId]: 42,
  [symName]: "Charlie",
  toString: "custom"
};

// Object.fromEntries patterns
const entriesArr = [["x", 1], ["y", 2], ["z", 3]];
const fromEntriesObj = Object.fromEntries(entriesArr);
const mapToEntries = Object.fromEntries(new Map([["a", 1], ["b", 2]]));

// Object patterns with optional properties
const partialUser = {
  id: 2,
  name: "Dave",
  email: "dave@example.com",
  active: false,
  score: 88.3
};

// Nested object manipulation
const nested = {
  level1: {
    level2: {
      level3: {
        value: "deep"
      }
    }
  }
};
const deepValue = nested.level1.level2.level3.value;
const deepLevel2 = nested.level1.level2;
const deepLevel1 = nested.level1;

// Object grouping
const users = [
  { name: "Alice", dept: "Engineering", role: "Dev" },
  { name: "Bob", dept: "Engineering", role: "Manager" },
  { name: "Charlie", dept: "Marketing", role: "Lead" },
  { name: "Dave", dept: "Marketing", role: "Analyst" }
];
const groupedByDept = Object.groupBy(users, u => u.dept);
const groupedByRole = Object.groupBy(users, u => u.role);

// Record pattern
const statusMap = {
  pending: "Waiting",
  approved: "Accepted",
  rejected: "Declined",
  completed: "Done"
};

// Config object pattern
const config = {
  api: {
    baseUrl: "https://api.example.com",
    timeout: 5000,
    retries: 3,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer token123"
    }
  },
  database: {
    host: "localhost",
    port: 5432,
    name: "mydb",
    options: {
      ssl: true,
      poolSize: 10,
      idleTimeout: 30000
    }
  },
  features: {
    darkMode: true,
    notifications: true,
    betaFeatures: false
  }
};
const apiConfig = config.api;
const dbConfig = config.database;
const apiTimeout = config.api.timeout;
const dbPort = config.database.port;
const sslEnabled = config.database.options.ssl;

// Object pattern with function properties
const mathUtils = {
  PI: Math.PI,
  E: Math.E,
  abs: Math.abs,
  max: Math.max,
  min: Math.min,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  random: Math.random,
  sqrt: Math.sqrt,
  pow: Math.pow
};

// Builder pattern with objects
const buildUser = (base) => ({
  ...base,
  createdAt: new Date(),
  updatedAt: new Date(),
  version: 1,
  meta: {
    createdBy: "system",
    status: "active"
  }
});
const builtUser = buildUser({ id: 1, name: "Eve" });
