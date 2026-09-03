import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regression tests for the phpastgen legacy single-file passthrough (Requirement 2.8, design §2.1).
//
// The pre-upgrade behavior these tests pin: with no `-i/--input`, phpastgen forwards
// `--with-recovery --resolve-names -P --json-dump <file>` to the vendored `php-parse` binary and
// streams the resulting JSON AST to stdout. They spawn the wrapper exactly as chen does today, so
// they exercise real parsing rather than a mock. They need a built plugin bundle (bash build.sh /
// composer install under plugins/) and a PHP runtime on the PATH.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const wrapper = join(repoRoot, "phpastgen.js");
const fixture = join(__dirname, "projects", "php-parsing", "greeter.php");
const phpParseBin =
  process.env.PHP_PARSER_BIN || join(repoRoot, "plugins", "bin", "php-parse");

// The wrapper streams the child parser's stdout via `stdio: "inherit"`, so it writes to this
// process's real stdout fd rather than a pipe. Redirect the spawned wrapper's stdout to a temp
// file (an fd we control) so the test captures exactly what lands on standard output.
function runWrapper(args, { env = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "phpastgen-legacy-"));
  const outPath = join(tmp, "stdout.txt");
  const errPath = join(tmp, "stderr.txt");
  const outFd = openSync(outPath, "w");
  const errFd = openSync(errPath, "w");
  try {
    const result = spawnSync(process.execPath, [wrapper, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", outFd, errFd]
    });
    return {
      status: result.status,
      stdout: readFileSync(outPath, "utf-8"),
      stderr: readFileSync(errPath, "utf-8")
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function hasPhp() {
  const result = spawnSync(process.env.PHP_CMD || "php", ["--version"], {
    encoding: "utf-8"
  });
  return result.status === 0;
}

// The passthrough cannot be exercised without a PHP runtime and the vendored parser binary.
if (!hasPhp()) {
  console.log("SKIP phpastgen-legacy-regression: PHP runtime not found on PATH");
  process.exit(0);
}
if (!existsSync(phpParseBin)) {
  console.log(
    `SKIP phpastgen-legacy-regression: vendored php-parse binary not found at ${phpParseBin} (run composer install under plugins/)`
  );
  process.exit(0);
}

// 1. Legacy flags stream a JSON AST to stdout and exit 0.
{
  const run = runWrapper([
    "--with-recovery",
    "--resolve-names",
    "-P",
    "--json-dump",
    fixture
  ]);
  assert.equal(run.status, 0, "legacy passthrough should exit 0");
  const start = run.stdout.indexOf("[");
  assert.ok(start !== -1, "stdout should contain a JSON array of nodes");
  const ast = JSON.parse(run.stdout.slice(start));
  assert.ok(Array.isArray(ast), "top-level AST should be an array");
  const nodeTypes = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (node && typeof node === "object") {
      if (typeof node.nodeType === "string") {
        nodeTypes.add(node.nodeType);
      }
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  };
  walk(ast);
  assert.ok(
    nodeTypes.has("Stmt_Function"),
    "AST should contain the declared function"
  );
  assert.ok(
    nodeTypes.has("Stmt_Class"),
    "AST should contain the declared class"
  );
  console.log("ok legacy passthrough streams JSON AST to stdout");
}

// 2. The PHP_PARSER_BIN override is honored by the resolved binary.
{
  const run = runWrapper(
    ["--with-recovery", "--resolve-names", "-P", "--json-dump", fixture],
    { env: { PHP_PARSER_BIN: phpParseBin } }
  );
  assert.equal(
    run.status,
    0,
    "legacy passthrough with PHP_PARSER_BIN override should exit 0"
  );
  assert.ok(
    run.stdout.includes("nodeType"),
    "override run should still stream the AST"
  );
  console.log("ok legacy passthrough honors PHP_PARSER_BIN override");
}

// 3. No `-i/--input` means legacy mode (no batch output directory is produced).
{
  const run = runWrapper([
    "--with-recovery",
    "--resolve-names",
    "-P",
    "--json-dump",
    fixture
  ]);
  assert.ok(
    !existsSync(join(repoRoot, ".ast")),
    "legacy mode must not create the batch output directory"
  );
  assert.equal(run.status, 0);
  console.log("ok legacy mode does not trigger batch output");
}

console.log("phpastgen-legacy-regression: all checks passed");

// 4. Regression for the splice bug: runLegacyPassthrough must PREPEND the resolved php-parse bin
//    to the forwarded argv (command = `php <php-parse-bin> <all original flags...>`) and must NOT
//    drop the first forwarded flag. The pre-fix code did `forwarded.splice(0, 1, bin)`, which
//    replaced argv[0] (e.g. "--with-recovery") with the bin, silently dropping error recovery.
//
//    This is exercised without a real PHP runtime: PHP_CMD is stubbed with a tiny script that
//    writes every argument it receives (one per line) to a capture file, and PHP_PARSER_BIN is set
//    to a known sentinel path. We then assert the captured argv is exactly
//    [<bin>, ...originalFlags], proving the bin is prepended and every flag survives.
{
  const { runLegacyPassthrough } = await import("../phpastgen.js");

  const tmp = mkdtempSync(join(tmpdir(), "phpastgen-argv-"));
  const capturePath = join(tmp, "argv.txt");
  const stubPath = join(tmp, "php-cmd-stub.sh");
  const sentinelBin = "/sentinel/path/php-parse";
  try {
    // The stub records its args (from $1 onward) newline-delimited into the capture file.
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(
      stubPath,
      '#!/bin/sh\n: > "$PHPASTGEN_ARGV_CAPTURE"\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$PHPASTGEN_ARGV_CAPTURE"; done\n',
      "utf-8"
    );
    chmodSync(stubPath, 0o755);

    const originalFlags = [
      "--with-recovery",
      "--resolve-names",
      "-P",
      "--json-dump",
      fixture
    ];

    const savedPhpCmd = process.env.PHP_CMD;
    const savedParserBin = process.env.PHP_PARSER_BIN;
    process.env.PHP_CMD = stubPath;
    process.env.PHP_PARSER_BIN = sentinelBin;
    process.env.PHPASTGEN_ARGV_CAPTURE = capturePath;
    try {
      const rc = runLegacyPassthrough(originalFlags);
      assert.equal(rc, 0, "runLegacyPassthrough should return 0");
    } finally {
      if (savedPhpCmd === undefined) delete process.env.PHP_CMD;
      else process.env.PHP_CMD = savedPhpCmd;
      if (savedParserBin === undefined) delete process.env.PHP_PARSER_BIN;
      else process.env.PHP_PARSER_BIN = savedParserBin;
      delete process.env.PHPASTGEN_ARGV_CAPTURE;
    }

    const captured = readFileSync(capturePath, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0);

    assert.deepEqual(
      captured,
      [sentinelBin, ...originalFlags],
      "forwarded argv must PREPEND the php-parse bin and keep every original flag"
    );
    assert.equal(
      captured[0],
      sentinelBin,
      "the php-parse bin must be the first argument (prepended, not substituted)"
    );
    assert.ok(
      captured.includes("--with-recovery"),
      "the first forwarded flag (--with-recovery) must survive"
    );
    assert.equal(
      captured[1],
      "--with-recovery",
      "the original argv order must be preserved right after the bin"
    );
    console.log(
      "ok runLegacyPassthrough prepends php-parse bin and keeps --with-recovery"
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
