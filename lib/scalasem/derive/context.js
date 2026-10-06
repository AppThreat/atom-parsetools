// The derivation context: indexes over the facts of every file, and the owner and name
// helpers every evidence kind shares. The API tables live in lib/scalasem/rules/*.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "rules");

const ruleCache = new Map();

export function loadRules(name) {
  if (!ruleCache.has(name)) {
    ruleCache.set(
      name,
      JSON.parse(readFileSync(join(rulesDir, `${name}.json`), "utf-8"))
    );
  }
  return ruleCache.get(name);
}

// The walk stops after this many call or local value boundaries, a user bound: values that
// travel further are not tracked.
export const MAX_BOUNDARIES = 4;

/**
 * Build the derivation context over the raw facts of every file.
 *
 * @param {Map<string, Object>} files File path to raw facts
 * @param {Object} config Parsed project configuration `{ routes, values }`
 * @returns {Object} Context with the indexes the derivations share
 */
export function deriveContext(files, config = {}) {
  const constants = new Map();
  const defsByKey = new Map();
  const defsByLine = new Map();
  const callsByTarget = new Map();
  const callsByCaller = new Map();
  const projectClasses = new Map();
  const valsBySym = new Map();
  const allCalls = [];
  for (const [file, facts] of files) {
    for (const constant of facts.constants || []) {
      constants.set(constant.sym, { ...constant, file });
    }
    for (const def of facts.definitions || []) {
      if (def.name === "<init>" || def.kind === "type") {
        continue;
      }
      defsByKey.set(`${def.owner}.${def.name}`, { ...def, file });
      if (def.kind === "val" && def.sym) {
        valsBySym.set(def.sym, { ...def, file });
      }
      defsByLine.set(`${file}:${def.line}:${def.name}`, { ...def, file });
      if (
        def.kind === "class" ||
        def.kind === "trait" ||
        def.kind === "object"
      ) {
        // A type definition names its full name in its owner and name; the companion object
        // and the module class share the parents.
        for (const key of [
          `${def.owner}.${def.name}`,
          `${def.owner}.${def.name}$`
        ]) {
          const parent = projectClasses.get(key) || { parents: [], file };
          parent.parents.push(...(def.parents || []));
          parent.file = file;
          projectClasses.set(key, parent);
        }
      }
    }
    for (const call of facts.calls || []) {
      const callWithFile = { ...call, file };
      allCalls.push(callWithFile);
      const target = `${call.owner}.${call.name}`;
      if (!callsByTarget.has(target)) {
        callsByTarget.set(target, []);
      }
      callsByTarget.get(target).push(callWithFile);
      const caller = call.caller || "";
      if (!callsByCaller.has(caller)) {
        callsByCaller.set(caller, []);
      }
      callsByCaller.get(caller).push(callWithFile);
    }
  }
  const configValues = new Map();
  // A key set to a literal and overridden by an environment variable keeps the literal,
  // which names the endpoint.
  for (const value of config.values || []) {
    const known = configValues.get(value.key);
    if (!known || known.value.startsWith("env:")) {
      configValues.set(value.key, value);
    }
  }
  return {
    files,
    constants,
    defsByKey,
    defsByLine,
    callsByTarget,
    callsByCaller,
    projectClasses,
    valsBySym,
    allCalls,
    configValues,
    config,
    parameterMemo: new Map()
  };
}

/** The annotation names of a definition, in dot form for both readers. */
export function annotationNamesOf(def) {
  const names = [];
  for (const annotation of def.annotations || []) {
    names.push(annotation.name);
  }
  for (const raw of def.annotationNames || []) {
    names.push(raw.replaceAll("/", ".").replace(/\.$/, ""));
  }
  return names;
}

/** The class root of an owner: `javax.crypto.Cipher$` is `javax.crypto.Cipher`. */
export function classRoot(owner) {
  return String(owner || "")
    .replace(/\$$/, "")
    .replace(/\.\$/, ".");
}

/** Owners match with or without the companion object marker, and nested objects flatten. */
function ownerKey(owner) {
  return String(owner || "")
    .split(/[#$]+|\./)
    .filter(Boolean)
    .join(".");
}

export function ownerMatches(ruleOwner, callOwner) {
  return ownerKey(ruleOwner) === ownerKey(callOwner);
}

export function ownerPrefixMatches(prefix, owner) {
  const left = ownerKey(prefix);
  const right = ownerKey(owner);
  return right === left || right.startsWith(`${left}.`);
}

export function lastSegment(sym) {
  return String(sym || "")
    .split(".")
    .pop();
}

export function ownerOf(sym) {
  const segments = String(sym).split(".");
  return segments.slice(0, -1).join(".");
}

export const skipGenerated = (file) => /(^|\/)(target|out)\//.test(file);

export const HTTP_VERBS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS"
];

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(item);
  }
  return map;
}
