// Records the merged facts and the route configuration of a compiled Scala project, which the
// evidence tests read without a compiler. The sources of each recorded project are kept next
// to its recording under test-fixtures/projects/scala/evidence/<name>/.
//
//   node test-fixtures/record-scalasem-evidence.js <compiled project dir> <name>
//
// The project has to be built already: the recording reads what its build left on disk.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

import { inventory } from "../lib/scalasem/build.js";
import { collectFacts } from "../lib/scalasem/collect.js";
import { parseProjectConfig } from "../lib/scalasem/config.js";

const [projectArg, name] = process.argv.slice(2);
if (!projectArg || !name) {
  console.error(
    "usage: node test-fixtures/record-scalasem-evidence.js <compiled project dir> <name>"
  );
  process.exit(2);
}
const projectDir = realpathSync(resolve(projectArg));
const opts = { noBuild: true, installDeps: false, semanticdb: "auto" };
const detected = await inventory(projectDir, opts);
const collected = collectFacts(projectDir, detected.modules, opts);
const config = parseProjectConfig(projectDir);
const recording = {
  files: Object.fromEntries(
    [...collected.files.entries()].sort(([a], [b]) => a.localeCompare(b))
  ),
  config: { routes: config.routes, values: config.values }
};
const outDir = join(process.cwd(), "test-fixtures", "projects", "scala", "evidence");
mkdirSync(outDir, { recursive: true });
const text = JSON.stringify(recording);
if (text.includes(projectDir)) {
  console.error(`${name}: the recording names the project directory`);
  process.exit(1);
}
writeFileSync(join(outDir, `${name}.facts.json`), `${text}\n`);
console.log(
  `${name}: ${collected.files.size} files, ${config.routes.length} routes recorded`
);
