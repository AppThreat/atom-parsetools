#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  realpathSync
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectPhp } from "@appthreat/atom-common";

let url = import.meta.url;
if (!url.startsWith("file://")) {
  url = new URL(`file://${import.meta.url}`).toString();
}
const dirName = import.meta ? dirname(fileURLToPath(url)) : __dirname;
export const PLUGINS_HOME = join(dirName, "plugins");
export const PARENT_NODE_PLUGINS_HOME = join(
  dirName,
  "..",
  "..",
  "node_modules",
  "@appthreat",
  "atom-parsetools",
  "plugins"
);

/**
 * Generator version string. This is the single source of truth for the phpastgen wrapper
 * version. `--version` prints exactly this string, and `--parser-info` reports the same string
 * on its "Generator version:" line (design §2.1, Requirement 1.6).
 */
export const GENERATOR_VERSION = "2.0.0";

/**
 * Default output directory for batch mode (mirrors ruby_ast_gen's `.ast`).
 */
export const DEFAULT_OUTPUT = ".ast";

/**
 * Default exclusion regex applied to the path relative to the input.
 */
export const DEFAULT_EXCLUDE = "^(tests?|vendor|Tests?)";

/**
 * Default worker-pool size for batch runs (bounded concurrent `php-parse` subprocesses).
 */
export const DEFAULT_THREADS = 10;

/**
 * Bounds for `--threads`: values outside this inclusive range fall back to DEFAULT_THREADS.
 */
export const MIN_THREADS = 1;
export const MAX_THREADS = 64;

/**
 * Default depth cap before truncation.
 */
export const DEFAULT_MAX_DEPTH = 250;

/**
 * Bounds for `--max-depth` (inclusive).
 */
export const MIN_MAX_DEPTH = 1;
export const MAX_MAX_DEPTH = 10000;

/**
 * Directory names whose subtrees are skipped wholesale during discovery (design §2.2). Matched as
 * exact path components, never followed even if reachable via a symlink.
 */
export const VENDOR_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  "vendor",
  "node_modules",
  ".idea",
  ".vscode"
]);

/**
 * File extensions recognized as PHP by name alone (design §2.2). Compared lower-cased and
 * including the leading dot.
 */
export const PHP_EXTENSIONS = new Set([
  ".php",
  ".phtml",
  ".php3",
  ".php4",
  ".php5",
  ".phps",
  ".inc"
]);

/**
 * Supported PHP grammar target versions (8.0 through 8.5 inclusive). A `--target-version` outside
 * this set is rejected (Requirement 1.7).
 */
export const SUPPORTED_TARGET_VERSIONS = [
  "8.0",
  "8.1",
  "8.2",
  "8.3",
  "8.4",
  "8.5"
];

/**
 * Resolve the vendored `php-parse` binary path, preferring an explicit PHP_PARSER_BIN override,
 * then the bundled plugins, then a parent node_modules install.
 *
 * @returns {string} path to the php-parse binary
 */
export function resolvePhpParseBin() {
  let bin = process.env.PHP_PARSER_BIN || join(PLUGINS_HOME, "bin", "php-parse");
  if (
    !existsSync(bin) &&
    existsSync(join(PARENT_NODE_PLUGINS_HOME, "bin", "php-parse"))
  ) {
    bin = join(PARENT_NODE_PLUGINS_HOME, "bin", "php-parse");
  }
  return bin;
}

/**
 * Read the vendored nikic/php-parser version from `plugins/composer/installed.php` so provenance
 * is not hard-coded (design §Milestone A task 1). Falls back to reading the package composer.json
 * and finally to "unknown" if neither is readable.
 *
 * @returns {string} the vendored parser version (e.g. "5.8.0") or "unknown"
 */
export function vendoredParserVersion() {
  for (const home of [PLUGINS_HOME, PARENT_NODE_PLUGINS_HOME]) {
    const installed = join(home, "composer", "installed.php");
    if (existsSync(installed)) {
      try {
        const text = readFileSync(installed, "utf-8");
        // Locate the nikic/php-parser entry, then its pretty_version.
        const idx = text.indexOf("nikic/php-parser");
        if (idx !== -1) {
          const slice = text.slice(idx);
          const match = slice.match(
            /'pretty_version'\s*=>\s*'v?([^']+)'/
          );
          if (match) {
            return match[1];
          }
        }
      } catch {
        // fall through to next candidate
      }
    }
  }
  return "unknown";
}

/**
 * `timeout` must be a number: spawnSync throws ERR_INVALID_ARG_TYPE on the raw string an
 * environment variable gives us. Unset or unparseable means no timeout.
 *
 * @returns {number | undefined}
 */
export function spawnTimeout() {
  const timeout = Number.parseInt(
    process.env.ATOM_TIMEOUT || process.env.ASTGEN_TIMEOUT,
    10
  );
  return Number.isNaN(timeout) ? undefined : timeout;
}

/**
 * Parse the phpastgen CLI arguments into an options object. Mirrors the ruby_ast_gen surface.
 *
 * Validation performed here (design §2.1, Requirements 1.7, 2.11):
 *  - `--threads` outside [1, 64] warns and falls back to the default of 10.
 *  - `--max-depth` outside [1, 10000] warns and falls back to the default of 250.
 *  - `--target-version` (alias `--parser-target`) outside 8.0–8.5 is flagged as invalid so the
 *    caller can reject the invocation, emit no AST, and exit non-zero.
 *
 * @param {string[]} argv arguments (already sliced past node + script)
 * @returns {{
 *   input: (string|undefined),
 *   output: string,
 *   exclude: string,
 *   log: string,
 *   debug: boolean,
 *   targetVersion: (string|undefined),
 *   invalidTargetVersion: (string|undefined),
 *   maxDepth: number,
 *   threads: number,
 *   failOnError: boolean,
 *   parserInfo: boolean,
 *   showVersion: boolean,
 *   help: boolean,
 *   rest: string[]
 * }}
 */
export function parseArgs(argv) {
  const opts = {
    input: undefined,
    output: DEFAULT_OUTPUT,
    exclude: DEFAULT_EXCLUDE,
    log: "info",
    debug: false,
    targetVersion: undefined,
    invalidTargetVersion: undefined,
    maxDepth: DEFAULT_MAX_DEPTH,
    threads: DEFAULT_THREADS,
    failOnError: false,
    parserInfo: false,
    showVersion: false,
    help: false,
    rest: []
  };

  const next = (i) => {
    if (i + 1 >= argv.length) {
      return undefined;
    }
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-i":
      case "--input":
        opts.input = next(i);
        i++;
        break;
      case "-o":
      case "--output":
        opts.output = next(i) ?? DEFAULT_OUTPUT;
        i++;
        break;
      case "-e":
      case "--exclude":
        opts.exclude = next(i) ?? DEFAULT_EXCLUDE;
        i++;
        break;
      case "-l":
      case "--log":
        opts.log = next(i) ?? "info";
        i++;
        break;
      case "-d":
      case "--debug":
        opts.debug = true;
        opts.log = "debug";
        break;
      case "--target-version":
      case "--parser-target": {
        const value = next(i);
        i++;
        if (value !== undefined && SUPPORTED_TARGET_VERSIONS.includes(value)) {
          opts.targetVersion = value;
        } else {
          // Record the offending value so main() can reject the invocation.
          opts.invalidTargetVersion = value ?? "";
        }
        break;
      }
      case "--max-depth": {
        const value = Number.parseInt(next(i), 10);
        i++;
        if (
          Number.isNaN(value) ||
          value < MIN_MAX_DEPTH ||
          value > MAX_MAX_DEPTH
        ) {
          console.warn(
            `Ignoring out-of-range --max-depth value; falling back to ${DEFAULT_MAX_DEPTH} (allowed ${MIN_MAX_DEPTH}-${MAX_MAX_DEPTH}).`
          );
          opts.maxDepth = DEFAULT_MAX_DEPTH;
        } else {
          opts.maxDepth = value;
        }
        break;
      }
      case "--threads": {
        const value = Number.parseInt(next(i), 10);
        i++;
        if (
          Number.isNaN(value) ||
          value < MIN_THREADS ||
          value > MAX_THREADS
        ) {
          console.warn(
            `Ignoring out-of-range --threads value; falling back to ${DEFAULT_THREADS} (allowed ${MIN_THREADS}-${MAX_THREADS}).`
          );
          opts.threads = DEFAULT_THREADS;
        } else {
          opts.threads = value;
        }
        break;
      }
      case "--fail-on-error":
        opts.failOnError = true;
        break;
      case "--parser-info":
        opts.parserInfo = true;
        break;
      case "--version":
        opts.showVersion = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        opts.rest.push(arg);
        break;
    }
  }
  return opts;
}

