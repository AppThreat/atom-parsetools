import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end tests for the rbastgen wrapper: they run the command the way chen does and assert on
// the generated files, because the wrapper never exits non-zero for per-file problems. They need a
// built plugin bundle (bash build.sh) and a supported Ruby on the PATH.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);
const fixtureRoot = join(__dirname, "projects", "ruby-parsing");
const wrapper = join(repoRoot, "rbastgen.js");

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

function generate(extraArgs = []) {
  const outputRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-ruby-"));
  const run = runWrapper(["-i", fixtureRoot, "-o", outputRoot, ...extraArgs]);
  return { outputRoot, run };
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

function nodesOfType(ast, type) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (node && typeof node === "object") {
      if (node.type === type) {
        found.push(node);
      }
      for (const value of Object.values(node)) {
        walk(value);
      }
    }
  };
  walk(ast);
  return found;
}

const parserInfo = runWrapper(["--parser-info"]);
assert.equal(parserInfo.status, 0, "rbastgen --parser-info should exit 0");
if (/Ruby is not installed/.test(parserInfo.stdout + parserInfo.stderr)) {
  console.log("rbastgen tests skipped: no supported Ruby on the PATH");
  process.exit(0);
}
if (!/Parser backend:/.test(parserInfo.stdout)) {
  console.log(
    "rbastgen tests skipped: plugins are not built (run `bash build.sh`)"
  );
  process.exit(0);
}

// The bundle must be loadable under any supported Ruby ABI, which means nothing in it may be a
// compiled extension: those are built per ABI and per platform and are what previously pinned the
// published package to the single Ruby it was built with.
const bundleRoot = join(repoRoot, "plugins", "rubyastgen", "bundle", "ruby");
const nativeArtifacts = filesUnder(bundleRoot).filter((file) =>
  /\.(so|bundle|dll)$/.test(file)
);
assert.deepEqual(
  nativeArtifacts,
  [],
  "the vendored Ruby bundle must stay pure Ruby so one build runs on every supported Ruby"
);

// `parser` is reached through GEM_PATH and prism through the runtime's default gems; both must
// report a real version, since a silent fallback is how a broken bundle looks.
const backend = /Parser backend: (\S+)/.exec(parserInfo.stdout)?.[1];
const parserGem = /Parser gem: (\S+)/.exec(parserInfo.stdout)?.[1];
const prismGem = /Prism gem: (\S+)/.exec(parserInfo.stdout)?.[1];
assert.match(backend ?? "", /^(Prism::Translation::Parser\d+|Parser::Ruby\d+)$/);
assert.notEqual(parserGem, "unavailable", "the vendored parser gem must load");
assert.notEqual(prismGem, "unavailable", "the runtime's prism gem must load");

// The parser that loads must be the vendored one. RubyGems needs specifications/*.gemspec to
// activate it (prism's translation layer asks for `gem "parser", ">= 3.3.7.2"` before requiring it),
// so a build that strips those specs falls back to whatever the machine happens to have installed —
// or to nothing at all. A developer machine usually has the gem too, which is why the clean-room
// version of this check runs in CI against the ruby:3.4 and ruby:4.0 images.
const vendoredParser = filesUnder(bundleRoot)
  .map((file) => /specifications\/parser-(.+)\.gemspec$/.exec(file)?.[1])
  .find(Boolean);
assert.ok(vendoredParser, "no parser gemspec is vendored; RubyGems cannot activate the gem");
assert.equal(
  parserGem,
  vendoredParser,
  "the run should use the vendored parser gem, not another copy on the machine"
);

