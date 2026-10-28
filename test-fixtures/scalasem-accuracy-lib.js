// The parts of the accuracy check that read no project and run no tool: a constant pool
// reader for the classes a compiled module really references, a zip central directory
// reader for the classes a classpath jar carries, the scoring that compares the two against
// what the report names, and the difference against the numbers of an earlier run. The
// accuracy script drives them; the units test pins them.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The classes a class file names in its constant pool: its own and super types included,
 * which is what makes the pool a ground truth of what the module was compiled against.
 * Written against the class file format directly, so no ASM jar is needed to score a run.
 *
 * @param {Buffer} bytes Content of a `.class` file
 * @returns {string[]} Dotted class names, for example `org.objectweb.asm.ClassReader`
 */
export function constantPoolClasses(bytes) {
  const names = [];
  if (bytes.length < 10 || bytes.readUInt32BE(0) !== 0xcafebabe) {
    return names;
  }
  const count = bytes.readUInt16BE(8);
  // The pool is one based, and a long or double takes the slot after its own, so the
  // entries are kept by index and skipped over while reading.
  const pool = new Map();
  let at = 10;
  for (let index = 1; index < count && at + 3 <= bytes.length; index++) {
    const tag = bytes[at];
    at += 1;
    if (tag === 1) {
      const length = bytes.readUInt16BE(at);
      at += 2;
      pool.set(index, bytes.toString("utf-8", at, at + length));
      at += length;
    } else if (tag === 3 || tag === 4) {
      at += 4;
    } else if (tag === 5 || tag === 6) {
      at += 8;
      index++;
    } else if (
      tag === 7 ||
      tag === 8 ||
      tag === 16 ||
      tag === 19 ||
      tag === 20
    ) {
      pool.set(index, bytes.readUInt16BE(at));
      at += 2;
    } else if (
      tag === 9 ||
      tag === 10 ||
      tag === 11 ||
      tag === 12 ||
      tag === 17 ||
      tag === 18
    ) {
      at += 4;
    } else if (tag === 15) {
      at += 3;
    } else {
      // A tag this reader does not know ends the walk; the names so far stay.
      break;
    }
  }
  for (const value of pool.values()) {
    if (typeof value !== "number") {
      continue;
    }
    const name = pool.get(value);
    if (typeof name !== "string") {
      continue;
    }
    // An array type names the element type behind the `[L...;` wrapper; an array of a
    // primitive names no class type.
    const element = /^(\[+)?L([^;]+);?$/.exec(name)?.[2] || name;
    if (element.includes("[")) {
      continue;
    }
    names.push(element.replaceAll("/", "."));
  }
  return names;
}

/**
 * The entry paths of a jar, read from its zip central directory: the class list of the jar
 * without unpacking it.
 *
 * @param {Buffer|string} jar Jar content or path
 * @returns {string[]} Entry paths, for example `org/objectweb/asm/ClassReader.class`
 */
export function zipEntryNames(jar) {
  const bytes = typeof jar === "string" ? readFileSync(jar) : jar;
  // The end record sits in the last bytes, followed only by a comment of at most 64 KiB.
  const from = Math.max(0, bytes.length - 66000);
  let end = -1;
  for (let at = bytes.length - 22; at >= from; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    return [];
  }
  // Every zip field is little endian.
  const entries = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const names = [];
  for (
    let seen = 0;
    seen < entries &&
    at + 46 <= bytes.length &&
    bytes.readUInt32LE(at) === 0x02014b50;
    seen++
  ) {
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    names.push(bytes.toString("utf-8", at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/** `org/objectweb/asm/ClassReader.class` reads as `org.objectweb.asm.ClassReader`. */
export function dottedClassName(entryPath) {
  if (!entryPath.endsWith(".class")) {
    return undefined;
  }
  return entryPath.slice(0, -".class".length).replaceAll("/", ".");
}

/**
 * The name a report fact mentions, in the spelling a class entry carries: the `$` of an
 * object or a closure is part of the implementation class name, and a trailing `$` on a
 * module reference matches both spellings.
 *
 * @param {string} name A type, owner or symbol name from the report
 * @returns {string[]|undefined} Class names that count as naming the class
 */
function nameVariants(name) {
  if (!name || /[^A-Za-z0-9_.$]/.test(name)) {
    return undefined;
  }
  return name.endsWith("$") ? [name, name.slice(0, -1)] : [name];
}

/**
 * Which libraries a module really uses, and which of them the report names.
 *
 * @param {Object[]} jars The module classpath: one entry per jar, with its coordinate and
 *   its zip entry names
 * @param {string[]} referencedClasses The classes the module's own class files name
 * @param {string[]} reportedNames The types, owners and symbols the report mentions for the
 *   module
 * @param {string} [ownGroup] Group of the project's own artifacts, which are upstream
 *   modules rather than libraries and stay out of the scoring
 * @returns {{ used: Object[], misses: Object[], suspects: Object[] }} `used` are the
 *   libraries at least one class file references, `misses` the used ones the report never
 *   names, and `suspects` the ones the report names without a class file reference
 */
export function scoreLibraries(
  jars,
  referencedClasses,
  reportedNames,
  ownGroup
) {
  const referenced = new Set(referencedClasses);
  const reported = new Set(reportedNames.flatMap((n) => nameVariants(n) || []));
  const used = [];
  const misses = [];
  const suspects = [];
  for (const jar of jars) {
    if (ownGroup && jar.group === ownGroup) {
      continue;
    }
    const classes = new Set();
    for (const entry of jar.entries || []) {
      const name = dottedClassName(entry);
      if (
        name &&
        !name.endsWith("package-info") &&
        !name.endsWith("module-info")
      ) {
        classes.add(name);
      }
    }
    let usedByClassFiles = false;
    let namedInReport = false;
    for (const name of classes) {
      if (!usedByClassFiles && referenced.has(name)) {
        usedByClassFiles = true;
      }
      if (!namedInReport && (reported.has(name) || reported.has(`${name}$`))) {
        namedInReport = true;
      }
      if (usedByClassFiles && namedInReport) {
        break;
      }
    }
    const coordinate = {
      group: jar.group,
      artifact: jar.artifact,
      version: jar.version
    };
    if (usedByClassFiles) {
      used.push(coordinate);
      if (!namedInReport) {
        misses.push(coordinate);
      }
    } else if (namedInReport) {
      suspects.push(coordinate);
    }
  }
  return { used, misses, suspects };
}

/**
 * What changed against the numbers of an earlier run. Coverage share, the call site rate and
 * the counts of the report can regress; a diagnostic that appears is a regression, one that
 * disappears is an improvement.
 *
 * @param {Object} current The numbers of this run
 * @param {Object} baseline The numbers of the earlier run
 * @returns {{ fields: Object[], regressions: string[] }}
 */
export function baselineDiff(current, baseline) {
  const fields = [];
  const push = (key, before, after) => {
    if (typeof before !== "number" || typeof after !== "number") {
      return;
    }
    fields.push({ key, before, after, delta: after - before });
  };
  const currentCoverage = current.coverage?.overall || {};
  const baselineCoverage = baseline.coverage?.overall || {};
  push("coverage.files", baselineCoverage.files, currentCoverage.files);
  push(
    "coverage.withFacts",
    baselineCoverage.withFacts,
    currentCoverage.withFacts
  );
  push("coverage.share", baselineCoverage.share, currentCoverage.share);
  const modules = new Map(
    (baseline.coverage?.modules || []).map((m) => [m.id, m])
  );
  for (const module of current.coverage?.modules || []) {
    const before = modules.get(module.id);
    if (before) {
      push(`coverage.${module.id}`, before.share, module.share);
    }
  }
  for (const key of [
    "calls",
    "definitions",
    "callStacks",
    "crypto",
    "endpoints"
  ]) {
    push(key, baseline.counts?.[key], current.counts?.[key]);
  }
  push(
    "callSites.namedShare",
    baseline.callSites?.namedShare,
    current.callSites?.namedShare
  );
  const codes = new Set([
    ...Object.keys(baseline.diagnostics || {}),
    ...Object.keys(current.diagnostics || {})
  ]);
  for (const code of [...codes].sort()) {
    push(
      `diagnostics.${code}`,
      baseline.diagnostics?.[code] || 0,
      current.diagnostics?.[code] || 0
    );
  }
  const regressions = [];
  for (const field of fields) {
    const worse =
      (field.key.startsWith("coverage.") &&
        field.key !== "coverage.files" &&
        field.delta < 0) ||
      (field.key === "callSites.namedShare" && field.delta < 0) ||
      (field.key.startsWith("diagnostics.") && field.delta > 0) ||
      (["calls", "definitions"].includes(field.key) && field.delta < 0);
    if (worse) {
      regressions.push(`${field.key}: ${field.before} -> ${field.after}`);
    }
  }
  if ((current.failures?.length || 0) > (baseline.failures?.length || 0)) {
    regressions.push(
      `failures: ${(baseline.failures || []).length} -> ${(current.failures || []).length}`
    );
  }
  return { fields, regressions };
}

/** The scalasem version of the checkout the accuracy script runs from. */
export function scalasemVersion() {
  return require("../package.json").version;
}
