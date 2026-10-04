// A parsetools CLI run as an atom helper must not outlive its supervisor, and must take the
// processes it started down with it, even while its main thread is blocked in spawnSync.
import assert from "node:assert";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  descendantsOf,
  exitWithSupervisor,
  parentPidFromProcStat,
  processPairsFromPs
} from "../supervise.js";

const SUPERVISE = fileURLToPath(new URL("../supervise.js", import.meta.url));

// The process-table parsers run on every platform; the watchdog embeds the same functions.
// pid 1's parent 0 is not a process, so that line is skipped.
assert.deepStrictEqual(
  processPairsFromPs("    1     0\n  420     1\n  421   420\n\n"),
  [
    [420, 1],
    [421, 420]
  ]
);
assert.strictEqual(
  parentPidFromProcStat("421 (ruby) S 420 421 420 0 -1 4194560"),
  420
);
assert.strictEqual(
  parentPidFromProcStat("422 (my (odd) name) R 421 422 420 0 -1 4194560"),
  421,
  "a command name with spaces and parentheses must not shift the fields"
);
assert.strictEqual(parentPidFromProcStat("garbage"), undefined);
assert.deepStrictEqual(
  descendantsOf(
    [
      [420, 1],
      [421, 420],
      [422, 421],
      [500, 1]
    ],
    420
  ),
  [421, 422]
);

if (process.platform === "win32") {
  console.log(
    "supervise-regression: skipped on Windows (signal semantics differ)"
  );
  process.exit(0);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, ms = 8000) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (predicate()) {
      return true;
    }
    await sleep(50);
  }
  return predicate();
}

assert.strictEqual(
  exitWithSupervisor({}),
  undefined,
  "no supervisor named, no watchdog"
);
assert.strictEqual(exitWithSupervisor({ ATOM_PARENT_PID: "x" }), undefined);

const dir = mkdtempSync(join(tmpdir(), "parsetools-supervise-"));
const pidsFile = join(dir, "pids.json");
// The tool: arms the watchdog, then blocks its main thread in spawnSync on a long-running child,
// as rbastgen does with ruby and scalasem with sbt.
const tool = join(dir, "tool.mjs");
writeFileSync(
  tool,
  `import { spawnSync } from "node:child_process";
import { exitWithSupervisor } from ${JSON.stringify(SUPERVISE)};
exitWithSupervisor();
spawnSync(process.execPath, ["-e", ${JSON.stringify(
    `require("node:fs").writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ tool: process.ppid, child: process.pid })); setInterval(() => {}, 1000);`
  )}], { stdio: "ignore" });
`
);

async function startTool(env, viaIntermediate, toolStdio = "ignore") {
  rmSync(pidsFile, { force: true });
  let launcher;
  if (viaIntermediate) {
    // An intermediate parent (atom, in real use) that is killed outright. atom reads its
    // helpers' output through pipes, so with "pipe" the tool's stderr has no reader once the
    // intermediate is gone.
    launcher = spawn(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(tool)}], { stdio: ${JSON.stringify(toolStdio)} }); c.stdout?.resume(); c.stderr?.resume(); setInterval(() => {}, 1000);`
      ],
      { env: { ...process.env, ...env }, stdio: "ignore" }
    );
  } else {
    launcher = spawn(process.execPath, [tool], {
      env: { ...process.env, ...env },
      stdio: "ignore"
    });
  }
  assert.ok(
    await waitFor(() => existsSync(pidsFile)),
    "the tool never started its child"
  );
  return { launcher, pids: JSON.parse(readFileSync(pidsFile, "utf-8")) };
}

try {
  // 1. The supervisor named by ATOM_PARENT_PID dies.
  const supervisor = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" }
  );
  const first = await startTool(
    { ATOM_PARENT_PID: String(supervisor.pid) },
    false
  );
  supervisor.kill("SIGKILL");
  assert.ok(
    await waitFor(() => !isAlive(first.pids.child)),
    "the tool's child outlived the supervisor"
  );
  assert.ok(
    await waitFor(() => !isAlive(first.pids.tool)),
    "the tool outlived the supervisor"
  );

  // 2. The tool's own parent is killed (the supervisor itself is still alive).
  const second = await startTool(
    { ATOM_PARENT_PID: String(process.pid) },
    true
  );
  second.launcher.kill("SIGKILL");
  assert.ok(
    await waitFor(() => !isAlive(second.pids.child)),
    "the tool's child outlived its parent"
  );
  assert.ok(
    await waitFor(() => !isAlive(second.pids.tool)),
    "the tool outlived its parent"
  );

  // 3. As 2, with the tool's stdout and stderr piped to the parent that dies: the watchdog's
  // notice then hits a closed pipe, which must not stop it from stopping the tool.
  const piped = await startTool(
    { ATOM_PARENT_PID: String(process.pid) },
    true,
    "pipe"
  );
  piped.launcher.kill("SIGKILL");
  assert.ok(
    await waitFor(() => !isAlive(piped.pids.child)),
    "the tool's child outlived a parent that read its output"
  );
  assert.ok(
    await waitFor(() => !isAlive(piped.pids.tool)),
    "the tool outlived a parent that read its output"
  );

  // 4. Without ATOM_PARENT_PID nothing watches: the tool keeps running after its parent dies.
  const third = await startTool({ ATOM_PARENT_PID: "" }, true);
  third.launcher.kill("SIGKILL");
  await sleep(2500);
  assert.ok(
    isAlive(third.pids.tool),
    "an unsupervised tool must not stop on its own"
  );
  process.kill(third.pids.child, "SIGKILL");
  await waitFor(() => !isAlive(third.pids.tool));
  console.log("supervise-regression: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
