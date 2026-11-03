import test from "node:test";
import assert from "node:assert/strict";

import { annotate, golangPurl, pseudoVersion } from "./annotate-sbom.js";

const commit = "622d4f779368e3d8cc721b329f8d1fb9066b528c";
const tscOld = "pkg:golang/github.com/microsoft/typescript/tsc@v0.0.0";
const shimOld = "pkg:golang/github.com/microsoft/typescript/tsc/shim@v0.0.0";
const parsaOld = "pkg:golang/github.com/appthreat/atom-parsetools/parsa";
const stdOld = "pkg:golang/stdlib@v1.27.2";

function sample() {
  return {
    metadata: {
      component: {
        name: "github.com/AppThreat/atom-parsetools/parsa",
        version: "",
        purl: parsaOld,
        "bom-ref": parsaOld,
        properties: [
          { name: "cdx:go:local_dir", value: "/home/runner/work/parsa" },
          { name: "internal:SrcGoMod", value: "/home/runner/work/parsa/go.mod" },
        ],
      },
    },
    components: [
      { name: "github.com/microsoft/TypeScript/tsc", version: "v0.0.0", purl: tscOld, "bom-ref": tscOld, scope: "optional" },
      { name: "github.com/microsoft/TypeScript/tsc/shim", version: "v0.0.0", purl: shimOld, "bom-ref": shimOld },
      { name: "stdlib", version: "v1.27.2", purl: stdOld, "bom-ref": stdOld },
    ],
    dependencies: [
      { ref: parsaOld, dependsOn: [shimOld, stdOld] },
      { ref: shimOld, dependsOn: [tscOld] },
      { ref: tscOld, dependsOn: [] },
      { ref: stdOld, dependsOn: [] },
    ],
  };
}

const patches = [{ name: "0001-x.patch", content: "diff --git a/x b/x\n" }];

test("pseudoVersion and golangPurl follow Go and cdxgen", () => {
  assert.equal(pseudoVersion(commit, "20261102220236"), "v0.0.0-20261102220236-622d4f779368");
  assert.equal(golangPurl("github.com/AppThreat/x", "v2.0.0-dev+abc"), "pkg:golang/github.com/appthreat/x@v2.0.0-dev%2Babc");
});

test("annotate names the TypeScript commit, its patches and parsa, and drops the standard library", () => {
  const bom = annotate(sample(), {
    version: "2.0.0",
    commit,
    commitTime: "20261102220236",
    patches,
    repoUrl: "https://github.com/AppThreat/atom-parsetools",
    repoCommit: "abc",
  });
  const tscRef = "pkg:golang/github.com/microsoft/typescript/tsc@v0.0.0-20261102220236-622d4f779368";
  assert.equal(bom.components.length, 2);
  const [tsc, shim] = bom.components;
  assert.equal(tsc.purl, tscRef);
  assert.equal(tsc.scope, "required");
  assert.equal(tsc.pedigree.commits[0].uid, commit);
  assert.equal(tsc.pedigree.patches[0].diff.text.content, patches[0].content);
  assert.equal(tsc.pedigree.patches[0].diff.url, "https://github.com/AppThreat/atom-parsetools/blob/abc/parsa/patches/0001-x.patch");
  assert.equal(shim.version, "v0.0.0-20261102220236-622d4f779368");
  assert.equal(shim.licenses[0].license.id, "Apache-2.0");
  assert.ok(!JSON.stringify(bom).includes("stdlib"));
  const meta = bom.metadata.component;
  assert.equal(meta.name, "parsa");
  assert.equal(meta.purl, "pkg:golang/github.com/appthreat/atom-parsetools/parsa@v2.0.0");
  assert.equal(meta.properties, undefined);
  assert.equal(bom.metadata.supplier.name, "Team AppThreat");
  // Every dependency entry follows the renamed refs.
  const refs = new Set([meta["bom-ref"], ...bom.components.map((c) => c["bom-ref"])]);
  for (const dep of bom.dependencies) {
    assert.ok(refs.has(dep.ref), dep.ref);
    for (const r of dep.dependsOn) assert.ok(refs.has(r), r);
  }
});

test("annotate leaves a patch without a url when no commit is given", () => {
  const bom = annotate(sample(), { version: "2.0.0", commit, commitTime: "20261102220236", patches });
  assert.equal(bom.components[0].pedigree.patches[0].diff.url, undefined);
});
