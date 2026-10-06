// Inbound endpoints: the routes of Play route files, and the route DSLs of the frameworks,
// read from the source tokens. The token structure gives the path and the nesting; the
// symbol the compiler recorded at a token confirms which framework it belongs to, so plain
// strings and identifiers that only look like routes are never endpoints.
import { TOKEN, argumentLists } from "../lexer.js";
import { loadRules, skipGenerated } from "./context.js";

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Normalize a route path: `:id`, `*rest`, `$id` and `$id<regex>` become `{name}`. */
export function normalizePath(pattern) {
  const path = String(pattern || "")
    .replace(/\$([A-Za-z_]\w*)<[^>]*>/g, "{$1}")
    .replace(/:([A-Za-z_]\w*)/g, "{$1}")
    .replace(/\*([A-Za-z_]\w*)/g, "{$1}")
    .replace(/\$\{?([A-Za-z_]\w*)\}?/g, "{$1}")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Derive inbound endpoints: the route configuration first, then every framework DSL the
 * sources use.
 *
 * @param {Object} ctx Derivation context
 * @returns {Object[]} Endpoint entries
 */
export function deriveEndpoints(ctx) {
  const rules = loadRules("endpoints");
  const endpoints = [];
  const seen = new Set();
  const emit = (endpoint) => {
    const key = JSON.stringify([
      endpoint.framework,
      endpoint.method,
      endpoint.path,
      endpoint.file,
      endpoint.line
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      endpoints.push(endpoint);
    }
  };
  playRoutes(ctx, emit);
  for (const file of ctx.files.keys()) {
    if (skipGenerated(file)) {
      continue;
    }
    const source = ctx.sourceOf(file);
    if (!source) {
      continue;
    }
    directiveRoutes(rules.directives, source, emit);
    patternRoutes(rules.patterns, source, emit);
    tapirRoutes(rules.tapir, source, emit);
    zioRoutes(rules.zio, source, emit);
    annotationRoutes(rules.cask, source, emit);
    actionRoutes(ctx, rules.scalatra, source, emit);
    sirdRoutes(ctx, rules.sird, source, emit);
  }
  return endpoints.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method)
  );
}

/** Play: the route table is the framework's own; a mounted router is reached through its mount. */
function playRoutes(ctx, emit) {
  for (const route of ctx.config.routes || []) {
    const entry = {
      framework: "play",
      method: route.method,
      handler: route.controllerMethod
    };
    emit({
      ...entry,
      path: normalizePath(route.pattern),
      file: route.file,
      line: route.line,
      ...(route.router ? { router: route.router } : {})
    });
    if (route.mountFile) {
      emit({
        ...entry,
        path: normalizePath(route.pattern),
        file: route.mountFile,
        line: route.mountLine
      });
    }
  }
}

/**
 * Akka and Pekko directive trees: `pathPrefix("orders") { path(LongNumber) { get { ... } } }`.
 * Each directive's block is its extent, prefixes compose down the nesting, and the verbs
 * inside or around a path directive are its methods; a path no verb guards takes any method.
 */
function directiveRoutes(rules, source, emit) {
  const { tokens } = source;
  const nodes = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== TOKEN.IDENT || !rules.directives.includes(token.value)) {
      continue;
    }
    const symbol = source.symbolAt(i, (s) =>
      rules.ownerPrefixes.some((prefix) => s.startsWith(prefix))
    );
    if (!symbol) {
      continue;
    }
    const lists = argumentLists(tokens, i);
    const end = lists.length ? lists[lists.length - 1].close : i;
    const args = lists.find((list) => tokens[list.open].text === "(");
    nodes.push({
      kind: token.value,
      verb: VERBS.includes(token.value.toUpperCase())
        ? token.value.toUpperCase()
        : undefined,
      framework: symbol.includes("pekko") ? "pekko-http" : "akka-http",
      start: i,
      end,
      segments: args
        ? matcherSegments(rules, tokens, args.open, args.close)
        : []
    });
  }
  const terminals = new Set(rules.terminals);
  const inside = (outer, inner) =>
    outer !== inner && outer.start < inner.start && inner.start <= outer.end;
  for (const node of nodes) {
    const ancestors = nodes.filter((n) => inside(n, node));
    const prefix = ancestors
      .filter((n) => rules.prefixes.includes(n.kind))
      .flatMap((n) => n.segments);
    if (terminals.has(node.kind)) {
      const own = node.kind === "path" ? node.segments : [];
      const methods = new Set(
        [...ancestors, ...nodes.filter((n) => inside(node, n))]
          .map((n) => n.verb)
          .filter(Boolean)
      );
      for (const method of methods.size ? methods : ["ANY"]) {
        emit({
          framework: node.framework,
          method,
          path: normalizePath(`/${[...prefix, ...own].join("/")}`),
          ...handlerOf(source, node.start),
          file: source.file,
          line: tokens[node.start].line + 1
        });
      }
    } else if (
      node.verb &&
      prefix.length &&
      !ancestors.some((n) => terminals.has(n.kind)) &&
      !nodes.some((n) => terminals.has(n.kind) && inside(node, n))
    ) {
      // A verb under a prefix with no path below it matches the prefix itself.
      emit({
        framework: node.framework,
        method: node.verb,
        path: normalizePath(`/${prefix.join("/")}`),
        ...handlerOf(source, node.start),
        file: source.file,
        line: tokens[node.start].line + 1
      });
    }
  }
}

