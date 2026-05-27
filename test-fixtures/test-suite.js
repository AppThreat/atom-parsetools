// Comprehensive Type Inference Test Suite
// Tests and validates type inference accuracy for pure JavaScript codebases

import { parse } from "@babel/parser";
import tsc from "typescript";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_FIXTURES_DIR = join(__dirname, "projects", "simple-js");
const RESULTS_DIR = join(__dirname, "results");

/**
 * Test Case Definition
 */
class TestCase {
  constructor(name, code, expectedTypes) {
    this.name = name;
    this.code = code;
    this.expectedTypes = expectedTypes; // Map of variable name to expected type
  }
}

/**
 * Test Suite for Type Inference
 */
class TypeInferenceTestSuite {
  constructor() {
    this.testCases = [];
    this.results = [];
  }

  /**
   * Add a test case
   */
  addTestCase(name, code, expectedTypes) {
    this.testCases.push(new TestCase(name, code, expectedTypes));
    return this;
  }

  /**
   * Run all test cases
   */
  run() {
    console.log("=== Type Inference Test Suite ===\n");
    console.log(`Running ${this.testCases.length} test cases...\n`);

    let passed = 0;
    let failed = 0;

    for (const testCase of this.testCases) {
      const result = this.runTestCase(testCase);
      this.results.push(result);

      if (result.passed) {
        passed++;
        console.log(`✓ ${testCase.name}`);
      } else {
        failed++;
        console.log(`✗ ${testCase.name}`);
        for (const failure of result.failures) {
          console.log(`  - ${failure.variable}: expected "${failure.expected}", got "${failure.actual}"`);
        }
      }
    }

    console.log(`\n=== Results ===`);
    console.log(`Passed: ${passed}/${this.testCases.length}`);
    console.log(`Failed: ${failed}/${this.testCases.length}`);
    console.log(`Success Rate: ${((passed / this.testCases.length) * 100).toFixed(2)}%`);

    // Save results
    this.saveResults();

    return { passed, failed, total: this.testCases.length };
  }

  /**
   * Run a single test case
   */
  runTestCase(testCase) {
    // Create a temporary TypeScript program
    const compilerOptions = {
      target: tsc.ScriptTarget.ES2022,
      allowJs: true,
      checkJs: true,
      alwaysStrict: false,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"]
    };

    const host = tsc.createCompilerHost(compilerOptions);
    const originalGetSourceFile = host.getSourceFile;
    const sourceFile = tsc.createSourceFile("test.js", testCase.code, tsc.ScriptTarget.ES2022);
    host.getSourceFile = function(fileName) {
      if (fileName === "test.js") return sourceFile;
      return originalGetSourceFile.apply(this, arguments);
    };

    const program = tsc.createProgram(["test.js"], compilerOptions, host);
    const typeChecker = program.getTypeChecker();

    // Extract types from the source file
    const actualTypes = this.extractTypes(sourceFile, typeChecker);

    // Compare with expected types
    const failures = [];
    for (const [variable, expected] of testCase.expectedTypes) {
      const actual = actualTypes.get(variable);
      if (!actual || !this.typesMatch(expected, actual)) {
        failures.push({
          variable,
          expected,
          actual: actual || "missing"
        });
      }
    }

    return {
      testCase: testCase.name,
      passed: failures.length === 0,
      failures,
      actualTypes: Object.fromEntries(actualTypes)
    };
  }

