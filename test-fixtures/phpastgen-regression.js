import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end regression tests for the phpastgen batch generator (Requirements 2.2, 2.3, 2.4, 2.7).
//
// These run the wrapper exactly the way chen does — `node phpastgen.js -i <dir> -o <tmp>` — and
// pin the observable batch behavior: one *.json AST per good file mirroring the input layout, a
// phpastgen_manifest.jsonl with the expected counters, diagnostics on the known-bad file with a
// clean (exit 0) run, stale-diagnostics removal on a clean run, and that the legacy single-file
// passthrough still streams JSON to stdout.
//
// They exercise real parsing rather than a mock, so they need a PHP runtime on the PATH and the
// vendored php-parse binary (composer install under plugins/). When either is missing the suite
// skips cleanly, mirroring phpastgen-legacy-regression.js.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const wrapper = join(repoRoot, "phpastgen.js");
const fixtureRoot = join(__dirname, "projects", "php-parsing");
const phpParseBin =
  process.env.PHP_PARSER_BIN || join(repoRoot, "plugins", "bin", "php-parse");

function hasPhp() {
  const result = spawnSync(process.env.PHP_CMD || "php", ["--version"], {
    encoding: "utf-8"
  });
  return result.status === 0;
}

// Batch parsing cannot run without a PHP runtime and the vendored parser binary.
if (!hasPhp()) {
  console.log("SKIP phpastgen-regression: PHP runtime not found on PATH");
  process.exit(0);
}
if (!existsSync(phpParseBin)) {
  console.log(
    `SKIP phpastgen-regression: vendored php-parse binary not found at ${phpParseBin} (run composer install under plugins/)`
  );
  process.exit(0);
}

// Run the wrapper as a child process. Batch mode writes AST/side-record files and prints nothing
// to stdout, so a plain pipe capture is enough here.
function runWrapper(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [wrapper, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, ...env }
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

// The legacy passthrough streams the child parser's stdout via `stdio: "inherit"`, so redirect the
// spawned wrapper's stdout/stderr to temp files we control to capture exactly what it emits.
function runWrapperCapturingFds(args, { env = {} } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "phpastgen-regression-io-"));
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

function filesUnder(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(relative(root, full));
      }
    }
  };
  walk(root);
  return found.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function nodesOfType(node, type, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) {
      nodesOfType(item, type, found);
    }
    return found;
  }
  if (node && typeof node === "object") {
    if (node.nodeType === type) {
      found.push(node);
    }
    for (const value of Object.values(node)) {
      nodesOfType(value, type, found);
    }
  }
  return found;
}

function generate(extraArgs = []) {
  const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-php-"));
  const run = runWrapper(["-i", fixtureRoot, "-o", outputRoot, ...extraArgs]);
  return { outputRoot, run };
}

