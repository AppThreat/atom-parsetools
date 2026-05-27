// Type Inference Test Runner - Simplified Version
// Uses TypeScript AST directly for accurate type inference

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
const BASELINE_OUTPUT_DIR = join(__dirname, "baseline");

/**
 * Get all JS files in a directory
 */
function getJsFiles(dir) {
  const files = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...getJsFiles(fullPath));
    } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Create TypeScript program for type inference
 */
function createTypeScriptProgram(srcFiles) {
  return tsc.createProgram(srcFiles, {
    target: tsc.ScriptTarget.ES2022,
    module: tsc.ModuleKind.CommonJS,
    moduleResolution: tsc.ModuleResolutionKind.Node10,
    allowSyntheticDefaultImports: true,
    allowJs: true,
    checkJs: true,
    alwaysStrict: false,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"]
  });
}

/**
 * Extract type information from TypeScript AST
 * Returns a map of variable names to their inferred types
 */
function extractVariableTypes(sourceFile, typeChecker) {
  const types = new Map();

  function visit(node) {
    // Handle variable declarations
    if (tsc.isVariableStatement(node)) {
      const declList = node.declarationList;
      for (const decl of declList.declarations) {
        const name = decl.name.getText(sourceFile);
        try {
          const type = typeChecker.getTypeAtLocation(decl.name);
          const typeStr = typeChecker.typeToString(type);

          // Get line number
          const line = sourceFile.getLineAndCharacterOfPosition(decl.name.getStart());

          // Classify the type
          let category = "unknown";
          if (typeStr === "any" || typeStr === "unknown") {
            category = "any";
          } else if (typeStr.includes("[]") || typeStr.includes("Array<")) {
            category = "array";
          } else if (typeStr === "string" || typeStr === "number" || typeStr === "boolean" || typeStr === "bigint" || typeStr === "symbol") {
            category = "primitive";
          } else if (typeStr === "object") {
            category = "object";
          } else if (typeStr.includes("=>") || typeStr === "Function") {
            category = "function";
          } else if (typeStr.includes("{") || typeStr.includes("<")) {
            category = "complex";
          } else if (typeStr.includes("'") || typeStr.includes('"')) {
            category = "literal";
          } else if (typeStr.includes("|")) {
            category = "union";
          } else {
            category = "other";
          }

          types.set(name, {
            type: typeStr,
            category,
            line: line.line + 1,
            position: decl.name.getStart()
          });
        } catch {
          types.set(name, {
            type: "any",
            category: "any",
            line: 0,
            position: decl.name.getStart()
          });
        }
      }
    }

    // Handle function declarations
    if (tsc.isFunctionDeclaration(node)) {
      const name = node.name?.getText(sourceFile) || "anonymous";
      try {
        const signature = typeChecker.getSignatureFromDeclaration(node);
        if (signature) {
          const returnType = typeChecker.getReturnTypeOfSignature(signature);
          const typeStr = typeChecker.typeToString(returnType);
          const line = sourceFile.getLineAndCharacterOfPosition(node.name.getStart());

          let category = "function";
          if (typeStr === "void" || typeStr === "any") {
            category = "function_return_" + typeStr;
          }

          types.set(name, {
            type: `function => ${typeStr}`,
            category,
            line: line.line + 1,
            position: node.name.getStart()
          });
        }
      } catch {
        // ignore
      }
    }

    // Recurse
    tsc.forEachChild(node, visit);
  }

  visit(sourceFile);
  return types;
}

/**
 * Analyze a file and extract type information
 */
function analyzeFile(filePath, program) {
  const typeChecker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(filePath);
  if (!sourceFile) {
    return {
      filePath,
      types: new Map(),
      error: "Source file not found"
    };
  }

  const types = extractVariableTypes(sourceFile, typeChecker);
  return {
    filePath,
    types
  };
}

/**
 * Calculate metrics from analysis results
 */
function calculateMetrics(results) {
  let totalVariables = 0;
  let inferredTypes = 0;
  let anyTypes = 0;
  let primitiveTypes = 0;
  let arrayTypes = 0;
  let functionTypes = 0;
  let objectTypes = 0;
  let complexTypes = 0;
  let literalTypes = 0;
  let unionTypes = 0;
  const categoryDistribution = {};
  const typeDistribution = {};
  const fileMetrics = [];

  for (const result of results) {
    const fileResult = {
      filePath: result.filePath,
      totalVariables: result.types.size,
      typesInferred: 0,
      variables: []
    };

    totalVariables += result.types.size;

    for (const [name, info] of result.types) {
      totalVariables++;

      fileResult.variables.push({
        name,
        type: info.type,
        category: info.category,
        line: info.line
      });

      if (info.category === "any") {
        anyTypes++;
      } else {
        inferredTypes++;
        fileResult.typesInferred++;

        // Count by category
        categoryDistribution[info.category] = (categoryDistribution[info.category] || 0) + 1;
        typeDistribution[info.type] = (typeDistribution[info.type] || 0) + 1;

        if (info.category === "primitive") primitiveTypes++;
        if (info.category === "array") arrayTypes++;
        if (info.category === "function") functionTypes++;
        if (info.category === "object") objectTypes++;
        if (info.category === "complex") complexTypes++;
        if (info.category === "literal") literalTypes++;
        if (info.category === "union") unionTypes++;
      }
    }

    fileMetrics.push(fileResult);
  }

  return {
    totalVariables,
    inferredTypes,
    inferenceRate: totalVariables > 0
      ? ((inferredTypes / totalVariables) * 100).toFixed(2) + "%"
      : "0%",
    anyTypes,
    primitiveTypes,
    arrayTypes,
    functionTypes,
    objectTypes,
    complexTypes,
    literalTypes,
    unionTypes,
    categoryDistribution,
    typeDistribution,
    fileMetrics
  };
}