  /**
   * Extract types from a TypeScript source file
   */
  extractTypes(sourceFile, typeChecker) {
    const types = new Map();

    function visit(node) {
      if (tsc.isVariableStatement(node)) {
        const declList = node.declarationList;
        for (const decl of declList.declarations) {
          const name = decl.name.getText(sourceFile);
          try {
            const type = typeChecker.getTypeAtLocation(decl.name);
            const typeStr = typeChecker.typeToString(type);
            types.set(name, typeStr);
          } catch {
            types.set(name, "any");
          }
        }
      }

      // Handle function declarations
      if (tsc.isFunctionDeclaration(node) && node.name) {
        const name = node.name.getText(sourceFile);
        try {
          const sig = typeChecker.getSignatureFromDeclaration(node);
          if (sig) {
            const retType = typeChecker.getReturnTypeOfSignature(sig);
            const retStr = typeChecker.typeToString(retType);
            const params = node.parameters.map(p => {
              const paramName = p.name.getText(sourceFile);
              return paramName + ": any";
            }).join(", ");
            types.set(name, `(${params}) => ${retStr}`);
          }
        } catch {
          types.set(name, "function");
        }
      }

      tsc.forEachChild(node, visit);
    }

    visit(sourceFile);
    return types;
  }

  /**
   * Check if two types match
   */
  typesMatch(expected, actual) {
    // Exact match
    if (expected === actual) return true;

    // Normalize whitespace
    const normExpected = expected.replace(/\s+/g, " ").trim();
    const normActual = actual.replace(/\s+/g, " ").trim();
    if (normExpected === normActual) return true;

    // Check for type compatibility
    if (expected === "number" && (actual === "number" || /\d+$/.test(actual))) return true;
    if (expected === "string" && (actual === "string" || /^".*"$/s.test(actual))) return true;
    if (expected === "boolean" && (actual === "boolean" || actual === "true" || actual === "false")) return true;
    if (expected === "number[]" && actual === "number[]") return true;
    if (expected === "string[]" && actual === "string[]") return true;

    return false;
  }

  /**
   * Save results to file
   */
  saveResults() {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const resultsFile = join(RESULTS_DIR, "test-results.json");
    writeFileSync(
      resultsFile,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        results: this.results,
        summary: {
          total: this.testCases.length,
          passed: this.results.filter(r => r.passed).length,
          failed: this.results.filter(r => !r.passed).length
        }
      }, null, 2)
    );
  }
}

/**
 * Define test cases for primitive types
 */
function addPrimitiveTests(suite) {
  suite.addTestCase(
    "String literal",
    'const str = "hello";',
    new Map([["str", '"hello"']])
  );

  suite.addTestCase(
    "Number literal",
    "const num = 42;",
    new Map([["num", "42"]])
  );

  suite.addTestCase(
    "Boolean literal",
    "const bool = true;",
    new Map([["bool", "true"]])
  );

  suite.addTestCase(
    "Null literal",
    "const nill = null;",
    new Map([["nill", "null"]])
  );

  suite.addTestCase(
    "Undefined literal",
    "const und = undefined;",
    new Map([["und", "undefined"]])
  );

  suite.addTestCase(
    "BigInt literal",
    "const big = 100n;",
    new Map([["big", "100n"]])
  );
}

/**
 * Define test cases for array types
 */
function addArrayTests(suite) {
  suite.addTestCase(
    "Number array",
    "const nums = [1, 2, 3];",
    new Map([["nums", "number[]"]])
  );

  suite.addTestCase(
    "String array",
    'const strs = ["a", "b", "c"];',
    new Map([["strs", "string[]"]])
  );

  suite.addTestCase(
    "Mixed array",
    'const mixed = [1, "two", true];',
    new Map([["mixed", "(string | number | boolean)[]"]])
  );

  suite.addTestCase(
    "Nested array",
    "const nested = [[1, 2], [3, 4]];",
    new Map([["nested", "number[][]"]])
  );
}

/**
 * Define test cases for object types
 */
function addObjectTests(suite) {
  suite.addTestCase(
    "Simple object",
    "const point = { x: 10, y: 20 };",
    new Map([["point", "{ x: number; y: number; }"]])
  );

  suite.addTestCase(
    "Nested object",
    "const nested = { a: { b: { c: 1 } } };",
    new Map([["nested", "{ a: { b: { c: number; }; }; }"]])
  );

  suite.addTestCase(
    "Object with array",
    "const obj = { items: [1, 2, 3] };",
    new Map([["obj", "{ items: number[]; }"]])
  );
}

