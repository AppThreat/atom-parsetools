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
  deriveJsDynamicCrypto(ctx, rules, emit);
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
  const externOwners = new Map();
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
      const owners = [
        `${def.owner}.${def.name}`,
        `${def.owner}.${def.name.replace(/\$$/, "")}$`
      ];
      for (const owner of owners) {
        externOwners.set(owner, library ? String(library) : "native");
      }
      const methodOwners = new Set(owners);
      for (const method of facts.definitions || []) {
        const known = externs.algorithmMethods[method.name];
        if (!known || !methodOwners.has(method.owner)) {
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
  deriveExternCalls(ctx, rules, emit, externOwners);
  return externOwners;
}

/** Normalize a route path: `:id`, `$id` and `*rest` become `{...}` placeholders. */
export function normalizePath(pattern) {
  return String(pattern || "")
    .replace(/:[A-Za-z_][\w.-]*/g, (m) => `{${m.slice(1)}}`)
    .replace(/\*[A-Za-z_][\w.-]*/g, (m) => `{${m.slice(1)}}`)
    .replace(/\$\{?([A-Za-z_]\w*)\}?/g, "{$1}")
    .replace(/\/+$/, "") || "/";
}

const skipGenerated = (file) => /(^|\/)(target|out)\//.test(file);

/**
 * Derive inbound endpoints: the route configuration files first, then every framework DSL
 * the facts name.
 *
 * @param {Object} ctx Derivation context
 * @returns {Object[]} Endpoint entries
 */
export function deriveEndpoints(ctx) {
  const rules = loadRules("endpoints");
  const endpoints = [];
  const emit = (endpoint) => {
    if (!endpoints.some((e) => e.path === endpoint.path && e.method === endpoint.method && e.file === endpoint.file && e.line === endpoint.line)) {
      endpoints.push(endpoint);
    }
  };

  // Play: the routes configuration is the framework's own table; generated routers under
  // target would only repeat it.
  for (const route of ctx.config.routes || []) {
    emit({
      framework: "play",
      method: route.method,
      path: normalizePath(route.pattern),
      handler: route.controllerMethod,
      file: route.mountFile || route.file,
      line: route.mountLine || route.line
    });
  }

  for (const [file, facts] of ctx.files) {
    if (skipGenerated(file)) {
      continue;
    }
    caskEndpoints(rules.cask, file, facts, emit);
    tapirEndpoints(rules.tapir, file, facts, emit);
    http4sEndpoints(rules.http4s, file, facts, emit);
    pekkoEndpoints(rules.pekko, file, facts, emit);
    zioEndpoints(rules.zio, file, facts, emit);
    scalatraEndpoints(rules.scalatra, file, facts, emit);
  }
  return endpoints.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.path.localeCompare(b.path)
  );
}

function caskEndpoints(rules, file, facts, emit) {
  for (const def of facts.definitions || []) {
    for (const annotation of def.annotations || []) {
      const verb = Object.entries(rules.verbs).find(([name]) =>
        annotation.name
          .split(".")
          .some((segment) => segment === name || segment === `${name}Route`)
      )?.[1];
      if (!verb) {
        continue;
      }
      const path = annotation.args?.find((a) => typeof a === "string");
      emit({
        framework: "cask",
        method: verb,
        path: normalizePath(path),
        handler: def.id || `${def.owner}.${def.name}`,
        file,
        line: def.line
      });
    }
  }
}

/** tapir: fixed segments and captures in source order inside one endpoint value. */
function tapirEndpoints(rules, file, facts, emit) {
  const byCaller = new Map();
  const positionText = new Map();
  for (const call of facts.calls || []) {
    if (!rules.segmentOwners.includes(call.owner)) {
      continue;
    }
    const arg = (call.args || []).find((a) => a.index === 0);
    let segment;
    if (rules.literalNames.includes(call.name) && arg?.string !== undefined) {
      segment = arg.string;
    } else if (rules.captureNames.includes(call.name)) {
      segment = typeof arg?.string === "string" ? `{${arg.string}}` : "{}";
    }
    if (segment === undefined) {
      continue;
    }
    // Nested applications of one callee share a position; the one that names the capture
    // wins over the one that carries the implicit codec.
    const key = `${call.line}:${call.column}`;
    if (positionText.has(key) && segment === "{}") {
      continue;
    }
    positionText.set(key, segment);
    const callerKey = call.caller || "";
    if (!byCaller.has(callerKey)) {
      byCaller.set(callerKey, new Map());
    }
    byCaller.get(callerKey).set(key, { segment, line: call.line, column: call.column });
  }
  for (const [caller, byPosition] of byCaller) {
    const segments = [...byPosition.values()].sort(
      (a, b) => a.line - b.line || a.column - b.column
    );
    if (!segments.length) {
      continue;
    }
    const first = segments[0].line;
    const last = segments[segments.length - 1].line;
    const verbRefs = (facts.references || []).filter((ref) => {
      if (!ref.symbol.startsWith(rules.verbOwnerPrefix)) {
        return false;
      }
      const name = ref.symbol.slice(rules.verbOwnerPrefix.length).toUpperCase();
      return HTTP_VERBS.includes(name) && ref.line >= first - 1 && ref.line <= last + 1;
    });
    const verb =
      verbRefs.find((ref) => ref.line >= first && ref.line <= last) || verbRefs[0];
    emit({
      framework: "tapir",
      method: verb
        ? verb.symbol.slice(rules.verbOwnerPrefix.length).toUpperCase()
        : "GET",
      path: normalizePath(`/${segments.map((s) => s.segment).join("/")}`),
      handler: caller.split(".").slice(-2).join("."),
      file,
      line: definitionLineOfCaller(ctxOf(facts), caller) ?? segments[0].line
    });
  }
}

