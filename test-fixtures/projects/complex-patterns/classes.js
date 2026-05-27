// Test Fixture: Complex Class Patterns
// Tests type inference for classes, inheritance, and OOP patterns

// === BASIC CLASS ===
class Employee {
  constructor(name, salary, department) {
    this.name = name;
    this.salary = salary;
    this.department = department;
    this.hoursWorked = 0;
  }

  getName() {
    return this.name;
  }

  getSalary() {
    return this.salary;
  }

  setSalary(salary) {
    this.salary = salary;
    return this;
  }

  work(hours) {
    this.hoursWorked += hours;
    return this;
  }

  getHoursWorked() {
    return this.hoursWorked;
  }

  calculateBonus() {
    return this.salary * 0.1;
  }

  isFullTime() {
    return this.hoursWorked >= 40;
  }

  static create(name, salary, department) {
    return new Employee(name, salary, department);
  }

  static fromJson(json) {
    return new Employee(json.name, json.salary, json.department);
  }
}

// === CLASS INHERITANCE ===
class Manager extends Employee {
  constructor(name, salary, department, teamSize) {
    super(name, salary, department);
    this.teamSize = teamSize;
    this.bonusMultiplier = 1.5;
  }

  getTeamSize() {
    return this.teamSize;
  }

  setTeamSize(size) {
    this.teamSize = size;
    return this;
  }

  calculateBonus() {
    return this.salary * 0.1 * this.bonusMultiplier;
  }

  manage(employee) {
    return { manager: this.name, employee: employee.getName() };
  }

  static createTeamLead(name, salary, department, teamSize) {
    return new Manager(name, salary, department, teamSize);
  }
}

// === COMPLEX CLASS WITH PROPERTIES ===
class BankAccount {
  constructor(owner, balance) {
    this.owner = owner;
    this.balance = balance;
    this.transactions = [];
    this.isFrozen = false;
  }

  deposit(amount) {
    this.balance += amount;
    this.transactions.push({ type: "deposit", amount, date: new Date() });
    return this.balance;
  }

  withdraw(amount) {
    if (amount > this.balance) {
      return { success: false, remaining: this.balance - amount };
    }
    this.balance -= amount;
    this.transactions.push({ type: "withdrawal", amount, date: new Date() });
    return this.balance;
  }

  getBalance() {
    return this.balance;
  }

  getTransactions() {
    return this.transactions;
  }

  freeze() {
    this.isFrozen = true;
    return this;
  }

  unfreeze() {
    this.isFrozen = false;
    return this;
  }

  isFrozen() {
    return this.isFrozen;
  }

  transferTo(target, amount) {
    if (this.balance >= amount) {
      this.balance -= amount;
      target.deposit(amount);
      return { success: true, from: this.owner, to: target.owner, amount };
    }
    return { success: false, from: this.owner, to: target.owner, amount };
  }

  getStatement() {
    return {
      owner: this.owner,
      balance: this.balance,
      transactions: this.transactions,
      frozen: this.isFrozen
    };
  }
}

// === FACTORY PATTERN ===
class Shape {
  constructor(color) {
    this.color = color;
  }

  area() {
    return 0;
  }

  perimeter() {
    return 0;
  }

  getColor() {
    return this.color;
  }
}

class Circle extends Shape {
  constructor(color, radius) {
    super(color);
    this.radius = radius;
  }

  area() {
    return Math.PI * this.radius * this.radius;
  }

  perimeter() {
    return 2 * Math.PI * this.radius;
  }

  getRadius() {
    return this.radius;
  }
}

class Rectangle extends Shape {
  constructor(color, width, height) {
    super(color);
    this.width = width;
    this.height = height;
  }

  area() {
    return this.width * this.height;
  }

  perimeter() {
    return 2 * (this.width + this.height);
  }

  getWidth() {
    return this.width;
  }

  getHeight() {
    return this.height;
  }
}

class Triangle extends Shape {
  constructor(color, base, height) {
    super(color);
    this.base = base;
    this.height = height;
  }

  area() {
    return 0.5 * this.base * this.height;
  }

  getBase() {
    return this.base;
  }

  getHeight() {
    return this.height;
  }
}

function createShape(type, color, ...dims) {
  switch (type) {
    case "circle":
      return new Circle(color, dims[0]);
    case "rectangle":
      return new Rectangle(color, dims[0], dims[1]);
    case "triangle":
      return new Triangle(color, dims[0], dims[1]);
    default:
      return new Shape(color);
  }
}