/**
 * Detected PHP runtime version, or undefined when PHP is not on the PATH.
 *
 * @returns {string | undefined}
 */
export function detectedPhpVersion() {
  const result = spawnSync(
    process.env.PHP_CMD || "php",
    ["-r", "echo PHP_VERSION;"],
    { encoding: "utf-8", timeout: spawnTimeout() }
  );
  if (result.status === 0 && result.stdout) {
    return result.stdout.trim();
  }
  return undefined;
}

/**
 * Print usage text. Owned/expanded by the CLI reporting task; kept minimal here so dispatch works.
 */
export function printUsage() {
  console.log(
    [
      "Usage: phpastgen [options] [-- <legacy php-parse args>]",
      "",
      "Options:",
      "  -i, --input <path>          input file or directory (batch mode)",
      `  -o, --output <dir>          output directory (default: '${DEFAULT_OUTPUT}')`,
      `  -e, --exclude <regex>       exclusion regex (default: '${DEFAULT_EXCLUDE}')`,
      "  -l, --log <level>           debug | info | warn | error (default: info)",
      "  -d, --debug                 same as --log debug",
      "      --target-version <x.y>  pin PHP grammar (alias: --parser-target)",
      `      --max-depth <n>         depth cap before truncation (default: ${DEFAULT_MAX_DEPTH})`,
      `      --threads <n>           worker processes for directory runs (default: ${DEFAULT_THREADS})`,
      "      --fail-on-error         exit non-zero if any file failed",
      "      --parser-info           print parser/runtime capability report and exit 0",
      "      --version               print generator version and exit 0",
      "      --help                  print usage"
    ].join("\n")
  );
}

/**
 * The newest grammar the vendored parser supports. Used as the default Target_Version when none is
 * provided (Requirement 1.4) and surfaced in the capability report.
 *
 * @returns {string} the newest supported target grammar (e.g. "8.5")
 */
export function newestTargetVersion() {
  return SUPPORTED_TARGET_VERSIONS[SUPPORTED_TARGET_VERSIONS.length - 1];
}

/**
 * Print the parser/runtime capability report (design §2.5, Requirements 1.2, 1.4, 1.5, 1.8).
 *
 * The report contains exactly:
 *  - `Parser backend:` — the vendored nikic/php-parser and its version.
 *  - `PHP version:` — the detected PHP runtime version.
 *  - `Generator version:` — the generator version string (identical to `--version`).
 *  - `Supported target versions:` — the target grammars covering 8.0 through 8.5 inclusive, with
 *    the default (newest) grammar marked.
 *  - `Token emulation:` — indicates that the vendored parser can parse a newer requested target
 *    grammar even on an older PHP runtime, so the runtime need not be upgraded (Requirement 1.2).
 *
 * Consumers (the chen capability probe and the atom version gate) parse the `Generator version:`
 * and `Parser backend:` lines, mirroring how the Ruby regression test parses `Parser backend:`.
 *
 * When no PHP runtime is on the PATH, print a report indicating that PHP is not installed and
 * return a non-zero exit code (Requirement 1.8).
 *
 * @returns {number} process exit code (0 on success, non-zero when PHP is not installed)
 */
export function printParserInfo() {
  const phpVersion = detectedPhpVersion();
  const backend = `nikic/php-parser@${vendoredParserVersion()}`;
  if (!phpVersion) {
    // Requirement 1.8: no PHP runtime on the PATH. Still surface the backend + generator + grammar
    // provenance (which do not depend on a runtime) so downstream gates get useful context, then
    // report the missing runtime and exit non-zero.
    console.log(`Parser backend: ${backend}`);
    console.log("PHP version: PHP is not installed");
    console.log(`Generator version: ${GENERATOR_VERSION}`);
    console.log(
      `Supported target versions: ${SUPPORTED_TARGET_VERSIONS.join(", ")}`
    );
    console.log(
      `Token emulation: enabled (parse target grammars up to ${newestTargetVersion()} without a matching PHP runtime)`
    );
    console.log("PHP is not installed");
    return 1;
  }
  const grammars = SUPPORTED_TARGET_VERSIONS.map((v) =>
    v === newestTargetVersion() ? `${v} (default)` : v
  ).join(", ");
  console.log(`Parser backend: ${backend}`);
  console.log(`PHP version: ${phpVersion}`);
  console.log(`Generator version: ${GENERATOR_VERSION}`);
  console.log(`Supported target versions: ${grammars}`);
  // Requirement 1.2: token emulation lets an older PHP runtime parse a newer requested grammar.
  console.log(
    `Token emulation: enabled (parse target grammars up to ${newestTargetVersion()} without a matching PHP runtime)`
  );
  return 0;
}

/**
 * Cheap best-effort sniff for a PHP open tag (`<?php` or `<?=`) in the leading bytes of a file.
 * Only the first chunk is read so the check stays inexpensive on large files.
 *
 * @param {string} filePath
 * @returns {boolean} true when an open tag is found near the start of the file
 */
export function hasPhpOpenTag(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return false;
    }
    const head = buffer.toString("utf-8", 0, bytesRead);
    return head.includes("<?php") || head.includes("<?=");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failures
      }
    }
  }
}

/**
 * Decide whether a file is recognized as PHP (design §2.2): any of the known PHP extensions, or an
 * extensionless file whose leading bytes contain a `<?php`/`<?=` open tag.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isRecognizedPhp(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext !== "") {
    return PHP_EXTENSIONS.has(ext);
  }
  // Extensionless: fall back to a cheap open-tag sniff.
  return hasPhpOpenTag(filePath);
}

/**
 * Discover PHP files under the input path (design §2.2).
 *
 * For a single-file input the exclusion regex is matched against the file's basename, so a
 * parent-directory name can never silently drop the file. For a directory input the tree is
 * walked, `VENDOR_DIRS` subtrees are skipped wholesale, symlinked directories are not followed,
 * and the exclusion regex is matched against each entry's path relative to the input.
 *
 * @param {string} inputPath file or directory to scan
 * @param {RegExp} excludeRegex regex matched against the path relative to the input
 * @returns {{ included: string[], excludedCount: number, skippedNonPhpCount: number }}
 */