/**
 * Define test cases for function types
 */
function addFunctionTests(suite) {
  suite.addTestCase(
    "Function returning number",
    "function add(a, b) { return a + b; }",
    new Map([["add", "(a: any, b: any) => any"]])
  );

  suite.addTestCase(
    "Function returning string",
    'function greet(name) { return "Hello, " + name; }',
    new Map([["greet", "(name: any) => string"]])
  );

  suite.addTestCase(
    "Function returning boolean",
    "function isEven(n) { return n % 2 === 0; }",
    new Map([["isEven", "(n: any) => boolean"]])
  );

  suite.addTestCase(
    "Function returning void",
    "function log(msg) { console.log(msg); }",
    new Map([["log", "(msg: any) => void"]])
  );
}

/**
 * Define test cases for ES6+ features
 */
function addES6Tests(suite) {
  suite.addTestCase(
    "Nullish coalescing",
    'const val = null ?? "default";',
    new Map([["val", '"default"']])
  );

  suite.addTestCase(
    "Optional chaining",
    "const obj = { a: { b: 1 } }; const val = obj?.a?.b;",
    new Map([["obj", "{ a: { b: number; }; }"], ["val", "number"]])
  );

  suite.addTestCase(
    "Spread operator",
    "const a = [1, 2]; const b = [...a, 3];",
    new Map([["a", "number[]"], ["b", "number[]"]])
  );

  suite.addTestCase(
    "Destructuring",
    "const { x, y } = { x: 1, y: 2 };",
    new Map([["{ x, y }", "{ x: number; y: number; }"]])
  );
}

/**
 * Define test cases for built-in types
 */
function addBuiltInTests(suite) {
  suite.addTestCase(
    "Date",
    "const date = new Date();",
    new Map([["date", "Date"]])
  );

  suite.addTestCase(
    "RegExp",
    "const regex = /pattern/gi;",
    new Map([["regex", "RegExp"]])
  );

  suite.addTestCase(
    "Error",
    'const err = new Error("message");',
    new Map([["err", "Error"]])
  );

  suite.addTestCase(
    "Map",
    "const map = new Map();",
    new Map([["map", "Map<any, any>"]])
  );

  suite.addTestCase(
    "Set",
    "const set = new Set();",
    new Map([["set", "Set<any>"]])
  );
}

/**
 * Define test cases for binary expressions
 */
function addBinaryExpressionTests(suite) {
  suite.addTestCase(
    "Addition expression",
    "const sum = 10 + 20;",
    new Map([["sum", "number"]])
  );

  suite.addTestCase(
    "Subtraction expression",
    "const diff = 100 - 42;",
    new Map([["diff", "number"]])
  );

  suite.addTestCase(
    "Multiplication expression",
    "const prod = 6 * 7;",
    new Map([["prod", "number"]])
  );

  suite.addTestCase(
    "Division expression",
    "const quot = 100 / 4;",
    new Map([["quot", "number"]])
  );

  suite.addTestCase(
    "Comparison expression",
    "const isGreater = 10 > 5;",
    new Map([["isGreater", "boolean"]])
  );

  suite.addTestCase(
    "Equality expression",
    "const isEqual = 5 === 5;",
    new Map([["isEqual", "boolean"]])
  );

  suite.addTestCase(
    "String concatenation",
    'const concat = "Hello" + " " + "World";',
    new Map([["concat", "string"]])
  );
}

/**
 * Define test cases for conditional expressions
 */
function addConditionalTests(suite) {
  suite.addTestCase(
    "Simple ternary",
    'const positive = 10 > 0 ? "yes" : "no";',
    new Map([["positive", "string"]])
  );

  suite.addTestCase(
    "Nested ternary",
    'const sign = -5 > 0 ? 1 : (-5 < 0 ? -1 : 0);',
    new Map([["sign", "number"]])
  );
}

