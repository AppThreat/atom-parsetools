// A tsconfig without `include` lists every file under its directory. None of
// them may bring back what discovery leaves out: directories named in
// ASTGEN_IGNORE_DIRS or the default list, names matching
// ASTGEN_IGNORE_FILE_PATTERN, and minified files. The tsconfig's declaration
// files are still parsed and still give the program their types.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputRoot,
  expectType,
  readJson
} from "./ast-regression-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const fixtureRoot = join(__dirname, "projects", "ignored-dirs");
const outputs = [];

const discoveryEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      name !== "ASTGEN_IGNORE_DIRS" && name !== "ASTGEN_IGNORE_FILE_PATTERN"
  )
);

const runWith = (env) => {
  const outputRoot = createOutputRoot("atom-parsetools-ignored-dirs-");
  outputs.push(outputRoot);
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "astgen.js"),
      "-i",
      fixtureRoot,
      "-o",
      outputRoot,
      "-t",
      "js"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...discoveryEnv, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return outputRoot;
};

const writtenFiles = (outputRoot) => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(outputRoot)
    .filter((path) => path.endsWith(".json"))
    .map((path) =>
      relative(outputRoot, path)
        .replaceAll("\\", "/")
        .replace(/\.json$/, "")
    )
    .sort();
};

try {
  // The default ignore list covers e2e and examples.
  const defaults = runWith({});
  assert.deepEqual(writtenFiles(defaults), [
    "src/env.d.ts",
    "src/legacy-api.ts",
    "src/service.ts"
  ]);
  expectType(
    {
      code: readFileSync(join(fixtureRoot, "src/service.ts"), "utf8"),
      typemap: readJson(join(defaults, "src/service.ts.typemap")),
      relativeName: "src/service.ts"
    },
    "buildId =",
    "string"
  );

  // A list of its own replaces the defaults, so examples is parsed again.
  const ownList = runWith({ ASTGEN_IGNORE_DIRS: "e2e,node_modules" });
  assert.deepEqual(writtenFiles(ownList), [
    "examples/demo.ts",
    "src/env.d.ts",
    "src/legacy-api.ts",
    "src/service.ts"
  ]);

  // cdxgen passes a scan's exclude patterns as ASTGEN_IGNORE_FILE_PATTERN.
  const filePattern = runWith({ ASTGEN_IGNORE_FILE_PATTERN: "legacy" });
  assert.deepEqual(writtenFiles(filePattern), [
    "src/env.d.ts",
    "src/service.ts"
  ]);

  console.log("astgen ignored directory regression tests passed");
} finally {
  for (const outputRoot of outputs) {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}