/** The segments a path matcher expression names: literals and the capturing matchers. */
function matcherSegments(rules, tokens, open, close) {
  const segments = [];
  for (let k = open + 1; k < close; k++) {
    const token = tokens[k];
    if (token.type === TOKEN.STRING) {
      segments.push(...token.value.split("/").filter(Boolean));
    } else if (
      token.type === TOKEN.IDENT &&
      rules.captures.includes(token.value)
    ) {
      segments.push("{}");
    } else if (token.type === TOKEN.BRACKET && token.match > k) {
      k = token.match;
    }
  }
  return segments;
}

/**
 * Pattern routes, the http4s DSL and the ZIO HTTP 2 one: `case GET -> Root / "users" /
 * IntVar(id) =>`. The verb carries the framework's symbol; the segments follow `Root`.
 */
function patternRoutes(rules, source, emit) {
  const { tokens } = source;
  const mounts = routerMounts(rules, source);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== "case" || tokens[i].type !== TOKEN.KEYWORD) {
      continue;
    }
    // The pattern ends at the arrow or a guard.
    let end = i + 1;
    while (
      end < tokens.length &&
      tokens[end].text !== "=>" &&
      !(tokens[end].type === TOKEN.KEYWORD && tokens[end].text === "if")
    ) {
      if (tokens[end].type === TOKEN.BRACKET && tokens[end].match > end) {
        end = tokens[end].match;
      }
      end += 1;
    }
    const route = parsePatternRoute(rules, source, i + 1, end);
    if (route) {
      const prefix = mounts.get(source.definitionAt(i)?.name) || "";
      emit({
        framework: route.framework,
        method: route.method,
        path: normalizePath(`${prefix}/${route.segments.join("/")}`),
        ...handlerOf(source, i),
        file: source.file,
        line: tokens[i].line + 1
      });
    }
    i = end;
  }
}

function parsePatternRoute(rules, source, start, end) {
  const { tokens } = source;
  let i = start;
  // `req @ GET -> ...` binds the request.
  if (tokens[i + 1]?.text === "@") {
    i += 2;
  }
  // `Method.GET` in ZIO HTTP, plain `GET` in http4s.
  if (
    tokens[i + 1]?.type === TOKEN.DOT &&
    tokens[i + 2]?.type === TOKEN.IDENT
  ) {
    i += 2;
  }
  const verb = tokens[i];
  if (!verb || !VERBS.includes(verb.value)) {
    return undefined;
  }
  const symbol = source.symbolAt(i, (s) =>
    rules.verbPrefixes.some((prefix) => s.startsWith(prefix))
  );
  if (!symbol || tokens[i + 1]?.text !== "->") {
    return undefined;
  }
  const segments = [];
  let k = i + 2;
  if (tokens[k]?.value === "Root") {
    k += 1;
  }
  for (; k < end; k++) {
    const token = tokens[k];
    if (token.text === "/" || token.text === "::") {
      continue;
    }
    if (token.type === TOKEN.STRING) {
      segments.push(token.value);
    } else if (token.type === TOKEN.IDENT) {
      const call = tokens[k + 1]?.text === "(" ? tokens[k + 1] : undefined;
      if (call) {
        // `IntVar(id)` captures `id`.
        const bound =
          tokens[k + 2]?.type === TOKEN.IDENT ? tokens[k + 2].value : "";
        segments.push(`{${bound === "_" ? "" : bound}}`);
        k = call.match;
      } else {
        segments.push(`{${token.value === "_" ? "" : token.value}}`);
      }
    } else {
      return undefined;
    }
  }
  return {
    method: verb.value,
    segments,
    framework: symbol.startsWith("zio.") ? "zio-http" : "http4s"
  };
}

