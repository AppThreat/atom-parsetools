// Bounded value propagation: the value a call argument carries, followed through the
// parameters of project methods and through local and object constants to a literal. Every
// call site and every value declaration on the way is one boundary, and a value that needs
// more than MAX_BOUNDARIES of them is not resolved. Fields and other heap state are never
// followed, and a recursive call ends the walk.
import { MAX_BOUNDARIES, lastSegment } from "./context.js";

const UNRESOLVED = Object.freeze({ values: [], resolved: false });

/**
 * Resolve the value of one argument of a call.
 *
 * @param {Object} ctx Derivation context
 * @param {Object} call Call fact carrying `args`
 * @param {number} index Argument position
 * @param {Object} [opts] `{ budget }`
 * @returns {{values: Array<{value: string|number, resolution: string, via: Object[]}>, resolved: boolean}}
 */
export function resolveArgument(ctx, call, index, opts = {}) {
  const arg = argumentAt(call, index);
  if (!arg) {
    return UNRESOLVED;
  }
  return valueOfArgument(
    ctx,
    call,
    arg,
    opts.budget ?? MAX_BOUNDARIES,
    new Set()
  );
}

/** The argument at a position, in the shape the propagation can read. */
export function argumentAt(call, index) {
  const candidates = (call.args || []).filter(
    (a) => a.index === index && !Array.isArray(a.parts) && !a.call
  );
  return (
    candidates.find(
      (a) => typeof a.string === "string" || a.const !== undefined
    ) ||
    candidates.find((a) => a.int !== undefined || a.long !== undefined) ||
    candidates.find((a) => a.param !== undefined) ||
    candidates[0]
  );
}

function valueOfArgument(ctx, call, arg, budget, seen) {
  if (typeof arg.string === "string") {
    return resolvedWith({ value: arg.string, resolution: "literal", via: [] });
  }
  const number = arg.int ?? arg.long;
  if (number !== undefined) {
    return resolvedWith({ value: number, resolution: "literal", via: [] });
  }
  if (arg.const !== undefined) {
    return constantValue(ctx, call, arg, budget);
  }
  if (arg.param !== undefined && arg.paramIndex !== undefined) {
    return followParameter(ctx, call, arg.paramIndex, budget, seen);
  }
  if (arg.ident !== undefined) {
    return identValue(ctx, call, arg, budget);
  }
  return UNRESOLVED;
}

function resolvedWith(value) {
  return { values: [value], resolved: true };
}

/**
 * A constant argument carries its value. A local one names the line it is declared at; an
 * object member is found by its symbol. Either declaration is one boundary.
 */
function constantValue(ctx, call, arg, budget) {
  if (budget < 1) {
    return UNRESOLVED;
  }
  if (arg.defLine !== undefined) {
    return resolvedWith({
      value: arg.const,
      resolution: "constant",
      via: [{ file: call.file, line: arg.defLine }]
    });
  }
  const constant = ctx.constants.get(arg.sym);
  if (constant && constant.value === arg.const) {
    return resolvedWith({
      value: arg.const,
      resolution: isInline(ctx, constant) ? "inline" : "constant",
      via: [{ file: constant.file, line: constant.line }]
    });
  }
  return resolvedWith({ value: arg.const, resolution: "constant", via: [] });
}

function isInline(ctx, constant) {
  const definition = ctx.defsByLine.get(
    `${constant.file}:${constant.line}:${lastSegment(constant.sym)}`
  );
  return Boolean(definition?.flags?.includes("inline"));
}

/**
 * An identifier argument: an object constant the facts name by symbol, the form SemanticDB
 * facts take, or a value read from the configuration on its declaring line.
 */
function identValue(ctx, call, arg, budget) {
  const constant = arg.sym ? ctx.constants.get(arg.sym) : undefined;
  if (constant && budget >= 1 && constant.value !== undefined) {
    return resolvedWith({
      value: constant.value,
      resolution: isInline(ctx, constant) ? "inline" : "constant",
      via: [{ file: constant.file, line: constant.line }]
    });
  }
  const configured = configValueOf(ctx, arg.sym);
  if (configured !== undefined) {
    return resolvedWith({
      value: configured,
      resolution: "config",
      via: [{ file: call.file, line: call.line }]
    });
  }
  return UNRESOLVED;
}

/** A configuration key read on the declaring line of a value: `config.get[String]("key")`. */
function configValueOf(ctx, sym) {
  if (!sym) {
    return undefined;
  }
  const constant = ctx.constants.get(sym);
  const declaration = constant || ctx.valsBySym?.get(sym);
  if (!declaration?.file || !declaration.line) {
    return undefined;
  }
  for (const call of ctx.files.get(declaration.file)?.calls || []) {
    if (
      call.line !== declaration.line ||
      !/Configuration$|^play\.api\./.test(call.owner || "")
    ) {
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

/**
 * Follow a parameter of the method a call sits in to the arguments of every call site of
 * that method. Each call site is one boundary. Call sites inside the method itself are
 * recursion and end the walk, and so does a method already on the path. A result is kept
 * for reuse unless a cycle was cut while computing it, since another path may go on there.
 */
function followParameter(ctx, call, paramIndex, budget, seen) {
  const method = call.caller;
  if (!method || budget < 1) {
    return UNRESOLVED;
  }
  const key = `${method}#${call.callerSignature || ""}#${paramIndex}`;
  if (seen.has(key)) {
    return { ...UNRESOLVED, cut: true };
  }
  const memoKey = `${key}@${budget}`;
  if (ctx.parameterMemo?.has(memoKey)) {
    return ctx.parameterMemo.get(memoKey);
  }
  const nextSeen = new Set(seen).add(key);
  const values = [];
  let cut = false;
  for (const site of callSitesOf(ctx, method, call.callerSignature)) {
    if (site.caller === method) {
      continue;
    }
    const arg = argumentAt(site, paramIndex);
    if (!arg) {
      continue;
    }
    const resolved = valueOfArgument(ctx, site, arg, budget - 1, nextSeen);
    cut ||= Boolean(resolved.cut);
    for (const value of resolved.values) {
      values.push({
        ...value,
        resolution: "argument",
        via: [{ file: site.file, line: site.line }, ...value.via]
      });
    }
  }
  const result = {
    values: uniqueValues(values),
    resolved: values.length > 0,
    ...(cut ? { cut } : {})
  };
  if (!cut) {
    ctx.parameterMemo?.set(memoKey, result);
  }
  return result;
}

/** The call sites of a method, narrowed to one overload when its signature is known. */
function callSitesOf(ctx, method, signature) {
  const sites = ctx.callsByTarget.get(method) || [];
  if (!signature) {
    return sites;
  }
  return sites.filter((site) => !site.signature || site.signature === signature);
}

function uniqueValues(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = `${value.value}|${value.via.map((v) => `${v.file}:${v.line}`).join(">")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
