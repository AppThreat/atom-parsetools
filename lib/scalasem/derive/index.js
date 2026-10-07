// Evidence derivation: turns the per file facts into crypto findings, endpoints, outbound
// services and data stores, entry points and call stacks. The API tables live in
// lib/scalasem/rules/*.json; everything structural (value propagation, route composition,
// graph search) is code in this directory.

import { deriveCrypto, deriveNativeBindings } from "./crypto.js";
import { deriveEndpoints } from "./endpoints.js";
import {
  deriveCallGraph,
  deriveCallStacks,
  deriveEntryPoints
} from "./graph.js";
import { deriveServices } from "./services.js";
import { deriveContext } from "./context.js";

/**
 * JavaScript module imports of Scala.js facades: the module name every `@JSImport`
 * annotation names, with the object that imports it.
 *
 * @param {Object} ctx Derivation context
 * @returns {Object[]}
 */
export function deriveJsModules(ctx) {
  const modules = [];
  for (const [file, facts] of ctx.files) {
    for (const def of facts.definitions || []) {
      for (const annotation of def.annotations || []) {
        const match = /(?:^|\.)JSImport$/.exec(annotation.name || "");
        const name =
          match && (annotation.args || []).find((a) => typeof a === "string");
        if (!name) {
          continue;
        }
        modules.push({
          module: name,
          owner: `${def.owner}.${def.name}`,
          file,
          line: def.line
        });
      }
    }
  }
  return modules.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line
  );
}

const SERVICE_TAGS = {
  datastore: "database",
  messaging: "messaging",
  cloud: "cloud",
  websocket: "websocket",
  "http-client": "http-client"
};

/** The version 1 tags the derived evidence adds to a file entry. */
function evidenceTags(crypto, endpoints, services) {
  const tagsByFile = new Map();
  const add = (file, tag) => {
    if (!file) {
      return;
    }
    const tags = tagsByFile.get(file) || new Set();
    tags.add(tag);
    tagsByFile.set(file, tags);
  };
  for (const finding of crypto) {
    add(finding.file, "crypto");
  }
  for (const endpoint of endpoints) {
    add(endpoint.file, "framework-route");
    add(endpoint.file, "framework");
  }
  for (const service of services) {
    add(service.file, SERVICE_TAGS[service.kind] || "http-client");
  }
  return tagsByFile;
}

export function deriveEvidence(ctx) {
  const endpoints = deriveEndpoints(ctx);
  const entryPoints = deriveEntryPoints(ctx, endpoints);
  const graph = deriveCallGraph(ctx);
  const callStacks = deriveCallStacks(ctx, entryPoints, graph);
  const crypto = deriveCrypto(ctx);
  const services = deriveServices(ctx);
  return {
    crypto,
    endpoints,
    services,
    entryPoints,
    callGraph: { edges: graph.edges },
    callStacks,
    jsModules: deriveJsModules(ctx),
    nativeBindings: deriveNativeBindings(ctx),
    tagsByFile: evidenceTags(crypto, endpoints, services)
  };
}

export { deriveContext };