export function discoverFiles(inputPath, excludeRegex) {
  // Use lstat so a symlinked file/dir is classified by the link itself, not its target.
  let rootStat;
  try {
    rootStat = lstatSync(inputPath);
  } catch {
    return { included: [], excludedCount: 0, skippedNonPhpCount: 0 };
  }

  // Single-file input: match exclusion against the basename.
  if (rootStat.isFile()) {
    const rel = basename(inputPath);
    if (excludeRegex.test(rel)) {
      return { included: [], excludedCount: 1, skippedNonPhpCount: 0 };
    }
    if (isRecognizedPhp(inputPath)) {
      return { included: [inputPath], excludedCount: 0, skippedNonPhpCount: 0 };
    }
    return { included: [], excludedCount: 0, skippedNonPhpCount: 1 };
  }

  // Anything that is neither a regular file nor a directory (e.g. a symlink to a file, socket) is
  // treated by walking only when it is a directory; otherwise nothing to discover.
  if (!rootStat.isDirectory()) {
    return { included: [], excludedCount: 0, skippedNonPhpCount: 0 };
  }

  const included = [];
  let excludedCount = 0;
  let skippedNonPhpCount = 0;

  // Iterative walk to avoid deep recursion on large trees; do not follow symlinked directories.
  const stack = [inputPath];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      // Determine the entry kind without following symlinks. Dirent flags from withFileTypes do
      // not dereference symlinks, which is exactly what we want.
      if (entry.isSymbolicLink()) {
        // Never follow symlinked directories; classify a symlink by its own target only if it
        // resolves to a regular file, matching the "do not follow symlinked dirs" rule.
        let targetStat;
        try {
          targetStat = statSync(fullPath);
        } catch {
          continue;
        }
        if (targetStat.isDirectory()) {
          // Skip symlinked directories entirely.
          continue;
        }
        // Symlink to a file: treat as a candidate file below.
      }

      if (entry.isDirectory()) {
        if (VENDOR_DIRS.has(entry.name)) {
          // Skip the whole vendor subtree.
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      // At this point the entry is a regular file (or a symlink to a file).
      const rel = relative(inputPath, fullPath);
      if (excludeRegex.test(rel)) {
        excludedCount += 1;
        continue;
      }
      if (isRecognizedPhp(fullPath)) {
        included.push(fullPath);
      } else {
        skippedNonPhpCount += 1;
      }
    }
  }

  return { included, excludedCount, skippedNonPhpCount };
}

/**
 * Node children below a truncation boundary are cut and replaced by this marker so the surviving
 * tree still serializes to valid JSON. The `truncated` flag lets consumers detect a cut boundary.
 */
export const TRUNCATION_MARKER = "__phpastgen_truncated__";

/**
 * Maximum bytes of a leading chunk inspected for an encoding declaration. A `declare(encoding=...)`
 * statement or a byte-order mark is always near the start of the file, so a small window suffices.
 */
const ENCODING_SNIFF_BYTES = 4096;

/**
 * Map a PHP-flavored encoding label to a Node.js {@link Buffer} encoding, or undefined when the
 * label is unknown/unsupported so the caller falls back to UTF-8 scrubbing.
 *
 * @param {string} label the declared encoding label (case-insensitive)
 * @returns {BufferEncoding | undefined}
 */
function normalizeEncoding(label) {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  switch (normalized) {
    case "utf8":
      return "utf-8";
    case "usascii":
    case "ascii":
      return "ascii";
    case "iso88591":
    case "latin1":
    case "cp1252":
    case "windows1252":
      // Node treats latin1/binary as a single-byte pass-through, the closest built-in match.
      return "latin1";
    case "utf16":
    case "utf16le":
    case "ucs2":
      return "utf16le";
    default:
      return undefined;
  }
}

/**
 * Best-effort read of a declared source encoding from the leading bytes of a PHP file. Honors a
 * UTF-8/UTF-16 byte-order mark and a `declare(encoding='...')` statement. Returns undefined when no
 * declaration is found so the caller defaults to UTF-8 (design §2.3.1).
 *
 * @param {Buffer} bytes raw file bytes
 * @returns {string | undefined} a declared encoding label, or undefined
 */
export function readMagicEncodingComment(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return undefined;
  }
  // Byte-order marks take precedence over any textual declaration.
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  // Sniff a leading window for a declare(encoding=...) statement.
  const head = bytes.toString("latin1", 0, Math.min(bytes.length, ENCODING_SNIFF_BYTES));
  const match = head.match(
    /declare\s*\(\s*encoding\s*=\s*['"]([^'"]+)['"]\s*\)/i
  );
  if (match) {
    return match[1];
  }
  return undefined;
}

/**
 * Decode raw file bytes into text, honoring a declared encoding and falling back to UTF-8 with
 * invalid byte sequences replaced (design §2.3.1, Requirement 2.5).
 *
 * When the declared encoding decodes cleanly the result is returned with `scrubbed=false`. When
 * there is no usable declaration, or decoding produces the Unicode replacement character
 * (U+FFFD) — i.e. the bytes were not valid for the declared encoding — the content is decoded as
 * UTF-8 with invalid sequences replaced and `scrubbed` is set to true. This makes the operation
 * idempotent: text that has already been scrubbed contains only valid UTF-8 (no invalid bytes to
 * replace), so re-decoding its UTF-8 bytes yields the same text (Property 5 / P5).
 *
 * @param {Buffer} bytes raw file bytes
 * @returns {{ text: string, scrubbed: boolean }}
 */
export function decodeAndScrub(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  const declared = readMagicEncodingComment(buffer);
  const enc = normalizeEncoding(declared ?? "UTF-8");

  // The declared label was recognized: try a strict decode. Node's decoders insert the U+FFFD
  // replacement character for byte sequences that are invalid for the target encoding, so its
  // presence signals that a clean decode was not possible.
  if (enc !== undefined) {
    const text = buffer.toString(enc);
    if (!text.includes("\uFFFD")) {
      return { text, scrubbed: false };
    }
  }

  // No usable declaration, or the declared encoding produced invalid sequences: scrub as UTF-8.
  return { text: buffer.toString("utf-8"), scrubbed: true };
}

/**
 * Return the array of child AST nodes reachable from `node` (design §2.3.2). nikic ASTs are plain
 * objects/arrays: children are the object-or-array valued properties (skipping the `nodeType`,
 * `attributes` metadata and the truncation marker itself), plus array elements.
 *
 * @param {*} node
 * @returns {Array<{ container: object, key: (string|number), value: object }>}
 */
function childNodeEntries(node) {
  const entries = [];
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const value = node[i];
      if (value !== null && typeof value === "object") {
        entries.push({ container: node, key: i, value });
      }
    }
    return entries;
  }
  if (node !== null && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (key === "nodeType" || key === TRUNCATION_MARKER) {
        continue;
      }
      const value = node[key];
      if (value !== null && typeof value === "object") {
        entries.push({ container: node, key, value });
      }
    }
  }
  return entries;
}

/**
 * Truncate an AST in place so no node survives at or below the depth cap, marking each cut boundary
 * and returning the number of truncation points (design §2.3.2, Requirement 2.6).
 *
 * A node reached at `depth >= maxDepth` is a truncation point: its descendant children are
 * detached and it is tagged with `truncated: true` (a boundary marker). The marker is placed on
 * object nodes; the count of boundaries is returned so the caller can record `truncated_nodes`.
 *
 * Postcondition: no node deeper than `maxDepth` survives, and the surviving tree still serializes
 * (children are removed rather than left dangling). Correctness Property 6 (P6).
 *
 * @param {*} node the AST root (object or array)
 * @param {number} maxDepth the depth cap (1-based; root is depth 0)
 * @param {number} [depth=0] current recursion depth
 * @returns {number} the number of truncation points introduced
 */
