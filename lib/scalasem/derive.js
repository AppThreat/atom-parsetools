// Evidence derivation: turns the per file facts into crypto findings, endpoints, outbound
// services and data stores, entry points and call stacks. The API tables live in
// lib/scalasem/rules/*.json; everything structural (value propagation, route composition,
// graph search) is code here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { quotableLiteral, sanitizeUrl } from "./util.js";

const rulesDir = join(dirname(fileURLToPath(import.meta.url)), "rules");

const ruleCache = new Map();

function loadRules(name) {
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
      defsByLine.set(`${file}:${def.line}:${def.name}`, { ...def, file });
      if (def.kind === "class" || def.kind === "trait" || def.kind === "object") {
        const parent = projectClasses.get(def.owner) || { parents: [], file };
        parent.parents.push(...(def.parents || []));
        parent.file = file;
        projectClasses.set(def.owner, parent);
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
  for (const value of config.values || []) {
    configValues.set(value.key, value);
  }
  return {
    files,
    constants,
    defsByKey,
    defsByLine,
    callsByTarget,
    callsByCaller,
    projectClasses,
    allCalls,
    configValues,
    config
  };
}

/** The class root of an owner: `javax.crypto.Cipher$` is `javax.crypto.Cipher`. */
function classRoot(owner) {
  return String(owner || "").replace(/\$$/, "").replace(/\.\$/, ".");
}

/** The algorithm family: the first transform segment, upper cased. */
function algorithmFamily(algorithm) {
  return String(algorithm || "").split("/")[0].toUpperCase();
}

/**
 * Resolve the string value of one argument of a call, following parameters to their call
 * sites and local values to their literals within the boundary budget.
 *
 * @param {Object} ctx Derivation context
 * @param {Object} call Call fact carrying `args`
 * @param {number} index Argument position
 * @param {number} [budget] Remaining boundaries
 * @param {Set} [seen] Method and parameter positions already on this walk
 * @returns {{values: Array<{value: string, resolution: string, via: Object[]}>, resolved: boolean}}
 */
export function resolveArgument(ctx, call, index, budget = MAX_BOUNDARIES, seen = new Set()) {
  const arg = (call.args || []).find(
    (a) => a.index === index && !Array.isArray(a.parts) && !a.call
  );
  if (!arg) {
    return { values: [], resolved: false };
  }
  if (typeof arg.string === "string") {
    return {
      values: [{ value: arg.string, resolution: "literal", via: [] }],
      resolved: true
    };
  }
  if (arg.const !== undefined) {
    return constValue(ctx, arg);
  }
  if (arg.param) {
    return followParameter(ctx, call.caller, arg.paramIndex, budget, seen, call);
  }
  if (arg.ident) {
    const constant = ctx.constants.get(arg.sym);
    if (constant && constant.tpe === "string") {
      const resolved = constValue(ctx, arg);
      if (resolved.resolved) {
        return resolved;
      }
    }
    const configured = configValueOf(ctx, arg.sym);
    if (configured) {
      return {
        values: [
          {
            value: configured,
            resolution: "config",
            via: [{ file: call.file, line: call.line }]
          }
        ],
        resolved: true
      };
    }
  }
  return { values: [], resolved: false };
}

function constValue(ctx, arg) {
  const constant = ctx.constants.get(arg.sym);
  if (!constant || constant.tpe !== "string") {
    return { values: [], resolved: false };
  }
  const definition = ctx.defsByLine.get(
    `${constant.file}:${constant.line}:${lastSegment(constant.sym)}`
  );
  const resolution = definition?.flags?.includes("inline") ? "inline" : "constant";
  return {
    values: [
      {
        value: constant.value,
        resolution,
        via: [{ file: constant.file, line: constant.line }]
      }
    ],
    resolved: true
  };
}

function lastSegment(sym) {
  return String(sym || "").split(".").pop();
}

/** A configuration key read on the defining line of a value: `config.get[String]("key")`. */
function configValueOf(ctx, sym) {
  const constant = ctx.constants.get(sym);
  const file = constant?.file;
  const line = constant?.line ?? definitionLineOf(ctx, sym);
  if (!file || !line) {
    return undefined;
  }
  const facts = ctx.files.get(file);
  for (const call of facts?.calls || []) {
    if (call.line !== line || !/Configuration$|^play\.api\./.test(call.owner)) {
      continue;
    }
    const key = (call.args || []).find(
      (a) => typeof a.string === "string"
    )?.string;
    if (key && ctx.configValues.has(key)) {
      return ctx.configValues.get(key).value;
    }
  }
  return undefined;
}

function definitionLineOf(ctx, sym) {
  for (const [key, def] of ctx.defsByKey) {
    if (key.endsWith(`.${lastSegment(sym)}`) && def.owner === ownerOf(sym)) {
      return def.line;
    }
  }
  return undefined;
}

function ownerOf(sym) {
  const segments = String(sym).split(".");
  return segments.slice(0, -1).join(".");
}

/**
 * Follow a parameter of a method to the arguments of every call site, within the boundary
 * budget. A recursive or cyclic path ends; a value that travels through more boundaries than
 * the budget is not resolved.
 */
function followParameter(ctx, caller, paramIndex, budget, seen, origin) {
  if (!caller || !caller.includes(".") || budget <= 0) {
    return { values: [], resolved: false };
  }
  const owner = caller.slice(0, caller.lastIndexOf("."));
  const name = caller.slice(caller.lastIndexOf(".") + 1);
  const methodKey = `${owner}.${name}`;
  if (seen.has(`${methodKey}#${paramIndex}`)) {
    return { values: [], resolved: false };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(`${methodKey}#${paramIndex}`);
  const sites = ctx.callsByTarget.get(methodKey) || [];
  const values = [];
  let anySite = false;
  for (const site of sites) {
    const arg = (site.args || []).find((a) => a.index === paramIndex);
    if (!arg) {
      continue;
    }
    anySite = true;
    const hop = [{ file: site.file, line: site.line }];
    if (typeof arg.string === "string") {
      values.push({ value: arg.string, resolution: "argument", via: hop });
      continue;
    }
    if (arg.const !== undefined) {
      const constant = ctx.constants.get(arg.sym);
      if (constant?.tpe === "string") {
        values.push({
          value: constant.value,
          resolution: "argument",
          via: [...hop, { file: constant.file, line: constant.line }]
        });
      }
      continue;
    }
    if (arg.param) {
      const deeper = followParameter(
        ctx,
        site.caller,
        arg.paramIndex,
        budget - 1,
        nextSeen,
        site
      );
      values.push(
        ...deeper.values.map((value) => ({
          ...value,
          via: [...hop, ...value.via]
        }))
      );
      continue;
    }
    if (arg.ident) {
      const constant = ctx.constants.get(arg.sym);
      if (constant?.tpe === "string") {
        values.push({
          value: constant.value,
          resolution: "argument",
          via: [...hop, { file: constant.file, line: constant.line }]
        });
      }
    }
  }
  return { values, resolved: values.length > 0 || (!anySite && budget === MAX_BOUNDARIES) };
}

/**
 * Derive crypto findings from the crypto rule table and the extern objects of native builds.
 *
 * @param {Object} ctx Derivation context
 * @returns {Object[]} Findings shaped for the report
 */
export function deriveCrypto(ctx) {
  const rules = loadRules("crypto");
  const findings = [];
  const seen = new Set();
  const emit = (finding) => {
    const key = JSON.stringify([
      finding.file,
      finding.line,
      finding.algorithm,
      finding.api
    ]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    findings.push(finding);
  };

  for (const call of ctx.allCalls) {
    for (const api of rules.apis) {
      if (call.owner !== api.owner) {
        continue;
      }
      if (api.name && call.name !== api.name) {
        continue;
      }
      if (api.nameIn && !api.nameIn.includes(call.name)) {
        continue;
      }
      for (const finding of cryptoFindingOf(ctx, rules, call, api)) {
        emit(finding);
      }
    }
    for (const enrichment of rules.enrichments) {
      if (
        call.name === enrichment.name &&
        classRoot(call.owner) === enrichment.ownerPrefix
      ) {
        enrichFindings(ctx, findings, call, enrichment);
      }
    }
  }

  // Algorithm values that name themselves: `JwtAlgorithm.HS256` as a reference or an
  // argument, on a line that also uses the API the algorithm value feeds.
  for (const [file, facts] of ctx.files) {
    const lineHasApi = new Set();
    for (const call of facts.calls || []) {
      if (
        rules.apis.some((api) => api.owner === call.owner) ||
        rules.algorithmRefs.some((ref) => call.owner.startsWith(ref.apiPrefix))
      ) {
        lineHasApi.add(call.line);
      }
    }
    for (const ref of facts.references || []) {
      if (
        rules.algorithmRefs.some((table) =>
          ref.symbol.startsWith(table.apiPrefix)
        )
      ) {
        lineHasApi.add(ref.line);
      }
    }
    for (const ref of facts.references || []) {
      for (const table of rules.algorithmRefs) {
        if (!ref.symbol.startsWith(table.symbolPrefix)) {
          continue;
        }
        const algorithm = ref.symbol.slice(table.symbolPrefix.length);
        if (!algorithm || !lineHasApi.has(ref.line)) {
          continue;
        }
        emit({
          algorithm,
          ...(table.primitive ? { primitive: table.primitive } : {}),
          kind: table.kind,
          api: table.api,
          provider: table.provider,
          resolution: "literal",
          file,
          line: ref.line
        });
      }
    }
  }

  deriveExternCrypto(ctx, rules, emit);
  return findings
    .filter((f) => f.algorithm || f.resolution === "unresolved")
    .map((finding) => {
      const { callerRef: _caller, apiOwner: _owner, ...publicFinding } =
        finding;
      return finishWeak(publicFinding);
    })
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        String(a.algorithm).localeCompare(String(b.algorithm))
    );
}

/** One finding for a call that matches a crypto API rule. */
function cryptoFindingOf(ctx, rules, call, api) {
  const finding = {
    ...(api.primitive ? { primitive: api.primitive } : {}),
    kind: api.kind || "algorithm",
    api: api.api,
    provider: api.provider,
    resolution: "literal",
    file: call.file,
    line: call.line
  };
  if (api.algorithm) {
    return [
      {
        ...finding,
        algorithm: api.algorithm,
        callerRef: call.caller,
        apiOwner: api.owner
      }
    ];
  }
  if (api.prefix) {
    const size = (call.args || []).find(
      (a) => a.index === api.arg && a.int !== undefined
    )?.int;
    if (size !== undefined) {
      return [
        {
          ...finding,
          algorithm: `${api.prefix}${size}`,
          callerRef: call.caller,
          apiOwner: api.owner
        }
      ];
    }
  }
  if (api.identPrefix) {
    const arg = (call.args || []).find(
      (a) =>
        a.index === api.arg &&
        (typeof a.ident === "string" || typeof a.sym === "string")
    );
    // The variant arrives as an identifier, or as a reference to an int constant the table
    // names: `Argon2Parameters.ARGON2_id` carries the value 2, the name carries the variant.
    const name = arg?.ident || lastSegment(arg?.sym);
    if (name && name.startsWith(api.identPrefix)) {
      const variant = name.slice(api.identPrefix.length);
      return [
        {
          ...finding,
          algorithm: `${api.canonicalPrefix}${variant}`,
          callerRef: call.caller,
          apiOwner: api.owner
        }
      ];
    }
  }
  const resolved = resolveArgument(ctx, call, api.arg);
  if (resolved.values.length) {
    return resolved.values.map((value) => {
      // A value that travelled to this call is reported where the literal appears, at the end
      // of the chain it took; the chain names every boundary.
      const travelled = value.resolution === "argument" && value.via.length;
      const site = travelled ? value.via[value.via.length - 1] : undefined;
      return {
        ...finding,
        algorithm: value.value,
        resolution: value.resolution,
        callerRef: call.caller,
        apiOwner: api.owner,
        ...(site ? { file: site.file, line: site.line } : {}),
        ...(value.via.length ? { via: value.via.slice(0, MAX_BOUNDARIES) } : {})
      };
    });
  }
  // The call site is reported even when the argument stays unknown, without an algorithm,
  // unless a sibling fact of the same site carries the literal (a merged application).
  const siblingHasValue = ctx.allCalls.some(
    (other) =>
      other.file === call.file &&
      other.line === call.line &&
      other.owner === call.owner &&
      other.name === call.name &&
      (other.args || []).some(
        (a) => a.index === api.arg && typeof a.string === "string"
      )
  );
  if (siblingHasValue) {
    return [];
  }
  return [
    {
      ...finding,
      resolution: "unresolved",
      callerRef: call.caller,
      apiOwner: api.owner
    }
  ];
}

/** Attach a parameter of the same caller to the findings of one API family. */
function enrichFindings(ctx, findings, call, enrichment) {
  const value = (call.args || []).find((a) => a.index === enrichment.arg);
  if (value === undefined) {
    return;
  }
  const numeric = value.int ?? value.long;
  const text = typeof value.string === "string" ? value.string : undefined;
  for (const finding of findings) {
    if (finding.file !== call.file || finding.callerRef !== call.caller) {
      continue;
    }
    if (enrichment.family && algorithmFamily(finding.algorithm) !== enrichment.family) {
      continue;
    }
    if (enrichment.primitive && finding.primitive !== enrichment.primitive) {
      continue;
    }
    if (
      !enrichment.family &&
      !enrichment.primitive &&
      classRoot(finding.apiOwner) !== enrichment.ownerPrefix
    ) {
      continue;
    }
    if (enrichment.field === "keySize" && numeric !== undefined) {
      finding.keySize = numeric;
    } else if (enrichment.field === "curve" && text) {
      finding.curve = text;
    } else if (enrichment.field === "bits" && numeric !== undefined) {
      finding.bits = numeric;
      if (enrichment.mode && !finding.mode) {
        finding.mode = enrichment.mode;
      }
    }
  }
}

/** Weak families and modes flag the finding. */
function finishWeak(finding) {
  const rules = loadRules("crypto");
  const family = algorithmFamily(finding.algorithm);
  if (rules.weakAlgorithms.some((weak) => family === weak)) {
    finding.weak = true;
  }
  const segments = String(finding.algorithm || "").split("/");
  if (segments.length > 1 && rules.weakModes.includes(segments[1].toUpperCase())) {
    finding.weak = true;
  }
  if (finding.mode && rules.weakModes.includes(String(finding.mode).toUpperCase())) {
    finding.weak = true;
  }
  const floor = rules.keySizeFloor[family];
  if (floor && finding.keySize !== undefined && finding.keySize < floor) {
    finding.weak = true;
  }
  return finding;
}

/** Algorithm bindings of native extern objects: every `@extern` method is a native symbol. */
function deriveExternCrypto(ctx, rules, emit) {
  const externs = rules.externObjects;
  for (const [file, facts] of ctx.files) {
    for (const def of facts.definitions || []) {
      if (def.kind !== "object" || !(def.annotations || []).length) {
        continue;
      }
      const names = def.annotations.map((a) => a.name);
      if (!names.includes(externs.externAnnotation)) {
        continue;
      }
      const link = def.annotations.find(
        (a) => a.name === externs.linkAnnotation
      );
      const library = link?.args?.[0];
      // The methods of the object name its symbol form as their owner.
      const owners = new Set([
        `${def.owner}.${def.name}`,
        `${def.owner}.${def.name.replace(/\$$/, "")}$`
      ]);
      for (const method of facts.definitions || []) {
        const known = externs.algorithmMethods[method.name];
        if (!known || !owners.has(method.owner)) {
          continue;
        }
        emit({
          algorithm: known.algorithm,
          ...(known.primitive ? { primitive: known.primitive } : {}),
          kind: "native-binding",
          api: library ? String(library) : "native",
          provider: "scala-native",
          resolution: "literal",
          ...(known.weak ? { weak: true } : {}),
          file,
          line: method.line
        });
      }
    }
  }
}

/**
 * Derive every evidence kind of a report.
 *
 * @param {Object} ctx Derivation context
 * @returns {{ crypto: Object[], endpoints: Object[], services: Object[], entryPoints: Object[], callGraph: Object, callStacks: Object[] }}
 */
export function deriveEvidence(ctx) {
  return {
    crypto: deriveCrypto(ctx)
  };
}
