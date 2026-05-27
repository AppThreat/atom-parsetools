// Advanced Class Patterns - Tests for complex class type inference

// Basic class with typed fields
class Person {
  constructor(name, age, email) {
    this.name = name;
    this.age = age;
    this.email = email;
    this.createdAt = new Date();
    this.isActive = true;
    this.tags = [];
    this.metadata = {};
  }

  getName() { return this.name; }
  getAge() { return this.age; }
  getEmail() { return this.email; }
  setName(name) { this.name = name; return this; }
  setAge(age) { this.age = age; return this; }
  setEmail(email) { this.email = email; return this; }
  addTag(tag) { this.tags.push(tag); return this; }
  removeTag(tag) { this.tags = this.tags.filter(t => t !== tag); return this; }
  getTags() { return this.tags; }
  getMetadata() { return this.metadata; }
  setMetadata(key, value) { this.metadata[key] = value; return this; }
  toJSON() { return { name: this.name, age: this.age, email: this.email }; }
  toString() { return `${this.name} (${this.age})`; }
  isEqual(other) { return this.name === other.name && this.age === other.age; }
  clone() { return new Person(this.name, this.age, this.email); }
}

// Class inheritance
class Employee extends Person {
  constructor(name, age, email, department, salary) {
    super(name, age, email);
    this.department = department;
    this.salary = salary;
    this.title = "Junior";
    this.projects = [];
  }

  getDepartment() { return this.department; }
  getSalary() { return this.salary; }
  getTitle() { return this.title; }
  setDepartment(dept) { this.department = dept; return this; }
  setSalary(salary) { this.salary = salary; return this; }
  setTitle(title) { this.title = title; return this; }
  getProjects() { return this.projects; }
  addProject(project) { this.projects.push(project); return this; }
  getAnnualBonus() { return this.salary * 0.1; }
  getMonthlySalary() { return this.salary / 12; }
  promote() { this.title = "Senior"; return this; }
  demote() { this.title = "Junior"; return this; }
  getEmployeeInfo() { return { ...super.toJSON(), department: this.department, salary: this.salary }; }
}

// Manager extends Employee
class Manager extends Employee {
  constructor(name, age, email, department, salary, teamSize) {
    super(name, age, email, department, salary);
    this.teamSize = teamSize;
    this.reports = [];
    this.budget = 100000;
  }

  getTeamSize() { return this.teamSize; }
  getReports() { return this.reports; }
  getBudget() { return this.budget; }
  addReport(report) { this.reports.push(report); return this; }
  removeReport(report) { this.reports = this.reports.filter(r => r !== report); return this; }
  setBudget(budget) { this.budget = budget; return this; }
  getTeamBudget() { return this.budget / this.teamSize; }
  getManagementBonus() { return this.salary * 0.2 + this.budget * 0.05; }
}

// Class with static members
class MathHelper {
  static PI = 3.14159;
  static E = 2.71828;
  static epsilon = 1e-10;
  static maxIterations = 100;

  static abs(x) { return x < 0 ? -x : x; }
  static max(a, b) { return a > b ? a : b; }
  static min(a, b) { return a < b ? a : b; }
  static clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  static lerp(a, b, t) { return a + (b - a) * t; }
  static distance(x1, y1, x2, y2) { return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2); }
  static midpoint(x1, y1, x2, y2) { return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }; }
  static isEven(n) { return n % 2 === 0; }
  static isOdd(n) { return n % 2 !== 0; }
  static factorial(n) { return n <= 1 ? 1 : n * MathHelper.factorial(n - 1); }
  static fibonacci(n) { return n <= 1 ? n : MathHelper.fibonacci(n - 1) + MathHelper.fibonacci(n - 2); }
}

// Class with getters and setters
class Rectangle {
  constructor(width, height) {
    this._width = width;
    this._height = height;
    this._color = "red";
    this._visible = true;
  }

  get width() { return this._width; }
  set width(w) { this._width = w; }
  get height() { return this._height; }
  set height(h) { this._height = h; }
  get color() { return this._color; }
  set color(c) { this._color = c; }
  get visible() { return this._visible; }
  set visible(v) { this._visible = v; }
  get area() { return this._width * this._height; }
  get perimeter() { return 2 * (this._width + this._height); }
  get diagonal() { return Math.sqrt(this._width ** 2 + this._height ** 2); }
  get isSquare() { return this._width === this._height; }
  get center() { return { x: this._width / 2, y: this._height / 2 }; }
  scale(factor) { this._width *= factor; this._height *= factor; return this; }
  rotate(degrees) { return { width: this._height, height: this._width, angle: degrees }; }
}

// Class implementing Iterator pattern
class Iterator {
  constructor(collection) {
    this._collection = collection;
    this._index = 0;
    this._done = false;
  }

  next() {
    if (this._index < this._collection.length) {
      this._done = false;
      return { value: this._collection[this._index++], done: false };
    }
    this._done = true;
    return { value: undefined, done: true };
  }

  current() { return this._collection[this._index]; }
  hasNext() { return this._index < this._collection.length; }
  getIndex() { return this._index; }
  isDone() { return this._done; }
  reset() { this._index = 0; this._done = false; return this; }
  skip(n) { this._index = Math.min(this._index + n, this._collection.length); return this; }
  peek() { return this._collection[this._index]; }
  getRemaining() { return this._collection.slice(this._index); }
}

// Class with complex state management
class StateMachine {
  constructor(initialState) {
    this._state = initialState;
    this._transitions = {};
    this._history = [initialState];
    this._listeners = [];
  }