const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function definitionLineOfCaller(ctx, caller) {
  const def = ctx?.defsByKey?.get(caller);
  return def?.line;
}

// A per file stand-in context for helpers that only need definitions.
const definitionContexts = new WeakMap();
function ctxOf(facts) {
  if (!definitionContexts.has(facts)) {
    definitionContexts.set(facts, {
      defsByKey: new Map(
        (facts.definitions || []).map((d) => [`${d.owner}.${d.name}`, d])
      )
    });
  }
  return definitionContexts.get(facts);
}

/** http4s: extractor patterns per route case, verbs from the method references. */
function http4sEndpoints(rules, file, facts, emit) {
  const byLine = new Map();
  for (const pattern of facts.patterns || []) {
    if (pattern.owner !== rules.segmentOwner && pattern.owner !== rules.captureOwner) {
      continue;
    }
    const key = pattern.line;
    if (!byLine.has(key)) {
      byLine.set(key, []);
    }
    byLine.get(key).push(pattern);
  }
  const verbsByLine = new Map();
  for (const ref of facts.references || []) {
    if (!ref.symbol.startsWith(rules.verbPrefix)) {
      continue;
    }
    const verb = ref.symbol.slice(rules.verbPrefix.length).toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(verb)) {
      verbsByLine.set(ref.line, verb);
    }
  }
  // A router mounts route values under a prefix: `Router("/api" -> users)`. The mounted
  // value is the identifier argument of the tuple arrow on the router's line.
  const prefixes = new Map();
  for (const call of facts.calls || []) {
    if (call.owner !== rules.routerOwner) {
      continue;
    }
    const prefix = (facts.calls || [])
      .filter((other) => other.line === call.line)
      .flatMap((other) => other.args || [])
      .find((a) => typeof a.string === "string" && a.string.startsWith("/"))?.string;
    const mounted = (facts.calls || [])
      .filter((other) => other.line === call.line && other.name === "->")
      .flatMap((other) => other.args || [])
      .find((a) => typeof a.ident === "string")?.sym;
    if (prefix && mounted) {
      prefixes.set(mounted, prefix);
    }
  }
  const callerPrefixOf = (line) => {
    const caller = (facts.calls || []).find((call) => call.line === line)?.caller;
    if (!caller) {
      return undefined;
    }
    const valName = caller.split(".").pop();
    return prefixes.get(valName) || prefixes.get(caller);
  };
  for (const [line, patterns] of byLine) {
    const segments = patterns
      .sort((a, b) => a.column - b.column)
      .flatMap((pattern) => {
        if (pattern.owner === rules.captureOwner) {
          return ["{}"];
        }
        return (pattern.args || []).filter(
          (a) => typeof a === "string"
        );
      });
    if (!segments.length) {
      continue;
    }
    const path = normalizePath(
      `${callerPrefixOf(line) || ""}/${segments.join("/")}`
    );
    emit({
      framework: "http4s",
      method: verbsByLine.get(line) || "GET",
      path,
      handler: patterns[0].idents?.[0] || undefined,
      file,
      line
    });
  }
}

/** Akka and Pekko: directive trees read in source order, the indentation carries the
 * nesting. The typed tree folds `pathPrefix("x")` into an application of the directive
 * value, so the path kinds come from references to the directive methods and the string
 * segments from the implicit matcher construction calls that follow them.
 */
