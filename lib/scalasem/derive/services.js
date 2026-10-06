// Outbound services and data stores: the clients the rule table names and their URLs.

import { sanitizeUrl } from "../util.js";
import { MAX_BOUNDARIES, loadRules, ownerPrefixMatches } from "./context.js";
import { resolveArgument } from "./values.js";

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
    if (
      !services.some(
        (s) =>
          s.file === service.file &&
          s.line === service.line &&
          s.client === service.client &&
          s.url === service.url
      )
    ) {
      services.push(service);
    }
  };
  for (const call of ctx.allCalls) {
    serviceOfCall(ctx, rules, call, emit);
  }
  bootstrapServices(ctx, rules, emit);
  libcurlServices(ctx, rules, emit);
  return services.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      String(a.client).localeCompare(String(b.client))
  );
}

function serviceOfCall(ctx, rules, call, emit) {
  for (const table of rules.urlCalls) {
    if (
      !ownerPrefixMatches(table.ownerPrefix, call.owner) ||
      (table.nameIn
        ? !table.nameIn.includes(call.name)
        : call.name !== table.name)
    ) {
      continue;
    }
    const url = resolveServiceValue(ctx, call, table.arg);
    if (
      url?.value &&
      (!table.urlOnly || /^[a-z][a-z0-9+.-]*:\/\//i.test(url.value))
    ) {
      emit(serviceEntry(call, table.client, url));
    }
    return;
  }
  for (const table of rules.httpClients) {
    if (table.skip || !ownerPrefixMatches(table.ownerPrefix, call.owner)) {
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
    if (!ownerPrefixMatches(table.ownerPrefix, call.owner)) {
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
    // A resolved interpolation arrives as a plain string argument.
    const plain = (call.args || []).find(
      (a) =>
        typeof a.string === "string" &&
        /^[a-z][a-z0-9+.-]*:\/\//i.test(a.string)
    );
    if (plain) {
      return { value: plain.string, resolution: "literal", via: [] };
    }
    if (table.urlFrom === "parts") {
      return undefined;
    }
  }
  if (table.urlFrom === "line" || table.urlFrom === "caller") {
    // The client call itself may carry the URL as an argument.
    const own = resolveServiceNamedArg(ctx, call);
    if (own) {
      return own;
    }
    const candidates =
      table.urlFrom === "line"
        ? (ctx.callsByCaller.get(call.caller) || []).filter(
            (c) => c.line === call.line
          )
        : ctx.callsByCaller.get(call.caller) || [];
    for (const candidate of candidates) {
      for (const urlTable of rules.urlCalls) {
        if (
          ownerPrefixMatches(urlTable.ownerPrefix, candidate.owner) &&
          (urlTable.nameIn
            ? urlTable.nameIn.includes(candidate.name)
            : candidate.name === urlTable.name)
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
  const arg = (call.args || []).find(
    (a) => typeof a.string === "string" && /^[a-z]+:\/\//i.test(a.string)
  );
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
  const text =
    prefix && !value.value.startsWith(prefix)
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
    const key = (call.args || []).find(
      (a) => typeof a.string === "string"
    )?.string;
    const setting = table.keys[key];
    if (!setting) {
      continue;
    }
    const value = (call.args || []).find(
      (a) =>
        a.index === 1 && (typeof a.string === "string" || a.const !== undefined)
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
      (a) =>
        a.index === 1 &&
        (a.const === table.urlOption || a.int === table.urlOption)
    );
    if (!option) {
      continue;
    }
    const wrapped = (call.args || []).find((a) => a.index === 2 && a.call);
    const url = wrapped?.args?.find(
      (a) => typeof a === "string" && a.includes("://")
    );
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
