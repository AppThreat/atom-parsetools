// A project's own compiler options win over astgen's defaults. The defaults used to be passed to
// the configuration parser as `existingOptions`, which TypeScript treats as command-line flags, so
// they replaced the project's `moduleResolution`, `lib`, `target` and the rest: a package reachable
// only through `exports` under `bundler` resolution stayed untyped, and the DOM was typed in a
// project whose `lib` leaves it out. Under the project's own options TypeScript also names a
// package file through a `paths` alias that covers node_modules (`@app/node_modules/pkg/...`),
// which is now printed as the package path. Both engines are checked: astgen's TypeScript 6 path and
// parsa, when the binary the CI native job builds is there (that job sets ASTGEN_NATIVE_REQUIRED).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const astgen = join(dirname(here), "astgen.js");
const fixtureRoot = join(here, "projects", "config-options");
const exe = process.platform === "win32" ? ".exe" : "";
const builtBinary = join(dirname(here), "parsa", "_deps", "bin", `parsa${exe}`);
const engines = existsSync(builtBinary) ? ["ts6", "native"] : ["ts6"];
if (process.env.ASTGEN_NATIVE_REQUIRED && engines.length === 1) {
  console.error(`not ok - ASTGEN_NATIVE_REQUIRED is set and there is no binary at ${builtBinary}`);
  process.exit(1);
}

for (const engine of engines) {
  const out = mkdtempSync(join(tmpdir(), "astgen-config-options-"));
  try {
    const r = spawnSync(
      process.execPath,
      [astgen, "-i", fixtureRoot, "-o", out, "-t", "ts"],
      {
        cwd: here,
        // main defaults to the native engine; release/1.x has only TypeScript 6 and ignores this
        env: {
          ...process.env,
          ASTGEN_TYPES: engine,
          ...(engine === "native" ? { ASTGEN_NATIVE_BIN: builtBinary } : {})
        },
        encoding: "utf8",
        timeout: 120000
      }
    );
    assert.ok(!r.signal, `astgen was stopped by ${r.signal}`);
    assert.equal(r.status, 0, r.stderr?.slice(0, 1500));

    if (engine === "native") {
      const types = readFileSync(join(out, "astgen_manifest.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.kind === "types");
      assert.equal(types.at(-1)?.engine, "native", `the native run fell back: ${JSON.stringify(types.at(-1))}`);
    }
    const rel = join("src", "settings.ts");
    const code = readFileSync(join(fixtureRoot, rel), "utf8");
    const types = JSON.parse(readFileSync(join(out, rel + ".typemap"), "utf8"));
    const typeAt = (needle) => {
      const position = code.indexOf(needle);
      assert.notEqual(position, -1, `missing fixture needle: ${needle}`);
      return types[String(position)];
    };

    assert.equal(
      typeAt("extraMode }"),
      "string",
      `${engine}: the project's bundler resolution must reach the exports-only subpath`
    );
    assert.equal(
      typeAt("activeMode"),
      'import("tiny-config/types/inner").Mode',
      `${engine}: a package file is named by its package path, not through the root's paths alias`
    );
    assert.equal(
      typeAt("document"),
      undefined,
      `${engine}: the project's lib leaves the DOM out, so document has no type`
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
console.log(`astgen config options tests passed (${engines.join(", ")})`);