/** `Router("/api" -> users)` mounts the routes `users` holds under `/api`. */
function routerMounts(rules, source) {
  const { tokens } = source;
  const mounts = new Map();
  for (let i = 0; i < tokens.length; i++) {
    if (
      tokens[i].value !== "Router" ||
      !source.symbolAt(i, (s) => s.startsWith(rules.router))
    ) {
      continue;
    }
    const [list] = argumentLists(tokens, i);
    for (const arg of list?.args || []) {
      const [prefix, arrow, target] = arg.map((k) => tokens[k]);
      if (
        prefix?.type === TOKEN.STRING &&
        arrow?.text === "->" &&
        target?.type === TOKEN.IDENT
      ) {
        mounts.set(target.value, prefix.value.replace(/\/$/, ""));
      }
    }
  }
  return mounts;
}

/**
 * tapir: `endpoint.get.in("api" / path[Long]("id"))`. The chain from `endpoint` names the
 * method and the path inputs; query, header and body inputs are not path segments.
 */
function tapirRoutes(rules, source, emit) {
  const { tokens } = source;
  for (let i = 0; i < tokens.length; i++) {
    if (
      tokens[i].value !== "endpoint" ||
      tokens[i - 1]?.type === TOKEN.DOT ||
      !source.symbolAt(i, (s) => s.startsWith(rules.prefix))
    ) {
      continue;
    }
    let method;
    const segments = [];
    let k = i + 1;
    while (
      tokens[k]?.type === TOKEN.DOT &&
      tokens[k + 1]?.type === TOKEN.IDENT
    ) {
      const member = tokens[k + 1].value;
      const lists = argumentLists(tokens, k + 1);
      if (VERBS.includes(member.toUpperCase())) {
        method = member.toUpperCase();
      } else if (member === "in" && lists[0]) {
        segments.push(
          ...tapirSegments(rules, tokens, lists[0].open, lists[0].close)
        );
      }
      k = lists.length ? lists[lists.length - 1].close + 1 : k + 2;
    }
    if (method || segments.length) {
      emit({
        framework: "tapir",
        method: method || "GET",
        path: normalizePath(`/${segments.join("/")}`),
        ...handlerOf(source, i),
        file: source.file,
        line: tokens[i].line + 1
      });
    }
    i = k - 1;
  }
}

function tapirSegments(rules, tokens, open, close) {
  const segments = [];
  for (let k = open + 1; k < close; k++) {
    const token = tokens[k];
    if (token.type === TOKEN.STRING) {
      segments.push(...token.value.split("/").filter(Boolean));
    } else if (
      token.type === TOKEN.IDENT &&
      rules.captures.includes(token.value)
    ) {
      const lists = argumentLists(tokens, k);
      const name = lists.find((l) => tokens[l.open].text === "(")?.args[0];
      const named =
        name && tokens[name[0]]?.type === TOKEN.STRING
          ? tokens[name[0]].value
          : "";
      segments.push(`{${named}}`);
      k = lists.length ? lists[lists.length - 1].close : k;
    } else if (
      token.type === TOKEN.IDENT &&
      rules.inputs.includes(token.value)
    ) {
      // A query, header or body input ends the path.
      return segments;
    }
  }
  return segments;
}

/** ZIO HTTP 3: `Method.GET / "users" / int("id") -> handler(...)`. */
function zioRoutes(rules, source, emit) {
  const { tokens } = source;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (
      tokens[i].value !== "Method" ||
      tokens[i + 1].type !== TOKEN.DOT ||
      !VERBS.includes(tokens[i + 2].value) ||
      tokens[i - 1]?.text === "case" ||
      !source.symbolAt(i + 2, (s) => s.startsWith(rules.prefix))
    ) {
      continue;
    }
    const segments = [];
    let k = i + 3;
    let complete = false;
    for (; k < tokens.length; k++) {
      const token = tokens[k];
      if (token.text === "->") {
        complete = true;
        break;
      }
      if (token.text === "/") {
        continue;
      }
      if (token.type === TOKEN.STRING) {
        segments.push(...token.value.split("/").filter(Boolean));
      } else if (
        token.type === TOKEN.IDENT &&
        rules.captures.includes(token.value)
      ) {
        const [list] = argumentLists(tokens, k);
        const name = list?.args[0] && tokens[list.args[0][0]];
        segments.push(`{${name?.type === TOKEN.STRING ? name.value : ""}}`);
        k = list ? list.close : k;
      } else if (token.value === "Root" || token.value === "trailing") {
        continue;
      } else {
        break;
      }
    }
    if (complete) {
      emit({
        framework: "zio-http",
        method: tokens[i + 2].value,
        path: normalizePath(`/${segments.join("/")}`),
        ...handlerOf(source, i),
        file: source.file,
        line: tokens[i].line + 1
      });
    }
    i = k;
  }
}

