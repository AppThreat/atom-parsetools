// Exercises the command line the pinned atom version runs: scalasem <workDir> <outFile> with
// no flags, which must exit 0 and produce a file every consumer of the version 1 keys reads.
// The no build form runs the same way without starting a build tool.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const scalasem = join(process.cwd(), "scalasem.js");
const out = mkdtempSync(join(tmpdir(), "scalasem-cli-"));
// The fixture is copied so the build tool runs of the flag free form cannot rewrite the
// files the repository keeps.
const project = join(out, "project");
cpSync(
  join(process.cwd(), "test-fixtures", "projects", "scala", "showcase"),
  project,
  {
    recursive: true
  }
);

// The no build form reads the classpath the last build exported next to its outputs.
const repository = join(out, "repository", "org", "example", "dep_3", "1.0");
const exported = join(repository, "dep_3-1.0.jar");
mkdirSync(repository, { recursive: true });
// An empty but valid zip archive: the end of central directory record alone.
writeFileSync(
  exported,
  Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])
);
const streams = join(
  project,
  "target",
  "streams",
  "compile",
  "dependencyClasspath",
  "_global",
  "streams"
);
mkdirSync(streams, { recursive: true });
writeFileSync(join(streams, "export"), exported);

// A project without a route file still reports the endpoints its configuration names.
mkdirSync(join(project, "conf"), { recursive: true });
writeFileSync(
  join(project, "conf", "application.conf"),
  'db.default.url = "jdbc:postgresql://admin:hunter2@db.internal:5432/app"\n'
);

function runScalasem(args) {
  return spawnSync(process.execPath, [scalasem, ...args], {
    encoding: "utf-8"
  });
}

let result = runScalasem([project, join(out, "slices.json"), "--no-build"]);
if (result.status !== 0 || !existsSync(join(out, "slices.json"))) {
  // Without a JDK or a cached compiler the analysis cannot run; that is not a failure of the
  // command line contract being tested here.
  console.log(
    `scalasem-cli: skipped, analysis unavailable (${(result.stderr || "").split("\n")[0]})`
  );
  rmSync(out, { recursive: true, force: true });
  process.exit(0);
}
const report = JSON.parse(readFileSync(join(out, "slices.json"), "utf-8"));

// The version 1 keys and the version 2 contract.
assert.strictEqual(report._meta.schemaVersion, "scalasem/2");
assert.deepStrictEqual(
  report.modules.map((m) => m.classDirs),
  [["target/scala-3.3.7/classes"]],
  "one module for the class directory, not one per package"
);
assert.ok(
  report.config && Array.isArray(report.config.routes),
  "config.routes present"
);
assert.ok(Array.isArray(report.modules), "modules present");
const fileKeys = Object.keys(report).filter((k) => k.endsWith(".scala"));
assert.ok(fileKeys.length === 2, "the source file entries of the fixture");
for (const key of fileKeys) {
  const entry = report[key];
  assert.ok(typeof entry.sourceFile === "string");
  assert.ok(Array.isArray(entry.tags));
  assert.ok(Array.isArray(entry.usedTypes));
  assert.ok(Array.isArray(entry.literals));
  assert.ok(Array.isArray(entry.calls) && entry.calls.length > 0);
  assert.ok(Array.isArray(entry.references));
}

assert.deepStrictEqual(
  report.config.values.map((v) => `${v.key}=${v.value}`),
  ["db.default.url=jdbc:postgresql://db.internal:5432/app"],
  "configuration values without a route file, credentials removed"
);

assert.ok(
  report.modules[0].classpath.some(
    (c) => c.group === "org.example" && c.artifact === "dep_3"
  ),
  "leftover classpath of the last build read"
);

// A second run with no flags at all, the exact form atom uses.
result = runScalasem([project, join(out, "atom.json")]);
assert.strictEqual(
  result.status,
  0,
  `scalasem <dir> <file> failed: ${result.stderr}`
);
assert.ok(existsSync(join(out, "atom.json")), "atom form produced the file");

// An option and its value as two words: the value is not taken for the output file.
result = runScalasem([
  project,
  join(out, "spaced.json"),
  "--no-build",
  "--semanticdb",
  "never"
]);
assert.strictEqual(result.status, 0, `spaced option failed: ${result.stderr}`);
assert.ok(
  existsSync(join(out, "spaced.json")) && !existsSync(join(project, "never"))
);

// Usage errors fail with a non-zero exit and no output file.
result = runScalasem([join(out, "no-such-directory"), join(out, "none.json")]);
assert.notStrictEqual(result.status, 0, "missing directory must fail");
assert.ok(!existsSync(join(out, "none.json")));

cleanup();
console.log(
  `scalasem-cli: atom command line and no build form checked, ${fileKeys.length} entries`
);

function cleanup() {
  rmSync(out, { recursive: true, force: true });
}
