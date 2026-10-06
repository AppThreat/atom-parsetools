// Validates reports against the schema v2 file. The validator supports the keywords the
// schema uses, so no dependency is added to the package.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { buildReport } from "../lib/scalasem/schema.js";
import { parseFacts } from "../lib/scalasem/inspect.js";
import { buildFileEntry } from "../lib/scalasem/facts.js";
import { parseProjectConfig } from "../lib/scalasem/config.js";

const schema = JSON.parse(
  readFileSync(
    join(process.cwd(), "lib", "scalasem", "scalasem-v2.schema.json"),
    "utf-8"
  )
);

/**
 * @param {*} value Value to check
 * @param {Object} node Schema node
 * @param {string} path Where the value sits, for messages
 * @returns {string[]} Violations
 */
function validate(value, node, path) {
  const errors = [];
  if (node.$ref) {
    const ref = node.$ref.replace(/^#\/definitions\//, "");
    return validate(value, schema.definitions[ref], path);
  }
  if (node.const !== undefined && value !== node.const) {
    errors.push(`${path}: expected ${JSON.stringify(node.const)}`);
  }
  if (node.enum && !node.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${node.enum.join(", ")}`);
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.length) {
    const actual = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value === "number" && Number.isInteger(value)
          ? "integer"
          : typeof value;
    if (!types.includes(actual)) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${actual}`);
      return errors;
    }
  }
  if (typeof value === "number" && node.minimum !== undefined && value < node.minimum) {
    errors.push(`${path}: ${value} is below ${node.minimum}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (node.minProperties && Object.keys(value).length < node.minProperties) {
      errors.push(`${path}: expected at least ${node.minProperties} properties`);
    }
    for (const key of node.required || []) {
      if (!(key in value)) {
        errors.push(`${path}: missing ${key}`);
      }
    }
    const patterns = Object.entries(node.patternProperties || {});
    for (const key of Object.keys(value)) {
      const matching = patterns.filter(([pattern]) => new RegExp(pattern).test(key));
      if (matching.length) {
        for (const [, child] of matching) {
          errors.push(...validate(value[key], child, `${path}.${key}`));
        }
      } else if (
        node.additionalProperties === false &&
        !(node.properties && key in node.properties)
      ) {
        errors.push(`${path}: ${key} is not allowed here`);
      }
    }
    for (const [key, child] of Object.entries(node.properties || {})) {
      if (key in value) {
        errors.push(...validate(value[key], child, `${path}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && node.items) {
    value.forEach((item, index) => {
      errors.push(...validate(item, node.items, `${path}[${index}]`));
    });
  }
  return errors;
}

// A recorded report of a real project.
const recorded = JSON.parse(
  readFileSync(
    join(process.cwd(), "test-fixtures", "projects", "scala", "reports", "showcase.json"),
    "utf-8"
  )
);
let violations = validate(recorded, schema, "$");
assert.deepStrictEqual(violations, [], `recorded report violates the schema:\n${violations.join("\n")}`);

// A report built the way the writer builds it, over the recorded inspector output.
const lines = readFileSync(
  join(process.cwd(), "test-fixtures", "projects", "scala", "inspector", "showcase-3.3.7.jsonl"),
  "utf-8"
)
  .split("\n")
  .filter((line) => line.trim());
const facts = parseFacts(join(process.cwd(), "test-fixtures", "projects", "scala", "showcase"), lines);
const config = parseProjectConfig(
  join(process.cwd(), "test-fixtures", "projects", "scala", "playish")
);
const fileEntries = {};
for (const [file, raw] of facts) {
  fileEntries[file] = buildFileEntry(
    raw,
    { id: "showcase", platform: "jvm", scalaVersion: "3.3.7" },
    file,
    {}
  );
}
const report = buildReport({
  projectDir: "/src/showcase",
  tool: "sbt",
  version: "1.10.11",
  modules: [
    {
      id: "showcase",
      platform: "jvm",
      scalaVersion: "3.3.7",
      classDirs: ["target/scala-3.3.7/classes"],
      sourceRoots: ["src/main/scala"],
      classpath: [
        {
          path: "/coursier-cache/org/scala-lang/scala3-library_3/3.3.7/scala3-library_3-3.3.7.jar",
          group: "org.scala-lang",
          artifact: "scala3-library_3",
          version: "3.3.7"
        }
      ],
      projectDir: "/src/showcase"
    }
  ],
  fileEntries,
  config,
  diagnostics: [{ code: "unreadable-tasty", module: "showcase", count: 1 }],
  toolchains: [
    { version: "3.3.7", source: "sbt" },
    { version: "3.3.7", source: "sbt" }
  ]
});
violations = validate(report, schema, "$");
assert.deepStrictEqual(violations, [], `built report violates the schema:\n${violations.join("\n")}`);
assert.deepStrictEqual(
  report._meta.compilers,
  [{ source: "sbt", version: "3.3.7" }],
  "one compiler entry for modules that share it"
);

// Sorting: two builds of the same parts produce the same bytes.
assert.deepStrictEqual(
  JSON.stringify(buildReport({ ...reportParts() })),
  JSON.stringify(buildReport({ ...reportParts() })),
  "report writing is not deterministic"
);

function reportParts() {
  return {
    projectDir: "/src/showcase",
    tool: "sbt",
    modules: [],
    fileEntries,
    config: { routes: [] },
    diagnostics: [],
    toolchains: []
  };
}

console.log(
  `scalasem-report-schema: recorded and built reports valid, ${Object.keys(recorded).length} top level keys`
);
