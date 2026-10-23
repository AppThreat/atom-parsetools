// Type maps for code that uses Node built-ins. TypeScript 6 leaves every
// node_modules/@types package out of the program unless `types` names it, so
// astgen includes them all for projects that do not set `types`. The fixture
// carries a small stand-in for @types/node, so the test needs no install.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectType, readJson, runAstgen } from "./ast-regression-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const fixtureRoot = join(__dirname, "projects", "node-builtins");
const scratch = [];

const tempDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

const copyFixture = (tsconfig) => {
  const projectRoot = tempDir("atom-parsetools-node-types-project-");
  cpSync(fixtureRoot, projectRoot, { recursive: true });
  if (tsconfig) {
    writeFileSync(join(projectRoot, "tsconfig.json"), JSON.stringify(tsconfig));
  }
  return projectRoot;
};

const load = (projectRoot, outputRoot, relativeName) => {
  const typemapPath = join(outputRoot, `${relativeName}.typemap`);
  return {
    code: readFileSync(join(projectRoot, relativeName), "utf8"),
    typemap: existsSync(typemapPath) ? readJson(typemapPath) : {},
    relativeName
  };
};

const expectNodeTypes = (projectRoot, outputRoot) => {
  const server = load(projectRoot, outputRoot, "server.js");
  expectType(server, "configText =", "string");
  expectType(server, "encoded =", "string");
  expectType(server, "workingDir =", "string");
  const reader = load(projectRoot, outputRoot, "reader.ts");
  expectType(reader, "lines =", "Array<string>");
  expectType(reader, "firstLine =", "string");
};

try {
  // astgen runs from the repository root here, so the @types lookup has to
  // start at the project rather than at the working directory.
  const plainOutput = tempDir("atom-parsetools-node-types-");
  runAstgen(fixtureRoot, plainOutput);
  expectNodeTypes(fixtureRoot, plainOutput);

  // A tsconfig that does not set `types` gets the same packages.
  const configured = copyFixture({ compilerOptions: { allowJs: true } });
  const configuredOutput = tempDir("atom-parsetools-node-types-");
  runAstgen(configured, configuredOutput);
  expectNodeTypes(configured, configuredOutput);

  // An explicit `types` is the project's choice and is kept.
  const optedOut = copyFixture({
    compilerOptions: { allowJs: true, types: [] }
  });
  const optedOutOutput = tempDir("atom-parsetools-node-types-");
  runAstgen(optedOut, optedOutOutput);
  const server = load(optedOut, optedOutOutput, "server.js");
  const configTextAt = server.code.indexOf("configText =");
  assert.notEqual(
    server.typemap[String(configTextAt)],
    "string",
    "a tsconfig with `types: []` keeps node_modules/@types out of the program"
  );

  // chen's invocation: the project is the working directory and `-i` is left
  // at its default.
  const chenStyle = copyFixture();
  const chenStyleOutput = tempDir("atom-parsetools-node-types-");
  execFileSync(
    process.execPath,
    [join(repoRoot, "astgen.js"), "-o", chenStyleOutput, "-t", "js"],
    { cwd: chenStyle, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  expectNodeTypes(chenStyle, chenStyleOutput);

  console.log("astgen Node built-in type regression tests passed");
} finally {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
}
