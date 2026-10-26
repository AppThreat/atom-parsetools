// A type that recurses through conditional types must not take the heap with
// it. Writing one, TypeScript's node builder keeps expanding past the length
// limit once it is truncating; an ORM client's result types (Prisma 4's, in
// the shape the fixture copies) run to tens of thousands of builder calls a
// write,
// and in a real project to millions of characters, until the process runs out
// of memory and no file gets an AST. astgen cancels such a write and treats the
// type as one too long to write, which it was going to be anyway.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputRoot,
  expectType,
  readJson
} from "./ast-regression-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const fixtureRoot = join(__dirname, "projects", "recursive-payload");
const outputRoot = createOutputRoot("atom-parsetools-recursive-types-");

const load = (relativeName) => ({
  code: readFileSync(join(fixtureRoot, relativeName), "utf8"),
  typemap: readJson(join(outputRoot, `${relativeName}.typemap`)),
  relativeName
});

try {
  // Without the cancellation the fixture needs about 2 GB; 512 MB leaves the
  // bounded writes ample room and fails the unbounded ones.
  const run = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=512",
      join(repoRoot, "astgen.js"),
      "-i",
      fixtureRoot,
      "-o",
      outputRoot,
      "-t",
      "ts"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ASTGEN_TYPE_TIMING: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  assert.equal(run.status, 0, `astgen failed:\n${run.stderr.slice(-2000)}`);
  const cancelled = [...run.stderr.matchAll(/cancelledWrites=(\d+)/g)].reduce(
    (sum, m) => sum + Number(m[1]),
    0
  );
  assert.ok(cancelled > 0, "no type write was cancelled");

  const service = load("service.ts");
  load("client.ts");

  // Everything else is written as before
  expectType(service, "title =", "(name: string) => string");
  expectType(service, "author: string", "string", { offset: 8 });
  expectType(service, "include:", "{ author: boolean; tags: boolean; }", {
    offset: 9
  });

  console.log("astgen recursive type regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