/**
 * cask: `@cask.get("/hello/:name")` on a method; `@cask.route("/x", methods = Seq("post"))`
 * names its methods.
 */
function annotationRoutes(rules, source, emit) {
  const { tokens } = source;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (
      tokens[i].text !== "@" ||
      tokens[i + 1].value !== "cask" ||
      tokens[i + 2].type !== TOKEN.DOT
    ) {
      continue;
    }
    const nameIndex = i + 3;
    const kind = tokens[nameIndex]?.value;
    const methods = rules.endpoints[kind];
    if (!methods) {
      continue;
    }
    const [list] = argumentLists(tokens, nameIndex);
    const path = list?.args[0] && tokens[list.args[0][0]];
    if (path?.type !== TOKEN.STRING) {
      continue;
    }
    let verbs = methods;
    if (kind === "route") {
      const named = (list.args.slice(1) || []).find(
        (arg) => tokens[arg[0]]?.value === "methods"
      );
      const listed = (named || [])
        .map((k) => tokens[k])
        .filter((t) => t.type === TOKEN.STRING)
        .map((t) => t.value.toUpperCase());
      verbs = listed.length ? listed : ["GET"];
    }
    const def = nextDefinition(tokens, list.close + 1);
    for (const method of verbs) {
      emit({
        framework: "cask",
        method,
        path: normalizePath(path.value),
        ...(def !== undefined ? handlerOf(source, def) : {}),
        file: source.file,
        line: tokens[i].line + 1
      });
    }
  }
}

function nextDefinition(tokens, from) {
  for (let k = from; k < tokens.length && k < from + 40; k++) {
    if (tokens[k].type === TOKEN.KEYWORD && tokens[k].text === "def") {
      return k + 1;
    }
  }
  return undefined;
}

/**
 * Scalatra actions: `get("/path") { ... }` in a class whose ancestry reaches Scalatra, the
 * framework's own action methods or a project trait's wrappers of them.
 */
function actionRoutes(ctx, rules, source, emit) {
  const { tokens } = source;
  for (let i = 0; i < tokens.length; i++) {
    const verb = tokens[i].value;
    if (
      tokens[i].type !== TOKEN.IDENT ||
      !rules.verbs.includes(verb) ||
      tokens[i - 1]?.type === TOKEN.DOT ||
      tokens[i + 1]?.text !== "("
    ) {
      continue;
    }
    const [list] = argumentLists(tokens, i);
    const path = list?.args[0] && tokens[list.args[0][0]];
    if (path?.type !== TOKEN.STRING || !path.value.startsWith("/")) {
      continue;
    }
    const owner = source.classAt(i);
    if (!owner || !ctx.extendsAny(owner, rules.ancestors)) {
      continue;
    }
    if (!source.symbolAt(i, () => true)) {
      continue;
    }
    emit({
      framework: "scalatra",
      method: verb.toUpperCase(),
      path: normalizePath(path.value),
      ...handlerOf(source, i),
      file: source.file,
      line: tokens[i].line + 1
    });
  }
}

/**
 * Play's string interpolating routing DSL: `case GET(p"/posts/$id") =>` inside a router a
 * route file mounts with `-> /v1/posts v1.post.PostRouter`.
 */
function sirdRoutes(ctx, rules, source, emit) {
  const { tokens } = source;
  for (let i = 0; i + 3 < tokens.length; i++) {
    const verb = tokens[i].value;
    if (
      !VERBS.includes(verb) ||
      tokens[i + 1].text !== "(" ||
      tokens[i + 2].type !== TOKEN.INTERP ||
      tokens[i + 2].interpolator !== "p" ||
      !source.symbolAt(i, (s) => s.startsWith(rules.prefix))
    ) {
      continue;
    }
    const pattern = tokens[i + 2].parts
      .map((part, k) =>
        k < tokens[i + 2].holes.length
          ? `${part}{${tokens[i + 2].holes[k].name || ""}}`
          : part
      )
      .join("");
    const owner = source.classAt(i);
    const mount = (ctx.config.routerMounts || []).find(
      (m) =>
        owner && (owner.sym === m.router || owner.sym?.endsWith(`.${m.router}`))
    );
    emit({
      framework: "play",
      method: verb,
      path: normalizePath(
        `${mount?.prefix?.replace(/\/$/, "") || ""}${pattern}`
      ),
      ...handlerOf(source, i),
      file: source.file,
      line: tokens[i].line + 1
    });
  }
}

/** The definition a route sits in, as its handler. */
function handlerOf(source, index) {
  const def = source.definitionAt(index);
  return def ? { handler: `${def.owner}.${def.name}` } : {};
}
