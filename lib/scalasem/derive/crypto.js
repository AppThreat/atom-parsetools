// Crypto findings: the algorithms the API calls of the rule table name, with the mode,
// padding, key size and curve their configuration calls add, and the native and JavaScript
// crypto entry points of Scala Native and Scala.js builds.
import {
  CANONICAL_ALGORITHMS,
  algorithmText,
  canonicalName,
  cipherPrimitive,
  isWeak,
  parseTransformation
} from "./algorithms.js";
import {
  annotationNamesOf,
  loadRules,
  ownerMatches,
  ownerPrefixMatches
} from "./context.js";
import { argumentAt, resolveArgument } from "./values.js";

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
      finding.name,
      finding.api,
      finding.kind
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(finding);
    }
    return finding;
  };
  // The findings of each API call, by the call, so configuration calls can find the
  // instance they configure.
  const produced = [];
  for (const call of ctx.allCalls) {
    if (!call.owner || !call.name) {
      continue;
    }
    for (const api of rules.apis) {
      if (
        !ownerMatches(api.owner, call.owner) ||
        (api.name && call.name !== api.name) ||
        (api.nameIn && !api.nameIn.includes(call.name))
      ) {
        continue;
      }
      for (const finding of findingsOfCall(ctx, rules, call, api)) {
        produced.push({ call, finding: emit(finding) });
      }
    }
  }
  enrich(ctx, rules, produced);
  algorithmReferences(ctx, rules, emit);
  nativeCrypto(ctx, rules, emit);
  jsDynamicCrypto(ctx, rules, emit);
  password4jCrypto(ctx, rules, emit);
  return findings
    .map((finding) => (isWeak(finding) ? { ...finding, weak: true } : finding))
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        String(a.algorithm || a.name).localeCompare(String(b.algorithm || b.name))
    );
}

/** The findings of one call that matches an API rule. */
function findingsOfCall(ctx, rules, call, api) {
  const base = {
    ...(api.primitive ? { primitive: api.primitive } : {}),
    kind: api.kind || "algorithm",
    api: api.api,
    provider: providerOf(ctx, rules, call, api),
    file: call.file,
    line: call.line
  };
  if (api.algorithm) {
    return [{ ...base, algorithm: api.algorithm, resolution: "literal" }];
  }
  if (api.bitsPrefix) {
    const bits = numberArgument(ctx, call, api.arg);
    const algorithm =
      bits !== undefined ? `${api.bitsPrefix}${bits}` : argumentAt(call, api.arg) ? undefined : api.default;
    return [
      algorithm
        ? { ...base, algorithm: canonicalName(algorithm), resolution: "literal" }
        : { ...base, resolution: "unresolved" }
    ];
  }
  if (api.identPrefix) {
    const arg = argumentAt(call, api.arg);
    const ident = arg?.ident || arg?.sym?.split(".").pop();
    if (ident?.startsWith(api.identPrefix)) {
      const variant = ident.slice(api.identPrefix.length).toLowerCase();
      return [
        {
          ...base,
          algorithm: canonicalName(`${api.canonicalPrefix}${variant}`),
          resolution: "literal"
        }
      ];
    }
    return [{ ...base, resolution: "unresolved" }];
  }
  const values =
    api.parse === "object-literal"
      ? objectLiteralValues(ctx, call, api.arg)
      : resolveArgument(ctx, call, api.arg).values;
  if (!values.length) {
    return hasSiblingValue(ctx, call, api.arg)
      ? []
      : [{ ...base, resolution: "unresolved" }];
  }
  return values.map((value) => {
    const travelled = value.resolution === "argument" && value.via.length;
    const site = travelled ? value.via[value.via.length - 1] : undefined;
    const at = {
      ...base,
      ...(site ? { file: site.file, line: site.line } : {}),
      ...(value.via.length ? { via: value.via } : {})
    };
    const text = algorithmText(value.value);
    if (!text) {
      return { ...at, resolution: "unresolved" };
    }
    const resolution = value.resolution === "config" ? "constant" : value.resolution;
    if (api.parse === "transformation") {
      const parts = parseTransformation(text);
      return {
        ...at,
        ...parts,
        primitive: cipherPrimitive(parts, base.primitive),
        resolution
      };
    }
    return { ...at, algorithm: canonicalName(text), resolution };
  });
}

