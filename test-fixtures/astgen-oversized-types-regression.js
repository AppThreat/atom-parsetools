// A type that sprawls when written out must not reach the type map in full:
// such a type exhausted the heap after a few files (Playwright's `expect` is
// one). Each `pair()` call in the fixture doubles the structure, so the deepest
// levels run to tens of thousands of characters. astgen writes such a type by
// its alias name where it has one and otherwise treats it as unresolved, and
// writes every ordinary type as before.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputRoot,
  expectType,
  readJson,
  runAstgen
} from "./ast-regression-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const fixtureRoot = join(__dirname, "projects", "oversized-types");
const singleOutput = createOutputRoot("atom-parsetools-oversized-");
const workersOutput = createOutputRoot("atom-parsetools-oversized-workers-");
const maxTypeStringLength = 4096;
const relativeNames = ["consumer.ts", "pairs.ts"];

const load = (outputRoot, relativeName) => ({
  code: readFileSync(join(fixtureRoot, relativeName), "utf8"),
  typemap: readJson(join(outputRoot, `${relativeName}.typemap`)),
  relativeName
});

try {
  runAstgen(fixtureRoot, singleOutput);
  const pairs = load(singleOutput, "pairs.ts");
  const consumer = load(singleOutput, "consumer.ts");

  for (const { relativeName, typemap } of [pairs, consumer]) {
    const longest = Math.max(...Object.values(typemap).map((t) => t.length));
    assert.ok(
      longest < maxTypeStringLength,
      `${relativeName} has a ${longest}-character type`
    );
  }

  expectType(pairs, "level1 =", "{ left: string; right: string; }");
  expectType(pairs, "shallow =", "{ left: string; right: string; }");
  // Where TypeScript can write the alias briefly it still does; from the other
  // file the structure has to be written out, and that does not fit.
  expectType(pairs, "deep:", "{ inner: typeof level12; }");
  expectType(consumer, "again =", 'import("./pairs").Deep');
  expectType(consumer, "small =", "string");

  // Each worker builds its own program; a file's types must not depend on
  // which files the same program saw before it.
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "astgen.js"),
      "-i",
      fixtureRoot,
      "-o",
      workersOutput,
      "-t",
      "js"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ASTGEN_TYPE_WORKERS: "2" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  assert.deepEqual(
    readdirSync(workersOutput)
      .filter((f) => f.endsWith(".typemap"))
      .sort(),
    relativeNames.map((name) => `${name}.typemap`)
  );
  for (const relativeName of relativeNames) {
    assert.deepEqual(
      load(workersOutput, relativeName).typemap,
      load(singleOutput, relativeName).typemap,
      `${relativeName} differs between one thread and two workers`
    );
  }

  console.log("astgen oversized type regression tests passed");
} finally {
  rmSync(singleOutput, { recursive: true, force: true });
  rmSync(workersOutput, { recursive: true, force: true });
}
