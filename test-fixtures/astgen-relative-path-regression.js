// Output names are the file's path relative to the source directory. astgen run from the project
// directory without -i has "." as its source, and the old regular expression ("^./") cut the first
// character and slash of every path, so a/b.js was written as b.js.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const astgen = join(dirname(fileURLToPath(import.meta.url)), "..", "astgen.js");
const root = mkdtempSync(join(tmpdir(), "astgen-relpath-"));
try {
  writeFileSync(join(root, "package.json"), '{"name":"relpath"}');
  for (const rel of ["a/b.js", "ab/c.js", "top.js"]) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), "export const x = 1;\n");
  }
  const out = join(root, "out");
  execFileSync(process.execPath, [astgen, "-o", out, "--no-tsTypes"], { cwd: root, stdio: "ignore" });
  for (const rel of ["a/b.js", "ab/c.js", "top.js"]) {
    const p = join(out, `${rel}.json`);
    assert.ok(existsSync(p), `${rel}.json must be written`);
    assert.equal(JSON.parse(readFileSync(p, "utf8")).relativeName.split("\\").join("/"), rel);
  }
  assert.ok(!existsSync(join(out, "b.js.json")), "a/b.js must not be written as b.js");
  console.log("ok - output names are relative to the source directory");
} finally {
  rmSync(root, { recursive: true, force: true });
}
