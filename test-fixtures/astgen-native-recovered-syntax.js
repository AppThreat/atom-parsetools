// Syntax Babel parses and the pinned tsgo does not (Flow annotations, do expressions,
// export-default-from): tsgo recovers from it instead of failing, so parsa types a recovered
// tree. The recovered tree's nodes need not match Babel's, so the one hard rule is that whatever
// parsa writes must still land on a node Babel's AST has: chen reads the type map through Babel's
// offsets, and an entry at a position with no Babel node is unreadable. The run must also end
// within its caps with its diagnostics reported, never crash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const exe = process.platform === "win32" ? ".exe" : "";
const builtBinary = join(repo, "parsa", "_deps", "bin", `parsa${exe}`);
const fixtureSet = join(repo, "parsa", "testdata", "typemap", "unparsable");
// files/, not src/: the golden-map fixture walker treats every src/ directory as a set with expected maps
const fixtureFiles = join(fixtureSet, "files");
let failures = 0;
let skipped = 0;

if (process.env.ASTGEN_NATIVE_REQUIRED && !existsSync(builtBinary)) {
  console.error(`not ok - ASTGEN_NATIVE_REQUIRED is set and there is no binary at ${builtBinary}`);
  process.exit(1);
}

if (!existsSync(builtBinary)) {
  skipped++;
  console.log(`skip - recovered syntax (no binary at ${builtBinary}; run npm run test:native first)`);
} else {
  const out = mkdtempSync(join(tmpdir(), "parsa-unparsable-"));
  try {
    const report = join(out, "report.json");
    const r = spawnSync(builtBinary, ["js", "--types-only", "-i", fixtureSet, "-o", out, "--report", report, "--memory-mb", "2048"], {
      encoding: "utf8",
      timeout: 120000
    });
    assert.equal(r.status, 0, `parsa ended with ${r.status}:\n${r.stderr?.slice(0, 2000)}`);
    assert.ok(!r.signal, `killed by ${r.signal}`);

    // astgen's parser chain in miniature: standard (TypeScript + JSX) first, then the Flow
    // plugin, then the non-JSX retry; the first configuration that parses the file without
    // errors is the tree its AST comes from, so that is the tree positions are checked against
    const base = ["optionalChaining", "classProperties", "classPrivateProperties", "classPrivateMethods", "decorators-legacy", "exportDefaultFrom", "doExpressions", "numericSeparator", "dynamicImport", "importAttributes", "explicitResourceManagement", "topLevelAwait", "sourcePhaseImports", "deferredImportEvaluation"];
    const chain = [
      [...base, "typescript", "jsx"],
      [...base, "jsx", ["flow", { all: true, enums: true }]],
      [...base, "typescript"]
    ];
    assert.ok(existsSync(report), "the run writes its report");
    const rep = JSON.parse(readFileSync(report, "utf8"));
    assert.ok(Array.isArray(rep.diagnostics), "the report carries its diagnostics");
    // a file may hit a budget, but that must be reported, not silent
    for (const name of readdirSync(fixtureFiles).filter((n) => n.endsWith(".js"))) {
      const text = readFileSync(join(fixtureFiles, name), "utf8");
      let parsed;
      for (const plugins of chain) {
        try {
          parsed = parse(text, {
            sourceType: "module",
            errorRecovery: true,
            allowImportExportEverywhere: true,
            allowAwaitOutsideFunction: true,
            allowReturnOutsideFunction: true,
            allowSuperOutsideMethod: true,
            allowUndeclaredExports: true,
            plugins
          });
        } catch {
          continue; // this configuration rejects the file outright; the next one is tried
        }
        if (parsed.errors.length === 0) break;
      }
      assert.ok(parsed, `${name}: no Babel configuration in astgen's chain parses the fixture`);
      assert.deepEqual(parsed.errors, [], `${name}: Babel parses the fixture with errors left over`);
      const starts = new Set();
      const walk = (n) => {
        if (n && typeof n.type === "string" && typeof n.start === "number") starts.add(n.start);
        for (const k of Object.keys(n ?? {})) {
          if (k === "loc" || k === "leadingComments" || k === "trailingComments" || k === "innerComments") continue;
          const v = n[k];
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object" && typeof v.type === "string") walk(v);
        }
      };
      walk(parsed.program);

      const mapPath = join(out, "files", `${name}.typemap`);
      const syntax = (rep.diagnostics ?? []).filter((d) => d.reason === "syntax-not-parsed" && d.file.endsWith(name));
      if (!existsSync(mapPath)) {
        // the run declined to type a recovered tree: that must be said, not silent
        assert.ok(syntax.length === 1, `${name}: no type map and no syntax-not-parsed diagnostic`);
        console.log(`ok - ${name}: not typed (${syntax[0].detail.slice(0, 60)})`);
        continue;
      }
      assert.deepEqual(syntax, [], `${name}: a type map was written, so the file parsed cleanly and needs no diagnostic`);
      const map = JSON.parse(readFileSync(mapPath, "utf8"));
      const keys = Object.keys(map);
      assert.ok(keys.length > 0, `${name}: the recovered tree is typed somewhere`);
      const orphans = keys.filter((k) => !starts.has(Number(k)));
      assert.deepEqual(orphans, [], `${name}: ${orphans.length} of ${keys.length} entries are at positions Babel's AST has no node for`);
      console.log(`ok - ${name}: ${keys.length} entries all land on Babel nodes`);
    }

    for (const d of rep.diagnostics ?? []) {
      assert.ok(d.file && d.reason, `a diagnostic names its file and reason: ${JSON.stringify(d)}`);
    }
    console.log(`ok - the run reported ${rep.gaveUpTypes ?? 0} types given up, ${(rep.diagnostics ?? []).length} diagnostic(s)`);
  } catch (err) {
    failures++;
    console.error(`not ok - recovered syntax\n${err.stack}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (failures) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
}
console.log(`parsa recovered syntax tests ${skipped ? "skipped (no binary)" : "passed"}`);
