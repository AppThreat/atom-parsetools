// Entry points, the call graph over project methods and the call stacks to library calls.

import { classRoot, lastSegment, skipGenerated } from "./context.js";

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
      if (def.kind === "def" && def.name === "main") {
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
    const key = actionKey(ctx, route.controllerMethod);
    const def = key && ctx.defsByKey.get(key);
    if (def) {
      emit({
        kind: "play-action",
        file: def.file,
        line: def.line,
        ref: key
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
  return entries.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}

/**
 * The definition a Play route action names: `controllers.HomeController.index` is a method
 * of the class, or of the object of that name.
 */
function actionKey(ctx, ref) {
  const at = ref.lastIndexOf(".");
  if (at < 0) {
    return undefined;
  }
  const owner = ref.slice(0, at);
  const name = ref.slice(at + 1);
  return [`${owner}.${name}`, `${owner}$.${name}`].find((key) =>
    ctx.defsByKey.has(key)
  );
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
    // Dispatch through a parent the project defines; a library supertype such as a function
    // type would connect every implementation in the project.
    const projectParents = parentsOf(ctx, def.owner).filter((parent) =>
      ctx.projectClasses.has(parent)
    );
    for (const owner of [def.owner, ...projectParents]) {
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
    if (
      from === to ||
      seenEdges.has(key) ||
      !ctx.defsByKey.has(from) ||
      !ctx.defsByKey.has(to)
    ) {
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
      addEdge(
        call.caller,
        to,
        call,
        call.owner === ownerOfKey(to) ? undefined : "approximate"
      );
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
        for (const to of methodsByName.get(
          `${argumentCall.owner}.${argumentCall.name}`
        )) {
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
    // A test is not an entry of the program.
    if (entry.kind === "test") {
      continue;
    }
    const key = methodKeyOf(ctx, entry.ref);
    if (!key) {
      continue;
    }
    entryKeys.add(key);
    // Entering an application object means entering through its members.
    const def = ctx.defsByKey.get(key);
    if (def && ["object", "class", "trait"].includes(def.kind)) {
      for (const member of ctx.defsByKey.keys()) {
        if (member.startsWith(`${key}.`) || member.startsWith(`${key}$.`)) {
          entryKeys.add(member);
        }
      }
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
      !call.owner ||
      graph.projectOwner.has(call.owner) ||
      graph.projectOwner.has(classRoot(call.owner)) ||
      RUNTIME_OWNER.test(call.owner)
    ) {
      continue;
    }
    if (!reverse.has(call.caller) && !entryKeys.has(call.caller)) {
      continue;
    }
    sinks.push(call);
  }
  // The routes from the entries to one method, shortest first: a breadth first walk back
  // over the call graph, each route at most eleven calls long, a method never twice on one.
  const routesTo = new Map();
  const pathsOf = (method) => {
    if (routesTo.has(method)) {
      return routesTo.get(method);
    }
    const paths = [];
    let frontier = [{ node: method, frames: [], seen: new Set([method]) }];
    for (
      let depth = 0;
      depth <= 11 && frontier.length && paths.length < 12;
      depth++
    ) {
      const next = [];
      for (const { node, frames, seen } of frontier) {
        if (entryKeys.has(node)) {
          paths.push({ entry: node, frames });
          if (paths.length >= 12) {
            break;
          }
          continue;
        }
        for (const edge of reverse.get(node) || []) {
          if (seen.has(edge.from) || next.length > 2000) {
            continue;
          }
          next.push({
            node: edge.from,
            frames: [
              {
                function: lastSegment(edge.from),
                file: edge.file,
                line: edge.line,
                ...(edge.column ? { column: edge.column } : {})
              },
              ...frames
            ],
            seen: new Set(seen).add(edge.from)
          });
        }
      }
      frontier = next;
    }
    routesTo.set(method, paths);
    return paths;
  };
  // Every distinct route is reported once, at its own sink, shortest first; no library
  // owner keeps more than three stacks.
  const candidates = [];
  for (const sink of sinks) {
    for (const path of pathsOf(sink.caller)) {
      const entryDef = ctx.defsByKey.get(path.entry);
      const frames = [
        ...(entryDef
          ? [
              {
                function: lastSegment(path.entry),
                file: entryDef.file,
                line: entryDef.line
              }
            ]
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
  candidates.sort(
    (a, b) =>
      a.frames.length - b.frames.length ||
      a.sink.file.localeCompare(b.sink.file) ||
      a.sink.line - b.sink.line ||
      a.route.localeCompare(b.route)
  );
  const stacks = [];
  const routes = new Set();
  const ownerCounts = new Map();
  for (const candidate of candidates) {
    const ownerCount = ownerCounts.get(candidate.sink.owner) || 0;
    if (routes.has(candidate.route) || ownerCount >= 3) {
      continue;
    }
    routes.add(candidate.route);
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
  }
  return stacks.sort(
    (a, b) =>
      a.sink.file.localeCompare(b.sink.file) ||
      a.sink.line - b.sink.line ||
      a.frames.length - b.frames.length
  );
}

/** The method key of an entry reference, when the referenced definition is in the project. */
function methodKeyOf(ctx, ref) {
  if (ctx.defsByKey.has(ref)) {
    return ref;
  }
  return actionKey(ctx, ref);
}
