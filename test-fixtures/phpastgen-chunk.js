// Batch runs parse many files per PHP interpreter (phpbatch.php) instead of one php-parse per
// file. This suite checks that the switch is invisible in the output:
//   1. chunked and per-file runs write byte-identical ASTs for every file both can parse;
//   2. a string literal holding bytes that are not UTF-8 no longer costs the chunked run the file;
//   3. files the driver never reports (it died) are parsed one by one, so nothing is lost;
//   4. --include-vendor parses vendor/ and node_modules/, never .git/, and keeps the other
//      default exclusions;
//   5. --files-per-process is validated and capped.
// Needs PHP and the vendored parser; skips without them.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import {
  MAX_FILES_PER_PROCESS,
  PHP_BATCH_DRIVER,
  batchDriverAutoload,
  parseArgs,
  runBatch
} from "../phpastgen.js";

const php = spawnSync(process.env.PHP_CMD || "php", ["--version"], {
  encoding: "utf-8"
});
if (php.status !== 0 || !batchDriverAutoload()) {
  console.log(
    "SKIP phpastgen-chunk: needs PHP and the vendored parser (run build.sh or set PHP_PARSER_BIN)"
  );
  process.exit(0);
}

// 5. Option parsing.
assert.equal(parseArgs(["-i", "x"]).includeVendor, false);
assert.equal(parseArgs(["-i", "x", "--include-vendor"]).includeVendor, true);
assert.equal(
  parseArgs(["-i", "x", "--files-per-process", "7"]).filesPerProcess,
  7
);
assert.equal(
  parseArgs(["-i", "x", "--files-per-process", "100000"]).filesPerProcess,
  MAX_FILES_PER_PROCESS
);
assert.equal(
  parseArgs(["-i", "x", "--files-per-process", "0"]).filesPerProcess,
  undefined
);

const root = mkdtempSync(join(tmpdir(), "phpastgen-chunk-test-"));
const input = join(root, "input");
const write = (rel, text) => {
  const path = join(input, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
};

function asts(outputDir) {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".json")) {
        found.set(relative(outputDir, path), readFileSync(path, "utf-8"));
      }
    }
  };
  walk(outputDir);
  return found;
}

async function run(name, opts) {
  const output = join(root, name);
  rmSync(output, { recursive: true, force: true });
  const exitCode = await runBatch({ input, output, threads: 2, ...opts });
  assert.equal(exitCode, 0, `${name} exited ${exitCode}`);
  return asts(output);
}

try {
  for (let i = 0; i < 7; i++) {
    write(
      `src/file${i}.php`,
      `<?php\nnamespace App\\Part${i};\nuse Lib\\Client;\nfunction run${i}(Client $c) { return $c->send("${i}"); }\n`
    );
  }
  write("index.php", "<?php\nrequire 'vendor/autoload.php';\necho 1;\n");
  write("binary.php", '<?php\n$marker = "\\x80\\xff";\n');
  write(
    "vendor/lib/client/Client.php",
    "<?php\nnamespace Lib;\nclass Client { public function send($v) { return $v; } }\n"
  );
  write("node_modules/pkg/helper.php", "<?php\nfunction helper() {}\n");
  write(".git/hooks/hook.php", "<?php\nfunction hook() {}\n");
  write("tests/AppTest.php", "<?php\nfunction test_app() {}\n");

  // 1. and 4.: identical ASTs, vendor/ and node_modules/ only on request.
  const perFile = await run("per-file", {
    includeVendor: true,
    filesPerProcess: 1
  });
  const chunked = await run("chunked", {
    includeVendor: true,
    filesPerProcess: 3
  });
  for (const [path, text] of perFile) {
    assert.equal(chunked.get(path), text, `${path} differs between modes`);
  }
  for (const path of [
    join("vendor", "lib", "client", "Client.php.json"),
    join("node_modules", "pkg", "helper.php.json")
  ]) {
    assert.ok(chunked.has(path), `--include-vendor did not parse ${path}`);
  }
  for (const path of chunked.keys()) {
    assert.ok(!path.startsWith(".git"), `${path} must never be parsed`);
    assert.ok(!path.startsWith("tests"), `${path} is excluded by default`);
  }
  const withoutVendor = await run("default", { filesPerProcess: 3 });
  for (const path of withoutVendor.keys()) {
    assert.ok(
      !path.startsWith("vendor") && !path.startsWith("node_modules"),
      `${path} is skipped without --include-vendor`
    );
  }
  assert.ok(withoutVendor.has(join("src", "file0.php.json")));

  // 2. php-parse cannot encode the raw bytes; the driver substitutes them.
  assert.ok(!perFile.has("binary.php.json"));
  assert.ok(chunked.has("binary.php.json"));

  // 3. A driver that dies before reporting anything: every file is still parsed, by itself.
  if (process.platform !== "win32") {
    const stub = join(root, "php-dies-in-driver.sh");
    writeFileSync(
      stub,
      `#!/bin/sh\nif [ "$1" = "${PHP_BATCH_DRIVER}" ]; then exit 255; fi\nexec "${process.env.PHP_CMD || "php"}" "$@"\n`,
      "utf-8"
    );
    chmodSync(stub, 0o755);
    const previous = process.env.PHP_CMD;
    process.env.PHP_CMD = stub;
    try {
      const recovered = await run("recovered", {
        includeVendor: true,
        filesPerProcess: 3
      });
      assert.deepEqual(
        [...recovered.keys()].sort(),
        [...perFile.keys()].sort()
      );
      for (const [path, text] of perFile) {
        assert.equal(recovered.get(path), text, `${path} differs after a retry`);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.PHP_CMD;
      } else {
        process.env.PHP_CMD = previous;
      }
    }
  }
  assert.ok(existsSync(PHP_BATCH_DRIVER));
  console.log("phpastgen-chunk: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
