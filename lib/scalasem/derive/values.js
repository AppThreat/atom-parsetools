// Bounded value propagation: the string a call argument carries, followed through parameters
// and local values to a literal.

import { MAX_BOUNDARIES, lastSegment, ownerOf } from "./context.js";

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
export function resolveArgument(
  ctx,
  call,
  index,
  budget = MAX_BOUNDARIES,
  seen = new Set()
) {
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
    return followParameter(
      ctx,
      call.caller,
      arg.paramIndex,
      budget,
      seen,
      call
    );
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
  // A constant argument may carry its value already, when the facts come from SemanticDB;
  // the symbol lookup only adds the line the value was declared at.
  const constant = ctx.constants.get(arg.sym);
  if (constant?.tpe === "string") {
    const definition = ctx.defsByLine.get(
      `${constant.file}:${constant.line}:${lastSegment(constant.sym)}`
    );
    const resolution = definition?.flags?.includes("inline")
      ? "inline"
      : "constant";
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
  if (typeof arg.const === "string") {
    return {
      values: [{ value: arg.const, resolution: "constant", via: [] }],
      resolved: true
    };
  }
  return { values: [], resolved: false };
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
      if (constant?.tpe === "string" || typeof arg.const === "string") {
        values.push({
          value: constant?.value ?? arg.const,
          resolution: "argument",
          via: [
            ...hop,
            ...(constant ? [{ file: constant.file, line: constant.line }] : [])
          ]
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
  return {
    values,
    resolved: values.length > 0 || (!anySite && budget === MAX_BOUNDARIES)
  };
}
