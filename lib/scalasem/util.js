// Shared helpers for the scalasem engine: file walking that includes dot directories,
// subprocess execution with the timeouts the other tools of this package use, and path
// normalisation between the build tools.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

// Directories that never hold project sources worth inspecting.
const SKIP_DIRS = new Set([
  "node_modules",
  "bower_components",
  "giter8",
  ".git"
]);

/**
 * Recursive file listing. Unlike the generic walker of this package, dot directories are
 * visited, because scala-cli writes its output to `.scala-build/`.
 *
 * @param {string} dir Directory to walk
 * @param {string} extension File extension to collect, for example `.tasty`
 * @param {Object} [opts] `{ skip }` additional directory names to skip
 * @returns {string[]} Absolute file paths
 */
export function listFiles(dir, extension, opts = {}) {
  const skip = new Set([...(opts.skip || []), ...SKIP_DIRS]);
  const result = [];
  const visit = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          visit(full);
        }
      } else if (entry.name.endsWith(extension)) {
        result.push(full);
      }
    }
  };
  visit(dir);
  return result.sort();
}

/**
 * List the directories of a directory tree that directly contain a file with the given
 * extension.
 *
 * @param {string} dir Directory to walk
 * @param {string} extension File extension to look for
 * @param {Object} [opts] `{ skip }` additional directory names to skip
 * @returns {string[]} Absolute directory paths
 */
export function listDirsHolding(dir, extension, opts = {}) {
  const skip = new Set([...(opts.skip || []), ...SKIP_DIRS]);
  const result = [];
  const visit = (d) => {
    let entries;
    let holds = false;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) {
          visit(full);
        }
      } else if (entry.name.endsWith(extension)) {
        holds = true;
      }
    }
    if (holds) {
      result.push(d);
    }
  };
  visit(dir);
  return result.sort();
}

/**
 * `timeout` must be a number: spawnSync throws ERR_INVALID_ARG_TYPE on the raw string an
 * environment variable gives us. Unset or unparseable means no timeout.
 *
 * @returns {number|undefined} Timeout in milliseconds
 */
export function spawnTimeout() {
  const timeout = Number.parseInt(
    process.env.ATOM_TIMEOUT || process.env.ASTGEN_TIMEOUT,
    10
  );
  return Number.isNaN(timeout) ? undefined : timeout;
}

/**
 * Run a command and capture its output.
 *
 * @param {string} cmd Executable
 * @param {string[]} args Arguments
 * @param {Object} [opts] `{ cwd, env, timeout }`
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
export function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    cwd: opts.cwd || process.env.ATOM_CWD || process.cwd(),
    env: opts.env || process.env,
    timeout: opts.timeout ?? spawnTimeout(),
    maxBuffer: opts.maxBuffer || 1024 * 1024 * 1024
  });
}

/**
 * The java executable to run the helper with. Build tools report the JVM they used, but any
 * reasonably new one loads the same classes.
 *
 * @returns {string}
 */
export function javaCommand() {
  return process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
}

/**
 * Normalise a source path the compiler recorded to a project relative one. sbt records
 * project relative paths, Mill and scala-cli absolute ones.
 *
 * @param {string} projectDir Absolute project directory
 * @param {string} p Recorded path
 * @returns {string} POSIX style relative path when it is inside the project, else the input
 */
export function normaliseSourcePath(projectDir, p) {
  if (!p) {
    return p;
  }
  const posix = p.replaceAll("\\", "/");
  const abs = isAbsolute(posix) ? resolve(posix) : resolve(projectDir, posix);
  let rel = relative(projectDir, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return posix;
  }
  return rel.split(sep).join("/");
}

/**
 * Parse a Maven coordinate out of a repository layout path, for example
 * `<cache>/https/repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/1.86/bcprov-jdk18on-1.86.jar`.
 *
 * @param {string} jarPath Jar location
 * @returns {{ group: string, artifact: string, version: string }|undefined}
 */
export function jarCoordinate(jarPath) {
  const parts = String(jarPath).replaceAll("\\", "/").split("/");
  for (let i = parts.length - 3; i >= 1; i--) {
    const artifact = parts[i];
    const version = parts[i + 1];
    const file = parts[i + 2];
    if (!artifact || !version || !file || !file.endsWith(".jar")) {
      continue;
    }
    if (!file.startsWith(`${artifact}-${version}`)) {
      continue;
    }
    if (!/^\d/.test(version)) {
      continue;
    }
    const groupParts = [];
    for (let j = i - 1; j >= 0; j--) {
      const seg = parts[j];
      if (
        seg === "maven2" ||
        seg === "repository" ||
        seg === "caches" ||
        seg.includes(".")
      ) {
        break;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(seg)) {
        break;
      }
      groupParts.unshift(seg);
    }
    if (groupParts.length) {
      return {
        group: groupParts.join("."),
        artifact,
        version
      };
    }
  }
  return undefined;
}

/**
 * True when the file looks like something the report may quote: identifiers, algorithm
 * names, route paths and sanitized URLs.
 *
 * @param {string} value Literal to test
 * @returns {boolean}
 */
export function quotableLiteral(value) {
  if (!value || value.length > 128) {
    return false;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return true;
  }
  // Algorithm and protocol spellings: SHA-256, AES/GCM/NoPadding, TLSv1.3, PBKDF2WithHmacSHA256
  if (/^[A-Za-z][A-Za-z0-9+._-]*(\/[A-Za-z0-9+._-]*)*$/.test(value)) {
    return true;
  }
  if (value.startsWith("/") && !value.includes("..")) {
    return true;
  }
  if (/^(https?|jdbc):/.test(value)) {
    return true;
  }
  return false;
}

/**
 * Drop userinfo, query and fragment from a URL the way the report writer requires.
 *
 * @param {string} value Possibly a URL
 * @returns {string}
 */
export function sanitizeUrl(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value;
  }
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch (_err) {
    return value;
  }
}

/**
 * Read the first bytes of a file.
 *
 * @param {string} file Path
 * @param {number} length Byte count
 * @returns {Buffer|null}
 */
export function readHead(file, length) {
  let fh;
  try {
    fh = openSync(file, "r");
    const buf = Buffer.alloc(length);
    const read = readSync(fh, buf, 0, length, 0);
    return buf.subarray(0, read);
  } catch (_err) {
    return null;
  } finally {
    if (fh !== undefined) {
      closeSync(fh);
    }
  }
}

export { basename };