/** The integer value of an argument: a literal, or a constant within the propagation bound. */
function numberArgument(ctx, call, index) {
  const value = resolveArgument(ctx, call, index).values.find(
    (v) => typeof v.value === "number"
  );
  return value?.value;
}

/**
 * The algorithm name of a WebCrypto argument: a string, or the `name` of an algorithm object
 * built inline, whose literal arguments the facts keep.
 */
function objectLiteralValues(ctx, call, index) {
  const resolved = resolveArgument(ctx, call, index).values;
  if (resolved.length) {
    return resolved;
  }
  const nested = (call.args || []).find(
    (a) => a.index === index && a.call && Array.isArray(a.args)
  );
  const name = nested?.args.find(
    (piece) => typeof piece === "string" && algorithmText(piece)
  );
  return name ? [{ value: name, resolution: "literal", via: [] }] : [];
}

/** True when another fact of the same call position carries the literal itself. */
function hasSiblingValue(ctx, call, index) {
  if (!ctx.callsAtPosition) {
    ctx.callsAtPosition = new Map();
    for (const other of ctx.allCalls) {
      const key = `${other.file}:${other.line}:${other.column}:${other.owner}.${other.name}`;
      if (!ctx.callsAtPosition.has(key)) {
        ctx.callsAtPosition.set(key, []);
      }
      ctx.callsAtPosition.get(key).push(other);
    }
  }
  const key = `${call.file}:${call.line}:${call.column}:${call.owner}.${call.name}`;
  return (ctx.callsAtPosition.get(key) || []).some(
    (other) =>
      other !== call &&
      (other.args || []).some(
        (a) => a.index === index && typeof a.string === "string"
      )
  );
}

/**
 * The provider a JCA call names: a provider name argument, a provider instance built on the
 * same line, or the API's default.
 */
function providerOf(ctx, rules, call, api) {
  if (api.providerArg === undefined) {
    return api.provider;
  }
  const arg = argumentAt(call, api.providerArg);
  const text =
    typeof arg?.string === "string"
      ? arg.string
      : typeof arg?.const === "string"
        ? arg.const
        : undefined;
  if (text !== undefined) {
    return rules.providers[text] || algorithmText(text) || api.provider;
  }
  if (!arg) {
    return api.provider;
  }
  const facts = ctx.files.get(call.file);
  for (const other of facts?.calls || []) {
    if (other.line !== call.line || other.name !== "<init>") {
      continue;
    }
    for (const [owner, provider] of Object.entries(rules.providerOwners)) {
      if (ownerMatches(owner, other.owner)) {
        return provider;
      }
    }
  }
  return api.provider;
}

/**
 * Configuration calls add the key size, curve or tag length to the instance they configure:
 * `kpg.initialize(2048)` reaches the finding of the `getInstance` call that `kpg` holds, and
 * a parameter spec built in the call that consumes it reaches the consumer's instance. When
 * no instance can be named, a caller with a single matching finding takes it.
 */