// === BUILDER PATTERN ===
class UserBuilder {
  constructor() {
    this.name = "";
    this.email = "";
    this.age = 0;
    this.role = "user";
    this.metadata = {};
  }

  setName(name) {
    this.name = name;
    return this;
  }

  setEmail(email) {
    this.email = email;
    return this;
  }

  setAge(age) {
    this.age = age;
    return this;
  }

  setRole(role) {
    this.role = role;
    return this;
  }

  addMetadata(key, value) {
    this.metadata[key] = value;
    return this;
  }

  build() {
    return {
      name: this.name,
      email: this.email,
      age: this.age,
      role: this.role,
      metadata: this.metadata
    };
  }
}

// === SINGLETON PATTERN ===
class Config {
  constructor() {
    this.settings = {};
    this.version = "1.0.0";
  }

  set(key, value) {
    this.settings[key] = value;
    return this;
  }

  get(key) {
    return this.settings[key];
  }

  getAll() {
    return this.settings;
  }

  has(key) {
    return key in this.settings;
  }

  reset() {
    this.settings = {};
    return this;
  }

  static getInstance() {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }
}

// === OBSERVER PATTERN ===
class EventEmitter {
  constructor() {
    this.listeners = {};
  }

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
    return this;
  }

  off(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    }
    return this;
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data));
    }
    return this;
  }

  once(event, callback) {
    const wrapper = (data) => {
      callback(data);
      this.off(event, wrapper);
    };
    return this.on(event, wrapper);
  }

  getEventCount(event) {
    return this.listeners[event]?.length || 0;
  }
}

// === ITERATOR PATTERN ===
class Collection {
  constructor(items) {
    this.items = items;
  }

  add(item) {
    this.items.push(item);
    return this;
  }

  remove(item) {
    this.items = this.items.filter(i => i !== item);
    return this;
  }

  forEach(fn) {
    this.items.forEach(fn);
    return this;
  }

  map(fn) {
    return this.items.map(fn);
  }

  filter(fn) {
    return new Collection(this.items.filter(fn));
  }

  reduce(fn, initial) {
    return this.items.reduce(fn, initial);
  }

  find(fn) {
    return this.items.find(fn);
  }

  first() {
    return this.items[0];
  }

  last() {
    return this.items[this.items.length - 1];
  }

  size() {
    return this.items.length;
  }

  isEmpty() {
    return this.items.length === 0;
  }

  toArray() {
    return this.items;
  }

  contains(item) {
    return this.items.includes(item);
  }

  sort(fn) {
    this.items.sort(fn);
    return this;
  }

  reverse() {
    this.items.reverse();
    return this;
  }

  slice(start, end) {
    return new Collection(this.items.slice(start, end));
  }

  concat(other) {
    return new Collection([...this.items, ...other.items]);
  }
}

// === DATA TRANSFORMER ===
class DataTransformer {
  constructor(data) {
    this.data = data;
    this.changes = [];
  }

  pick(keys) {
    const result = {};
    keys.forEach(key => {
      result[key] = this.data[key];
    });
    this.changes.push({ op: "pick", keys });
    return new DataTransformer(result);
  }

  omit(keys) {
    const result = {};
    Object.keys(this.data).forEach(key => {
      if (!keys.includes(key)) {
        result[key] = this.data[key];
      }
    });
    this.changes.push({ op: "omit", keys });
    return new DataTransformer(result);
  }

  mapValues(fn) {
    const result = {};
    Object.keys(this.data).forEach(key => {
      result[key] = fn(this.data[key], key);
    });
    this.changes.push({ op: "mapValues" });
    return new DataTransformer(result);
  }

  filterKeys(fn) {
    const result = {};
    Object.keys(this.data).forEach(key => {
      if (fn(key)) {
        result[key] = this.data[key];
      }
    });
    this.changes.push({ op: "filterKeys" });
    return new DataTransformer(result);
  }

  rename(from, to) {
    const result = { ...this.data };
    result[to] = result[from];
    delete result[from];
    this.changes.push({ op: "rename", from, to });
    return new DataTransformer(result);
  }

  merge(other) {
    const result = { ...this.data, ...other.data };
    this.changes.push({ op: "merge" });
    return new DataTransformer(result);
  }

  getValue() {
    return this.data;
  }

  getChanges() {
    return this.changes;
  }
}
