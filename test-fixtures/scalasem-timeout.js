// Every build tool and the inspector JVM that scalasem starts stop with it when the
// time limit its caller handed down is up: a hanging fake of each tool must be gone,
// its own child gone with it, by the time scalasem exits.
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { resolveToolchain } from "../lib/scalasem/compiler.js";

if (process.platform === "win32") {
  console.log("scalasem-timeout: skipped on Windows (signal semantics differ)");
  process.exit(0);
}

const scalasem = join(process.cwd(), "scalasem.js");
const TIME_LIMIT_MS = 4000;
// The run must end well within this: a missing deadline would hang forever.
const WALL_CLOCK_LIMIT_MS = 90000;

// A stand-in for sbt, mill, maven, scala-cli or the inspector JVM: it records its
// own pid and the pid of a child it starts, and never exits on its own.
const HANG = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
try {
  writeFileSync(
    process.env.HANG_PIDS_FILE,
    JSON.stringify({ pid: process.pid, childPid: child.pid })
  );
} catch {}
setInterval(() => {}, 1000);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, ms = 10000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (predicate()) {
      return true;
    }
    await sleep(50);
  }
  return predicate();
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

const root = mkdtempSync(join(tmpdir(), "scalasem-timeout-"));
const binDir = join(root, "bin");
mkdirSync(binDir, { recursive: true });

function fakeTool(name) {
  const file = join(binDir, name);
  writeFileSync(file, HANG);
  chmodSync(file, 0o755);
  return file;
}

// One hanging tool per build tool, each with a child of its own, so the run has to
// stop a process tree and not only the tool it started.
const pidsFile = join(root, "pids.json");
const projects = {
  sbt: join(root, "sbt"),
  mill: join(root, "mill"),
  maven: join(root, "maven"),
  "scala-cli": join(root, "scala-cli")
};
for (const dir of Object.values(projects)) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(projects.maven, "pom.xml"), "<project/>");

async function runScalasem(buildTool, env) {
  const project = projects[buildTool];
  const out = join(project, "report.json");
  const startedAt = Date.now();
  const child = spawnSync(
    process.execPath,
    [scalasem, project, out, "--build", buildTool],
    {
      timeout: WALL_CLOCK_LIMIT_MS,
      env: {
        ...process.env,
        ...env,
        HANG_PIDS_FILE: pidsFile,
        SCALASEM_TIMEOUT: String(TIME_LIMIT_MS),
        ATOM_TIMEOUT: "",
        ASTGEN_TIMEOUT: ""
      }
    }
  );
  assert.ok(
    !child.error,
    `scalasem --build ${buildTool} did not finish on its own: ${child.error}`
  );
  return { out, startedAt, child };
}

async function assertTreeStopped() {
  assert.ok(
    await waitFor(() => existsSync(pidsFile)),
    "the fake build tool never started"
  );
  const { pid, childPid } = JSON.parse(readFileSync(pidsFile, "utf-8"));
  assert.ok(
    await waitFor(() => !isAlive(pid) && !isAlive(childPid), 15000),
    "the build tool or its child survived the scalasem deadline"
  );
  return { pid, childPid };
}

// sbt, mill, maven and scala-cli: the inventory of a forced build tool hangs in the
// fake, and the deadline stops it with its child.
fakeTool("scala-cli");
for (const [buildTool, env] of [
  ["sbt", { SBT_CMD: fakeTool("sbt") }],
  ["mill", { MILL_CMD: fakeTool("mill") }],
  ["maven", { MVN_CMD: fakeTool("mvn") }],
  ["scala-cli", { PATH: `${binDir}:${process.env.PATH}` }]
]) {
  // The fake writes the pids file as it starts, so a stale one must not count.
  rmSync(pidsFile, { force: true });
  const { out, child } = await runScalasem(buildTool, env);
  const { pid, childPid } = await assertTreeStopped();
  assert.notStrictEqual(
    child.status,
    0,
    "a killed run must not report success"
  );
  assert.ok(!existsSync(out), "a killed run wrote no report");
  console.log(
    `scalasem-timeout: --build ${buildTool} stopped (tool ${pid}, child ${childPid})`
  );
}

// The inspector JVM: the TASTy of the checked in project is read through a fake
// java, which the deadline stops the same way. Skipped when the compiler of the
// fixture cannot be resolved without a download, since nothing else would start.
rmSync(pidsFile, { force: true });
const toolchain = resolveToolchain(
  {
    scalaVersion: "3.3.7",
    buildTool: "test",
    compilerJars: [],
    libraryJars: []
  },
  { installDeps: false }
);
if (toolchain?.inspectorJar) {
  const jdk = join(root, "jdk");
  mkdirSync(join(jdk, "bin"), { recursive: true });
  writeFileSync(join(jdk, "bin", "java"), HANG);
  chmodSync(join(jdk, "bin", "java"), 0o755);
  const project = join(
    process.cwd(),
    "test-fixtures",
    "projects",
    "scala",
    "showcase"
  );
  const out = join(root, "showcase-report.json");
  const child = spawnSync(
    process.execPath,
    [scalasem, project, out, "--build", "none"],
    {
      timeout: WALL_CLOCK_LIMIT_MS,
      env: {
        ...process.env,
        HANG_PIDS_FILE: pidsFile,
        JAVA_HOME: jdk,
        SCALASEM_TIMEOUT: String(TIME_LIMIT_MS)
      }
    }
  );
  assert.ok(
    !child.error,
    `the inspector JVM run did not finish on its own: ${child.error}`
  );
  const { pid, childPid } = await assertTreeStopped();
  assert.notStrictEqual(
    child.status,
    0,
    "a killed run must not report success"
  );
  assert.ok(!existsSync(out), "a killed run wrote no report");
  console.log(
    `scalasem-timeout: the inspector JVM stopped (java ${pid}, child ${childPid})`
  );
} else {
  console.log(
    "scalasem-timeout: the 3.3.7 compiler is not resolvable offline, inspector JVM leg skipped"
  );
}

rmSync(root, { recursive: true, force: true });
console.log("scalasem-timeout: every build tool stops with its children");
