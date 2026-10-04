import { Worker } from "node:worker_threads";

/**
 * [pid, parent pid] pairs from the output of `ps -A -o pid=,ppid=`.
 *
 * @param {string} text ps output
 * @returns {number[][]} Process and parent ids
 */
export function processPairsFromPs(text) {
  const pairs = [];
  for (const line of text.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child > 0 && parent > 0) {
      pairs.push([child, parent]);
    }
  }
  return pairs;
}

/**
 * The parent pid in the contents of a Linux `/proc/<pid>/stat` file.
 *
 * The second field, the command name, is in parentheses and may itself contain spaces and
 * parentheses, so the fields after it are counted from the last closing one.
 *
 * @param {string} stat Contents of the stat file
 * @returns {number|undefined} The parent pid
 */
export function parentPidFromProcStat(stat) {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const parent = Number(fields[1]);
  return parent > 0 ? parent : undefined;
}

/**
 * Every descendant of `root`, given [pid, parent pid] pairs.
 *
 * @param {number[][]} pairs Process and parent ids
 * @param {number} root Process whose descendants to collect
 * @returns {number[]} Descendant pids, children before grandchildren
 */
export function descendantsOf(pairs, root) {
  const children = new Map();
  for (const [child, parent] of pairs) {
    if (!children.has(parent)) {
      children.set(parent, []);
    }
    children.get(parent).push(child);
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

// Runs on its own thread: the tools parse synchronously and block on spawnSync, so a timer on the
// main thread would not fire until the work it should interrupt is over. The helpers above are
// embedded by source, so the worker and the tests run the same code.
const WATCHDOG = `
const { spawnSync } = require("node:child_process");
const { readdirSync, readFileSync, writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { pid, initialParent, isWin, pollMs, graceMs } = workerData;
${processPairsFromPs.toString()}
${parentPidFromProcStat.toString()}
${descendantsOf.toString()}

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

// The process table, from ps or, where ps is missing (minimal and distroless images), from /proc.
function processPairs() {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf-8" });
  if (ps.status === 0 && ps.stdout) {
    return processPairsFromPs(ps.stdout);
  }
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const pairs = [];
    for (const entry of readdirSync("/proc")) {
      if (!/^[0-9]+$/.test(entry)) {
        continue;
      }
      try {
        const parent = parentPidFromProcStat(readFileSync("/proc/" + entry + "/stat", "utf-8"));
        if (parent) {
          pairs.push([Number(entry), parent]);
        }
      } catch {
        // exited while being listed
      }
    }
    return pairs;
  } catch {
    return undefined;
  }
}

const signal = (p, sig) => {
  try {
    process.kill(p, sig);
  } catch {
    // already gone
  }
};

const report = (message) => {
  try {
    writeSync(2, message);
  } catch {
    // nobody reads stderr any more
  }
};

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const timer = setInterval(() => {
  if (!isGone()) {
    return;
  }
  clearInterval(timer);
  report("atom-parsetools: supervising process " + pid + " is gone; stopping.\\n");
  if (isWin) {
    // Stops this process and everything it started.
    spawnSync("taskkill", ["/T", "/F", "/PID", String(process.pid)]);
    return;
  }
  const pairs = processPairs();
  if (!pairs) {
    report("atom-parsetools: cannot list processes (no ps or /proc); processes this tool started may keep running.\\n");
  }
  const helpers = pairs ? descendantsOf(pairs, process.pid) : [];
  helpers.forEach((p) => signal(p, "SIGTERM"));
  if (helpers.length) {
    pause(graceMs);
  }
  helpers.forEach((p) => signal(p, "SIGKILL"));
  // SIGTERM first, so a handler the tool installed still runs; then make sure.
  signal(process.pid, "SIGTERM");
  pause(graceMs);
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
