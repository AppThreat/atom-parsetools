// Tests for the SemanticDB reader over recorded files: the protobuf decoder, the symbol
// grammar, the source lexer and the facts of a Scala 2 module. No compiler is needed.
import { strict as assert } from "node:assert";
import { join } from "node:path";
import process from "node:process";

import {
  decodeTextDocuments,
  parseSymbol,
  readSemanticdbDir,
  semanticdbFacts
} from "../lib/scalasem/semanticdb.js";
import { argumentTokens, tokenize } from "../lib/scalasem/lexer.js";

const project = join(
  process.cwd(),
  "test-fixtures",
  "projects",
  "scala",
  "semanticdb"
);
const documents = readSemanticdbDir(join(project, "meta"));
assert.ok(documents.length === 2, "expected the recorded documents");

const routes = documents.find((d) => d.uri.endsWith("Routes.scala"));
const store = documents.find((d) => d.uri.endsWith("Store.scala"));
assert.ok(routes && store, "documents carry their source uri");
assert.ok(routes.occurrences.length > 20, "occurrences decoded");
assert.ok(routes.symbols.length > 0, "symbol information decoded");
assert.ok(routes.synthetics.length > 0, "synthetics decoded with the flag on");

// The symbol grammar.
assert.deepStrictEqual(parseSymbol("java/security/MessageDigest#getInstance()."), {
  owner: "java.security.MessageDigest",
  name: "getInstance",
  kind: "method",
  path: ["java", "security", "MessageDigest#getInstance()."]
});
assert.deepStrictEqual(
  parseSymbol("slick/jdbc/JdbcBackend#DatabaseFactoryDef#forURL().(driver)"),
  {
    owner: "slick.jdbc.JdbcBackend.DatabaseFactoryDef",
    name: "forURL",
    kind: "method",
    path: ["slick", "jdbc", "JdbcBackend#DatabaseFactoryDef#forURL().(driver)"]
  }
);
assert.deepStrictEqual(parseSymbol("corpus/legacy/Routes."), {
  owner: "corpus.legacy",
  name: "Routes",
  kind: "object",
  path: ["corpus", "legacy", "Routes."]
});
assert.strictEqual(parseSymbol("local12"), undefined);

// The lexer: positions, strings and interpolation holes.
const tokens = tokenize('  val alg = "SHA-512" // note\n  digestWith(alg, d)');
const alg = tokens.find((t) => t.text === "alg");
assert.strictEqual(alg.char, 6, "token carries its line start position");
const interpToken = tokenize('val u = s"https://$host/path"').find(
  (t) => t.type === "interp"
);
assert.deepStrictEqual(interpToken.holes, ["host"], "interpolation holes");
const groups = argumentTokens(
  tokenize('run("a", 1, x)'),
  0,
  3
);
assert.strictEqual(groups.length, 3, "argument groups split at the top level");

// The facts of the recorded module.
const routesFacts = semanticdbFacts(project, routes).facts;
assert.ok(routesFacts.calls.length > 5, "call facts from occurrences");
const pathPrefix = routesFacts.calls.find(
  (call) => call.name === "pathPrefix" && call.args?.length
);
assert.deepStrictEqual(pathPrefix.args, [{ index: 0, string: "legacy" }]);
assert.strictEqual(pathPrefix.caller, "corpus.legacy.Routes.route");
const digest = routesFacts.calls.find(
  (call) => call.name === "getInstance" && call.args?.length
);
assert.deepStrictEqual(digest.args, [{ index: 0, string: "SHA-1" }]);
assert.ok(
  routesFacts.references.some(
    (ref) => ref.symbol === "akka.http.scaladsl.server.directives.MethodDirectives.post"
  ),
  "method references lose the grammar markers"
);
assert.ok(
  routesFacts.definitions.some(
    (def) => def.kind === "object" && def.name === "Routes"
  ),
  "object definitions"
);
assert.strictEqual(routesFacts.factsSource, "semanticdb");

const storeFacts = semanticdbFacts(project, store).facts;
const forURL = storeFacts.calls.find(
  (call) => call.name === "forURL" && call.args?.length
);
assert.ok(
  forURL.args.some(
    (arg) => arg.string === "jdbc:postgresql://legacy-db:5432/users"
  ),
  "jdbc url argument"
);
assert.strictEqual(storeFacts.factsSource, "semanticdb");

// The decoder skips unknown fields by wire type.
const unknown = Buffer.from([
  0x0a, 0x08, // one document
  0x12, 0x03, 0x61, 0x2e, 0x62, // field 2 of the document (uri): "a.b"
  0x30, 0x01 // field 6 varint: a shape a newer writer added
]);
const [doc] = decodeTextDocuments(unknown);
assert.strictEqual(doc.uri, "a.b");

console.log(
  `scalasem-semanticdb: ${documents.length} documents, ${routesFacts.calls.length} routes calls, ${storeFacts.calls.length} store calls`
);