function pekkoEndpoints(rules, file, facts, emit) {
  const stringMatchers = (facts.calls || []).filter(
    (call) =>
      call.name.startsWith("_segment") &&
      (call.args || []).some((a) => typeof a.string === "string")
  );
  const directives = [];
  const pushDirective = (framework, kind, segments, at) => {
    directives.push({ framework, kind, segments, ...at });
  };
  for (const ref of facts.references || []) {
    const frameworkPrefix = rules.ownerPrefixes.find((prefix) =>
      ref.symbol.startsWith(prefix)
    );
    if (!frameworkPrefix) {
      continue;
    }
    const framework = frameworkPrefix.includes("pekko") ? "pekko-http" : "akka-http";
    const verb = /\.MethodDirectives\.(get|post|put|delete|patch|head|options)$/.exec(
      ref.symbol
    )?.[1];
    if (verb) {
      pushDirective(framework, "verb", [], {
        verb: verb.toUpperCase(),
        line: ref.line,
        column: ref.column
      });
      continue;
    }
    const pathKind = /\.PathDirectives\.(path|pathPrefix|pathEnd|pathEndOrSingleSlash|pathSingleSlash)$/.exec(
      ref.symbol
    )?.[1];
    if (!pathKind) {
      continue;
    }
    if (pathKind === "pathEnd" || pathKind === "pathEndOrSingleSlash" || pathKind === "pathSingleSlash") {
      pushDirective(framework, "pathEnd", [], { line: ref.line, column: ref.column });
      continue;
    }
    // The string segments of a prefix or path arrive through the implicit matcher
    // construction of the same source line.
    const segments = [];
    for (const matcher of stringMatchers) {
      if (matcher.line === ref.line && matcher.column >= ref.column) {
        const text = (matcher.args || [])
          .filter((a) => typeof a.string === "string")
          .map((a) => a.string)
          .join("/");
        segments.push(...text.split("/").filter(Boolean));
      }
    }
    // The directive application that starts at this position extends over the block it
    // takes; its last line closes the scope of a prefix.
    const scopeEnd = Math.max(
      0,
      ...(facts.calls || [])
        .filter((call) => call.line === ref.line && call.column === ref.column)
        .map((call) => call.endLine || call.line)
    );
    pushDirective(framework, pathKind, segments, {
      line: ref.line,
      column: ref.column,
      endLine: scopeEnd || ref.line
    });
  }
  // A direct `path(matcher)` call keeps its arguments.
  for (const call of facts.calls || []) {
    const frameworkPrefix = rules.ownerPrefixes.find((prefix) =>
      call.owner.startsWith(prefix)
    );
    if (
      frameworkPrefix &&
      classRoot(call.owner).endsWith("PathDirectives") &&
      call.name === "path"
    ) {
      pushDirective(
        frameworkPrefix.includes("pekko") ? "pekko-http" : "akka-http",
        "path",
        pathSegmentsOf(call, rules),
        {
          line: call.line,
          column: call.column,
          endLine: call.endLine || call.line,
          fromCall: true
        }
      );
    }
  }
  directives.sort((a, b) => a.line - b.line || a.column - b.column);
  // A direct `path(matcher)` call and the reference to the same method share a position;
  // the call keeps the real arguments.
  const uniqueDirectives = [];
  for (const directive of directives) {
    const same = uniqueDirectives.find(
      (d) => d.line === directive.line && d.column === directive.column && d.kind === directive.kind
    );
    if (!same) {
      uniqueDirectives.push(directive);
    } else if (directive.fromCall) {
      same.segments = directive.segments;
    }
  }
  const emitted = [];
  for (let i = 0; i < uniqueDirectives.length; i++) {
    const directive = uniqueDirectives[i];
    const emitPath = (parts, line, index) => {
      const verb = verbAfter(uniqueDirectives, index);
      emitted.push({
        framework: directive.framework,
        method: verb || "GET",
        path: normalizePath(`/${parts.join("/")}`),
        file,
        line
      });
    };
    if (directive.kind === "pathPrefix") {
      // A prefix reaches the path directives nested under it: everything after it that
      // starts further right, until a directive at the same or lower column.
      for (let j = i + 1; j < uniqueDirectives.length; j++) {
        if (
          uniqueDirectives[j].column <= directive.column ||
          uniqueDirectives[j].line < directive.line ||
          uniqueDirectives[j].line > (directive.endLine || directive.line)
        ) {
          break;
        }
        if (uniqueDirectives[j].kind === "path") {
          emitPath(
            [...directive.segments, ...uniqueDirectives[j].segments],
            uniqueDirectives[j].line,
            j
          );
        } else if (uniqueDirectives[j].kind === "pathEnd") {
          emitPath([...directive.segments], uniqueDirectives[j].line, j);
        }
      }
    } else if (directive.kind === "path") {
      emitPath(directive.segments, directive.line, i);
    } else if (directive.kind === "pathEnd") {
      emitPath([], directive.line, i);
    }
  }
  for (const endpoint of emitted) {
    emit(endpoint);
  }
}

/** The first verb directive inside one path directive, before the next sibling path. */
function verbAfter(group, index) {
  const directive = group[index];
  for (let j = index + 1; j < group.length; j++) {
    if (group[j].kind === "verb") {
      return group[j].verb;
    }
    if (group[j].column <= directive.column) {
      return undefined;
    }
  }
  return undefined;
}

/** Path segments of one directive call: literals, matcher identifiers and composed parts. */
function pathSegmentsOf(call, rules) {
  const segments = [];
  for (const arg of call.args || []) {
    if (typeof arg.string === "string") {
      segments.push(...arg.string.split("/").filter(Boolean));
    } else if (Array.isArray(arg.parts)) {
      segments.push(...arg.parts.filter((p) => typeof p === "string" && p).join("").split("/").filter(Boolean));
    } else if (arg.call && Array.isArray(arg.args)) {
      for (const piece of arg.args) {
        if (typeof piece === "string" && piece) {
          segments.push(...piece.split("/").filter(Boolean));
        }
      }
    } else if (arg.ident && rules.matchers.includes(arg.ident)) {
      segments.push("{}");
    } else if (arg.param && rules.matchers.includes(arg.param)) {
      segments.push("{}");
    }
  }
  return segments;
}

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

