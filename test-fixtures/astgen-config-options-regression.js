// A project's own compiler options win over astgen's defaults. The defaults used to be passed to
// the configuration parser as `existingOptions`, which TypeScript treats as command-line flags, so
// they replaced the project's `moduleResolution`, `lib`, `target` and the rest: a package reachable
// only through `exports` under `bundler` resolution stayed untyped, and the DOM was typed in a
// project whose `lib` leaves it out. Under the project's own options TypeScript also names a
// package file through a `paths` alias that covers node_modules (`@app/node_modules/pkg/...`),
// which is now printed as the package path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const astgen = join(dirname(here), "astgen.js");
const fixtureRoot = join(here, "projects", "config-options");
const out = mkdtempSync(join(tmpdir(), "astgen-config-options-"));

try {
  const r = spawnSync(
    process.execPath,
    [astgen, "-i", fixtureRoot, "-o", out, "-t", "ts"],
    {
      cwd: here,
      // main defaults to the native engine; release/1.x has only TypeScript 6 and ignores this
      env: { ...process.env, ASTGEN_TYPES: "ts6" },
      encoding: "utf8",
      timeout: 120000
    }
  );
  assert.ok(!r.signal, `astgen was stopped by ${r.signal}`);
  assert.equal(r.status, 0, r.stderr?.slice(0, 1500));

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
    "the project's bundler resolution must reach the exports-only subpath"
  );
  assert.equal(
    typeAt("activeMode"),
    'import("tiny-config/types/inner").Mode',
    "a package file is named by its package path, not through the root's paths alias"
  );
  assert.equal(
    typeAt("document"),
    undefined,
    "the project's lib leaves the DOM out, so document has no type"
  );
  console.log("astgen config options tests passed");
} finally {
  rmSync(out, { recursive: true, force: true });
}
