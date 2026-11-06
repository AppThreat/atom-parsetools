// Nested projects with their own configuration. A repository that keeps a second project in a
// subdirectory, with its own tsconfig.json (juice-shop's frontend/), had that project typed by the
// root program, with the root's compiler options: the nested project's module resolution, `paths`
// and `strict` were all ignored. Each nested project is now typed by a program built from its own
// configuration. The fixtures commit their stub packages (.gitignore exceptions let them through,
// as for node-builtins).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const astgen = join(dirname(here), "astgen.js");
// release/1.x has no lib/typemap module to import the name from
const MANIFEST_FILENAME = "astgen_manifest.jsonl";
const outputRoot = mkdtempSync(join(tmpdir(), "astgen-nested-configs-"));
let failures = 0;

const test = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}\n${err.stack}`);
  }
};

const runs = new Map();
const run = (fixtureName, env = {}) => {
  const key = `${fixtureName} ${JSON.stringify(env)}`;
  if (runs.has(key)) {
    return runs.get(key);
  }
  const fixtureRoot = join(here, "projects", fixtureName);
  const out = join(outputRoot, `${fixtureName}-${runs.size}`);
  const r = spawnSync(
    process.execPath,
    [astgen, "-i", fixtureRoot, "-o", out, "-t", "ts"],
    {
      cwd: here,
      // main defaults to the native engine; release/1.x has only TypeScript 6 and ignores this
      env: { ...process.env, ASTGEN_TYPES: "ts6", ...env },
      encoding: "utf8",
      timeout: 120000
    }
  );
  assert.ok(!r.signal, `astgen was stopped by ${r.signal}`);
  assert.equal(r.status, 0, r.stderr?.slice(0, 1500));
  const result = { fixtureRoot, out, stderr: r.stderr ?? "" };
  runs.set(key, result);
  return result;
};

const outputFiles = (out) => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(out).map((file) => file.slice(out.length + 1).replaceAll("\\", "/"));
};

const typeAt = (r, relPath, needle) => {
  const code = readFileSync(join(r.fixtureRoot, relPath), "utf8");
  const map = JSON.parse(readFileSync(join(r.out, relPath + ".typemap"), "utf8"));
  const position = code.indexOf(needle);
  assert.notEqual(position, -1, `missing fixture needle: ${needle}`);
  return map[String(position)];
};

const budgetRecords = (out) => {
  const manifest = join(out, MANIFEST_FILENAME);
  return existsSync(manifest)
    ? readFileSync(manifest, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((record) => record.kind === "type_budget")
    : [];
};

test("a nested project is typed with its own configuration", () => {
  const r = run("nested-configs");
  // frontend/tsconfig.json is solution-style and references src/tsconfig.app.json, whose base
  // configuration sets bundler resolution: only that reaches the stub's exports-only subpath
  const widget = "frontend/src/widget.ts";
  assert.equal(typeAt(r, widget, "widgetLevel"), "string", "the frontend's own stub package");
  assert.equal(
    typeAt(r, widget, "widgetExtraLevel"),
    "string",
    "the frontend's bundler resolution, inherited through extends"
  );
  assert.equal(typeAt(r, widget, "widgetBadge"), "string", "the frontend's own paths");
  assert.equal(
    typeAt(r, widget, "widgetFlag"),
    "boolean | undefined",
    "the frontend's strict option"
  );
  assert.ok(
    existsSync(join(r.out, "frontend/src/ui/badge.ts.typemap")),
    "the target of the frontend's paths is typed too"
  );
});

test("a workspace package without node_modules gets its options and the root's packages", () => {
  const r = run("nested-configs");
  const flags = "packages/shared/flags.ts";
  assert.equal(
    typeAt(r, flags, "sharedLevel"),
    "number",
    "the package resolves the root's stub by walking up"
  );
  assert.equal(
    typeAt(r, flags, "sharedFlag"),
    "boolean | undefined",
    "the package's own strict option"
  );
});

test("a file at the root keeps the root project's types", () => {
  // the root configuration has no include, so it lists the nested projects' files too; built into
  // the root program, they decided which tiny-logger the root's own import found
  const r = run("nested-configs");
  assert.equal(typeAt(r, "src/app.js", "appLevel"), "number", "the root's stub package");
  assert.equal(typeAt(r, "src/app.js", "appLabel"), "string", "the root's own paths");
  assert.ok(existsSync(join(r.out, "config/settings.ts.typemap")));
});

test("a nested tsconfig under an ignored directory changes nothing", () => {
  const r = run("nested-configs");
  assert.deepEqual(
    outputFiles(r.out).filter((file) => file.startsWith("examples")),
    [],
    "discovery leaves examples/ out, so its tsconfig types nothing"
  );
  assert.deepEqual(budgetRecords(r.out), [], "the run stays inside its budgets");
});

test("a solution-style root configuration hands the root to the configuration beside it", () => {
  // Vite and Angular generate a root tsconfig.json with no files of its own that references
  // tsconfig.app.json; its paths are the ones the root's files are built with
  const r = run("solution-root");
  assert.equal(typeAt(r, "src/main.ts", "mainAnswer"), "number");
});

test("a nested file past its budget keeps its AST and the record names its project", () => {
  const r = run("nested-budgets", { ASTGEN_TYPE_FILE_TIMEOUT_MS: "1500" });
  assert.ok(existsSync(join(r.out, "frontend/src/heavy.js.json")), "the AST is written first");
  assert.ok(!existsSync(join(r.out, "frontend/src/heavy.js.typemap")), "no types for it");
  assert.ok(
    existsSync(join(r.out, "frontend/src/small.js.typemap")),
    "the next file of the nested project is typed by a new worker"
  );
  assert.ok(existsSync(join(r.out, "src/root.js.typemap")), "the root project is unaffected");
  assert.deepEqual(budgetRecords(r.out), [
    {
      kind: "type_budget",
      engine: "ts6",
      project: "frontend",
      reason: "file-wall-time",
      file: join(r.fixtureRoot, "frontend", "src", "heavy.js"),
      limit_ms: 1500
    }
  ]);
  assert.match(r.stderr, /typing .*heavy\.js took longer than 1500 ms/);
});

rmSync(outputRoot, { recursive: true, force: true });
if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log("astgen nested project tests passed");
