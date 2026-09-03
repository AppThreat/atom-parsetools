import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GENERATOR_VERSION,
  SUPPORTED_TARGET_VERSIONS,
  printParserInfo
} from "../phpastgen.js";

// Unit tests for the phpastgen `--parser-info` capability report and the `--version` string
// (Requirements 1.5, 1.6; design §2.5). These pin the cross-repo contract that the chen capability
// probe and the atom version gate rely on: the report carries a `Parser backend:` line, a
// `Generator version:` line whose value is identical to what `--version` prints and to
// GENERATOR_VERSION, and a supported-target list covering 8.0 through 8.5 inclusive.
//
// `printParserInfo()` prints the backend, generator version, and grammar coverage regardless of
// whether a PHP runtime is present (it only changes the PHP-version line and exit code when PHP is
// missing), so the report content is captured in-process here without requiring a PHP runtime.
// The `--version` value is captured by spawning the wrapper the same way chen invokes it.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const wrapper = join(repoRoot, "phpastgen.js");

// Capture everything printParserInfo() writes to console.log, returning the joined lines plus the
// returned exit code. console.log is restored afterward even if an assertion throws.
function capturePrintParserInfo() {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  let rc;
  try {
    rc = printParserInfo();
  } finally {
    console.log = originalLog;
  }
  return { rc, lines, text: lines.join("\n") };
}

// Parse the value to the right of a `Label:` line prefix, trimmed. Returns undefined when the line
// is absent.
function lineValue(lines, label) {
  const match = lines.find((line) => line.startsWith(label));
  if (match === undefined) {
    return undefined;
  }
  return match.slice(label.length).trim();
}

// Spawn the wrapper with `--version` and capture its stdout. Mirrors how chen/atom invoke the
// generator to read the version string.
function runVersion() {
  const result = spawnSync(process.execPath, [wrapper, "--version"], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: process.env
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 1. The capability report contains a `Parser backend:` line naming the vendored parser and its
//    version (Requirement 1.5).
{
  const { lines } = capturePrintParserInfo();
  const backend = lineValue(lines, "Parser backend:");
  assert.ok(
    backend !== undefined,
    "report must contain a 'Parser backend:' line"
  );
  assert.ok(
    backend.includes("nikic/php-parser"),
    `parser backend line should name the vendored parser, got '${backend}'`
  );
  assert.ok(
    /@\S+/.test(backend),
    `parser backend line should carry a version, got '${backend}'`
  );
  console.log("ok --parser-info report contains a Parser backend line");
}

// 2. The report contains a `Generator version:` line whose value equals GENERATOR_VERSION
//    (Requirement 1.5).
{
  const { lines } = capturePrintParserInfo();
  const generator = lineValue(lines, "Generator version:");
  assert.ok(
    generator !== undefined,
    "report must contain a 'Generator version:' line"
  );
  assert.equal(
    generator,
    GENERATOR_VERSION,
    "generator version in report must equal GENERATOR_VERSION"
  );
  console.log("ok --parser-info report contains the generator version");
}

// 3. The report's supported target grammars cover 8.0 through 8.5 inclusive (Requirement 1.5).
{
  const { lines } = capturePrintParserInfo();
  const supported = lineValue(lines, "Supported target versions:");
  assert.ok(
    supported !== undefined,
    "report must contain a 'Supported target versions:' line"
  );
  for (const version of ["8.0", "8.1", "8.2", "8.3", "8.4", "8.5"]) {
    assert.ok(
      supported.includes(version),
      `supported target versions must cover ${version}, got '${supported}'`
    );
  }
  // Guard against the constant itself regressing out of the 8.0-8.5 range.
  assert.deepEqual(
    SUPPORTED_TARGET_VERSIONS,
    ["8.0", "8.1", "8.2", "8.3", "8.4", "8.5"],
    "SUPPORTED_TARGET_VERSIONS must span 8.0 through 8.5 inclusive"
  );
  console.log("ok --parser-info report covers grammars 8.0 through 8.5");
}

// 4. `--version` prints exactly GENERATOR_VERSION and exits 0 (Requirement 1.6).
{
  const run = runVersion();
  assert.equal(run.status, 0, "--version should exit 0");
  assert.equal(
    run.stdout.trim(),
    GENERATOR_VERSION,
    "--version must print exactly the generator version string"
  );
  console.log("ok --version prints the generator version and exits 0");
}

// 5. The `Generator version:` line in the report is identical to what `--version` prints, so the
//    two entry points never drift (Requirement 1.6).
{
  const { lines } = capturePrintParserInfo();
  const reportGenerator = lineValue(lines, "Generator version:");
  const versionOutput = runVersion().stdout.trim();
  assert.equal(
    reportGenerator,
    versionOutput,
    "the report's generator version must match the --version output"
  );
  console.log(
    "ok --parser-info generator version matches the --version output"
  );
}

console.log("phpastgen-parser-info: all checks passed");
