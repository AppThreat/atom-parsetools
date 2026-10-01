import { Worker } from "node:worker_threads";

// Runs on its own thread: the tools parse synchronously and block on spawnSync, so a timer on the
// main thread would not fire until the work it should interrupt is over.
const WATCHDOG = `
const { spawnSync } = require("node:child_process");
const { writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { pid, initialParent, isWin, pollMs, graceMs } = workerData;

const isAlive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

// Gone when the supervisor has exited, or when this process's own parent has: on POSIX an orphan
// is adopted, so its parent pid changes. Windows does not reparent, so the parent is probed.
const isGone = () =>
  !isAlive(pid) ||
  (isWin ? initialParent !== pid && !isAlive(initialParent) : process.ppid !== initialParent);

function descendants(root) {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf-8" });
  if (ps.status !== 0 || !ps.stdout) {
    return [];
  }
  const children = new Map();
  for (const line of ps.stdout.split("\\n")) {
    const [child, parent] = line.trim().split(/\\s+/).map(Number);
    if (child > 0 && parent > 0) {
      if (!children.has(parent)) {
        children.set(parent, []);
      }
      children.get(parent).push(child);
    }
  }
  const found = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()) || []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

const signal = (p, sig) => {
  try {
    process.kill(p, sig);
  } catch {
    // already gone
  }
};

const timer = setInterval(() => {
  if (!isGone()) {
    return;
  }
  clearInterval(timer);
  writeSync(2, "atom-parsetools: supervising process " + pid + " is gone; stopping.\\n");
  if (isWin) {
    // Stops this process and everything it started.
    spawnSync("taskkill", ["/T", "/F", "/PID", String(process.pid)]);
    return;
  }
  const helpers = descendants(process.pid);
  helpers.forEach((p) => signal(p, "SIGTERM"));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, graceMs);
  helpers.forEach((p) => signal(p, "SIGKILL"));
  signal(process.pid, "SIGKILL");
}, pollMs);
`;

/**
 * Stop this tool, and the processes it started, once the process that supervises it is gone.
 *
 * atom runs these tools as helpers. Its environment carries ATOM_PARENT_PID, naming the process
 * that supervises atom; when atom itself is killed outright, this tool would otherwise run on for
 * nobody, still holding its memory and its own children (ruby, php, sbt). A no-op when
 * ATOM_PARENT_PID is not set, as when a tool is run by hand.
 *
 * @param {Object} [env] Environment to read ATOM_PARENT_PID from
 * @returns {Worker|undefined} The watchdog thread, which never keeps the process alive
 */
export function exitWithSupervisor(env = process.env) {
  const pid = Number.parseInt(env.ATOM_PARENT_PID, 10);
  if (!(pid > 0)) {
    return undefined;
  }
  const worker = new Worker(WATCHDOG, {
    eval: true,
    workerData: {
      pid,
      initialParent: process.ppid,
      isWin: process.platform === "win32",
      pollMs: 1000,
      graceMs: 1000
    }
  });
  worker.unref();
  return worker;
}