/** ZIO HTTP: segments and captures before the route arrow on the same line. */
function zioEndpoints(rules, file, facts, emit) {
  const routes = (facts.calls || []).filter(
    (call) => call.owner === rules.routeOwner && rules.routeNames.includes(call.name)
  );
  const segmentsByLine = new Map();
  for (const call of facts.calls || []) {
    if (!rules.segmentOwners.includes(call.owner) && !rules.captureOwners.includes(call.owner)) {
      continue;
    }
    const isCapture =
      rules.captureOwners.includes(call.owner) && rules.captureNames.includes(call.name);
    const arg = (call.args || []).find((a) => a.index === 0 && typeof a.string === "string");
    if (!arg) {
      continue;
    }
    const segment = isCapture ? `{${arg.string}}` : arg.string;
    if (!segmentsByLine.has(call.line)) {
      segmentsByLine.set(call.line, []);
    }
    segmentsByLine.get(call.line).push({ segment, column: call.column });
  }
  const verbsByLine = new Map();
  for (const ref of facts.references || []) {
    if (!ref.symbol.startsWith(rules.verbPrefix)) {
      continue;
    }
    const verb = ref.symbol.slice(rules.verbPrefix.length).toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(verb)) {
      verbsByLine.set(ref.line, verb);
    }
  }
  for (const route of routes) {
    const segments = (segmentsByLine.get(route.line) || [])
      .sort((a, b) => a.column - b.column)
      .map((s) => s.segment);
    emit({
      framework: "zio-http",
      method: verbsByLine.get(route.line) || "GET",
      path: normalizePath(`/${segments.join("/")}`),
      handler: route.caller?.split(".").slice(-2).join("."),
      file,
      line: route.line
    });
  }
}

/** Scalatra: the action calls of a servlet, `get("/x") { ... }`. */
function scalatraEndpoints(rules, file, facts, emit) {
  for (const call of facts.calls || []) {
    const verb = rules.verbs[call.name];
    if (!verb || !rules.ownerPrefixes.some((p) => call.owner.startsWith(p))) {
      continue;
    }
    const path = (call.args || []).find(
      (a) => typeof a.string === "string" && a.string.startsWith("/")
    )?.string;
    if (!path) {
      continue;
    }
    emit({
      framework: "scalatra",
      method: verb,
      path: normalizePath(path),
      handler: call.caller?.split(".").slice(-2).join("."),
      file,
      line: call.line
    });
  }
}

/**
 * Derive outbound services and data stores.
 *
 * @param {Object} ctx Derivation context
 * @returns {Object[]} Service entries
 */
export function deriveServices(ctx) {
  const rules = loadRules("services");
  const services = [];
  const emit = (service) => {
    if (!services.some((s) => s.file === service.file && s.line === service.line && s.client === service.client)) {
      services.push(service);
    }
  };
  for (const call of ctx.allCalls) {
    serviceOfCall(ctx, rules, call, emit);
  }
  bootstrapServices(ctx, rules, emit);
  libcurlServices(ctx, rules, emit);
  return services.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || String(a.client).localeCompare(String(b.client))
  );
}

function serviceOfCall(ctx, rules, call, emit) {
  for (const table of rules.urlCalls) {
    if (!call.owner.startsWith(table.ownerPrefix) || call.name !== table.name) {
      continue;
    }
    const url = resolveServiceValue(ctx, call, table.arg);
    if (url?.value) {
      emit(serviceEntry(call, table.client, url));
    }
    return;
  }
  for (const table of rules.httpClients) {
    if (table.skip || !call.owner.startsWith(table.ownerPrefix)) {
      continue;
    }
    if (table.nameIn && !table.nameIn.includes(call.name)) {
      continue;
    }
    const url = urlForClient(ctx, rules, call, table);
    if (url?.value) {
      emit(serviceEntry(call, table.client, url, table.kind));
    }
    return;
  }
  for (const table of [...rules.dataStores, ...rules.messaging]) {
    if (!call.owner.startsWith(table.ownerPrefix)) {
      continue;
    }
    if (table.name && call.name !== table.name) {
      continue;
    }
    if (table.nameIn && !table.nameIn.includes(call.name)) {
      continue;
    }
    const value = resolveServiceValue(ctx, call, table.arg ?? 0);
    if (value?.value) {
      emit(serviceEntry(call, table.client, value, table.kind, table.prefix));
    }
    return;
  }
}