function enrich(ctx, rules, produced) {
  const byDeclaration = new Map();
  const byCaller = new Map();
  for (const entry of produced) {
    const key = `${entry.call.file}:${entry.call.caller}:${entry.call.line}`;
    if (!byDeclaration.has(key)) {
      byDeclaration.set(key, []);
    }
    byDeclaration.get(key).push(entry.finding);
    const callerKey = `${entry.call.file}:${entry.call.caller}`;
    if (!byCaller.has(callerKey)) {
      byCaller.set(callerKey, []);
    }
    byCaller.get(callerKey).push(entry.finding);
  }
  const valLine = valLines(ctx);
  const instanceFindings = (file, caller, valName) => {
    const line = valLine.get(`${file}:${caller}.${valName}`);
    return line === undefined
      ? undefined
      : byDeclaration.get(`${file}:${caller}:${line}`);
  };
  for (const call of ctx.allCalls) {
    for (const rule of rules.enrichments) {
      if (
        call.name !== rule.name ||
        !ownerPrefixMatches(rule.ownerPrefix, call.owner)
      ) {
        continue;
      }
      const value = resolveArgument(ctx, call, rule.arg).values[0]?.value;
      if (value === undefined) {
        continue;
      }
      let targets;
      if (call.recv?.ident) {
        targets = instanceFindings(call.file, call.caller, call.recv.ident);
      } else {
        targets = consumerFindings(ctx, call, instanceFindings);
      }
      if (!targets) {
        const candidates = (byCaller.get(`${call.file}:${call.caller}`) || []).filter(
          (finding) => accepts(rule, finding)
        );
        targets = candidates.length === 1 ? candidates : [];
      }
      for (const finding of targets) {
        if (accepts(rule, finding)) {
          applyEnrichment(rule, finding, value);
        }
      }
    }
  }
}

/** The declaring line of every local value, by file, enclosing method and name. */
function valLines(ctx) {
  const lines = new Map();
  for (const [file, facts] of ctx.files) {
    for (const def of facts.definitions || []) {
      if (def.kind === "val") {
        lines.set(`${file}:${def.owner}.${def.name}`, def.line);
      }
    }
  }
  return lines;
}

/**
 * The findings of the instance a parameter spec is handed to: a call with a receiver on the
 * same line, or one that passes the value the spec was assigned to.
 */
function consumerFindings(ctx, spec, instanceFindings) {
  const calls = ctx.callsByCaller.get(spec.caller) || [];
  const sameLine = calls.find(
    (other) =>
      other !== spec &&
      other.file === spec.file &&
      other.line === spec.line &&
      other.recv?.ident
  );
  if (sameLine) {
    return instanceFindings(spec.file, spec.caller, sameLine.recv.ident);
  }
  const facts = ctx.files.get(spec.file);
  const assigned = (facts?.definitions || []).find(
    (def) =>
      def.kind === "val" && def.owner === spec.caller && def.line === spec.line
  );
  if (!assigned) {
    return undefined;
  }
  const consumer = calls.find(
    (other) =>
      other.recv?.ident &&
      (other.args || []).some((a) => a.ident === assigned.name)
  );
  return consumer
    ? instanceFindings(spec.file, spec.caller, consumer.recv.ident)
    : undefined;
}

/** An enrichment that names its algorithms applies to those only. */
function accepts(rule, finding) {
  return !rule.algorithms || rule.algorithms.includes(finding.algorithm);
}

function applyEnrichment(rule, finding, value) {
  if (rule.field === "keySize" && typeof value === "number") {
    finding.keySize = value;
  } else if (rule.field === "curve" && algorithmText(value)) {
    finding.curve = String(value);
  } else if (rule.field === "bits" && typeof value === "number") {
    finding.bits = value;
    if (rule.mode && !finding.mode) {
      finding.mode = rule.mode;
    }
  }
}

/**
 * Algorithm values that name themselves, `JwtAlgorithm.HS256`, on a line that calls the
 * library or on the declaration of a value such a call is given.
 */
