// Re-records the inspector output the engine tests read: the helper is compiled with each
// compiler release below and run over the checked in TASTy files of the showcase project.
// Run after changing the helper: npm run test:scala:record
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import {
  compileHelper,
  resolveToolchain,
  runInspector
} from "../lib/scalasem/compiler.js";

const projects = join(process.cwd(), "test-fixtures", "projects", "scala");
const classDir = join(projects, "showcase", "target", "scala-3.3.7", "classes");
const tastyFiles = readdirSync(join(classDir, "showcase"))
  .filter((f) => f.endsWith(".tasty"))
  .map((f) => join(classDir, "showcase", f));

// sbt records source paths relative to the build, so the helper runs from the project.
process.chdir(join(projects, "showcase"));
for (const version of ["3.3.7", "3.5.2", "3.8.4", "3.9.0"]) {
  const toolchain = resolveToolchain(
    {
      scalaVersion: version,
      buildTool: "test",
      compilerJars: [],
      libraryJars: []
    },
    { installDeps: true }
  );
  const helperDir = toolchain && compileHelper(toolchain);
  if (!helperDir) {
    console.error(`${version}: no compiler or helper, recording skipped`);
    process.exitCode = 1;
    continue;
  }
  const lines = runInspector(toolchain, helperDir, [classDir], tastyFiles);
  writeFileSync(
    join(projects, "inspector", `showcase-${version}.jsonl`),
    `${lines.join("\n")}\n`
  );
  console.log(`${version}: ${lines.length} facts recorded`);
}
