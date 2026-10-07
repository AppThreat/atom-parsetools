// Outbound services and data stores: the clients the rule table names, with the URL, host or
// topic each one reaches. Only values shaped like a URL with a host, a host and port, or a
// topic name are reported, and URLs lose their credentials, query and token shaped segments.
import { looksSecret, quotableLiteral, sanitizeUrl } from "../util.js";
import { loadRules, ownerMatches, ownerPrefixMatches } from "./context.js";
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
  const seen = new Set();
  const emit = (service) => {
    const key = JSON.stringify([
      service.file,
      service.line,
      service.client,
      service.url,
      service.host,
      service.topic
    ]);
    if (!seen.has(key)) {
      seen.add(key);
      services.push(service);
    }
  };
  for (const call of ctx.allCalls) {
    if (!call.owner || !call.name) {
      continue;
    }
    const urlCall = rules.urlCalls.find((rule) => matches(rule, call));
    if (urlCall) {
      for (const value of valuesAt(ctx, call, urlCall.arg)) {
        emitAt(emit, call, "http-client", urlCall.client, value);
      }
      continue;
    }
    const client = rules.httpClients.find((rule) => matches(rule, call));
    if (client) {
      for (const value of clientValues(ctx, rules, call, client)) {
        emitAt(emit, call, "http-client", client.client, value);
      }
      continue;
    }
    const store = rules.dataStores.find((rule) => matches(rule, call));
    if (store) {
      const values = store.config
        ? configuredUrls(ctx, call, store.arg)
        : valuesAt(ctx, call, store.arg);
      for (const value of values) {
        emitAt(emit, call, "datastore", store.client, value);
      }
      continue;
    }
    const messaging = rules.messaging.find((rule) => matches(rule, call));
    if (messaging) {
      for (const value of valuesAt(ctx, call, messaging.arg)) {
        const topic = topicOf(value.value);
        if (topic) {
          emit(entry(call, "messaging", messaging.client, { topic }, value));
        }
      }
      continue;
    }
    const cloud = rules.cloud.find(
      (rule) =>
        matches(rule, call) &&
        (!rule.ownerSuffix || call.owner.endsWith(rule.ownerSuffix))
    );
    if (cloud) {
      if (cloud.arg === undefined) {
        emit(
          entry(
            call,
            "cloud",
            cloud.client,
            {},
            { resolution: "literal", via: [] }
          )
        );
      } else {
        for (const value of valuesAt(ctx, call, cloud.arg)) {
          emitAt(emit, call, "cloud", cloud.client, value);
        }
      }
    }
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

function matches(rule, call) {
  if (rule.owner && !ownerMatches(rule.owner, call.owner)) {
    return false;
  }
  if (rule.ownerPrefix && !ownerPrefixMatches(rule.ownerPrefix, call.owner)) {
    return false;
  }
  return rule.nameIn
    ? rule.nameIn.includes(call.name)
    : call.name === rule.name;
}

/** The values one argument of a call can take: an interpolation, or what propagation finds. */
function valuesAt(ctx, call, index) {
  const parts = (call.args || []).find(
    (a) => a.index === index && Array.isArray(a.parts)
  );
  if (parts) {
    const value = partsText(parts.parts);
    return value ? [{ value, resolution: "interpolated", via: [] }] : [];
  }
  return resolveArgument(ctx, call, index).values;
}

/** The URL a client call reaches, by the rule's `urlFrom`. */
function clientValues(ctx, rules, call, rule) {
  if (rule.urlFrom === "parts" || rule.urlFrom === "args") {
    return (call.args || []).flatMap((arg) => valuesAt(ctx, call, arg.index));
  }
  const candidates =
    rule.urlFrom === "line"
      ? (ctx.callsByCaller.get(call.caller) || []).filter(
          (other) => other.file === call.file && other.line === call.line
        )
      : (ctx.callsByCaller.get(call.caller) || []).filter(
          (other) => other.file === call.file
        );
  const values = [];
  for (const candidate of candidates) {
    const urlCall = rules.urlCalls.find((r) => matches(r, candidate));
    if (urlCall) {
      values.push(...valuesAt(ctx, candidate, urlCall.arg));
    }
  }
  return values;
}

/**
 * The text of an interpolation: literal pieces and constant holes joined, any other hole a
 * `{}` placeholder. Without a scheme and host of its own it is not a URL.
 */
function partsText(parts) {
  const pieces = [];
  for (const piece of parts) {
    if (typeof piece === "string") {
      pieces.push(piece);
    } else if (piece && typeof piece.const === "string") {
      pieces.push(piece.const);
    } else if (piece === null) {
      return undefined;
    } else {
      pieces.push("{}");
    }
  }
  return pieces.join("");
}

/** The URL a configuration path names: `forConfig("db.default")` reads `db.default.url`. */
function configuredUrls(ctx, call, index) {
  const path = resolveArgument(ctx, call, index).values.find(
    (v) => typeof v.value === "string"
  )?.value;
  if (!path) {
    return [];
  }
  for (const key of [
    `${path}.url`,
    `${path}.db.url`,
    `${path}.properties.url`
  ]) {
    const configured = ctx.configValues.get(key);
    if (configured) {
      return [
        {
          value: configured.value,
          resolution: "config",
          via: configured.file
            ? [{ file: configured.file, line: configured.line }]
            : []
        }
      ];
    }
  }
  return [];
}

function emitAt(emit, call, kind, client, value) {
  const location = locate(value.value);
  if (!location) {
    return;
  }
  const actualKind =
    location.websocket && kind === "http-client" ? "websocket" : kind;
  const { websocket: _websocket, ...where } = location;
  emit(entry(call, actualKind, client, where, value));
}

function entry(call, kind, client, where, value) {
  return {
    kind,
    client,
    ...where,
    resolution: value.resolution,
    ...(value.via?.length ? { via: value.via } : {}),
    file: call.file,
    line: call.line
  };
}

const HOST_PORTS = /^[A-Za-z0-9.-]+:\d{2,5}(,[A-Za-z0-9.-]+:\d{2,5})*$/;

/**
 * Where a value points: a URL with a host, a JDBC URL, or a list of host and port pairs.
 * Relative paths, URNs, configuration paths and plain words point nowhere.
 */
function locate(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  if (/^jdbc:/i.test(value)) {
    const url = sanitizeUrl(value);
    return quotableLiteral(url) ? { url } : undefined;
  }
  const url = /^([a-z][a-z0-9+._-]*):\/\/([^/?#]*)/i.exec(value);
  if (url) {
    const host = url[2].slice(url[2].lastIndexOf("@") + 1);
    if (!host || host.includes("{}") || !/^[A-Za-z0-9.[\]:,_-]+$/.test(host)) {
      return undefined;
    }
    return {
      url: sanitizeUrl(value),
      ...(/^wss?$/i.test(url[1]) ? { websocket: true } : {})
    };
  }
  if (HOST_PORTS.test(value) && !looksSecret(value)) {
    return { host: value };
  }
  // An endpoint the environment supplies: `url = ${?DATABASE_URL}`.
  if (/^env:[A-Z][A-Z0-9_]*$/.test(value)) {
    return { url: value };
  }
  return undefined;
}

function topicOf(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9._-]{1,249}$/.test(value) &&
    !looksSecret(value)
    ? value
    : undefined;
}

/** Kafka and friends: the servers a Properties map carries before the client is built. */
function bootstrapServices(ctx, rules, emit) {
  const table = rules.bootstrapKeys;
  for (const call of ctx.allCalls) {
    if (!call.owner?.startsWith(table.putOwner) || call.name !== "put") {
      continue;
    }
    const key = resolveArgument(ctx, call, 0).values.find(
      (v) => typeof v.value === "string"
    )?.value;
    const setting = table.keys[key];
    if (!setting) {
      continue;
    }
    for (const value of resolveArgument(ctx, call, 1).values) {
      if (typeof value.value !== "string") {
        continue;
      }
      // A listener list may carry a protocol and credentials: SASL_SSL://user:pass@host:port.
      const hosts = value.value
        .split(",")
        .map((part) => sanitizeUrl(part.trim()).replace(/^[A-Za-z_]+:\/\//, ""))
        .join(",");
      if (HOST_PORTS.test(hosts)) {
        emit(entry(call, setting.kind, setting.client, { host: hosts }, value));
      }
    }
  }
}

/** libcurl writes its URL through an option constant; the value follows as a C string. */
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
    const url = wrapped?.args?.find((a) => typeof a === "string");
    if (url) {
      emitAt(emit, call, "http-client", "libcurl", {
        value: url,
        resolution: "literal",
        via: []
      });
    }
  }
}
