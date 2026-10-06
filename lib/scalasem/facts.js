// Assembles the per file report entries: the schema v2 facts plus the version 1 keys that
// older consumers read (`sourceFile`, `usedTypes`, `tags`, `literals`).
import { quotableLiteral, sanitizeUrl } from "./util.js";

const TYPE_EXCLUDE_PREFIXES = ["scala.", "java.lang.", "java.io.", "java.util.", "java."];

/**
 * Build the report entry of one source file.
 *
 * @param {Object} raw Collected facts of the file: `{ definitions, calls, references, constants }`
 * @param {Object} module Module the file belongs to
 * @param {string} file Project relative source path
 * @param {Object} opts `{ caps }`
 * @returns {Object} Report entry with version 1 and version 2 keys
 */
export function buildFileEntry(raw, module, file, opts = {}) {
  const caps = opts.caps || {};
  const calls = dedupeCalls(raw.calls || []);
  const references = dedupeReferences(raw.references || []);
  const constants = (raw.constants || [])
    .slice()
    .sort((a, b) => a.line - b.line || String(a.sym).localeCompare(String(b.sym)));
  const definitions = (raw.definitions || [])
    .slice()
    .sort((a, b) => a.line - b.line || String(a.name).localeCompare(String(b.name)));
  const usedTypes = collectUsedTypes(references);
  const literals = collectLiterals(calls, constants, caps.literals ?? 100);
  const truncated =
    calls.length > (caps.calls ?? 2000) ||
    references.length > (caps.references ?? 2000) ||
    definitions.length > (caps.definitions ?? 2000);
  const entry = {
    sourceFile: file,
    tags: collectTags(usedTypes, file),
    usedTypes,
    literals,
    module: module?.id,
    platform: module?.platform || "jvm",
    scope: scopeOf(file, module),
    definitions: definitions.slice(0, caps.definitions ?? 2000).map(definitionId),
    calls: calls.slice(0, caps.calls ?? 2000).map(callId),
    references: references.slice(0, caps.references ?? 2000)
  };
  if (constants.length) {
    entry.constants = constants;
  }
  if (truncated) {
    entry.truncated = true;
  }
  return entry;
}

/** Class, trait, object and method names with their flags. */
function definitionKindOf(definition) {
  return definition.kind || "def";
}

function definitionId(definition) {
  return {
    id: `${definition.line}:${definition.column}:${definition.name}`,
    kind: definitionKindOf(definition),
    name: definition.name,
    owner: definition.owner,
    line: definition.line,
    endLine: definition.endLine,
    ...(definition.flags ? { flags: definition.flags } : {}),
    ...(definition.parents ? { parents: definition.parents } : {}),
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    ...(definition.signature ? { signature: definition.signature } : {})
  };
}

function callId(call) {
  return {
    line: call.line,
    column: call.column,
    caller: call.caller,
    owner: call.owner,
    name: call.name,
    ...(call.signature ? { signature: call.signature } : {}),
    ...(call.args ? { args: call.args } : {})
  };
}

function dedupeCalls(calls) {
  const seen = new Set();
  const result = [];
  for (const call of calls) {
    const key = `${call.line}:${call.column}:${call.owner}:${call.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (call.args) {
      call.args = call.args.map((arg) =>
        arg.string ? { string: sanitizeUrl(arg.string) } : arg
      );
    }
    result.push(call);
  }
  return result.sort((a, b) => a.line - b.line || a.column - b.column);
}

function dedupeReferences(references) {
  const seen = new Set();
  const result = [];
  for (const reference of references) {
    const key = `${reference.line}:${reference.symbol}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(reference);
  }
  return result.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** The type names the file uses, the version 1 key derived from the version 2 references. */
function collectUsedTypes(references) {
  const types = new Set();
  for (const reference of references) {
    if (reference.kind !== "type" && reference.kind !== "import") {
      continue;
    }
    const symbol = String(reference.symbol || "").split("#")[0].replace(/\.$/, "");
    if (!symbol || !symbol.includes(".")) {
      continue;
    }
    if (TYPE_EXCLUDE_PREFIXES.some((prefix) => symbol.startsWith(prefix))) {
      continue;
    }
    if (symbol.startsWith("javax.inject.")) {
      continue;
    }
    types.add(symbol);
  }
  return [...types].sort();
}

/** Framework tags, kept compatible with the version 1 heuristics. */
function collectTags(usedTypes, file) {
  const tags = new Set();
  for (const t of usedTypes) {
    if (t.startsWith("play.api.")) {
      tags.add("framework");
    }
    if (
      t.startsWith("play.api.data.Form") ||
      t.startsWith("play.api.mvc.Request") ||
      t.startsWith("play.twirl.api")
    ) {
      tags.add("framework-input");
    }
    if (
      t.startsWith("play.twirl.api.Html") ||
      t.startsWith("play.api.mvc.Result") ||
      t.startsWith("play.api.mvc.Action")
    ) {
      tags.add("framework-output");
    }
    if (
      t.startsWith("play.api.routing.") ||
      t.startsWith("play.core.routing") ||
      t.startsWith("router.RoutesPrefix")
    ) {
      tags.add("framework-route");
    }
    if (t.startsWith("slick.sql.") || t.startsWith("play.db.") || t.startsWith("slick.jdbc.")) {
      tags.add("database");
    }
  }
  if (file.includes("target/") || file.includes("target\\")) {
    tags.add("generated");
  }
  return [...tags].sort();
}

/**
 * String literals the report may quote: identifiers, algorithm spellings, route paths and
 * sanitized URLs. Everything else, secrets included, is dropped.
 */
function collectLiterals(calls, constants, cap) {
  const literals = new Set();
  for (const call of calls) {
    for (const arg of call.args || []) {
      if (arg.string && quotableLiteral(arg.string)) {
        literals.add(sanitizeUrl(arg.string));
      }
    }
  }
  for (const constant of constants) {
    if (constant.tpe === "string" && quotableLiteral(constant.value)) {
      literals.add(sanitizeUrl(constant.value));
    }
  }
  return [...literals].sort().slice(0, cap);
}

function scopeOf(file, module) {
  if (module?.scope === "test" || file.includes("/test/") || file.startsWith("test/")) {
    return "test";
  }
  if (file.includes("target/") || file.includes("target\\")) {
    return "generated";
  }
  return "main";
}