export function truncateDeep(node, maxDepth, depth = 0) {
  if (node === null || typeof node !== "object") {
    return 0;
  }

  if (depth >= maxDepth) {
    let count = 0;
    const entries = childNodeEntries(node);
    if (entries.length > 0) {
      // Detach every child subtree; mark the boundary on object nodes.
      for (const { container, key } of entries) {
        if (Array.isArray(container)) {
          container[key] = null;
        } else {
          delete container[key];
        }
      }
      if (!Array.isArray(node)) {
        node.truncated = true;
      }
      count += 1;
    }
    // Compact away the nulls introduced into arrays so the serialized tree stays clean.
    if (Array.isArray(node) && count > 0) {
      for (let i = node.length - 1; i >= 0; i--) {
        if (node[i] === null) {
          node.splice(i, 1);
        }
      }
    }
    return count;
  }

  let count = 0;
  for (const { value } of childNodeEntries(node)) {
    count += truncateDeep(value, maxDepth, depth + 1);
  }
  return count;
}

/**
 * Additive per-node key under which syntactic framework facts are emitted (design Decision 3,
 * §2.7, Requirement 6.1). The generator only surfaces *syntactic* facts already visible in the AST
 * — attribute groups (e.g. `#[Route(...)]`) and PHP superglobal references (`$_GET`/`$_POST`/
 * `$_REQUEST`) — leaving taint semantics to chen. This key is emitted strictly on nodes where such
 * a fact holds and is omitted everywhere else, so the contract stays additive (invariant 1) and
 * every pre-existing node field (including nikic's own `attrGroups`) is left byte-for-byte
 * unchanged.
 */
export const FRAMEWORK_FACTS_KEY = "framework_facts";

/**
 * PHP superglobal variable names the generator tags as syntactic framework facts (design §2.7,
 * Requirement 6.1). These are the request-borne superglobals chen's WordPress/plain-PHP taint
 * rules key off of; the generator merely records that a variable *is* one of them so downstream
 * consumers do not have to re-derive it. Matched against an `Expr_Variable` node's `name` string.
 */
export const SUPERGLOBAL_NAMES = new Set([
  "_GET",
  "_POST",
  "_REQUEST",
  "_SERVER",
  "_COOKIE",
  "_SESSION",
  "_FILES",
  "_ENV",
  "GLOBALS"
]);

/**
 * The subset of {@link SUPERGLOBAL_NAMES} that carry externally controlled request data — the
 * primary framework taint sources (design §2.7). Recorded on the fact so a consumer can cheaply
 * distinguish a request superglobal (`$_GET`) from an ambient one (`$_SERVER`) without a second
 * lookup table.
 */
const REQUEST_SUPERGLOBALS = new Set(["_GET", "_POST", "_REQUEST", "_COOKIE", "_FILES"]);

/**
 * Extract the attribute names declared on a node's nikic `attrGroups` array (design §2.7).
 *
 * nikic emits `attrGroups: [{ nodeType: "AttributeGroup", attrs: [{ nodeType: "Attribute",
 * name: { name: "Fully\\Qualified\\Route" }, ... }] }]` on declaration nodes, and an empty array
 * when a declaration carries no attributes. This returns the flat list of attribute names across
 * every group, or an empty array when the node carries none. The pre-existing `attrGroups` field
 * is read but never mutated.
 *
 * @param {*} node an AST node (may be any value)
 * @returns {string[]} attribute names in declaration order (empty when there are none)
 */
