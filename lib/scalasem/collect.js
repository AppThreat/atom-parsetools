// Reads the facts of every module of a build and merges them per source file.
import { inspectModule } from "./inspect.js";

const PLATFORM_ORDER = ["jvm", "js", "native"];

// Facts that are the same fact when they come from two compilations of one source.
const FACT_KEYS = {
  definitions: (d) =>
    `${d.kind}:${d.owner}.${d.name}:${d.line}:${d.column}:${d.signature || ""}`,
  calls: (c) =>
    `${c.line}:${c.column}:${c.owner}.${c.name}:${c.byName ?? ""}:${JSON.stringify(c.args || [])}`,
  patterns: (p) =>
    `${p.line}:${p.column}:${p.owner}.${p.name}:${JSON.stringify(p.args || [])}`,
  references: (r) => `${r.line}:${r.column}:${r.symbol}:${r.refKind || ""}`,
  constants: (c) => `${c.sym}:${c.line}`
};

/**
 * Inspect every module and merge the facts of each source file. A source compiled into
 * several modules, the shared sources of a cross build, keeps every fact once and lists each
 * platform it compiles for; its entry belongs to the JVM module when there is one.
 *
 * @param {string} projectDir Project directory
 * @param {Object[]} modules Module inventory
 * @param {Object} opts Command line options
 * @returns {Object} `{ files, moduleOf, platformsOf, diagnostics, toolchains, factsSources,
 *   modulesWithOutput, tastyFiles, readFiles }`
 */
export function collectFacts(projectDir, modules, opts = {}) {
  const files = new Map();
  const seen = new Map();
  const moduleOf = new Map();
  const platformsOf = new Map();
  const diagnostics = [];
  const toolchains = [];
  const factsSources = new Set();
  const modulesWithOutput = [];
  let tastyFiles = 0;
  let readFiles = 0;
  for (const module of modules) {
    module.projectDir = projectDir;
    const inspected = inspectModule(projectDir, module, opts);
    diagnostics.push(...inspected.diagnostics);
    toolchains.push(...inspected.toolchains);
    tastyFiles += inspected.tastyFiles;
    readFiles += inspected.readFiles;
    if (inspected.factsSource) {
      factsSources.add(inspected.factsSource);
    }
    for (const [file, facts] of inspected.files) {
      mergeFacts(files, seen, file, facts);
      const current = moduleOf.get(file);
      if (!current || platformRank(module) < platformRank(current)) {
        moduleOf.set(file, module);
      }
      if (module.platform) {
        const platforms = platformsOf.get(file) || new Set();
        platforms.add(module.platform);
        platformsOf.set(file, platforms);
      }
    }
    if (inspected.files.size || module.classpath?.length) {
      modulesWithOutput.push(module);
    }
  }
  return {
    files,
    moduleOf,
    platformsOf,
    diagnostics,
    toolchains,
    factsSources,
    modulesWithOutput,
    tastyFiles,
    readFiles
  };
}

function platformRank(module) {
  const rank = PLATFORM_ORDER.indexOf(module.platform || "jvm");
  return rank < 0 ? PLATFORM_ORDER.length : rank;
}

/** Add the facts of one compilation of a source, skipping the facts it already has. */
export function mergeFacts(files, seen, file, facts) {
  let merged = files.get(file);
  let keys = seen.get(file);
  if (!merged) {
    merged = { ...facts };
    keys = {};
    for (const kind of Object.keys(FACT_KEYS)) {
      merged[kind] = [];
      keys[kind] = new Set();
    }
    files.set(file, merged);
    seen.set(file, keys);
  }
  for (const [kind, keyOf] of Object.entries(FACT_KEYS)) {
    for (const fact of facts[kind] || []) {
      const key = keyOf(fact);
      if (!keys[kind].has(key)) {
        keys[kind].add(key);
        merged[kind].push(fact);
      }
    }
  }
}
