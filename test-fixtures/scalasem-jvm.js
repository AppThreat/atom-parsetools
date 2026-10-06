// Runs the inspector helper end to end when a JDK is available: the helper is compiled with
// every compiler release that can be resolved without downloading anything, and run over the
// TASTy files of the checked in project. Skipped cleanly when no JDK is present.
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import {
  compileHelper,
  resolveToolchain,
  runInspector
} from "../lib/scalasem/compiler.js";

const java = process.env.JAVA_HOME
  ? join(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "java.exe" : "java"
    )
  : "java";
const probe = process.platform === "win32" ? { shell: true } : {};
import { spawnSync } from "node:child_process";
const javaCheck = spawnSync(java, ["-version"], probe);
if (javaCheck.status !== 0) {
  console.log("scalasem-jvm: skipped, no JDK on PATH or JAVA_HOME");
  process.exit(0);
}

const project = join(
  process.cwd(),
  "test-fixtures",
  "projects",
  "scala",
  "showcase"
);
const classDir = join(project, "target", "scala-3.3.7", "classes");
const tastyFiles = readdirSync(join(classDir, "showcase"))
  .filter((f) => f.endsWith(".tasty"))
  .map((f) => join(classDir, "showcase", f));
assert.deepStrictEqual(
  tastyFiles.map((f) => basename(f)).sort(),
  ["Color.tasty", "Envelope.tasty", "Holder.tasty", "Sample.tasty", "Shapes.tasty"],
  "expected the compiled TASTy files of the fixture"
);

// The compiler comes from the caches of this machine, so the releases that resolve without a
// download vary; at least one is required. On CI the cache starts empty, and the first release
// is fetched through sbt the way scalasem itself does when installs are allowed.
const versions = ["3.3.7", "3.5.2", "3.7.3", "3.8.4", "3.9.0"];
const fetchFirst = Boolean(process.env.CI || process.env.SCALASEM_TEST_FETCH);
const run = [];
for (const version of versions) {
  const toolchain = resolveToolchain(
    {
      scalaVersion: version,
      buildTool: "test",
      compilerJars: [],
      libraryJars: []
    },
    { installDeps: fetchFirst && version === versions[0] }
  );
  if (!toolchain?.inspectorJar) {
    console.log(`scalasem-jvm: ${version} not resolvable offline, skipped`);
    continue;
  }
  const helperDir = compileHelper(toolchain);
  assert.ok(helperDir, `${version}: helper compiled`);
  const lines = runInspector(toolchain, helperDir, [classDir], tastyFiles);
  const facts = lines.filter((l) => l.includes('"kind":"def"')).length;
  const calls = lines.filter((l) => l.includes('"kind":"call"')).length;
  assert.ok(calls > 20, `${version}: expected call facts from the helper run`);
  assert.ok(
    lines.every((l) => l.startsWith("{")),
    `${version}: helper printed JSON lines`
  );
  run.push(`${version}=${calls} calls`);
}
assert.ok(run.length > 0, "no compiler release could be resolved offline");

// The helper cache is reused: a second compile of the same version does not recompile.
const first = resolveToolchain(
  {
    scalaVersion: versions[0],
    buildTool: "test",
    compilerJars: [],
    libraryJars: []
  },
  { installDeps: false }
);
if (first?.inspectorJar) {
  const before = compileHelper(first);
  const after = compileHelper(first);
  assert.strictEqual(
    before,
    after,
    "helper cache directory changed between compiles"
  );
}

console.log(`scalasem-jvm: ${run.join(", ")}`);