  getState() { return this._state; }
  getHistory() { return this._history; }
  getListeners() { return this._listeners; }
  getTransitions() { return this._transitions; }
  addTransition(from, to, event) {
    if (!this._transitions[from]) this._transitions[from] = {};
    this._transitions[from][event] = to;
    return this;
  }
  transition(event) {
    const next = this._transitions[this._state]?.[event];
    if (next) {
      this._state = next;
      this._history.push(next);
      this._listeners.forEach(fn => fn(next));
    }
    return this;
  }
  onTransition(listener) { this._listeners.push(listener); return this; }
  canTransition(event) { return !!this._transitions[this._state]?.[event]; }
  reset(state) { this._state = state; this._history = [state]; return this; }
  getHistoryLength() { return this._history.length; }
  hasBeenInState(state) { return this._history.includes(state); }
}

// Factory class
class ShapeFactory {
  constructor() {
    this._shapes = [];
    this._nextId = 1;
  }

  createCircle(radius) {
    const circle = { id: this._nextId++, type: "circle", radius, area: Math.PI * radius ** 2 };
    this._shapes.push(circle);
    return circle;
  }

  createRectangle(width, height) {
    const rect = { id: this._nextId++, type: "rectangle", width, height, area: width * height };
    this._shapes.push(rect);
    return rect;
  }

  createTriangle(base, height) {
    const tri = { id: this._nextId++, type: "triangle", base, height, area: (base * height) / 2 };
    this._shapes.push(tri);
    return tri;
  }

  getShapes() { return this._shapes; }
  getShapeById(id) { return this._shapes.find(s => s.id === id); }
  getShapeCount() { return this._shapes.length; }
  getTotalArea() { return this._shapes.reduce((sum, s) => sum + s.area, 0); }
  clear() { this._shapes = []; this._nextId = 1; return this; }
  removeShape(id) { this._shapes = this._shapes.filter(s => s.id !== id); return this; }
}

// Singleton pattern
class Config {
  constructor() {
    this._instance = null;
    this._values = {};
    this._defaults = {
      theme: "light",
      language: "en",
      fontSize: 14,
      darkMode: false,
      notifications: true
    };
  }

  getInstance() {
    if (!this._instance) {
      this._instance = new Config();
    }
    return this._instance;
  }

  get(key) { return this._values[key] ?? this._defaults[key]; }
  set(key, value) { this._values[key] = value; return this; }
  reset(key) { this._values[key] = this._defaults[key]; return this; }
  getAll() { return { ...this._defaults, ...this._values }; }
  has(key) { return key in this._values || key in this._defaults; }
  merge(config) { this._values = { ...this._values, ...config }; return this; }
  clear() { this._values = {}; return this; }
  getDefaults() { return this._defaults; }
}

// Observer pattern
class EventEmitter {
  constructor() {
    this._events = {};
    this._maxListeners = 10;
    this._eventCount = 0;
  }

  on(event, listener) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(listener);
    this._eventCount++;
    return this;
  }

  off(event, listener) {
    if (this._events[event]) {
      this._events[event] = this._events[event].filter(l => l !== listener);
    }
    return this;
  }

  emit(event, ...args) {
    if (this._events[event]) {
      this._events[event].forEach(l => l(...args));
    }
    return this;
  }

  once(event, listener) {
    const wrapper = (...args) => { listener(...args); this.off(event, wrapper); };
    return this.on(event, wrapper);
  }

  getEventCount() { return this._eventCount; }
  getMaxListeners() { return this._maxListeners; }
  getMaxEvents() { return Object.keys(this._events).length; }
  hasListeners(event) { return this._events[event] && this._events[event].length > 0; }
  getListeners(event) { return this._events[event] || []; }
  removeAllListeners(event) {
    if (event) { delete this._events[event]; }
    else { this._events = {}; }
    return this;
  }
}

// Data structure classes
class Stack {
  constructor() {
    this._items = [];
    this._maxSize = 100;
  }

  push(item) { this._items.push(item); return this; }
  pop() { return this._items.pop(); }
  peek() { return this._items[this._items.length - 1]; }
  isEmpty() { return this._items.length === 0; }
  isFull() { return this._items.length >= this._maxSize; }
  size() { return this._items.length; }
  clear() { this._items = []; return this; }
  contains(item) { return this._items.includes(item); }
  getIndex(item) { return this._items.indexOf(item); }
  toArray() { return [...this._items]; }
  getMaxSize() { return this._maxSize; }
}

class Queue {
  constructor() {
    this._items = [];
    this._maxSize = 100;
  }

  enqueue(item) { this._items.push(item); return this; }
  dequeue() { return this._items.shift(); }
  front() { return this._items[0]; }
  back() { return this._items[this._items.length - 1]; }
  isEmpty() { return this._items.length === 0; }
  isFull() { return this._items.length >= this._maxSize; }
  size() { return this._items.length; }
  clear() { this._items = []; return this; }
  getMaxSize() { return this._maxSize; }
  toArray() { return [...this._items]; }
}

// Instances
const person = new Person("Alice", 30, "alice@example.com");
const employee = new Employee("Bob", 35, "bob@example.com", "Engineering", 80000);
const manager = new Manager("Charlie", 40, "charlie@example.com", "Engineering", 100000, 5);
const mathHelper = MathHelper;
const rectangle = new Rectangle(10, 20);
const iterator = new Iterator([1, 2, 3, 4, 5]);
const stateMachine = new StateMachine("idle");
const shapeFactory = new ShapeFactory();
const config = new Config();
const eventEmitter = new EventEmitter();
const stack = new Stack();
const queue = new Queue();