/**
 * Generate baseline report
 */
function generateBaseline(metrics) {
  const report = {
    generatedAt: new Date().toISOString(),
    fixtureDir: TEST_FIXTURES_DIR,
    metrics
  };

  mkdirSync(BASELINE_OUTPUT_DIR, { recursive: true });
  writeFileSync(
    join(BASELINE_OUTPUT_DIR, "baseline.json"),
    JSON.stringify(report, null, 2)
  );

  return report;
}

/**
 * Generate human-readable summary
 */
function generateSummary(metrics) {
  let summary = "\n=== Type Inference Baseline Report ===\n\n";
  summary += `Generated: ${new Date().toISOString()}\n`;
  summary += `Fixture Directory: ${TEST_FIXTURES_DIR}\n\n`;
  summary += "--- Metrics ---\n";
  summary += `Total Variables: ${metrics.totalVariables}\n`;
  summary += `Types Inferred: ${metrics.inferredTypes}\n`;
  summary += `Inference Rate: ${metrics.inferenceRate}\n`;
  summary += `Any Types: ${metrics.anyTypes}\n`;
  summary += `Primitive Types: ${metrics.primitiveTypes}\n`;
  summary += `Array Types: ${metrics.arrayTypes}\n`;
  summary += `Function Types: ${metrics.functionTypes}\n`;
  summary += `Object Types: ${metrics.objectTypes}\n`;
  summary += `Complex Types: ${metrics.complexTypes}\n`;
  summary += `Literal Types: ${metrics.literalTypes}\n`;
  summary += `Union Types: ${metrics.unionTypes}\n\n`;

  summary += "--- Category Distribution ---\n";
  for (const [category, count] of Object.entries(metrics.categoryDistribution)
    .sort((a, b) => b[1] - a[1])) {
    summary += `  ${category}: ${count}\n`;
  }

  summary += "\n--- Top Type Distribution ---\n";
  const sortedTypes = Object.entries(metrics.typeDistribution)
    .sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [type, count] of sortedTypes) {
    summary += `  ${type}: ${count}\n`;
  }

  summary += "\n--- Per-File Breakdown ---\n";
  for (const file of metrics.fileMetrics) {
    summary += `\nFile: ${file.filePath}\n`;
    summary += `  Total Variables: ${file.totalVariables}\n`;
    summary += `  Types Inferred: ${file.typesInferred}\n`;

    if (file.variables.length > 0) {
      summary += "  Variables:\n";
      for (const v of file.variables) {
        summary += `    ${v.name} (line ${v.line}): ${v.type}\n`;
      }
    }
  }

  return summary;
}

/**
 * Main test runner
 */
async function runBaseline() {
  console.log("Running type inference baseline tests...");
  console.log(`Fixture directory: ${TEST_FIXTURES_DIR}`);

  // Get all JS files
  const jsFiles = getJsFiles(TEST_FIXTURES_DIR);
  console.log(`Found ${jsFiles.length} JavaScript files`);

  // Create TypeScript program
  const program = createTypeScriptProgram(jsFiles);
  const typeChecker = program.getTypeChecker();

  // Analyze each file
  const results = [];
  for (const file of jsFiles) {
    console.log(`Analyzing: ${file}`);
    const result = analyzeFile(file, program);
    results.push(result);
  }

  // Calculate metrics
  const metrics = calculateMetrics(results);

  // Generate baseline
  generateBaseline(metrics);

  // Generate and print summary
  const summary = generateSummary(metrics);
  mkdirSync(BASELINE_OUTPUT_DIR, { recursive: true });
  writeFileSync(join(BASELINE_OUTPUT_DIR, "summary.txt"), summary);

  console.log(summary);
  console.log(`\nBaseline saved to: ${BASELINE_OUTPUT_DIR}`);

  return metrics;
}

// Run if executed directly
if (process.argv[1] && process.argv[1].endsWith("run-tests.js")) {
  runBaseline();
}

export {
  getJsFiles,
  createTypeScriptProgram,
  extractVariableTypes,
  analyzeFile,
  calculateMetrics,
  runBaseline,
  TEST_FIXTURES_DIR,
  BASELINE_OUTPUT_DIR
};
