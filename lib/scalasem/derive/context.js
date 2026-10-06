// The derivation context: indexes over the facts of every file, and the owner and name
// helpers every evidence kind shares. The API tables live in lib/scalasem/rules/*.json.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOKEN, codeTokens, tokenize } from "../lexer.js";

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
 * @param {Object} [options] `{ projectDir }`, where the sources are read from
 * @returns {Object} Context with the indexes the derivations share
 */
export function deriveContext(files, config = {}, options = {}) {
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
    parameterMemo: new Map(),
    sourceOf: sourceReader(files, options.projectDir),
    extendsAny: (def, names) => extendsAny(projectClasses, def, names)
  };
}

/**
 * The sources of the project, read on demand: the code tokens of a file with the symbols the
 * facts record at their positions, and the definitions around a token.
 */
function sourceReader(files, projectDir) {
  const sources = new Map();
  return (file) => {
    if (!projectDir || !files.has(file)) {
      return undefined;
    }
    if (!sources.has(file)) {
      let text;
      try {
        text = readFileSync(join(projectDir, file), "utf-8");
      } catch (_err) {
        text = undefined;
      }
      sources.set(
        file,
        text === undefined ? undefined : sourceOf(file, text, files.get(file))
      );
    }
    return sources.get(file);
  };
}

function sourceOf(file, text, facts) {
  const tokens = codeTokens(tokenize(text));
  const symbols = new Map();
  const add = (line, column, symbol) => {
    const key = `${line}:${column}`;
    if (!symbols.has(key)) {
      symbols.set(key, []);
    }
    symbols.get(key).push(symbol);
  };
  const callsAt = new Map();
  const byLine = new Map();
  const addToLine = (line, symbol) => {
    if (!byLine.has(line)) {
      byLine.set(line, []);
    }
    byLine.get(line).push(symbol);
  };
  for (const ref of facts.references || []) {
    if (ref.symbol) {
      add(ref.line - 1, ref.column - 1, ref.symbol);
      addToLine(ref.line - 1, ref.symbol);
    }
  }
  for (const call of facts.calls || []) {
    if (call.owner && call.name) {
      const symbol = `${call.owner}.${call.name}`;
      add(call.line - 1, call.column - 1, symbol);
      addToLine(call.line - 1, symbol);
      const key = `${call.line - 1}:${call.column - 1}`;
      callsAt.set(key, [...(callsAt.get(key) || []), call]);
    }
  }
  // Members of classes, objects and traits; parameters, lambda parameters and local values
  // are not where a route or a call belongs.
  const types = new Set();
  for (const def of facts.definitions || []) {
    if (["class", "trait", "object"].includes(def.kind)) {
      types.add(`${def.owner}.${def.name}`);
      types.add(`${def.owner}.${def.name}$`);
    }
  }
  const scopes = (facts.definitions || [])
    .filter(
      (d) =>
        d.line &&
        d.endLine &&
        (["class", "trait", "object"].includes(d.kind) || types.has(d.owner))
    )
    .sort((a, b) => a.line - b.line || (b.endLine || 0) - (a.endLine || 0));
  const innermost = (index, kinds) => {
    const line = tokens[index].line + 1;
    let best;
    for (const def of scopes) {
      if (def.line > line) {
        break;
      }
      if (def.endLine >= line && kinds.includes(def.kind)) {
        best = def;
      }
    }
    return best;
  };
  return {
    file,
    tokens,
    /**
     * A symbol recorded for token `index` whose last name is the token's: at the token, at
     * the start of its qualifier chain (where a selection is placed), or elsewhere on its
     * line, since a symbol is recorded once per line.
     */
    symbolAt(index, accept) {
      const name = tokens[index].value ?? tokens[index].text;
      const matches = (symbol) =>
        lastSegment(symbol) === name && accept(symbol);
      let k = index;
      const positions = [k];
      while (
        tokens[k - 1]?.type === TOKEN.DOT &&
        tokens[k - 2]?.type === TOKEN.IDENT
      ) {
        k -= 2;
        positions.push(k);
      }
      for (const p of positions) {
        const found = (
          symbols.get(`${tokens[p].line}:${tokens[p].column}`) || []
        ).find(matches);
        if (found) {
          return found;
        }
      }
      return (byLine.get(tokens[index].line) || []).find(matches);
    },
    /** The calls recorded at token `index`, such as the conversion applied to it. */
    callsAt: (index) =>
      callsAt.get(`${tokens[index].line}:${tokens[index].column}`) || [],
    definitionAt: (index) =>
      innermost(index, ["def", "val"]) ||
      innermost(index, ["object", "class", "trait"]),
    classAt: (index) => innermost(index, ["class", "trait", "object"])
  };
}

/** True when a class, or any project class it extends, names one of the given parents. */
function extendsAny(projectClasses, def, names) {
  const seen = new Set();
  const pending = [...(def?.parents || [])];
  while (pending.length) {
    const parent = pending.pop();
    if (seen.has(parent)) {
      continue;
    }
    seen.add(parent);
    if (names.includes(parent)) {
      return true;
    }
    pending.push(...(projectClasses.get(parent)?.parents || []));
  }
  return false;
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
