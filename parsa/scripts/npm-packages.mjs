#!/usr/bin/env node
// The npm platform packages that carry parsa (@appthreat/parsa-<os>-<cpu>), one per release
// target, installed as optional dependencies of @appthreat/atom-parsetools so that npm picks the
// one matching the host and astgen finds the binary without any setting.
//
//   node parsa/scripts/npm-packages.mjs names
//   node parsa/scripts/npm-packages.mjs stage <dist-dir> <out-dir> <version>
//   node parsa/scripts/npm-packages.mjs optional-deps <package.json> <version>
//   node parsa/scripts/npm-packages.mjs wait <version> [timeout-seconds]
//
// `stage` turns the release binaries in <dist-dir> (parsa-<goos>-<goarch>[.exe], as
// build-release.sh names them) into one publishable directory per package, each with the release's
// post-build SBOM (sbom-parsa-postbuild.cdx.json) beside the binary. `optional-deps` writes
// the exact-version optionalDependencies into the root package.json just before it is published;
// they are not kept in git, so `npm ci` in this repository never asks the registry for packages of
// a version that is not published yet. `wait` returns once every package of a version is on the
// registry, so the root package is not published ahead of the binaries it depends on.
//
// The Linux binaries are static (no cgo), so the linux packages declare no libc and serve glibc
// and musl hosts alike.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { nativePackageName } from "../../lib/typemap/native.mjs";

// npm's os/cpu names, and the Go target build-release.sh writes for each.
export const TARGETS = [
  { os: "linux", cpu: "x64", goos: "linux", goarch: "amd64" },
  { os: "linux", cpu: "arm64", goos: "linux", goarch: "arm64" },
  { os: "darwin", cpu: "x64", goos: "darwin", goarch: "amd64" },
  { os: "darwin", cpu: "arm64", goos: "darwin", goarch: "arm64" },
  { os: "win32", cpu: "x64", goos: "windows", goarch: "amd64" },
  { os: "win32", cpu: "arm64", goos: "windows", goarch: "arm64" }
];

/** The package that carries parsa for a Node platform and architecture (named in astgen's lookup). */
export const packageName = (os, cpu) => nativePackageName(os, cpu);

/** The binary's file name inside a package (bin/<name>). */
export const binaryName = (os) => (os === "win32" ? "parsa.exe" : "parsa");

export const PACKAGE_NAMES = TARGETS.map((t) => packageName(t.os, t.cpu));

/** The post-build SBOM parsa-release.yml writes for the binaries; every package carries it. */
export const SBOM_NAME = "sbom-parsa-postbuild.cdx.json";

const isPrerelease = (version) => version.includes("-");

function packageJson(target, version) {
  return {
    name: packageName(target.os, target.cpu),
    version,
    description: `parsa, the native type map writer of @appthreat/atom-parsetools, for ${target.os}-${target.cpu}`,
    repository: { type: "git", url: "git+https://github.com/AppThreat/atom-parsetools.git", directory: "parsa" },
    homepage: "https://github.com/AppThreat/atom-parsetools/blob/main/docs/PACKAGING.md",
    license: "MIT",
    author: "Team AppThreat <cloud@appthreat.com>",
    os: [target.os],
    cpu: [target.cpu],
    files: ["bin/", SBOM_NAME],
    // yarn PnP must unpack a package whose binary is executed
    preferUnplugged: true
  };
}

function readme(target, version) {
  return `# ${packageName(target.os, target.cpu)}

The \`parsa\` binary of [@appthreat/atom-parsetools](https://www.npmjs.com/package/@appthreat/atom-parsetools)
${version} for ${target.os}-${target.cpu}. atom-parsetools lists it as an optional dependency, npm installs
the package that matches the host, and astgen runs \`bin/${binaryName(target.os)}\` to write JavaScript and
TypeScript type maps with TypeScript 7's checker. There is nothing to install or import directly.

\`${SBOM_NAME}\` is the CycloneDX SBOM of the release's binaries: the Go modules they were built
from, the pinned TypeScript commit and its patches.
`;
}

/** Writes one publishable directory per target under outDir; returns their paths. */
export function stage(distDir, outDir, version) {
  const sbom = join(distDir, SBOM_NAME);
  if (!existsSync(sbom)) throw new Error(`missing release SBOM ${sbom}`);
  const dirs = [];
  for (const t of TARGETS) {
    const asset = `parsa-${t.goos}-${t.goarch}${t.goos === "windows" ? ".exe" : ""}`;
    const from = join(distDir, asset);
    if (!existsSync(from)) throw new Error(`missing release binary ${from}`);
    const dir = join(outDir, `parsa-${t.os}-${t.cpu}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    const to = join(dir, "bin", binaryName(t.os));
    copyFileSync(from, to);
    chmodSync(to, 0o755);
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(packageJson(t, version), null, 2)}\n`);
    writeFileSync(join(dir, "README.md"), readme(t, version));
    copyFileSync(sbom, join(dir, SBOM_NAME));
    writeFileSync(join(dir, "LICENSE"), readFileSync(new URL("../../LICENSE", import.meta.url)));
    dirs.push(dir);
  }
  return dirs;
}

/** Sets the exact-version optionalDependencies of the root package.json. */
export function writeOptionalDeps(pkgPath, version) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.version !== version) {
    throw new Error(`package.json is ${pkg.version}, not ${version}`);
  }
  pkg.optionalDependencies = Object.fromEntries(PACKAGE_NAMES.map((n) => [n, version]));
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg.optionalDependencies;
}

/** Whether every package of a version is on the registry. */
export function published(version, view = npmView) {
  return PACKAGE_NAMES.every((n) => view(`${n}@${version}`) === version);
}

function npmView(spec) {
  try {
    return execFileSync("npm", ["view", spec, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case "names":
      console.log(PACKAGE_NAMES.join("\n"));
      return 0;
    case "stage": {
      const [dist, out, version] = args;
      if (!dist || !out || !version) break;
      for (const d of stage(dist, out, version)) console.log(d);
      return 0;
    }
    case "optional-deps": {
      const [pkgPath, version] = args;
      if (!pkgPath || !version) break;
      console.log(JSON.stringify(writeOptionalDeps(pkgPath, version), null, 2));
      return 0;
    }
    case "dist-tag": {
      const [version] = args;
      if (!version) break;
      console.log(isPrerelease(version) ? "next" : "latest");
      return 0;
    }
    case "wait": {
      const [version, timeout = "1800"] = args;
      if (!version) break;
      const until = Date.now() + Number(timeout) * 1000;
      while (!published(version)) {
        if (Date.now() > until) {
          console.error(`the parsa packages of ${version} are not all on the registry after ${timeout} s`);
          return 1;
        }
        await new Promise((r) => setTimeout(r, 30000));
      }
      console.log(`all ${PACKAGE_NAMES.length} parsa packages of ${version} are published`);
      return 0;
    }
  }
  console.error("usage: npm-packages.mjs names | stage <dist> <out> <version> | optional-deps <package.json> <version> | dist-tag <version> | wait <version> [seconds]");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