const { outputRoot, run } = generate();
try {
  // Per-file failures must never fail the run: chen reads a non-zero exit as "nothing parsed".
  assert.equal(run.status, 0, `rbastgen exited ${run.status}: ${run.stderr}`);

  const generated = filesUnder(outputRoot);
  assert.deepEqual(
    generated,
    [
      "Gemfile.json",
      "Rakefile.json",
      "app/models/user.rb.json",
      "lib/typed_api.rb.json",
      "ruby_ast_gen_diagnostics.jsonl",
      "ruby_ast_gen_manifest.jsonl"
    ],
    "unexpected set of generated files"
  );

  // Side-records must not end in .json: chen reads every *.json under the output as an AST.
  const astFiles = generated.filter((file) => file.endsWith(".json"));
  assert.ok(
    !astFiles.some((file) => file.startsWith("ruby_ast_gen_")),
    "run records must not be named *.json"
  );

  const manifest = readJson(join(outputRoot, "ruby_ast_gen_manifest.jsonl"));
  assert.equal(manifest.generator_version.split(".")[0], "2");
  assert.equal(manifest.files_parsed, 4, "4 Ruby files parse in the fixture");
  assert.equal(manifest.files_failed, 1, "unparseable.rb must be reported");
  assert.equal(manifest.files_skipped_nonruby, 1, "README.txt is not Ruby");
  assert.ok(
    manifest.files_excluded >= 1,
    "spec/ is dropped by the default exclusion regex"
  );
  assert.equal(manifest.truncated_files, 0);
  assert.equal(manifest.parser_target, null);
  assert.equal(manifest.input, fixtureRoot);

  const diagnostics = readFileSync(
    join(outputRoot, "ruby_ast_gen_diagnostics.jsonl"),
    "utf-8"
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].rel_file_path, "lib/unparseable.rb");
  assert.equal(typeof diagnostics[0].parse_error.line, "number");
  assert.equal(typeof diagnostics[0].parse_error.message, "string");

  // Ruby DSL files are found by basename, not extension: this is the whole point of the 2.x
  // discovery rules, and a Rails project's Rakefile/Gemfile carry real call graphs.
  const rakefile = readJson(join(outputRoot, "Rakefile.json"));
  assert.equal(rakefile.rel_file_path, "Rakefile");
  assert.ok(
    nodesOfType(rakefile, "send").some((node) => node.name === "task"),
    "Rakefile should contain the task DSL calls"
  );

  const typed = readJson(join(outputRoot, "lib/typed_api.rb.json"));
  assert.deepEqual(
    typed.magic_comments.map((comment) => [comment.name, comment.value]),
    [
      ["typed", "strict"],
      ["frozen_string_literal", "true"]
    ],
    "Sorbet strictness and frozen_string_literal should be reported as data"
  );
  const defs = nodesOfType(typed, "def");
  const withSig = defs.filter((node) => node.has_sig === true).map((n) => n.name);
  assert.deepEqual(
    withSig,
    ["greet", "maybe_count", "log_it"],
    "every def preceded by a sig block should be marked"
  );
  assert.ok(
    defs.some((node) => node.name === "undeclared" && !("has_sig" in node)),
    "a def without a sig must carry no has_sig key"
  );
  assert.ok(
    nodesOfType(typed, "str").some((node) => node.heredoc === true),
    "the heredoc argument should be marked"
  );

  const user = readJson(join(outputRoot, "app/models/user.rb.json"));
  assert.equal(user.parser_backend, backend, "per-file backend provenance");
  assert.ok(
    nodesOfType(user, "array").some((node) => node.percent_array === "%i"),
    "%i arrays should be marked"
  );
  assert.ok(
    nodesOfType(user, "regopt").some(
      (node) => Array.isArray(node.options) && node.options.includes("i")
    ),
    "regexp options should be emitted as a list"
  );
  assert.ok(
    nodesOfType(user, "csend").length + nodesOfType(user, "send").length > 5,
    "the model body should lower to send nodes"
  );
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}

// A clean run must not leave a stale diagnostics record behind, so the file always describes the
// run that produced it.
{
  const clean = generate(["-e", "^(spec|lib/unparseable)"]);
  try {
    assert.equal(clean.run.status, 0);
    assert.ok(
      !existsSync(join(clean.outputRoot, "ruby_ast_gen_diagnostics.jsonl")),
      "a run without failures must write no diagnostics record"
    );
    const manifest = readJson(
      join(clean.outputRoot, "ruby_ast_gen_manifest.jsonl")
    );
    assert.equal(manifest.files_failed, 0);
  } finally {
    rmSync(clean.outputRoot, { recursive: true, force: true });
  }
}

// --parser-target pins the grammar through the vendored parser gem, which is the only way to reach
// grammars prism does not translate. It also proves the gem is really being used.
{
  const pinned = runWrapper(["--parser-info", "--parser-target", "2.7"]);
  assert.equal(pinned.status, 0);
  assert.match(
    pinned.stdout,
    /Parser backend: Parser::Ruby27/,
    "--parser-target 2.7 should resolve to the parser gem's 2.7 grammar"
  );
}

// A bad ATOM_TIMEOUT must not take the wrapper down: spawnSync rejects a non-numeric timeout.
{
  const withTimeout = runWrapper(["--version"], { ATOM_TIMEOUT: "60000" });
  assert.equal(withTimeout.status, 0, withTimeout.stderr);
  assert.match(withTimeout.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const ignored = runWrapper(["--version"], { ATOM_TIMEOUT: "not-a-number" });
  assert.equal(ignored.status, 0, ignored.stderr);
}

const rubyVersion = /Ruby version: (\S+)/.exec(parserInfo.stdout)?.[1];
console.log(
  `rbastgen Ruby workflow tests passed (ruby ${rubyVersion}, ${backend}, parser ${parserGem}, prism ${prismGem})`
);
