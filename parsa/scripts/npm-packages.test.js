// Tests for npm-packages.mjs: the parsa platform packages and the root package's optional
// dependencies on them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packagedNativeBinary } from "../../lib/typemap/native.mjs";
import { PACKAGE_NAMES, SBOM_NAME, TARGETS, published, stage, writeOptionalDeps } from "./npm-packages.mjs";

test("one package per release target, named as astgen looks them up", () => {
  assert.deepEqual(PACKAGE_NAMES, [
    "@appthreat/parsa-linux-x64",
    "@appthreat/parsa-linux-arm64",
    "@appthreat/parsa-darwin-x64",
    "@appthreat/parsa-darwin-arm64",
    "@appthreat/parsa-win32-x64",
    "@appthreat/parsa-win32-arm64"
  ]);
});

test("stage writes a package per target with the binary, executable, under bin/, and the SBOM", () => {
  const root = mkdtempSync(join(tmpdir(), "parsa-npm-"));
  try {
    const dist = join(root, "dist");
    const out = join(root, "out");
    for (const t of TARGETS) {
      const name = `parsa-${t.goos}-${t.goarch}${t.goos === "windows" ? ".exe" : ""}`;
      writeFileSync(join(mkdirp(dist), name), `binary ${name}`);
    }
    assert.throws(() => stage(dist, out, "2.0.0-rc.1"), /missing release SBOM/);
    writeFileSync(join(dist, SBOM_NAME), '{"bomFormat":"CycloneDX"}');
    const dirs = stage(dist, out, "2.0.0-rc.1");
    assert.equal(dirs.length, 6);
    const linux = JSON.parse(readFileSync(join(out, "parsa-linux-x64", "package.json"), "utf8"));
    assert.equal(linux.name, "@appthreat/parsa-linux-x64");
    assert.equal(linux.version, "2.0.0-rc.1");
    assert.deepEqual(linux.os, ["linux"]);
    assert.deepEqual(linux.cpu, ["x64"]);
    assert.equal(linux.libc, undefined, "the static linux binary serves glibc and musl");
    assert.deepEqual(linux.files, ["bin/", SBOM_NAME]);
    for (const t of TARGETS) {
      assert.equal(readFileSync(join(out, `parsa-${t.os}-${t.cpu}`, SBOM_NAME), "utf8"), '{"bomFormat":"CycloneDX"}');
    }
    assert.equal(readFileSync(join(out, "parsa-linux-x64", "bin", "parsa"), "utf8"), "binary parsa-linux-amd64");
    if (process.platform !== "win32") {
      assert.ok(statSync(join(out, "parsa-linux-x64", "bin", "parsa")).mode & 0o111, "executable");
    }
    assert.equal(readFileSync(join(out, "parsa-win32-arm64", "bin", "parsa.exe"), "utf8"), "binary parsa-windows-arm64.exe");
    rmSync(join(dist, "parsa-darwin-arm64"));
    assert.throws(() => stage(dist, out, "2.0.0-rc.1"), /missing release binary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optional dependencies name every package at the exact version, and only for that version", () => {
  const root = mkdtempSync(join(tmpdir(), "parsa-npm-"));
  try {
    const pkg = join(root, "package.json");
    writeFileSync(pkg, JSON.stringify({ name: "@appthreat/atom-parsetools", version: "2.0.0-rc.1" }));
    writeOptionalDeps(pkg, "2.0.0-rc.1");
    const deps = JSON.parse(readFileSync(pkg, "utf8")).optionalDependencies;
    assert.deepEqual(Object.keys(deps), PACKAGE_NAMES);
    assert.ok(Object.values(deps).every((v) => v === "2.0.0-rc.1"));
    assert.throws(() => writeOptionalDeps(pkg, "2.0.0"), /not 2\.0\.0/, "a tag for another version must not publish");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("published waits for every package, not the first", () => {
  const all = (spec) => spec.split("@").pop();
  assert.equal(published("2.0.0-rc.1", all), true);
  const oneMissing = (spec) => (spec.startsWith("@appthreat/parsa-win32-arm64") ? "" : spec.split("@").pop());
  assert.equal(published("2.0.0-rc.1", oneMissing), false);
});

test("astgen finds the binary in the installed platform package", () => {
  const root = mkdtempSync(join(tmpdir(), "parsa-npm-"));
  try {
    const pkgDir = mkdirp(join(root, "node_modules", "@appthreat", "parsa-linux-x64", "bin"));
    writeFileSync(join(pkgDir, "parsa"), "");
    const pkgJson = join(root, "node_modules", "@appthreat", "parsa-linux-x64", "package.json");
    writeFileSync(pkgJson, "{}");
    const resolve = (spec) => {
      if (spec === "@appthreat/parsa-linux-x64/package.json") return pkgJson;
      throw new Error(`cannot find ${spec}`);
    };
    assert.equal(packagedNativeBinary({ platform: "linux", arch: "x64", resolve }), join(pkgDir, "parsa"));
    assert.equal(packagedNativeBinary({ platform: "linux", arch: "riscv64", resolve }), undefined, "no package for the host");
    rmSync(join(pkgDir, "parsa"));
    assert.equal(packagedNativeBinary({ platform: "linux", arch: "x64", resolve }), undefined, "a package without its binary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