export function attributeNames(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return [];
  }
  const groups = node.attrGroups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return [];
  }
  const names = [];
  for (const group of groups) {
    const attrs = group && typeof group === "object" ? group.attrs : undefined;
    if (!Array.isArray(attrs)) {
      continue;
    }
    for (const attr of attrs) {
      const name = attr && typeof attr === "object" ? attr.name : undefined;
      // nikic models the attribute name as a Name node with a string `name` property.
      if (name && typeof name === "object" && typeof name.name === "string") {
        names.push(name.name);
      } else if (typeof name === "string") {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * Compute the syntactic framework fact(s) for a single node, or `undefined` when the node carries
 * none (design Decision 3, §2.7, Requirement 6.1).
 *
 * Two syntactic facts are recognized, mirroring the design's "syntactic, cheap,
 * framework-agnostic-to-detect" set:
 *  - **attribute groups** — any node with a non-empty `attrGroups` yields
 *    `{ attributes: [<name>, ...] }`, the flat list of declared attribute names (e.g.
 *    `Symfony\\Component\\Routing\\Annotation\\Route`). This is what atom's policy maps to routed
 *    entrypoints and what chen keys Symfony routing off of.
 *  - **superglobal reference** — an `Expr_Variable` whose `name` is a known superglobal yields
 *    `{ superglobal: "_GET", request: true }`, where `request` flags the request-borne
 *    superglobals chen treats as taint sources.
 *
 * A node can carry both facts (they live under distinct keys), so the returned object may hold
 * either or both. Returning `undefined` (rather than an empty object) lets the caller omit the key
 * entirely, preserving the additive-contract invariant.
 *
 * @param {*} node an AST node
 * @returns {object | undefined} the fact object, or undefined when the node carries no fact
 */
export function frameworkFactFor(node) {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return undefined;
  }
  let fact;

  const attrs = attributeNames(node);
  if (attrs.length > 0) {
    fact = fact ?? {};
    fact.attributes = attrs;
  }

  if (node.nodeType === "Expr_Variable" && typeof node.name === "string" && SUPERGLOBAL_NAMES.has(node.name)) {
    fact = fact ?? {};
    fact.superglobal = node.name;
    fact.request = REQUEST_SUPERGLOBALS.has(node.name);
  }

  return fact;
}

/**
 * Walk a parsed AST in place and enrich each node that carries a syntactic framework fact with an
 * additive {@link FRAMEWORK_FACTS_KEY} key (design Decision 3, §2.7, Requirement 6.1).
 *
 * Enrichment is strictly additive: for a node with a fact, a new `framework_facts` key is set and
 * *no* pre-existing field is read-modified or removed (nikic's own `attrGroups`, `name`,
 * `attributes`, children, etc. are left untouched). Nodes with no fact are not touched at all, so
 * the emitted shape is byte-for-byte identical to the un-enriched AST except for the added keys —
 * satisfying the additive contract (invariant 1). The traversal mirrors the reachability rules
 * used elsewhere (object/array-valued properties plus array elements), skips the `attributes`
 * metadata blob and the truncation marker, and tolerates cycles defensively via a visited set.
 *
 * @param {*} node the AST root (nikic emits a top-level array of statements)
 * @returns {number} the number of nodes enriched (0 when no framework facts were found)
 */
export function enrichFrameworkFacts(node) {
  let enriched = 0;
  const seen = new Set();
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (!Array.isArray(current)) {
      const fact = frameworkFactFor(current);
      if (fact !== undefined) {
        // Additive only: set the new key without disturbing any existing field.
        current[FRAMEWORK_FACTS_KEY] = fact;
        enriched += 1;
      }
    }

    // Descend into child nodes, matching the traversal used by truncateDeep: object/array-valued
    // properties (excluding the nodeType tag, the framework-facts key we just wrote, and the
    // truncation marker) plus array elements.
    if (Array.isArray(current)) {
      for (const value of current) {
        if (value !== null && typeof value === "object") {
          stack.push(value);
        }
      }
    } else {
      for (const key of Object.keys(current)) {
        if (key === "nodeType" || key === FRAMEWORK_FACTS_KEY || key === TRUNCATION_MARKER) {
          continue;
        }
        const value = current[key];
        if (value !== null && typeof value === "object") {
          stack.push(value);
        }
      }
    }
  }
  return enriched;
}

/**
 * Attach additive top-level provenance keys to a parsed AST (design §2.3, Tier 2 contract).
 *
 * Chosen JSON shape — wrapper object, not sibling keys on the array:
 * `nikic/php-parser --json-dump` emits a top-level JSON *array* of statements. A JSON array cannot
 * carry sibling object keys, so provenance is attached by wrapping that array under an `ast` key in
 * a new object and placing the provenance keys as its siblings. The emitted shape is therefore:
 *
 *   { ast, parser_backend, generator_version, php_version, target_version,
 *     [rel_file_path], [encoding_scrubbed], [truncated_nodes] }
 *
 * The four required keys (`parser_backend`, `generator_version`, `php_version`, `target_version`)
 * are always present; `target_version` is `null` when unset. The optional keys are emitted strictly
 * when their fact holds — `encoding_scrubbed: true` only when a scrub occurred and
 * `truncated_nodes: <count>` only when the count is > 0 — satisfying the additive-contract
 * invariant (invariant 1, Requirements 4.1 / 2.5 / 2.6 / 6.1). chen's Milestone B `Domain` decoder
 * reads the `ast` array via `Domain.fromJson` and treats every provenance key as optional
 * (Requirement 5.5), so an older decoder tolerates a newer wrapper and vice versa. The concrete
 * shape is pinned by the contract snapshot task (tasks 15/24).
 *
 * @param {object} ast the parsed AST (nikic emits a top-level array of statements)
 * @param {object} provenance provenance fields to attach
 * @returns {object} an object carrying the AST plus provenance keys
 */
export function attachProvenance(ast, provenance) {
  const out = {
    ast,
    parser_backend: provenance.parser_backend,
    generator_version: provenance.generator_version,
    php_version: provenance.php_version,
    target_version: provenance.target_version ?? null
  };
  if (provenance.rel_file_path !== undefined) {
    out.rel_file_path = provenance.rel_file_path;
  }
  // Additive-only: emit optional keys strictly when the fact holds.
  if (provenance.encoding_scrubbed) {
    out.encoding_scrubbed = true;
  }
  if (
    provenance.truncated_nodes !== undefined &&
    provenance.truncated_nodes > 0
  ) {
    out.truncated_nodes = provenance.truncated_nodes;
  }
  return out;
}

/**
 * Build a diagnostic record for a file that failed to parse (design §2.3, §2.4). The record's
 * `parse_error` captures the parser's message, a best-effort line/column extracted from that
 * message, and a short machine-readable reason.
 *
 * @param {string} file absolute path of the failed file
 * @param {string} stderr the parser's stderr output (may be empty)
 * @param {string} [relFilePath] path relative to the run input
 * @returns {{ file_path: string, rel_file_path: string, parse_error: { message: string, line: number, column: number, reason: string } }}
 */
export function buildDiagnostic(file, stderr, relFilePath) {
  const message = (stderr || "").trim() || "Failed to parse PHP file";
  // nikic emits "... on line N" for syntax errors; extract it when present.
  const lineMatch = message.match(/on line (\d+)/i);
  const colMatch = message.match(/column (\d+)/i);
  return {
    file_path: file,
    rel_file_path: relFilePath ?? basename(file),
    parse_error: {
      message,
      line: lineMatch ? Number.parseInt(lineMatch[1], 10) : 0,
      column: colMatch ? Number.parseInt(colMatch[1], 10) : 0,
      reason: "parse-error"
    }
  };
}

/**
 * File name of the per-run manifest side-record (design §2.4). Always written on a batch run.
 * MUST end in `.jsonl` — chen reads every `*.json` under the output dir as an AST, so a side-record
 * named `*.json` would corrupt the consumer (non-negotiable invariant 2).
 */
export const MANIFEST_FILENAME = "phpastgen_manifest.jsonl";

/**
 * File name of the per-run diagnostics side-record (design §2.4). Written only when at least one
 * file failed to parse; removed on a clean (zero-failure) run so stale diagnostics never linger
 * (Requirement 2.7). MUST end in `.jsonl` for the same reason as the manifest.
 */
export const DIAGNOSTICS_FILENAME = "phpastgen_diagnostics.jsonl";

/**
 * The ordered set of manifest fields (design §2.4, authoritative). The manifest is a single JSONL
 * line containing exactly these keys.
 */
const MANIFEST_FIELDS = [
  "input",
  "output",
  "php_version",
  "parser_backend",
  "generator_version",
  "generated_at",
  "target_version",
  "files_parsed",
  "files_failed",
  "files_skipped_nonphp",
  "files_excluded",
  "truncated_files",
  "threads",
  "max_depth"
];

/**
 * Guard against ever naming a side-record `*.json`: chen treats every `*.json` under the output dir
 * as an AST, so a side-record with that extension would be mis-consumed (invariant 2). The naming
 * rule is `.jsonl`, never `.json` (design §2.4).
 *
 * @param {string} fileName the side-record file name
 * @throws {Error} when the name does not end in `.jsonl`
 */
function assertJsonlName(fileName) {
  if (!fileName.endsWith(".jsonl")) {
    throw new Error(
      `Side-record '${fileName}' must end in '.jsonl', never '.json' (design §2.4).`
    );
  }
}

/**
 * Write the per-run manifest side-record as a single JSONL line under the output directory
 * (design §2.4). The manifest is emitted on every batch run and contains exactly the authoritative
 * field set in the documented order; missing numeric fields default to 0 and `target_version`
 * defaults to null so the line is always complete. A `generated_at` timestamp is filled in when the
 * caller does not supply one.
 *
 * The file is named {@link MANIFEST_FILENAME} (`phpastgen_manifest.jsonl`); a `.json` name is
 * rejected so the manifest is never mistaken for an AST (invariant 2).
 *
 * @param {string} outputDir directory the manifest is written under
 * @param {object} entries manifest field values (see design §2.4)
 * @returns {string} the absolute path of the written manifest
 */
export function writeManifest(outputDir, entries = {}) {
  assertJsonlName(MANIFEST_FILENAME);
  const record = {};
  for (const field of MANIFEST_FIELDS) {
    if (field === "target_version") {
      record[field] = entries[field] ?? null;
    } else if (field === "generated_at") {
      record[field] = entries[field] ?? new Date().toISOString();
    } else if (field === "php_version") {
      // A-L1: `null` here is deliberately ambiguous-looking but is only reachable in ONE way.
      // "PHP absent" cannot reach a batch run: `main` returns early on `detectPhp()` before
      // `runBatch` is ever called, so by construction the runtime exists whenever a manifest is
      // written. A null therefore means "runtime present, but its version string could not be
      // extracted" (`php -r 'echo PHP_VERSION;'` failed or printed nothing). The distinction is
      // recorded here rather than in the record itself on purpose: the manifest key set is a pinned
      // contract (test-fixtures/phpastgen-contract-snapshot.js, design Decision 4), so adding a
      // discriminator key would be a non-additive contract change. Emit `null` and keep the shape.
      record[field] = entries[field] ?? null;
    } else if (
      field === "input" ||
      field === "output" ||
      field === "parser_backend" ||
      field === "generator_version"
    ) {
      record[field] = entries[field] ?? null;
    } else {
      // Numeric count/config fields default to 0 when absent.
      record[field] = entries[field] ?? 0;
    }
  }
  const path = join(outputDir, MANIFEST_FILENAME);
  writeFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
  return path;
}

/**
 * Write the per-run diagnostics side-record under the output directory (design §2.4), one JSONL
 * line per failed file. Each line carries `file_path`, `rel_file_path`, and the `parse_error`
 * object as produced by {@link buildDiagnostic}.
 *
 * When there were zero failures (empty or missing `diagnostics`), no diagnostics file is written
 * and any pre-existing diagnostics file from an earlier run is removed so stale diagnostics never
 * linger (Requirement 2.7). The file is named {@link DIAGNOSTICS_FILENAME}; a `.json` name is
 * rejected (invariant 2).
 *
 * @param {string} outputDir directory the diagnostics record is written under
 * @param {object[]} diagnostics one diagnostic object per failed file
 * @returns {string | null} the absolute path written, or null on a clean run
 */
export function writeDiagnostics(outputDir, diagnostics = []) {
  assertJsonlName(DIAGNOSTICS_FILENAME);
  const path = join(outputDir, DIAGNOSTICS_FILENAME);

  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    // Clean run: remove any stale diagnostics file so it does not linger (Requirement 2.7).
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch {
        // ignore removal failure; a stale file is preferable to aborting a successful run
      }
    }
    return null;
  }

  const lines = diagnostics.map((d) => JSON.stringify(d)).join("\n");
  writeFileSync(path, `${lines}\n`, "utf-8");
  return path;
}