function urlForClient(ctx, rules, call, table) {
  if (table.urlFrom?.startsWith("parts")) {
    const parts = (call.args || []).find((a) => Array.isArray(a.parts));
    if (parts) {
      const value = partsText(parts);
      if (value) {
        return { value, resolution: "interpolated", via: [] };
      }
    }
    if (table.urlFrom === "parts") {
      return undefined;
    }
  }
  if (table.urlFrom === "line" || table.urlFrom === "caller") {
    const candidates =
      table.urlFrom === "line"
        ? (ctx.callsByCaller.get(call.caller) || []).filter((c) => c.line === call.line)
        : ctx.callsByCaller.get(call.caller) || [];
    for (const candidate of candidates) {
      for (const urlTable of rules.urlCalls) {
        if (
          candidate.owner.startsWith(urlTable.ownerPrefix) &&
          candidate.name === urlTable.name
        ) {
          const url = resolveServiceValue(ctx, candidate, urlTable.arg);
          if (url?.value) {
            return url;
          }
        }
      }
    }
  }
  if (table.urlFrom === "args") {
    return resolveServiceNamedArg(ctx, call);
  }
  return undefined;
}

/** A named `uri = ...` argument, the form Akka and Pekko requests use. */
function resolveServiceNamedArg(ctx, call) {
  const arg = (call.args || []).find((a) => typeof a.string === "string" && /^[a-z]+:\/\//i.test(a.string));
  if (arg) {
    return { value: arg.string, resolution: "literal", via: [] };
  }
  const parts = (call.args || []).find((a) => Array.isArray(a.parts));
  if (parts) {
    const value = partsText(parts);
    if (value) {
      return { value, resolution: "interpolated", via: [] };
    }
  }
  return undefined;
}

/** Join the pieces of an interpolation argument into one string. */
function partsText(parts) {
  const pieces = [];
  for (const piece of parts.parts || []) {
    if (typeof piece === "string") {
      pieces.push(piece);
    } else if (piece && typeof piece.const === "string") {
      pieces.push(piece.const);
    } else {
      return undefined;
    }
  }
  const joined = pieces.join("");
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(joined) || /^kafka:/i.test(joined)
    ? joined
    : undefined;
}

function resolveServiceValue(ctx, call, index) {
  const resolved = resolveArgument(ctx, call, index);
  const value = resolved.values[0];
  if (!value || !value.value) {
    return undefined;
  }
  return value;
}

function serviceEntry(call, client, value, kind = "http-client", prefix) {
  const text = prefix && !value.value.startsWith(prefix)
    ? `${prefix}${value.value}`
    : value.value;
  return {
    kind,
    client,
    url: sanitizeUrl(text),
    resolution: value.resolution,
    ...(value.via?.length ? { via: value.via.slice(0, MAX_BOUNDARIES) } : {}),
    file: call.file,
    line: call.line
  };
}

/** Kafka and friends: the settings a Properties map carries before the client is built. */
function bootstrapServices(ctx, rules, emit) {
  const table = rules.bootstrapKeys;
  for (const call of ctx.allCalls) {
    if (!call.owner.startsWith(table.putOwner) || call.name !== "put") {
      continue;
    }
    const key = (call.args || []).find((a) => typeof a.string === "string")?.string;
    const setting = table.keys[key];
    if (!setting) {
      continue;
    }
    const value = (call.args || []).find(
      (a) => a.index === 1 && (typeof a.string === "string" || a.const !== undefined)
    );
    const host =
      typeof value?.string === "string"
        ? value.string
        : value?.const !== undefined
          ? String(value.const)
          : undefined;
    if (host) {
      emit({
        kind: setting.kind,
        client: setting.client,
        url: host,
        resolution: "literal",
        file: call.file,
        line: call.line
      });
    }
  }
}

/** libcurl writes its URL through an option constant; the value follows one call later. */
function libcurlServices(ctx, rules, emit) {
  const table = rules.libcurl;
  for (const call of ctx.allCalls) {
    if (call.name !== table.setter) {
      continue;
    }
    const option = (call.args || []).find(
      (a) => a.index === 1 && (a.const === table.urlOption || a.int === table.urlOption)
    );
    if (!option) {
      continue;
    }
    const wrapped = (call.args || []).find((a) => a.index === 2 && a.call);
    const url = wrapped?.args?.find((a) => typeof a === "string" && a.includes("://"));
    if (url) {
      emit({
        kind: "http-client",
        client: "libcurl",
        url: sanitizeUrl(url),
        resolution: "literal",
        file: call.file,
        line: call.line
      });
    }
  }
}

/** Calls to the algorithm methods of extern objects, at the call site. */
function deriveExternCalls(ctx, rules, emit, externOwners) {
  const externs = rules.externObjects;
  for (const call of ctx.allCalls) {
    if (!externOwners.has(call.owner)) {
      continue;
    }
    const known = externs.algorithmMethods[call.name];
    if (!known) {
      continue;
    }
    emit({
      algorithm: known.algorithm,
      ...(known.primitive ? { primitive: known.primitive } : {}),
      kind: "native-call",
      api: externOwners.get(call.owner),
      provider: "scala-native",
      resolution: "literal",
      ...(known.weak ? { weak: true } : {}),
      file: call.file,
      line: call.line
    });
  }
}

/** Dynamic member access on the JavaScript global, `crypto.createHash("md5")` in Scala.js. */
function deriveJsDynamicCrypto(ctx, rules, emit) {
  const table = rules.jsDynamic;
  if (!table) {
    return;
  }
  for (const [file, facts] of ctx.files) {
    const dynamicLines = new Set();
    const membersByLine = new Map();
    for (const call of facts.calls || []) {
      if (!call.owner.startsWith(table.ownerPrefix)) {
        continue;
      }
      dynamicLines.add(call.line);
      const members = (call.args || [])
        .filter((a) => typeof a.string === "string")
        .map((a) => a.string);
      membersByLine.set(call.line, [
        ...(membersByLine.get(call.line) || []),
        ...members
      ]);
    }
    if (!dynamicLines.size) {
      continue;
    }
    // The arguments of the dynamic call arrive as separate conversion calls on the line.
    const argumentsByLine = new Map();
    for (const call of facts.calls || []) {
      if (!dynamicLines.has(call.line) || call.owner === table.ownerPrefix.slice(0, -1)) {
        continue;
      }
      const text = (call.args || [])
        .filter((a) => typeof a.string === "string" || typeof a.const === "string")
        .map((a) => a.string ?? a.const);
      if (text.length) {
        argumentsByLine.set(call.line, [
          ...(argumentsByLine.get(call.line) || []),
          ...text
        ]);
      }
    }
    for (const line of dynamicLines) {
      const members = membersByLine.get(line) || [];
      if (!members.some((m) => table.memberNames.includes(m))) {
        continue;
      }
      const algorithm = (argumentsByLine.get(line) || []).find((value) =>
        /^(md2|md4|md5|sha-?0|sha-?1|sha-?224|sha-?256|sha-?384|sha-?512|sha3-?(224|256|384|512)|ripemd-?160|aes-?(128|192|256)-(cbc|gcm|ctr)|des-?ede3|rc4|chacha20|pbkdf2|scrypt)$/i.test(
          value
        )
      );
      if (!algorithm) {
        continue;
      }
      const member = members.find((m) => table.memberNames.includes(m));
      emit({
        algorithm: algorithm.toUpperCase(),
        ...(table.primitiveOf[member]
          ? { primitive: table.primitiveOf[member] }
          : {}),
        kind: "algorithm",
        api: table.api,
        provider: table.provider,
        resolution: "literal",
        ...(/^(md2|md4|md5|sha-?1|des|rc4)/i.test(algorithm) ? { weak: true } : {}),
        file,
        line
      });
    }
  }
}

/**
 * Entry points of the program: main methods, application objects, route handlers and the
 * actions the route configuration names.
 *
 * @param {Object} ctx Derivation context
 * @param {Object[]} endpoints Derived endpoints, whose handlers are entries
 * @returns {Object[]}
 */
export function deriveEntryPoints(ctx, endpoints) {
  const entries = [];
  const emit = (entry) => {
    const id = `${entry.file}#${entry.line}:${entry.kind}:${entry.ref || ""}`;
    if (!entries.some((e) => e.id === id)) {
      entries.push({ id, ...entry });
    }
  };
  const appParents = [
    "scala.App",
    "cats.effect.IOApp",
    "cats.effect.IOApp.Simple",
    "zio.ZIOAppDefault",
    "cask.MainRoutes"
  ];
  for (const [file, facts] of ctx.files) {
    for (const def of facts.definitions || []) {
      if (def.kind !== "object" && def.kind !== "def") {
        continue;
      }
      const isTest = /(^|\/)(test|src\/test)\//.test(file);
      if (
        def.kind === "def" &&
        def.name === "main" &&
        (def.params || []).length === 1
      ) {
        emit({
          kind: isTest ? "test" : "main",
          file,
          line: def.line,
          ref: `${def.owner}.${def.name}`
        });
      }
      if ((def.annotations || []).some((a) => a.name.endsWith(".main"))) {
        emit({
          kind: isTest ? "test" : "main",
          file,
          line: def.line,
          ref: `${def.owner}.${def.name}`
        });
      }
      if (
        def.kind === "object" &&
        (def.parents || []).some((parent) => appParents.includes(parent))
      ) {
        emit({
          kind: "app",
          file,
          line: def.line,
          ref: `${def.owner}.${def.name}`
        });
      }
      if ((def.annotations || []).some((a) => a.name.includes(".cask."))) {
        emit({
          kind: "http-handler",
          file,
          line: def.line,
          ref: `${def.owner}.${def.name}`
        });
      }
    }
  }
  // The actions a Play route table names are the entry points of the request path.
  for (const route of ctx.config.routes || []) {
    const ref = route.controllerMethod;
    const def = [...ctx.defsByKey.entries()].find(([key]) =>
      key.replace(/\$$/, "").endsWith(ref.replace(/\.$/, ""))
    );
    if (def) {
      emit({
        kind: "play-action",
        file: def[1].file,
        line: def[1].line,
        ref
      });
    }
  }
  for (const endpoint of endpoints) {
    if (endpoint.handler && endpoint.file && !skipGenerated(endpoint.file)) {
      emit({
        kind: "http-handler",
        file: endpoint.file,
        line: endpoint.line,
        ref: endpoint.handler
      });
    }
  }
  return entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** All parents of a project class, the traits and classes it extends, transitively. */
function parentsOf(ctx, owner, seen = new Set()) {
  if (seen.has(owner)) {
    return [];
  }
  seen.add(owner);
  const direct = ctx.projectClasses.get(owner)?.parents || [];
  const all = [];
  for (const parent of direct) {
    if (!all.includes(parent)) {
      all.push(parent);
    }
    for (const grand of parentsOf(ctx, parent, seen)) {
      if (!all.includes(grand)) {
        all.push(grand);
      }
    }
  }
  return all;
}

/**
 * The call graph over project methods, with class hierarchy analysis for calls through a
 * trait or parent class.
 *
 * @param {Object} ctx Derivation context
 * @returns {{ edges: Object[], adjacency: Map, byNameApplications: Object[] }}
 */
export function deriveCallGraph(ctx) {
  const projectOwner = new Set();
  for (const def of ctx.defsByKey.values()) {
    projectOwner.add(def.owner);
    if (def.kind === "class" || def.kind === "trait" || def.kind === "object") {
      projectOwner.add(`${def.owner}.${def.name}`);
      projectOwner.add(`${def.owner}.${def.name}$`);
    }
  }
  for (const owner of ctx.projectClasses.keys()) {
    projectOwner.add(owner);
  }
  // Methods by the class or trait that first defines them, for dispatch through a parent.
  const methodsByName = new Map();
  for (const [key, def] of ctx.defsByKey) {
    if (def.kind !== "def" && def.kind !== "val") {
      continue;
    }
    for (const owner of [def.owner, ...parentsOf(ctx, def.owner)]) {
      const methodKey = `${owner}.${def.name}`;
      if (!methodsByName.has(methodKey)) {
        methodsByName.set(methodKey, new Set());
      }
      methodsByName.get(methodKey).add(key);
    }
  }
  const edges = [];
  const seenEdges = new Set();
  const byNameApplications = [];
  const addEdge = (from, to, call, confidence) => {
    const key = `${from}>${to}@${call.file}:${call.line}`;
    if (from === to || seenEdges.has(key) || !ctx.defsByKey.has(from) || !ctx.defsByKey.has(to)) {
      return;
    }
    seenEdges.add(key);
    edges.push({
      from,
      to,
      file: call.file,
      line: call.line,
      column: call.column,
      ...(confidence ? { confidence } : {})
    });
  };
  for (const call of ctx.allCalls) {
    if (call.byName !== undefined) {
      byNameApplications.push(call);
      continue;
    }
    if (call.name === "<init>" || !call.caller) {
      continue;
    }
    const target = `${call.owner}.${call.name}`;
    const targets = methodsByName.get(target);
    if (!targets?.size) {
      continue;
    }
    for (const to of targets) {
      addEdge(call.caller, to, call, call.owner === ownerOfKey(to) ? undefined : "approximate");
    }
  }
  // A by-name parameter application runs an argument the caller passed; the argument is the
  // project call on the caller's line.
  for (const application of byNameApplications) {
    // The application fact's owner is the enclosing method itself; its call sites are the
    // places that method was called with the argument expression.
    const enclosing = application.owner;
    for (const site of ctx.callsByTarget.get(enclosing) || []) {
      const argumentCall = (ctx.callsByCaller.get(site.caller) || []).find(
        (other) =>
          other.line === site.line &&
          other.byName === undefined &&
          `${other.owner}.${other.name}` !== enclosing &&
          methodsByName.has(`${other.owner}.${other.name}`)
      );
      if (argumentCall) {
        for (const to of methodsByName.get(`${argumentCall.owner}.${argumentCall.name}`)) {
          addEdge(enclosing, to, application, "approximate");
        }
      }
    }
  }
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from).push(edge);
  }
  edges.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    edges: edges.map(({ column: _column, ...edge }) => edge),
    allEdges: edges,
    adjacency,
    projectOwner
  };
}

