// Inbound endpoints: the routes of the route files and the framework DSLs.

import {
  HTTP_VERBS,
  loadRules,
  ownerPrefixMatches,
  skipGenerated
} from "./context.js";

/** Normalize a route path: `:id`, `$id` and `*rest` become `{...}` placeholders. */
export function normalizePath(pattern) {
  return (
    String(pattern || "")
      .replace(/:[A-Za-z_][\w.-]*/g, (m) => `{${m.slice(1)}}`)
      .replace(/\*[A-Za-z_][\w.-]*/g, (m) => `{${m.slice(1)}}`)
      .replace(/\$\{?([A-Za-z_]\w*)\}?/g, "{$1}")
      .replace(/\/+$/, "") || "/"
  );
}

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
    if (
      !endpoints.some(
        (e) =>
          e.path === endpoint.path &&
          e.method === endpoint.method &&
          e.file === endpoint.file &&
          e.line === endpoint.line
      )
    ) {
      endpoints.push(endpoint);
    }
  };

  // Play: the routes configuration is the framework's own table; generated routers under
  // target would only repeat it.
  for (const route of ctx.config.routes || []) {
    // A mounted route is declared in its own file, with its own pattern, and reached
    // through its mount point with the mount prefix; both name it.
    emit({
      framework: "play",
      method: route.method,
      path: normalizePath(route.pattern),
      handler: route.controllerMethod,
      file: route.file,
      line: route.line,
      ...(route.router ? { router: route.router } : {})
    });
    if (route.mountFile) {
      const localPattern = route.declaredPattern || route.pattern;
      emit({
        framework: "play",
        method: route.method,
        path: normalizePath(localPattern),
        handler: route.controllerMethod,
        file: route.file,
        line: route.line
      });
      emit({
        framework: "play",
        method: route.method,
        path: normalizePath(route.pattern),
        handler: route.controllerMethod,
        file: route.mountFile,
        line: route.mountLine
      });
    }
  }

  for (const [file, facts] of ctx.files) {
    if (skipGenerated(file)) {
      continue;
    }
    if (facts.factsSource === "semanticdb") {
      // The Scala 2 builder DSLs fold into implicit conversions the occurrences do not
      // carry, so the routes come from the source lines the references sit on; the
      // directive trees of Akka and Pekko and the Scalatra actions read the same from
      // either reader.
      semanticdbLineEndpoints(rules, file, facts, emit);
      pekkoEndpoints(rules.pekko, file, facts, emit);
      scalatraEndpoints(rules.scalatra, file, facts, emit);
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
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.path.localeCompare(b.path)
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
    byCaller
      .get(callerKey)
      .set(key, { segment, line: call.line, column: call.column });
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
      return (
        HTTP_VERBS.includes(name) &&
        ref.line >= first - 1 &&
        ref.line <= last + 1
      );
    });
    const verb =
      verbRefs.find((ref) => ref.line >= first && ref.line <= last) ||
      verbRefs[0];
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
  const arrowLines = new Set();
  for (const pattern of facts.patterns || []) {
    if (/[.-]\$\.unapply$/.test(pattern.owner)) {
      arrowLines.add(pattern.line);
    }
    if (
      pattern.owner !== rules.segmentOwner &&
      pattern.owner !== rules.captureOwner
    ) {
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
    if (
      ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        verb
      )
    ) {
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
      .find(
        (a) => typeof a.string === "string" && a.string.startsWith("/")
      )?.string;
    const mounted = (facts.calls || [])
      .filter((other) => other.line === call.line && other.name === "->")
      .flatMap((other) => other.args || [])
      .find((a) => typeof a.ident === "string")?.sym;
    if (prefix && mounted) {
      prefixes.set(mounted, prefix);
    }
  }
  const callerPrefixOf = (line) => {
    const caller = (facts.calls || []).find(
      (call) => call.line === line
    )?.caller;
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
        return (pattern.args || []).filter((a) => typeof a === "string");
      });
    if (!segments.length && !arrowLines.has(line)) {
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

/** Route DSLs over source lines, for facts that come from SemanticDB. */
function semanticdbLineEndpoints(rules, file, facts, emit) {
  const stringsByLine = new Map();
  for (const token of facts.lineStrings || []) {
    if (!stringsByLine.has(token.line)) {
      stringsByLine.set(token.line, []);
    }
    stringsByLine.get(token.line).push(token);
  }
  const identsByLine = new Map();
  for (const token of facts.lineIdents || []) {
    if (!identsByLine.has(token.line)) {
      identsByLine.set(token.line, []);
    }
    identsByLine.get(token.line).push(token);
  }
  const linesOf = (prefix, dotPrefix) =>
    new Set(
      (facts.references || [])
        .filter(
          (ref) =>
            ref.symbol.startsWith(prefix) || ref.symbol.startsWith(dotPrefix)
        )
        .map((ref) => ref.line)
    );

  // cask: the annotation names the verb; the path literal sits on the annotation line.
  for (const def of facts.definitions || []) {
    for (const name of def.annotationNames || []) {
      const verb = Object.entries(rules.cask.verbs).find(([key]) => {
        const suffix = name.split("/").pop() || "";
        return (
          suffix === key ||
          suffix.startsWith(`${key}.`) ||
          suffix.startsWith(`${key}#`)
        );
      })?.[1];
      if (!verb) {
        continue;
      }
      for (let line = def.line - 2; line <= def.line; line++) {
        const path = (stringsByLine.get(line) || []).find((token) =>
          token.value.startsWith("/")
        )?.value;
        if (path) {
          emit({
            framework: "cask",
            method: verb,
            path: normalizePath(path),
            handler: `${def.owner}.${def.name}`,
            file,
            line
          });
          break;
        }
      }
    }
  }

  // tapir: fixed segments are the path literals, the name of a capture follows the
  // `path` combinator.
  const tapirLines = linesOf("sttp.tapir.", "sttp.tapir.");
  const tapirVerbLines = new Set(
    (facts.references || [])
      .filter((ref) =>
        /sttp\.tapir\.(EndpointInputsOps|Endpoints).*(get|post|put|delete|patch)/.test(
          ref.symbol
        )
      )
      .map((ref) => ref.line)
  );
  for (const line of tapirLines) {
    const strings = stringsByLine.get(line) || [];
    if (!strings.length) {
      continue;
    }
    const captureIdents = (identsByLine.get(line) || []).filter((t) =>
      ["path", "paths", "query", "header", "cookie"].includes(t.name)
    );
    // The route ends where the outputs begin; body literals are not segments.
    const outColumn = (facts.references || []).find(
      (ref) => ref.line === line && /EndpointOutputsOps/.test(ref.symbol)
    )?.column;
    const routeStrings = strings.filter(
      (t) => !outColumn || t.column < outColumn
    );
    if (!routeStrings.length) {
      continue;
    }
    const segments = [];
    for (const token of routeStrings.sort((a, b) => a.column - b.column)) {
      const capture = captureIdents.some(
        (ident) => ident.column < token.column
      );
      segments.push(
        capture ? `{${token.value.replace(/\/$/, "")}}` : token.value
      );
    }
    const verbRefs = (facts.references || []).filter((ref) =>
      ref.symbol.match(/\.(get|post|put|delete|patch)$/)
    );
    const verbRef =
      verbRefs.find((ref) => ref.line === line) ||
      verbRefs.find((ref) => ref.line >= line - 1 && ref.line <= line + 2);
    emit({
      framework: "tapir",
      method: verbRef ? verbRef.symbol.split(".").pop().toUpperCase() : "GET",
      path: normalizePath(`/${segments.join("/")}`),
      handler: defOwnerOf(facts, line),
      file,
      line
    });
  }

  // http4s: the path literals of the pattern line, with the router prefix.
  const http4sLines = linesOf("org.http4s.", "org.http4s.");
  const prefixes = new Map();
  for (const line of linesOf(
    "org.http4s.server.Router",
    "org.http4s.server.Router"
  )) {
    const prefix = (stringsByLine.get(line) || []).find((t) =>
      t.value.startsWith("/")
    )?.value;
    if (prefix) {
      prefixes.set(line, prefix);
    }
  }
  const mountedPrefix = [...prefixes.values()][0];
  for (const line of http4sLines) {
    if ((identsByLine.get(line) || []).some((t) => t.name === "Router")) {
      continue;
    }
    const verbRef = (facts.references || []).find(
      (ref) =>
        ref.line === line &&
        /\.Methods\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(ref.symbol)
    );
    const hasPattern = (facts.references || []).some(
      (ref) =>
        ref.line === line &&
        /(dsl\/impl\/package\.)?\/$|PathVar|Root|dsl/.test(ref.symbol)
    );
    const strings = stringsByLine.get(line) || [];
    const captures = (identsByLine.get(line) || []).filter((t) =>
      ["IntVar", "LongVar", "UUIDVar", "StringVar"].includes(t.name)
    );
    const isRootOnly =
      hasPattern &&
      !strings.length &&
      !captures.length &&
      (facts.references || []).some(
        (ref) => ref.line === line && ref.symbol.endsWith(".Root")
      );
    if (!hasPattern || (!strings.length && !captures.length && !isRootOnly)) {
      continue;
    }
    const pieces = [
      ...strings.map((t) => ({ column: t.column, text: t.value })),
      ...captures.map((t) => ({ column: t.column, text: "{}" }))
    ].sort((a, b) => a.column - b.column);
    emit({
      framework: "http4s",
      method: verbRef ? verbRef.symbol.split(".").pop() : "GET",
      path: normalizePath(
        `${mountedPrefix || ""}/${pieces.map((p) => p.text).join("/")}`
      ),
      handler: defOwnerOf(facts, line),
      file,
      line
    });
  }

  // ZIO HTTP: the route line carries its segments and the verb.
  const zioLines = linesOf("zio.http.", "zio.http.");
  for (const line of zioLines) {
    const strings = stringsByLine.get(line) || [];
    if (!strings.length) {
      continue;
    }
    const captureIdents = (identsByLine.get(line) || []).filter((t) =>
      ["int", "string", "long", "boolean", "uuid", "literal"].includes(t.name)
    );
    // The route pattern ends at the arrow; response literals are not segments.
    const arrowColumn = (facts.references || []).find(
      (ref) => ref.line === line && ref.symbol.includes("RoutePattern")
    )?.column;
    const routeStrings = strings.filter(
      (t) => !arrowColumn || t.column < arrowColumn
    );
    if (!routeStrings.length) {
      continue;
    }
    const segments = [];
    for (const token of routeStrings.sort((a, b) => a.column - b.column)) {
      const capture = captureIdents.some(
        (ident) => ident.column < token.column
      );
      segments.push(
        capture ? `{${token.value.replace(/\/$/, "")}}` : token.value
      );
    }
    const verbRef = (facts.references || []).find(
      (ref) => ref.line === line && /zio\.http\.Method\./.test(ref.symbol)
    );
    emit({
      framework: "zio-http",
      method: verbRef ? verbRef.symbol.split(".").pop().toUpperCase() : "GET",
      path: normalizePath(`/${segments.join("/")}`),
      handler: defOwnerOf(facts, line),
      file,
      line
    });
  }
}

/** The owner of the definition a line belongs to. */
function defOwnerOf(facts, line) {
  let best;
  for (const def of facts.definitions || []) {
    if (def.line <= line && (!best || def.line > best.line)) {
      best = def;
    }
  }
  return best ? `${best.owner}.${best.name}` : undefined;
}

/** The line the enclosing definition of a line is declared at. */
function declarationLineOf(facts, line) {
  let best;
  for (const def of facts.definitions || []) {
    if (def.line <= line && (!best || def.line > best.line)) {
      best = def;
    }
  }
  return best?.line;
}

/** Akka and Pekko: directive trees read in source order, the indentation carries the
 * nesting. The typed tree folds `pathPrefix("x")` into an application of the directive
 * value, so the path kinds come from references to the directive methods and the string
 * segments from the implicit matcher construction calls that follow them.
 */
function pekkoEndpoints(rules, file, facts, emit) {
  const fileHandler = facts.definitions?.length
    ? `${(facts.definitions.find((d) => d.kind === "object") || {}).owner}.${
        (facts.definitions.find((d) => d.kind === "object") || {}).name
      }`
    : undefined;
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
    const framework = frameworkPrefix.includes("pekko")
      ? "pekko-http"
      : "akka-http";
    const verb =
      /\.MethodDirectives\.(get|post|put|delete|patch|head|options)$/.exec(
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
    const pathKind =
      /\.PathDirectives\.(path|pathPrefix|pathEnd|pathEndOrSingleSlash|pathSingleSlash)$/.exec(
        ref.symbol
      )?.[1];
    if (!pathKind) {
      continue;
    }
    if (
      pathKind === "pathEnd" ||
      pathKind === "pathEndOrSingleSlash" ||
      pathKind === "pathSingleSlash"
    ) {
      pushDirective(framework, "pathEnd", [], {
        line: ref.line,
        column: ref.column
      });
      continue;
    }
    // The string segments of a prefix or path arrive through the implicit matcher
    // construction of the same source line, or as the arguments of the call at the
    // directive's own position, which is the form Scala 2 facts take.
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
    if (!segments.length) {
      const atPosition = (facts.calls || []).find(
        (call) =>
          call.line === ref.line &&
          call.column === ref.column &&
          call.name === pathKind
      );
      if (atPosition) {
        segments.push(...pathSegmentsOf(atPosition, rules));
      }
    }
    // The directive application that starts at this position extends over the block it
    // takes; its last line closes the scope of a prefix.
    const scopeEnd = Math.max(
      0,
      ...(facts.calls || [])
        .filter((call) => call.line === ref.line && call.column === ref.column)
        .map((call) => call.endLine || 0)
    );
    pushDirective(framework, pathKind, segments, {
      line: ref.line,
      column: ref.column,
      ...(scopeEnd > ref.line ? { endLine: scopeEnd } : {})
    });
  }
  // A direct `path(matcher)` or `pathPrefix(matcher)` call keeps its arguments.
  for (const call of facts.calls || []) {
    const frameworkPrefix = rules.ownerPrefixes.find((prefix) =>
      call.owner.startsWith(prefix)
    );
    if (
      frameworkPrefix &&
      (call.owner.includes("PathDirectives") ||
        ownerPrefixMatches(
          "akka.http.scaladsl.server.directives",
          call.owner
        ) ||
        ownerPrefixMatches(
          "org.apache.pekko.http.scaladsl.server.directives",
          call.owner
        )) &&
      ["path", "pathPrefix"].includes(call.name)
    ) {
      pushDirective(
        frameworkPrefix.includes("pekko") ? "pekko-http" : "akka-http",
        call.name,
        pathSegmentsOf(call, rules),
        {
          line: call.line,
          column: call.column,
          endLine: call.endLine,
          fromCall: true
        }
      );
    }
  }
  directives.sort((a, b) => a.line - b.line || a.column - b.column);
  const ownerDef = (facts.definitions || []).find((d) => d.kind === "object");
  const routeOwner = ownerDef
    ? `${ownerDef.owner}.${ownerDef.name}`
    : undefined;
  // A direct `path(matcher)` call and the reference to the same method share a position;
  // the call keeps the real arguments.
  const uniqueDirectives = [];
  for (const directive of directives) {
    const same = uniqueDirectives.find(
      (d) =>
        d.line === directive.line &&
        d.column === directive.column &&
        d.kind === directive.kind
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
      const verbDirective = verbAfterDirective(uniqueDirectives, index);
      const verb = verbDirective?.verb;
      emitted.push({
        framework: directive.framework,
        method: verb || "GET",
        path: normalizePath(`/${parts.join("/")}`),
        handler: routeOwner,
        file,
        line
      });
      // A verb on its own line declares the route as much as the path directive does.
      if (verbDirective && verbDirective.line > line) {
        emitted.push({
          framework: directive.framework,
          method: verb,
          path: normalizePath(`/${parts.join("/")}`),
          handler: routeOwner,
          file,
          line: verbDirective.line
        });
      }
    };
    if (directive.kind === "pathPrefix") {
      // A prefix reaches the path directives nested under it: everything after it that
      // starts further right, until a directive at the same or lower column.
      for (let j = i + 1; j < uniqueDirectives.length; j++) {
        if (
          uniqueDirectives[j].column <= directive.column ||
          uniqueDirectives[j].line < directive.line ||
          (directive.endLine !== undefined &&
            uniqueDirectives[j].line > directive.endLine)
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
  return verbAfterDirective(group, index)?.verb;
}

function verbAfterDirective(group, index) {
  const directive = group[index];
  for (let j = index + 1; j < group.length; j++) {
    if (group[j].kind === "verb") {
      return group[j];
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
      segments.push(
        ...arg.parts
          .filter((p) => typeof p === "string" && p)
          .join("")
          .split("/")
          .filter(Boolean)
      );
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

/** ZIO HTTP: segments and captures before the route arrow on the same line. */
function zioEndpoints(rules, file, facts, emit) {
  const routes = (facts.calls || []).filter(
    (call) =>
      call.owner === rules.routeOwner && rules.routeNames.includes(call.name)
  );
  const segmentsByLine = new Map();
  for (const call of facts.calls || []) {
    if (
      !rules.segmentOwners.includes(call.owner) &&
      !rules.captureOwners.includes(call.owner)
    ) {
      continue;
    }
    const isCapture =
      rules.captureOwners.includes(call.owner) &&
      rules.captureNames.includes(call.name);
    const arg = (call.args || []).find(
      (a) => a.index === 0 && typeof a.string === "string"
    );
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
    if (
      ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        verb
      )
    ) {
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
