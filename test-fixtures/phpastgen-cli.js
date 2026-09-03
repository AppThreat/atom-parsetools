import assert from "node:assert/strict";
import {
  DEFAULT_EXCLUDE,
  DEFAULT_MAX_DEPTH,
  DEFAULT_OUTPUT,
  DEFAULT_THREADS,
  MAX_MAX_DEPTH,
  MAX_THREADS,
  MIN_MAX_DEPTH,
  MIN_THREADS,
  SUPPORTED_TARGET_VERSIONS,
  parseArgs
} from "../phpastgen.js";

// Unit tests for the phpastgen CLI parsing and dispatch surface (Requirements 2.1, 2.11, 1.7;
// design §2.1). `parseArgs` is a pure function over argv, so these tests exercise it directly
// without a PHP runtime or the vendored parser binary. They pin: default values, the
// `--parser-target` alias resolving to the same field as `--target-version`, out-of-range
// `--threads`/`--max-depth` falling back to their defaults, unsupported `--target-version` being
// recorded as invalid, and `-i/--input` selecting batch mode.

// Silence the expected warnings from out-of-range values so the test output stays clean, while
// still asserting the fallback behavior. Restored after each block that needs it.
function withSilencedWarn(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

// 1. Defaults: with no arguments, every option takes its documented default (Requirement 2.1,
//    2.2, 2.6, 2.11 defaults).
{
  const opts = parseArgs([]);
  assert.equal(opts.input, undefined, "input defaults to undefined");
  assert.equal(opts.output, DEFAULT_OUTPUT, "output defaults to '.ast'");
  assert.equal(opts.output, ".ast", "output default value is '.ast'");
  assert.equal(
    opts.exclude,
    DEFAULT_EXCLUDE,
    "exclude defaults to the vendor/tests regex"
  );
  assert.equal(opts.threads, DEFAULT_THREADS, "threads defaults to 10");
  assert.equal(opts.threads, 10, "threads default value is 10");
  assert.equal(opts.maxDepth, DEFAULT_MAX_DEPTH, "max-depth defaults to 250");
  assert.equal(opts.maxDepth, 250, "max-depth default value is 250");
  assert.equal(opts.log, "info", "log level defaults to info");
  assert.equal(opts.debug, false, "debug defaults to false");
  assert.equal(opts.failOnError, false, "fail-on-error defaults to false");
  assert.equal(opts.parserInfo, false, "parser-info defaults to false");
  assert.equal(opts.showVersion, false, "version defaults to false");
  assert.equal(opts.help, false, "help defaults to false");
  assert.equal(
    opts.targetVersion,
    undefined,
    "target-version defaults to undefined (newest grammar)"
  );
  assert.equal(
    opts.invalidTargetVersion,
    undefined,
    "no invalid target version by default"
  );
  console.log("ok parseArgs applies documented defaults");
}

// 2. Alias resolution: `--parser-target` sets the same field as `--target-version` for every
//    supported grammar (Requirement 1.3, alias parity).
{
  for (const version of SUPPORTED_TARGET_VERSIONS) {
    const viaCanonical = parseArgs(["--target-version", version]);
    const viaAlias = parseArgs(["--parser-target", version]);
    assert.equal(
      viaCanonical.targetVersion,
      version,
      `--target-version ${version} pins targetVersion`
    );
    assert.equal(
      viaAlias.targetVersion,
      version,
      `--parser-target ${version} pins targetVersion`
    );
    assert.equal(
      viaAlias.targetVersion,
      viaCanonical.targetVersion,
      `--parser-target ${version} resolves identically to --target-version`
    );
    assert.equal(
      viaAlias.invalidTargetVersion,
      undefined,
      `supported ${version} via alias is not flagged invalid`
    );
  }
  console.log("ok --parser-target resolves identically to --target-version");
}

// 3. `--threads` out of the inclusive range 1-64 falls back to 10, in-range values are honored
//    (Requirement 2.11).
{
  withSilencedWarn(() => {
    assert.equal(
      parseArgs(["--threads", "0"]).threads,
      DEFAULT_THREADS,
      "threads below MIN_THREADS falls back to 10"
    );
    assert.equal(
      parseArgs(["--threads", String(MAX_THREADS + 1)]).threads,
      DEFAULT_THREADS,
      "threads above MAX_THREADS falls back to 10"
    );
    assert.equal(
      parseArgs(["--threads", "-5"]).threads,
      DEFAULT_THREADS,
      "negative threads falls back to 10"
    );
    assert.equal(
      parseArgs(["--threads", "notanumber"]).threads,
      DEFAULT_THREADS,
      "non-numeric threads falls back to 10"
    );
  });
  // In-range values are honored, including the inclusive bounds.
  assert.equal(
    parseArgs(["--threads", String(MIN_THREADS)]).threads,
    MIN_THREADS,
    "threads at MIN_THREADS is honored"
  );
  assert.equal(
    parseArgs(["--threads", String(MAX_THREADS)]).threads,
    MAX_THREADS,
    "threads at MAX_THREADS is honored"
  );
  assert.equal(parseArgs(["--threads", "8"]).threads, 8, "in-range threads honored");
  console.log("ok --threads out of 1-64 falls back to 10, in-range honored");
}

// 4. `--max-depth` out of the inclusive range 1-10000 falls back to 250, in-range values honored
//    (Requirement 2.6).
{
  withSilencedWarn(() => {
    assert.equal(
      parseArgs(["--max-depth", "0"]).maxDepth,
      DEFAULT_MAX_DEPTH,
      "max-depth below MIN_MAX_DEPTH falls back to 250"
    );
    assert.equal(
      parseArgs(["--max-depth", String(MAX_MAX_DEPTH + 1)]).maxDepth,
      DEFAULT_MAX_DEPTH,
      "max-depth above MAX_MAX_DEPTH falls back to 250"
    );
    assert.equal(
      parseArgs(["--max-depth", "-1"]).maxDepth,
      DEFAULT_MAX_DEPTH,
      "negative max-depth falls back to 250"
    );
    assert.equal(
      parseArgs(["--max-depth", "abc"]).maxDepth,
      DEFAULT_MAX_DEPTH,
      "non-numeric max-depth falls back to 250"
    );
  });
  assert.equal(
    parseArgs(["--max-depth", String(MIN_MAX_DEPTH)]).maxDepth,
    MIN_MAX_DEPTH,
    "max-depth at MIN_MAX_DEPTH is honored"
  );
  assert.equal(
    parseArgs(["--max-depth", String(MAX_MAX_DEPTH)]).maxDepth,
    MAX_MAX_DEPTH,
    "max-depth at MAX_MAX_DEPTH is honored"
  );
  assert.equal(
    parseArgs(["--max-depth", "500"]).maxDepth,
    500,
    "in-range max-depth honored"
  );
  console.log("ok --max-depth out of 1-10000 falls back to 250, in-range honored");
}

// 5. Unsupported `--target-version` (e.g. 9.0) is recorded as invalid and does not pin a valid
//    grammar, so main() can reject the invocation, emit no AST, and exit non-zero (Requirement
//    1.7). The alias path records invalidity identically.
{
  const viaCanonical = parseArgs(["--target-version", "9.0"]);
  assert.equal(
    viaCanonical.targetVersion,
    undefined,
    "unsupported target version does not pin a valid grammar"
  );
  assert.equal(
    viaCanonical.invalidTargetVersion,
    "9.0",
    "unsupported --target-version is recorded as invalid"
  );

  const viaAlias = parseArgs(["--parser-target", "7.4"]);
  assert.equal(
    viaAlias.invalidTargetVersion,
    "7.4",
    "unsupported --parser-target is recorded as invalid"
  );
  assert.equal(
    viaAlias.targetVersion,
    undefined,
    "unsupported --parser-target does not pin a valid grammar"
  );

  // A `--target-version` with no following value records an empty invalid marker rather than
  // silently pinning a grammar.
  const missingValue = parseArgs(["--target-version"]);
  assert.equal(
    missingValue.invalidTargetVersion,
    "",
    "missing target-version value is recorded as invalid (empty)"
  );
  console.log("ok unsupported --target-version is recorded as invalid");
}

// 6. Mode selection: `-i`/`--input` selects batch mode (input populated), its absence leaves input
//    undefined which dispatches to legacy passthrough (Requirement 2.1).
{
  const shortForm = parseArgs(["-i", "src"]);
  assert.equal(shortForm.input, "src", "-i sets the batch-mode input path");

  const longForm = parseArgs(["--input", "/tmp/project"]);
  assert.equal(
    longForm.input,
    "/tmp/project",
    "--input sets the batch-mode input path"
  );

  const legacy = parseArgs(["--with-recovery", "--json-dump", "a.php"]);
  assert.equal(
    legacy.input,
    undefined,
    "absence of -i/--input leaves input undefined (legacy passthrough)"
  );
  // Unrecognized legacy flags are collected in rest for forwarding.
  assert.ok(
    legacy.rest.includes("--with-recovery") && legacy.rest.includes("a.php"),
    "unrecognized args are collected in rest for legacy forwarding"
  );
  console.log("ok -i/--input selects batch mode; absence selects legacy passthrough");
}

// 7. Combined invocation: multiple options parse together without cross-talk.
{
  const opts = parseArgs([
    "-i",
    "app",
    "-o",
    "out",
    "--threads",
    "16",
    "--max-depth",
    "100",
    "--target-version",
    "8.3",
    "--fail-on-error",
    "-d"
  ]);
  assert.equal(opts.input, "app");
  assert.equal(opts.output, "out");
  assert.equal(opts.threads, 16);
  assert.equal(opts.maxDepth, 100);
  assert.equal(opts.targetVersion, "8.3");
  assert.equal(opts.invalidTargetVersion, undefined);
  assert.equal(opts.failOnError, true);
  assert.equal(opts.debug, true);
  assert.equal(opts.log, "debug", "-d raises log level to debug");
  console.log("ok combined options parse together without cross-talk");
}

console.log("phpastgen-cli: all checks passed");