function ownerOfKey(key) {
  return key.slice(0, key.lastIndexOf("."));
}

const RUNTIME_OWNER = /^(scala|java|jdk|javax|sun)\./;

/**
 * Call stacks from the entry points to library calls: at most three shortest stacks per
 * library owner, twelve frames deep, the entry first and the library call last.
 *
 * @param {Object} ctx Derivation context
 * @param {Object[]} entryPoints Derived entry points
 * @returns {Object[]} Call stacks
 */
export function deriveCallStacks(ctx, entryPoints, graph) {
  const entryKeys = new Set();
  for (const entry of entryPoints) {
    const key = methodKeyOf(ctx, entry.ref, entry);
    if (key) {
      entryKeys.add(key);
    }
  }
  const reverse = new Map();
  for (const edge of graph.allEdges || []) {
    if (!reverse.has(edge.to)) {
      reverse.set(edge.to, []);
    }
    reverse.get(edge.to).push(edge);
  }
  const sinks = [];
  for (const call of ctx.allCalls) {
    if (
      call.byName !== undefined ||
      call.name === "<init>" ||
      !call.caller ||
      graph.projectOwner.has(call.owner) ||
      graph.projectOwner.has(classRoot(call.owner))
    ) {
      continue;
    }
    if (RUNTIME_OWNER.test(call.owner)) {
      continue;
    }
    if (!reverse.has(call.caller) && !entryKeys.has(call.caller)) {
      continue;
    }
    sinks.push(call);
  }
  // Several distinct routes reach one method: up to three are kept, shortest first, so a
  // call through a helper and a direct call both survive.
  const pathsOf = (method) => {
    const paths = [];
    const signatures = new Set();
    let budget = 500;
    const walk = (node, frames, seen) => {
      if (paths.length >= 12 || frames.length > 11 || seen.has(node) || budget <= 0) {
        return;
      }
      budget -= 1;
      if (entryKeys.has(node)) {
        const signature = frames.map((f) => `${f.file}:${f.line}`).join("|");
        // Each route differs in its first hop, so the same shortcut does not crowd out the
        // paths through helpers.
        const firstHop = frames[0] ? `${frames[0].file}:${frames[0].line}` : "";
        if (!signatures.has(signature) && ![...signatures].some((s) => s.startsWith(firstHop + "|") || s === firstHop)) {
          signatures.add(signature);
          paths.push({ entry: node, frames: [...frames] });
        }
        return;
      }
      for (const edge of reverse.get(node) || []) {
        walk(
          edge.from,
          [
            {
              function: lastSegment(edge.from),
              file: edge.file,
              line: edge.line,
              ...(edge.column ? { column: edge.column } : {})
            },
            ...frames
          ],
          new Set([...seen, node])
        );
        if (paths.length >= 12) {
          return;
        }
      }
    };
    walk(method, [], new Set());
    return paths.sort((a, b) => a.frames.length - b.frames.length);
  };
  // Every distinct route is reported once, at its own sink: shortest first, and among
  // equal lengths the sink of the final call of the chain wins, which is where the chain
  // ends. No library owner keeps more than three stacks.
  const candidates = [];
  for (const sink of sinks) {
    for (const path of pathsOf(sink.caller)) {
      const entryDef = ctx.defsByKey.get(path.entry);
      const frames = [
        ...(entryDef
          ? [{ function: lastSegment(path.entry), file: entryDef.file, line: entryDef.line }]
          : []),
        ...path.frames,
        {
          function: lastSegment(sink.caller),
          file: sink.file,
          line: sink.line,
          ...(sink.column ? { column: sink.column } : {})
        }
      ];
      if (frames.length > 12) {
        continue;
      }
      candidates.push({
        sink,
        frames,
        route: frames.map((f) => `${f.file}:${f.line}`).join("|")
      });
    }
  }
  // One route is reported once, attached to the sink of the final call of the chain, and a
  // library owner keeps at most three stacks in total.
  const byRoute = new Map();
  for (const candidate of candidates) {
    if (!byRoute.has(candidate.route)) {
      byRoute.set(candidate.route, []);
    }
    byRoute.get(candidate.route).push(candidate);
  }
  const routes = [...byRoute.values()];
  for (const group of routes) {
    group.sort(
      (a, b) =>
        b.sink.line - a.sink.line || a.sink.file.localeCompare(b.sink.file)
    );
  }
  routes.sort(
    (a, b) => a[0].frames.length - b[0].frames.length || b[0].sink.line - a[0].sink.line
  );
  const stacks = [];
  const ownerCounts = new Map();
  for (const group of routes) {
    for (const candidate of group) {
      const ownerCount = ownerCounts.get(candidate.sink.owner) || 0;
      if (ownerCount >= 3) {
        continue;
      }
      ownerCounts.set(candidate.sink.owner, ownerCount + 1);
      stacks.push({
        sink: {
          owner: candidate.sink.owner,
          name: candidate.sink.name,
          file: candidate.sink.file,
          line: candidate.sink.line
        },
        frames: candidate.frames
      });
      break;
    }
  }
  return stacks.sort(
    (a, b) => a.sink.file.localeCompare(b.sink.file) || a.sink.line - b.sink.line
  );
}

/** The method key of an entry reference, when the referenced definition is a method. */
function methodKeyOf(ctx, ref, entry) {
  if (ctx.defsByKey.has(ref)) {
    return ref;
  }
  // A play action names `pkg.Class.method`; find it among the definitions of the file.
  for (const [key, def] of ctx.defsByKey) {
    if (def.file === entry.file && key.replace(/\$$/, "").endsWith(ref.replace(/\.$/, ""))) {
      return key;
    }
  }
  return undefined;
}

/**
 * Derive every evidence kind of a report.
 *
 * @param {Object} ctx Derivation context
 * @returns {{ crypto: Object[], endpoints: Object[], services: Object[], entryPoints: Object[], callGraph: Object, callStacks: Object[] }}
 */
export function deriveEvidence(ctx) {
  const endpoints = deriveEndpoints(ctx);
  const entryPoints = deriveEntryPoints(ctx, endpoints);
  const graph = deriveCallGraph(ctx);
  const callStacks = deriveCallStacks(ctx, entryPoints, graph);
  return {
    crypto: deriveCrypto(ctx),
    endpoints,
    services: deriveServices(ctx),
    entryPoints,
    callGraph: { edges: graph.edges },
    callStacks
  };
}