/**
 * Define test cases for logical expressions
 */
function addLogicalTests(suite) {
  suite.addTestCase(
    "Logical AND",
    "const bothTrue = true && false;",
    new Map([["bothTrue", "boolean"]])
  );

  suite.addTestCase(
    "Logical OR",
    "const eitherTrue = true || false;",
    new Map([["eitherTrue", "boolean"]])
  );

  suite.addTestCase(
    "Logical NOT",
    "const notTrue = !false;",
    new Map([["notTrue", "boolean"]])
  );
}

/**
 * Define test cases for call expressions
 */
function addCallExpressionTests(suite) {
  suite.addTestCase(
    "Math.max call",
    "const maxVal = Math.max(1, 2, 3);",
    new Map([["maxVal", "number"]])
  );

  suite.addTestCase(
    "Math.min call",
    "const minVal = Math.min(1, 2, 3);",
    new Map([["minVal", "number"]])
  );

  suite.addTestCase(
    "String method call",
    'const upper = "hello".toUpperCase();',
    new Map([["upper", "string"]])
  );

  suite.addTestCase(
    "Array method call",
    "const len = [1, 2, 3].length;",
    new Map([["len", "number"]])
  );
}

/**
 * Define test cases for constructor calls
 */
function addConstructorTests(suite) {
  suite.addTestCase(
    "Date constructor",
    "const date = new Date();",
    new Map([["date", "Date"]])
  );

  suite.addTestCase(
    "Error constructor",
    'const err = new Error("message");',
    new Map([["err", "Error"]])
  );

  suite.addTestCase(
    "RegExp constructor",
    "const regex = new RegExp('test');",
    new Map([["regex", "RegExp"]])
  );
}

/**
 * Define test cases for template literals
 */
function addTemplateLiteralTests(suite) {
  suite.addTestCase(
    "Simple template literal",
    'const tmpl = `Hello, World`;',
    new Map([["tmpl", "string"]])
  );

  suite.addTestCase(
    "Template with interpolation",
    'const name = "Alice"; const tmpl = `Hello, ${name}`;',
    new Map([["name", '"Alice"'], ["tmpl", "string"]])
  );
}

/**
 * Define test cases for class patterns
 */
function addClassTests(suite) {
  suite.addTestCase(
    "Class instance",
    "class Point { constructor(x, y) { this.x = x; this.y = y; } } const p = new Point(10, 20);",
    new Map([["p", "Point"]])
  );
}

/**
 * Define test cases for arrow functions
 */
function addArrowFunctionTests(suite) {
  suite.addTestCase(
    "Arrow function returning number",
    "const double = (x) => x * 2;",
    new Map([["double", "(x: any) => number"]])
  );

  suite.addTestCase(
    "Arrow function returning string",
    "const greet = (name) => \"Hello, \" + name;",
    new Map([["greet", "(name: any) => string"]])
  );

  suite.addTestCase(
    "Arrow function returning object",
    "const createPoint = (x, y) => ({ x, y });",
    new Map([["createPoint", "(x: any, y: any) => { x: any; y: any; }"]])
  );
}

/**
 * Run all test suites
 */
function runAllTests() {
  const suite = new TypeInferenceTestSuite();

  // Add all test cases
  addPrimitiveTests(suite);
  addArrayTests(suite);
  addObjectTests(suite);
  addFunctionTests(suite);
  addES6Tests(suite);
  addBuiltInTests(suite);
  addBinaryExpressionTests(suite);
  addConditionalTests(suite);
  addLogicalTests(suite);
  addCallExpressionTests(suite);
  addConstructorTests(suite);
  addTemplateLiteralTests(suite);
  addClassTests(suite);
  addArrowFunctionTests(suite);

  // Run tests
  return suite.run();
}

// Run if executed directly
if (process.argv[1] && process.argv[1].endsWith("test-suite.js")) {
  runAllTests();
}

export { TypeInferenceTestSuite, runAllTests };
