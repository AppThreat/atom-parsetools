// Crypto findings: the algorithms the API calls of the rule table name.

import {
  MAX_BOUNDARIES,
  annotationNamesOf,
  classRoot,
  lastSegment,
  loadRules,
  ownerMatches,
  ownerPrefixMatches
} from "./context.js";
import { resolveArgument } from "./values.js";

/** The algorithm family: the first transform segment, upper cased. */
function algorithmFamily(algorithm) {
  return String(algorithm || "")
    .split("/")[0]
    .toUpperCase();
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
      if (!ownerMatches(api.owner, call.owner)) {
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
        (classRoot(call.owner) === enrichment.ownerPrefix ||
          ownerPrefixMatches(enrichment.ownerPrefix, call.owner))
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
        rules.algorithmRefs.some(
          (ref) =>
            call.owner.startsWith(ref.apiPrefix) ||
            call.owner.startsWith(ref.apiPrefix.replaceAll("$.", "."))
        )
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
        // SemanticDB flattens the companion marker, so both spellings of the prefix match.
        const prefixes = [
          table.symbolPrefix,
          table.symbolPrefix.replaceAll("$.", ".")
        ];
        const prefix = prefixes.find((p) => ref.symbol.startsWith(p));
        if (!prefix) {
          continue;
        }
        const algorithm = ref.symbol.slice(prefix.length);
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
  derivePassword4jCrypto(ctx, rules, emit);
  return findings
    .filter((f) => f.algorithm || f.resolution === "unresolved")
    .map((finding) => {
      const {
        callerRef: _caller,
        apiOwner: _owner,
        ...publicFinding
      } = finding;
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
    if (
      enrichment.family &&
      algorithmFamily(finding.algorithm) !== enrichment.family
    ) {
      continue;
    }
    if (enrichment.primitive && finding.primitive !== enrichment.primitive) {
      continue;
    }
    if (
      !enrichment.family &&
      !enrichment.primitive &&
      !ownerPrefixMatches(enrichment.ownerPrefix, finding.apiOwner)
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
  if (
    segments.length > 1 &&
    rules.weakModes.includes(segments[1].toUpperCase())
  ) {
    finding.weak = true;
  }
  if (
    finding.mode &&
    rules.weakModes.includes(String(finding.mode).toUpperCase())
  ) {
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
      if (def.kind !== "object") {
        continue;
      }
      const names = annotationNamesOf(def);
      if (!names.length) {
        continue;
      }
      const isExtern = names.some(
        (name) =>
          name === externs.externAnnotation ||
          (name.includes("scalanative") && name.endsWith(".extern"))
      );
      if (!isExtern) {
        continue;
      }
      const link = (def.annotations || []).find(
        (a) =>
          a.name === externs.linkAnnotation ||
          a.name === "scala.scalanative.unsafe.link"
      );
      const linkName = names.find((name) =>
        name.endsWith("scalanative.unsafe.link")
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
      if (
        !dynamicLines.has(call.line) ||
        call.owner === table.ownerPrefix.slice(0, -1)
      ) {
        continue;
      }
      const text = (call.args || [])
        .filter(
          (a) => typeof a.string === "string" || typeof a.const === "string"
        )
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
        ...(/^(md2|md4|md5|sha-?1|des|rc4)/i.test(algorithm)
          ? { weak: true }
          : {}),
        file,
        line
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
  const rules = loadRules("crypto");
  const externs = rules.externObjects;
  const bindings = [];
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
      const owners = new Set([
        `${def.owner}.${def.name}`,
        `${def.owner}.${def.name.replace(/\$$/, "")}$`
      ]);
      const seen = new Set();
      for (const method of facts.definitions || []) {
        if (!owners.has(method.owner) || method.name === "<init>") {
          continue;
        }
        const key = `${method.owner}.${method.name}.${method.line}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        bindings.push({
          ...(library ? { library: String(library) } : {}),
          symbol: method.name,
          owner: method.owner,
          file,
          line: method.line
        });
      }
    }
  }
  return bindings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}

/** password4j chains: the algorithm the `with` step or the factory names. */
function derivePassword4jCrypto(ctx, rules, emit) {
  const table = rules.password4j;
  if (!table) {
    return;
  }
  for (const call of ctx.allCalls) {
    if (!table.methodNames.includes(call.name)) {
      continue;
    }
    const ident = (call.args || []).find(
      (a) => typeof a.ident === "string" && table.identAlgorithms[a.ident]
    );
    const algorithm = ident && table.identAlgorithms[ident.ident];
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
  for (const call of ctx.allCalls) {
    if (call.name !== "getInstance") {
      continue;
    }
    const factory = Object.entries(table.factoryAlgorithms).find(([owner]) =>
      ownerPrefixMatches(`${table.ownerPrefix}.${owner}`, call.owner)
    );
    if (factory) {
      emit({
        algorithm: factory[1],
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