function algorithmReferences(ctx, rules, emit) {
  for (const table of rules.algorithmRefs) {
    const allowed = new RegExp(table.names);
    const prefixes = [
      table.symbolPrefix,
      table.symbolPrefix.replaceAll("$.", ".")
    ];
    const library = table.symbolPrefix.split(".").slice(0, 2).join(".");
    for (const [file, facts] of ctx.files) {
      const apiLines = new Set();
      for (const call of facts.calls || []) {
        if (!call.owner?.startsWith(library)) {
          continue;
        }
        apiLines.add(call.line);
        // A value handed to the call counts on the line it is declared at.
        for (const arg of call.args || []) {
          const def = (facts.definitions || []).find(
            (d) => d.kind === "val" && d.name === arg.ident && d.owner === call.caller
          );
          if (def) {
            apiLines.add(def.line);
          }
        }
      }
      for (const ref of facts.references || []) {
        if (ref.refKind === "import" || !ref.symbol || !apiLines.has(ref.line)) {
          continue;
        }
        const prefix = prefixes.find((p) => ref.symbol.startsWith(p));
        const name = prefix && ref.symbol.slice(prefix.length);
        if (!name || !allowed.test(name)) {
          continue;
        }
        const primitive = Object.entries(table.primitiveByPrefix).find(([p]) =>
          name.startsWith(p)
        )?.[1];
        emit({
          algorithm: canonicalName(name),
          ...(primitive ? { primitive } : {}),
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
}

/** The objects a Scala Native build declares `@extern`, with the library each links. */
export function externObjects(ctx) {
  const externs = loadRules("crypto").externObjects;
  const objects = new Map();
  for (const [file, facts] of ctx.files) {
    for (const def of facts.definitions || []) {
      if (def.kind !== "object") {
        continue;
      }
      const names = annotationNamesOf(def);
      const isExtern = names.some(
        (n) =>
          n === externs.externAnnotation ||
          (n.includes("scalanative") && n.endsWith(".extern"))
      );
      if (!isExtern) {
        continue;
      }
      const link = (def.annotations || []).find(
        (a) =>
          a.name === externs.linkAnnotation ||
          a.name === "scala.scalanative.unsafe.link"
      );
      const library = link?.args?.[0] ? String(link.args[0]) : undefined;
      for (const owner of [
        `${def.owner}.${def.name}`,
        `${def.owner}.${def.name.replace(/\$$/, "")}$`
      ]) {
        objects.set(owner, { library, file, def });
      }
    }
  }
  return objects;
}

/**
 * Native crypto: the extern methods that name an algorithm, the calls of those, the fetch
 * functions whose argument names one, and the other crypto entry points the code calls,
 * which are named by the function when the algorithm is not known.
 */
function nativeCrypto(ctx, rules, emit) {
  const externs = rules.externObjects;
  const objects = externObjects(ctx);
  if (!objects.size) {
    return;
  }
  const cryptoFunction = new RegExp(externs.cryptoFunctions);
  for (const [file, facts] of ctx.files) {
    for (const method of facts.definitions || []) {
      const object = objects.get(method.owner);
      const known = externs.algorithmMethods[method.name];
      if (!object || !known) {
        continue;
      }
      emit({
        ...known,
        kind: "native-binding",
        name: method.name,
        api: object.library || "native",
        provider: "scala-native",
        resolution: "literal",
        file,
        line: method.line
      });
    }
  }
  for (const call of ctx.allCalls) {
    const object = objects.get(call.owner);
    if (!object) {
      continue;
    }
    const base = {
      kind: "native-call",
      name: call.name,
      api: object.library || "native",
      provider: "scala-native",
      file: call.file,
      line: call.line
    };
    const known = externs.algorithmMethods[call.name];
    if (known) {
      emit({ ...base, ...known, resolution: "literal" });
      continue;
    }
    const index = externs.nameArguments[call.name];
    if (index !== undefined) {
      const text = algorithmText(nativeStringArgument(call, index));
      if (text) {
        const parts = parseTransformation(text);
        emit({ ...base, ...parts, resolution: "literal" });
        continue;
      }
    }
    if (cryptoFunction.test(call.name)) {
      emit({ ...base, resolution: "unresolved" });
    }
  }
}

/** A string argument of a native call: a literal, or the literal a C string is built from. */
function nativeStringArgument(call, index) {
  for (const arg of call.args || []) {
    if (arg.index !== index) {
      continue;
    }
    if (typeof arg.string === "string") {
      return arg.string;
    }
    if (typeof arg.const === "string") {
      return arg.const;
    }
    if (arg.call && Array.isArray(arg.args)) {
      const text = arg.args.find((piece) => typeof piece === "string");
      if (text) {
        return text;
      }
    }
    if (Array.isArray(arg.parts) && arg.parts.every((p) => typeof p === "string")) {
      return arg.parts.join("");
    }
  }
  return undefined;
}

/**
 * Dynamic member access on the Node crypto module, `crypto.createHash("md5")` in Scala.js.
 * The member name and the arguments of one dynamic application are two applications at the
 * same position: the name first, the converted arguments after it.
 */
function jsDynamicCrypto(ctx, rules, emit) {
  const table = rules.jsDynamic;
  for (const [file, facts] of ctx.files) {
    const byPosition = new Map();
    for (const call of facts.calls || []) {
      if (!call.owner?.startsWith(table.ownerPrefix)) {
        continue;
      }
      const key = `${call.line}:${call.column}`;
      const entry = byPosition.get(key) || { line: call.line, values: [] };
      for (const arg of call.args || []) {
        if (arg.index === 0 && typeof arg.string === "string") {
          entry.member = arg.string;
        } else if (arg.index > 0) {
          const text =
            typeof arg.string === "string"
              ? arg.string
              : typeof arg.const === "string"
                ? arg.const
                : arg.call && Array.isArray(arg.args)
                  ? arg.args.find((piece) => typeof piece === "string")
                  : undefined;
          if (text !== undefined) {
            entry.values.push(text);
          }
        }
      }
      byPosition.set(key, entry);
    }
    for (const { member, values, line } of byPosition.values()) {
      if (!table.memberNames.includes(member)) {
        continue;
      }
      const parts = values
        .map((value) => algorithmText(value))
        .filter(Boolean)
        .map((text) => parseTransformation(text))
        .find((candidate) => CANONICAL_ALGORITHMS.includes(candidate.algorithm));
      if (!parts) {
        continue;
      }
      emit({
        ...parts,
        primitive: cipherPrimitive(parts, table.primitiveOf[member]),
        kind: "algorithm",
        api: table.api,
        provider: table.provider,
        resolution: "literal",
        file,
        line
      });
    }
  }
}

/** password4j chains: the algorithm a `with...` step or a hashing function factory names. */
function password4jCrypto(ctx, rules, emit) {
  const table = rules.password4j;
  for (const call of ctx.allCalls) {
    if (!call.owner || !ownerPrefixMatches(table.ownerPrefix, call.owner)) {
      continue;
    }
    let algorithm = table.methodNames[call.name];
    if (!algorithm && call.name === "getInstance") {
      algorithm = Object.entries(table.factoryAlgorithms).find(([owner]) =>
        ownerMatches(`${table.ownerPrefix}.${owner}`, call.owner)
      )?.[1];
    }
    if (algorithm) {
      emit({
        algorithm,
        primitive: "kdf",
        kind: "algorithm",
        api: table.api,
        provider: table.provider,
        resolution: "literal",
        file: call.file,
        line: call.line
      });
    }
  }
}

/**
 * Native bindings of Scala Native extern objects: every method of an `@extern` object,
 * with the library its `@link` annotation names.
 *
 * @param {Object} ctx Derivation context
 * @returns {Object[]}
 */
export function deriveNativeBindings(ctx) {
  const bindings = [];
  const seen = new Set();
  const objects = externObjects(ctx);
  for (const [file, facts] of ctx.files) {
    for (const method of facts.definitions || []) {
      const object = objects.get(method.owner);
      if (!object || object.file !== file || method.name === "<init>") {
        continue;
      }
      const key = `${method.owner}.${method.name}.${method.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      bindings.push({
        ...(object.library ? { library: object.library } : {}),
        symbol: method.name,
        owner: method.owner,
        file,
        line: method.line
      });
    }
  }
  return bindings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}