/**
 * The JSON nesting limit `JSON.stringify` must tolerate is unbounded in Node (it has no depth
 * limit), but chen and other consumers cap nesting. Derive a serializer nesting budget from the
 * depth cap plus headroom for the provenance wrapper so any surviving (already-truncated) tree
 * serializes (design §2.3.2 postcondition).
 *
 * @param {number} maxDepth
 * @returns {number}
 */
export function serializerNestingLimit(maxDepth) {
  return maxDepth + 8;
}

/**
 * Extract the JSON payload from `php-parse --json-dump` stdout. The binary may print a leading
 * banner before the JSON array, so lines are dropped until the first line that begins the JSON
 * document (`[` for the statement array, or `{` defensively).
 *
 * @param {string} stdout
 * @returns {string} the JSON text (empty when no JSON was found)
 */
export function extractJsonPayload(stdout) {
  const text = stdout || "";
  const startArr = text.indexOf("[");
  const startObj = text.indexOf("{");
  let start = -1;
  if (startArr === -1) {
    start = startObj;
  } else if (startObj === -1) {
    start = startArr;
  } else {
    start = Math.min(startArr, startObj);
  }
  if (start === -1) {
    return "";
  }
  return text.slice(start).trim();
}

/**
 * Cap on the bytes of parser output buffered per stream. Mirrors the `maxBuffer: 256MB` intent of
 * the previous `spawnSync` call: a runaway parser must not grow the Node heap without bound. With
 * the async `spawn` path the chunks are accumulated here, so the cap is enforced explicitly — once
 * exceeded the child is killed and the file yields a diagnostic instead of an AST.
 */
export const MAX_PARSER_OUTPUT_BYTES = 1024 * 1024 * 256;

/**
 * Run a command asynchronously and capture its output, resolving (never rejecting) with the same
 * shape the previous `spawnSync` call produced: `{ status, stdout, stderr, error }`.
 *
 * This is the piece that makes `--threads` real (design §2.1): `spawnSync` blocks the single Node
 * thread for the whole parse, so a pool of awaited `spawnSync` calls still runs strictly one file
 * at a time. `spawn` returns immediately and the parse completes on the event loop, so N pool
 * runners genuinely hold N concurrent `php php-parse` children.
 *
 * Failure handling mirrors `spawnSync` so callers need no new branches:
 *  - a spawn failure (e.g. PHP not on the PATH) resolves with `error` set,
 *  - a timeout (`ATOM_TIMEOUT`/`ASTGEN_TIMEOUT`) kills the child and resolves with `error` set,
 *  - output exceeding {@link MAX_PARSER_OUTPUT_BYTES} on either stream kills the child and resolves
 *    with `error` set, so unbounded output can never exhaust memory.
 *
 * @param {string} command executable to run
 * @param {string[]} args argv array (never a shell string: no injection surface)
 * @param {{ timeout?: number, maxBuffer?: number }} [options]
 * @returns {Promise<{ status: (number|null), stdout: string, stderr: string, error?: Error }>}
 */
export function spawnCapture(command, args, options = {}) {
  const timeout = options.timeout;
  const maxBuffer = options.maxBuffer ?? MAX_PARSER_OUTPUT_BYTES;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ status: null, stdout: "", stderr: "", error: err });
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let error;
    let timer;

    const kill = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // the child may already be gone
      }
    };

    const finish = (status) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        error
      });
    };

    if (timeout !== undefined && timeout > 0) {
      timer = setTimeout(() => {
        error = error ?? new Error(`php-parse timed out after ${timeout}ms`);
        kill();
      }, timeout);
      // Do not hold the event loop open on the timer alone.
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    }

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        // Same intent as spawnSync's maxBuffer guard: stop buffering and kill the child rather
        // than growing without bound. Drop the chunk so the retained bytes stay under the cap.
        error =
          error ??
          new Error(
            `php-parse stdout exceeded the ${maxBuffer} byte buffer limit`
          );
        kill();
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        error =
          error ??
          new Error(
            `php-parse stderr exceeded the ${maxBuffer} byte buffer limit`
          );
        kill();
        return;
      }
      stderrChunks.push(chunk);
    });

    // A pipe can error (e.g. EPIPE/EIO after the child is killed for a timeout or buffer overrun).
    // An unhandled 'error' event on a stream is an uncaught exception, which would abort the whole
    // batch over one file — exactly what per-file failure isolation forbids (Requirement 2.4).
    // Record it and force settlement; the recorded error becomes this file's diagnostic.
    const onStreamError = (err) => {
      error = error ?? err;
      kill();
      finish(null);
    };
    child.stdout.on("error", onStreamError);
    child.stderr.on("error", onStreamError);

    child.on("error", (err) => {
      error = error ?? err;
      finish(null);
    });

    child.on("close", (code) => {
      finish(code);
    });
  });
}

/**
 * Parse a single PHP file (design §2.3). Reads and decodes/scrubs the bytes, spawns the vendored
 * `php-parse` with recovery flags (adding `--target-php-version` when a target grammar is pinned),
 * parses the emitted JSON, truncates descendants below the depth cap, and attaches additive
 * provenance. On failure it returns a diagnostic instead of throwing so a bad file never aborts a
 * batch run (Requirement 2.4).
 *
 * **Async**: the parse subprocess is spawned non-blocking (see {@link spawnCapture}) so
 * `runInPool` can hold `--threads` parses in flight at once. This function therefore returns a
 * Promise; callers must await it. Everything else — argv, temp-file staging of the scrubbed text,
 * JSON payload extraction, truncation → framework-facts enrichment → provenance ordering, the
 * diagnostics emitted on failure, and the `{ok, ast, truncated, scrubbed}` result shape — is
 * unchanged.
 *
 * Provenance values that are invariant for a whole run (`php_version`, `parser_backend`) are taken
 * from `opts.phpVersion`/`opts.parserBackend` when the caller resolved them once (`runBatch` does),
 * and computed here otherwise so a direct caller still gets complete provenance.
 *
 * @param {string} file absolute path of the PHP file to parse
 * @param {object} opts parsed CLI options (input, output, targetVersion, maxDepth, phpVersion, parserBackend)
 * @returns {Promise<{ ok: boolean, ast?: object, truncated?: boolean, scrubbed?: boolean, diagnostic?: object }>}
 */