// 1. Full batch run over the fixture project pins the generated file set, manifest counters, and
//    diagnostics behavior for the known-bad file (Requirements 2.2, 2.3, 2.4).
{
  const { outputRoot, run } = generate();
  try {
    // Per-file failures must never fail the run: chen reads a non-zero exit as "nothing parsed"
    // (invariant 3). broken.php fails, but the run still exits 0.
    assert.equal(run.status, 0, `phpastgen exited ${run.status}: ${run.stderr}`);

    const generated = filesUnder(outputRoot);
    assert.deepEqual(
      generated,
      [
        "greeter.php.json",
        "phpastgen_diagnostics.jsonl",
        "phpastgen_manifest.jsonl",
        "src/Math.php.json"
      ],
      "unexpected set of generated files"
    );

    // Side-records must not end in .json: chen reads every *.json under the output as an AST
    // (invariant 2).
    const astFiles = generated.filter((file) => file.endsWith(".json"));
    assert.ok(
      !astFiles.some((file) => file.startsWith("phpastgen_")),
      "run records must not be named *.json"
    );

    // The layout is mirrored: a nested source file lands under the same relative path.
    assert.ok(
      existsSync(join(outputRoot, "src", "Math.php.json")),
      "the nested src/Math.php AST must mirror the input layout"
    );

    // 2. Manifest counters describe exactly this fixture (Requirement 2.3).
    const manifest = readJson(join(outputRoot, "phpastgen_manifest.jsonl"));
    assert.equal(manifest.generator_version.split(".")[0], "2");
    assert.equal(manifest.files_parsed, 2, "greeter.php and src/Math.php parse");
    assert.equal(manifest.files_failed, 1, "src/broken.php must be reported");
    assert.equal(
      manifest.files_skipped_nonphp,
      1,
      "README.txt is not PHP and must be skipped, not parsed"
    );
    assert.equal(
      manifest.files_excluded,
      1,
      "tests/MathTest.php is dropped by the default exclusion regex"
    );
    assert.equal(manifest.truncated_files, 0);
    assert.equal(manifest.target_version, null);
    assert.equal(manifest.input, fixtureRoot);
    assert.match(
      manifest.parser_backend,
      /^nikic\/php-parser@/,
      "manifest records the vendored parser backend provenance"
    );
    // The count invariant (Property 2): every walked file lands in exactly one bucket.
    assert.equal(
      manifest.files_parsed +
        manifest.files_failed +
        manifest.files_skipped_nonphp +
        manifest.files_excluded,
      5,
      "parsed + failed + skipped + excluded must equal the files walked"
    );

    // 3. Diagnostics: exactly one line for the known-bad file, and it names that file
    //    (Requirement 2.4). diagnostics.length == files_failed (Property 3).
    const diagnostics = readJsonl(
      join(outputRoot, "phpastgen_diagnostics.jsonl")
    );
    assert.equal(diagnostics.length, manifest.files_failed);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].rel_file_path, "src/broken.php");
    assert.equal(typeof diagnostics[0].parse_error.message, "string");
    assert.equal(typeof diagnostics[0].parse_error.line, "number");
    assert.equal(diagnostics[0].parse_error.reason, "parse-error");

    // 4. A good file's AST carries the additive provenance wrapper and the real parsed nodes.
    const greeter = readJson(join(outputRoot, "greeter.php.json"));
    assert.equal(greeter.rel_file_path, "greeter.php");
    assert.equal(greeter.generator_version, manifest.generator_version);
    assert.equal(greeter.parser_backend, manifest.parser_backend);
    assert.ok(Array.isArray(greeter.ast), "the AST payload is the nikic statement array");
    assert.ok(
      nodesOfType(greeter.ast, "Stmt_Function").length >= 1,
      "greeter.php should contain the declared function"
    );
    assert.ok(
      nodesOfType(greeter.ast, "Stmt_Class").length >= 1,
      "greeter.php should contain the declared class"
    );

    const math = readJson(join(outputRoot, "src", "Math.php.json"));
    assert.equal(math.rel_file_path, "src/Math.php");
    assert.ok(
      nodesOfType(math.ast, "Stmt_ClassMethod").length >= 2,
      "src/Math.php should contain its declared methods"
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
  console.log("ok batch run: file set, manifest counters, and diagnostics");
}

// 5. A clean run (excluding the broken file) must leave no stale diagnostics record behind, so the
//    file always describes the run that produced it (Requirement 2.7 / Property 8).
{
  const clean = generate(["-e", "^(tests?|vendor|Tests?|src/broken)"]);
  try {
    assert.equal(clean.run.status, 0, clean.run.stderr);
    assert.ok(
      !existsSync(join(clean.outputRoot, "phpastgen_diagnostics.jsonl")),
      "a run without failures must write no diagnostics record"
    );
    const manifest = readJson(join(clean.outputRoot, "phpastgen_manifest.jsonl"));
    assert.equal(manifest.files_failed, 0);
    assert.equal(manifest.files_parsed, 2);
  } finally {
    rmSync(clean.outputRoot, { recursive: true, force: true });
  }
  console.log("ok clean run leaves no stale diagnostics");
}

// 6. --fail-on-error flips the exit code when a file failed, while the AST/side-records are still
//    written (Requirement 2.4). Without the flag the same input exits 0 (asserted above).
{
  const { outputRoot, run } = generate(["--fail-on-error"]);
  try {
    assert.equal(
      run.status,
      1,
      "--fail-on-error must exit non-zero when at least one file failed"
    );
    assert.ok(
      existsSync(join(outputRoot, "phpastgen_manifest.jsonl")),
      "the manifest is still written under --fail-on-error"
    );
    assert.ok(
      existsSync(join(outputRoot, "greeter.php.json")),
      "good files are still emitted under --fail-on-error"
    );
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
  console.log("ok --fail-on-error changes the exit code without dropping output");
}

// 7. Legacy single-file passthrough still streams a JSON AST to stdout and never creates a batch
//    output directory (Requirement 2.8, invariant 4).
{
  const run = runWrapperCapturingFds([
    "--with-recovery",
    "--resolve-names",
    "-P",
    "--json-dump",
    join(fixtureRoot, "greeter.php")
  ]);
  assert.equal(run.status, 0, `legacy passthrough should exit 0: ${run.stderr}`);
  const start = run.stdout.indexOf("[");
  assert.ok(start !== -1, "stdout should contain a JSON array of nodes");
  const ast = JSON.parse(run.stdout.slice(start));
  assert.ok(Array.isArray(ast), "top-level legacy AST should be an array");
  assert.ok(
    !existsSync(join(repoRoot, ".ast")),
    "legacy mode must not create the batch output directory"
  );
  console.log("ok legacy passthrough still streams JSON to stdout");
}

console.log("phpastgen-regression: all checks passed");
