// Shared helpers for the scalasem engine: file walking that includes dot directories,
// subprocess execution with the timeouts the other tools of this package use, and path
// normalisation between the build tools.
import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

import { timeLimitReached } from "../../supervise.js";

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

const SOURCE_EXTENSIONS = [".scala", ".sc", ".java"];

/**
 * Whether any of a module's source roots holds a source file. An aggregate
 * project, such as an sbt root with no sources of its own, compiles nothing, so
 * nothing is missing when it yields no facts. Unknown roots count as sources.
 *
 * @param {string} projectDir Project directory the relative roots are under
 * @param {Object} module Module with `sourceRoots`
 * @returns {boolean}
 */
export function moduleHasSources(projectDir, module) {
  const roots = module?.sourceRoots;
  if (!Array.isArray(roots) || !roots.length) {
    return true;
  }
  const found = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (_err) {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && found(join(d, entry.name))) {
          return true;
        }
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        return true;
      }
    }
    return false;
  };
  return roots.some((root) =>
    found(isAbsolute(root) ? root : join(projectDir, root))
  );
}

/**
 * List the directories of a directory tree that directly contain a file with the given
 * extension.
 *
 * @param {string} dir Directory to walk
 * @param {string} extension File extension to look for
 * @param {Object} [opts] `{ skip, skipPaths }` additional directory names and absolute
 *   directory paths to skip
 * @returns {string[]} Absolute directory paths
 */
export function listDirsHolding(dir, extension, opts = {}) {
  const skip = new Set([...(opts.skip || []), ...SKIP_DIRS]);
  const skipPaths = new Set(opts.skipPaths || []);
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
        if (!skip.has(entry.name) && !skipPaths.has(full)) {
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
 * Once the handed-down time limit is up, no new subprocess starts: the watchdog is
 * already stopping the tool, and a helper started from then on would outlive it.
 *
 * @param {string} cmd Executable
 * @param {string[]} args Arguments
 * @param {Object} [opts] `{ cwd, env, timeout }`
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
export function run(cmd, args, opts = {}) {
  if (timeLimitReached()) {
    return {
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: ""
    };
  }
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
    ? join(
        process.env.JAVA_HOME,
        "bin",
        process.platform === "win32" ? "java.exe" : "java"
      )
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
  if (!value || value.length > 128 || looksSecret(value)) {
    return false;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return true;
  }
  // Algorithm and protocol spellings: SHA-256, AES/GCM/NoPadding, TLSv1.3, PBKDF2WithHmacSHA256
  if (/^[A-Za-z][A-Za-z0-9+._-]*(\/[A-Za-z0-9+._-]*)*$/.test(value)) {
    return true;
  }
  // Object identifiers name algorithms and curves: 1.2.840.113549.1.1.11
  if (/^[0-2](\.\d+){2,}$/.test(value)) {
    return true;
  }
  if (value.startsWith("/") && !value.includes("..")) {
    return true;
  }
  if (/^(https?|wss?|jdbc):/.test(value)) {
    return true;
  }
  return false;
}

/**
 * True for tokens that look like key material or credentials rather than names: JWTs, PEM
 * headers, long hex or base64 runs, and long mixed letter and digit strings with high entropy.
 * Algorithm spellings such as `PBKDF2WithHmacSHA256` stay quotable.
 *
 * @param {string} value Literal to test
 * @returns {boolean}
 */
export function looksSecret(value) {
  if (/^eyJ[A-Za-z0-9_-]+\./.test(value) || value.includes("-----BEGIN")) {
    return true;
  }
  if (/^(?:[0-9a-f]{32,}|[A-Za-z0-9+/]{40,}={0,2})$/i.test(value)) {
    return true;
  }
  if (/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(value)) {
    return true;
  }
  const letters = (value.match(/[A-Za-z]/g) || []).length;
  const digits = (value.match(/[0-9]/g) || []).length;
  if (value.length < 20 || !letters || digits < 6) {
    return false;
  }
  const counts = new Map();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy > 3.5;
}

/**
 * Drop userinfo, query and fragment from a URL the way the report writer requires, and
 * replace path segments that look like tokens (webhook keys, bot tokens, ids) with `{}`. JDBC
 * URLs keep their `jdbc:<driver>:` prefix; the user and password parameters some drivers
 * accept after a `;` are dropped too.
 *
 * @param {string} value Possibly a URL
 * @returns {string}
 */
export function sanitizeUrl(value) {
  if (typeof value !== "string") {
    return value;
  }
  const jdbc = /^(jdbc:[a-z0-9+.-]+:)(.*)$/i.exec(value);
  if (jdbc) {
    const rest = jdbc[2].split(";")[0];
    if (rest.startsWith("//")) {
      return `${jdbc[1]}${sanitizeUrl(`x:${rest}`).slice(2)}`;
    }
    // Oracle style `thin:user/password@host:port:sid`
    return `${jdbc[1]}${rest.split("?")[0].replace(/^([a-z]+:)[^@]*@/i, "$1@")}`;
  }
  const url = /^([a-z][a-z0-9+._-]*:\/\/)([^?#]*)/i.exec(value);
  if (!url) {
    return value;
  }
  const { host, path } = splitAuthority(url[2]);
  const segments = path
    .split("/")
    .map((segment) =>
      segment === "" || plainSegment(segment) ? segment : "{}"
    );
  return `${url[1]}${host}${segments.join("/")}`.replace(/\/$/, "");
}

/**
 * The host and the path of the part of a URL after `scheme://`. Userinfo ends at the last
 * `@` of the authority; a password with a `/` in it (`root:pa/ss@db`) moves that `@` past the
 * first `/`, which a port never does.
 */
function splitAuthority(rest) {
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  if (authority.includes("@")) {
    return {
      host: authority.slice(authority.lastIndexOf("@") + 1),
      path: slash < 0 ? "" : rest.slice(slash)
    };
  }
  const at = rest.lastIndexOf("@");
  const colon = rest.indexOf(":");
  if (at > 0 && colon > 0 && (slash < 0 || colon < slash)) {
    const afterColon = rest.slice(colon + 1, at);
    if (!/^\d+(\/|$)/.test(afterColon)) {
      const tail = rest.slice(at + 1);
      const tailSlash = tail.indexOf("/");
      return {
        host: tailSlash < 0 ? tail : tail.slice(0, tailSlash),
        path: tailSlash < 0 ? "" : tail.slice(tailSlash)
      };
    }
  }
  return { host: authority, path: slash < 0 ? "" : rest.slice(slash) };
}

/** A URL path segment that names something rather than carrying a token. */
function plainSegment(segment) {
  if (!/^[A-Za-z0-9._~{}$-]{1,64}$/.test(segment) || looksSecret(segment)) {
    return false;
  }
  // Long runs that mix letters and digits are keys and ids, not names.
  return !(
    segment.length >= 16 &&
    /[A-Za-z]/.test(segment) &&
    /[0-9]/.test(segment)
  );
}

/** The path list separator of this platform. */
export const PATH_LIST_SEPARATOR = process.platform === "win32" ? ";" : ":";

/**
 * A scratch directory under the system temporary directory.
 *
 * @param {string} prefix Directory name prefix
 * @returns {string} Created directory
 */
export function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
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