export async function parseOneFile(file, opts = {}) {
  const inputRoot = opts.input ?? dirname(file);
  const relFilePath = relative(inputRoot, file) || basename(file);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    return {
      ok: false,
      diagnostic: buildDiagnostic(file, `Unable to read file: ${err.message}`, relFilePath)
    };
  }

  const { text, scrubbed } = decodeAndScrub(bytes);

  // The parser reads from a file path, so write the (possibly scrubbed) text to a temp file. Using
  // a temp file keeps the on-disk source intact and lets scrubbing take effect for the parser.
  let tempDir;
  let tempFile;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "phpastgen-"));
    tempFile = join(tempDir, basename(file) || "source.php");
    writeFileSync(tempFile, text, "utf-8");
  } catch (err) {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
    return {
      ok: false,
      diagnostic: buildDiagnostic(file, `Unable to stage file: ${err.message}`, relFilePath)
    };
  }

  const args = ["--with-recovery", "--resolve-names", "-P", "--json-dump"];
  if (opts.targetVersion) {
    // The vendored php-parse binary pins the target grammar via `--version=VERSION` (design §2.3
    // names this `--target-php-version`; the binary's actual flag is `--version`). Token emulation
    // then parses the requested grammar regardless of the installed runtime (Requirement 1.2).
    args.push(`--version=${opts.targetVersion}`);
  }
  args.push(tempFile);

  let out;
  try {
    out = await spawnCapture(
      process.env.PHP_CMD || "php",
      [resolvePhpParseBin(), ...args],
      {
        timeout: spawnTimeout(),
        maxBuffer: MAX_PARSER_OUTPUT_BYTES
      }
    );
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  if (out.error) {
    return {
      ok: false,
      diagnostic: buildDiagnostic(file, out.error.message, relFilePath)
    };
  }

  const payload = extractJsonPayload(out.stdout);
  if (payload === "") {
    return {
      ok: false,
      diagnostic: buildDiagnostic(file, out.stderr, relFilePath)
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    return {
      ok: false,
      diagnostic: buildDiagnostic(
        file,
        `${out.stderr || ""}\nInvalid JSON from parser: ${err.message}`.trim(),
        relFilePath
      )
    };
  }

  const truncatedCount = truncateDeep(parsed, maxDepth);

  // Enrich surviving nodes with additive syntactic framework facts (attribute groups, superglobal
  // references) before wrapping in provenance. Runs after truncation so cut subtrees are never
  // re-walked, and leaves every pre-existing node field unchanged (design Decision 3, §2.7,
  // Requirement 6.1).
  enrichFrameworkFacts(parsed);

  // Both provenance values below are invariant for a whole run, so a batch resolves them ONCE and
  // threads them through opts (design §2.1; avoids a `php -r` subprocess and a composer file read
  // per file). A direct caller that did not pre-resolve them still gets identical values, computed
  // here. `!== undefined` rather than `??` so a deliberately-null php_version is preserved instead
  // of triggering a per-file re-detect.
  const phpVersion =
    opts.phpVersion !== undefined ? opts.phpVersion : detectedPhpVersion();
  const parserBackend =
    opts.parserBackend !== undefined
      ? opts.parserBackend
      : `nikic/php-parser@${vendoredParserVersion()}`;

  const ast = attachProvenance(parsed, {
    parser_backend: parserBackend,
    generator_version: GENERATOR_VERSION,
    php_version: phpVersion,
    target_version: opts.targetVersion ?? null,
    rel_file_path: relFilePath,
    encoding_scrubbed: scrubbed || undefined,
    truncated_nodes: truncatedCount > 0 ? truncatedCount : undefined
  });

  return {
    ok: true,
    ast,
    truncated: truncatedCount > 0,
    scrubbed
  };
}

/**
 * Compute the output path for a parsed file's AST JSON, mirroring the input-relative directory
 * layout under the output directory (design §2.3 batch mode). The written file is always a
 * `*.json` (invariant 2: only AST files are `*.json`; side-records are `*.jsonl`).
 *
 * The relative layout is preserved by appending `.json` to the file's path relative to the input
 * root, so `<input>/src/a.php` becomes `<output>/src/a.php.json`. For a single-file input the
 * basename is used so the file lands directly under the output directory.
 *
 * @param {string} outputDir the batch output directory
 * @param {string} inputRoot the run input path (file or directory)
 * @param {string} file the absolute path of the parsed file
 * @returns {string} the absolute AST JSON path
 */
export function astFilePath(outputDir, inputRoot, file) {
  let rel = relative(inputRoot, file);
  // A single-file input yields an empty relative path; use the basename instead so the AST lands
  // directly under the output dir rather than at the output dir itself.
  if (rel === "" || rel.startsWith("..")) {
    rel = basename(file);
  }
  return join(outputDir, `${rel}.json`);
}

/**
 * Drive `worker` over `items` with at most `limit` invocations outstanding at once — a bounded
 * concurrency pool (design §2.1 threading note).
 *
 * Concurrency approach: `limit` runners are started, each pulling the next item from a shared
 * cursor and awaiting it before taking another. Because `parseOneFile` now spawns `php-parse`
 * non-blocking (see {@link spawnCapture}), the awaits overlap and up to `limit` `php php-parse`
 * children are genuinely resident at once — never more, so `--threads` is a real upper bound on
 * concurrent subprocesses rather than a bound on outstanding bookkeeping. A worker that blocks the
 * thread (e.g. `spawnSync`) would collapse this back to serial execution, which is why the parse
 * path must stay async. Long-running work is bounded by `ATOM_TIMEOUT` inside `parseOneFile`.
 *
 * @template T
 * @param {T[]} items work items to process in order
 * @param {number} limit maximum outstanding invocations (>= 1)
 * @param {(item: T, index: number) => (void | Promise<void>)} worker per-item callback
 * @returns {Promise<void>} resolves once every item has been processed
 */
export async function runInPool(items, limit, worker) {
  const total = items.length;
  const poolSize = Math.max(1, Math.min(limit || 1, total || 1));
  let cursor = 0;

  const runOne = async () => {
    while (true) {
      const index = cursor;
      if (index >= total) {
        return;
      }
      cursor += 1;
      await worker(items[index], index);
    }
  };

  const runners = [];
  for (let i = 0; i < poolSize; i++) {
    runners.push(runOne());
  }
  await Promise.all(runners);
}

/**
 * Batch-mode orchestration (design §2.1 batch mode, §2.3/§2.4).
 *
 * Steps:
 *  1. Create the output directory (default `.ast`) if missing.
 *  2. Discover included/excluded/non-PHP files under the input.
 *  3. Parse the included files through a bounded worker pool (size `opts.threads`), writing exactly
 *     one `*.json` AST per successfully parsed file under the output directory, mirroring the
 *     input-relative directory layout. A file that fails parsing yields a diagnostic and never
 *     aborts the run (per-file failure isolation, Requirement 2.4).
 *  4. Always write the manifest side-record; write the diagnostics side-record only when failures
 *     occurred and remove any stale diagnostics file on a clean run (Requirement 2.7).
 *  5. Return a non-zero exit only under `--fail-on-error` when failures occurred; 0 otherwise.
 *
 * Loop invariant: `parsed + failed == number of included files processed so far`.
 *
 * `runInPool` is async, so this function returns a Promise resolving to the exit code. `main`
 * awaits it (or, when called synchronously, the returned Promise settles the process exit code).
 *
 * @param {object} opts parsed CLI options (input, output, exclude, threads, maxDepth, targetVersion, failOnError)
 * @returns {Promise<number>} process exit code
 */
export async function runBatch(opts) {
  const inputRoot = opts.input;
  const outputDir = opts.output ?? DEFAULT_OUTPUT;

  // 1. Ensure the output directory exists.
  mkdirSync(outputDir, { recursive: true });

  // 2. Discover files. The exclude option is a source string; compile it once here.
  const excludeRegex = new RegExp(opts.exclude ?? DEFAULT_EXCLUDE);
  const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
    inputRoot,
    excludeRegex
  );

  const counters = {
    parsed: 0,
    failed: 0,
    truncatedFiles: 0
  };
  const diagnostics = [];

  // Resolve the run-invariant provenance values ONCE (A-M1): `detectedPhpVersion()` shells out to
  // `php -r` and `vendoredParserVersion()` reads + regexes a composer file, and neither can change
  // during a run. They are threaded through `opts` to `parseOneFile` (the same way `targetVersion`
  // and `maxDepth` already are) and reused for the manifest below, so a 10k-file tree pays for them
  // once instead of 10k times. The emitted values are byte-identical to computing them per file.
  const phpVersion = opts.phpVersion ?? detectedPhpVersion();
  const parserBackend =
    opts.parserBackend ?? `nikic/php-parser@${vendoredParserVersion()}`;
  const runOpts = { ...opts, phpVersion, parserBackend };

  // 3. Parse through a bounded pool, writing one *.json AST per parsed file with per-file failure
  // isolation (Requirement 2.4). The loop invariant parsed + failed == processed holds because
  // every processed item lands in exactly one of the two branches below.
  await runInPool(included, opts.threads ?? DEFAULT_THREADS, async (file) => {
    let result;
    try {
      result = await parseOneFile(file, runOpts);
    } catch (err) {
      // Defensive: parseOneFile is designed not to throw, but an unexpected throw must still be
      // isolated to this file so it never aborts the batch.
      const relFilePath = relative(inputRoot, file) || basename(file);
      diagnostics.push(
        buildDiagnostic(file, `Unexpected parse failure: ${err.message}`, relFilePath)
      );
      counters.failed += 1;
      return;
    }

    if (result.ok) {
      const astPath = astFilePath(outputDir, inputRoot, file);
      try {
        mkdirSync(dirname(astPath), { recursive: true });
        writeFileSync(astPath, JSON.stringify(result.ast), "utf-8");
        counters.parsed += 1;
        if (result.truncated) {
          counters.truncatedFiles += 1;
        }
      } catch (err) {
        // A write failure is treated as a per-file failure so the run continues.
        const relFilePath = relative(inputRoot, file) || basename(file);
        diagnostics.push(
          buildDiagnostic(file, `Unable to write AST: ${err.message}`, relFilePath)
        );
        counters.failed += 1;
      }
    } else {
      diagnostics.push(result.diagnostic);
      counters.failed += 1;
    }
  });

  // 4. Write side-records. Manifest is always written; diagnostics only when failures occurred
  // (writeDiagnostics removes any stale file on a clean run — Requirement 2.7).
  // The manifest reuses the once-resolved values above rather than re-detecting (A-M1). A null
  // `php_version` here means the runtime was present but its version string could not be read —
  // "PHP absent" cannot reach this point, since `main` gates on `detectPhp()` first (see
  // writeManifest's note on that distinction).
  writeManifest(outputDir, {
    input: inputRoot,
    output: outputDir,
    php_version: phpVersion ?? null,
    parser_backend: parserBackend,
    generator_version: GENERATOR_VERSION,
    target_version: opts.targetVersion ?? null,
    files_parsed: counters.parsed,
    files_failed: counters.failed,
    files_skipped_nonphp: skippedNonPhpCount,
    files_excluded: excludedCount,
    truncated_files: counters.truncatedFiles,
    threads: opts.threads ?? DEFAULT_THREADS,
    max_depth: opts.maxDepth ?? DEFAULT_MAX_DEPTH
  });
  writeDiagnostics(outputDir, diagnostics);

  // 5. Exit code: non-zero only under --fail-on-error with failures.
  if (opts.failOnError && counters.failed > 0) {
    return 1;
  }
  return 0;
}

/**
 * Legacy single-file passthrough. Implemented by task 2.2; a working forward is provided here so
 * dispatch keeps the pre-upgrade behavior.
 *
 * @param {string[]} argv the original arguments to forward to php-parse
 */
export function runLegacyPassthrough(argv) {
  const cwd = process.env.ATOM_CWD || process.cwd();
  // Prepend the php-parse bin so the spawned command is `php <php-parse-bin> <all original flags>`.
  // Using splice(0, 1, bin) would drop the first forwarded flag (e.g. --with-recovery); prepend
  // instead so every flag chen forwards is preserved.
  const forwarded = [resolvePhpParseBin(), ...argv];
  spawnSync(process.env.PHP_CMD || "php", forwarded, {
    encoding: "utf-8",
    cwd,
    stdio: "inherit",
    stderr: "inherit",
    env: process.env,
    timeout: spawnTimeout()
  });
  return 0;
}

/**
 * Top-level dispatch (design §2.1).
 *  - If PHP is missing, warn and return a non-success result.
 *  - Handle `--version`, `--parser-info`, `--help`.
 *  - Reject an unsupported `--target-version`, emitting no AST and returning non-zero.
 *  - Dispatch to batch mode when `-i/--input` is present, else legacy passthrough.
 *
 * `runBatch` is async, so `main` is async too and resolves to the batch exit code; the synchronous
 * paths (`--version`, `--parser-info`, `--help`, missing PHP, invalid target, legacy passthrough)
 * resolve immediately.
 *
 * @param {string[]} argv arguments sliced past node + script
 * @returns {Promise<number | boolean>} exit code, or false when PHP is unavailable
 */
export async function main(argv) {
  const opts = parseArgs(argv);

  // `--version` prints exactly the string `--parser-info` reports and exits 0. This is checked
  // before the PHP presence gate so version reporting works without a PHP runtime.
  if (opts.showVersion) {
    console.log(GENERATOR_VERSION);
    return 0;
  }

  // `--parser-info` reports capability (and, when PHP is missing, says so and exits non-zero).
  if (opts.parserInfo) {
    return printParserInfo();
  }

  if (opts.help) {
    printUsage();
    return 0;
  }

  if (!detectPhp()) {
    console.warn("PHP is not installed!");
    return false;
  }

  // Reject an unsupported target grammar before doing any work: emit no AST, exit non-zero.
  if (opts.invalidTargetVersion !== undefined) {
    console.error(
      `Unsupported --target-version '${opts.invalidTargetVersion}'. Supported grammars: ${SUPPORTED_TARGET_VERSIONS.join(", ")}.`
    );
    return 1;
  }

  if (opts.input !== undefined) {
    return runBatch(opts);
  }
  return runLegacyPassthrough(argv);
}

// Only run when invoked directly (not when imported by tests).
//
// A plain `fileURLToPath(url) === process.argv[1]` comparison breaks under a global symlink
// install: the bin on PATH (e.g. /opt/homebrew/bin/phpastgen) is a symlink, so process.argv[1] is
// the symlink path while fileURLToPath(url) is the real file path, and the equality is false — so
// main() never runs. Resolve symlinks on BOTH sides (realpathSync) before comparing so a symlinked
// invocation is still recognized as the entry point, while an `import(...)` of this module (where
// argv[1] points at the test runner) does not trigger main().
export function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const invoked = realpathSync(process.argv[1]);
    const self = realpathSync(fileURLToPath(url));
    return invoked === self;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  Promise.resolve(main(process.argv.slice(2)))
    .then((rc) => {
      if (typeof rc === "number") {
        process.exitCode = rc;
      } else if (rc === false) {
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error(err?.stack || String(err));
      process.exitCode = 1;
    });
}
