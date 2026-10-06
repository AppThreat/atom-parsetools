// Tests for the SemanticDB reader over recorded files: the protobuf decoder, the symbol
// grammar, the source lexer and the facts of a Scala 2 module. No compiler is needed.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { inspectModule } from "../lib/scalasem/inspect.js";
import { argumentLists, codeTokens, tokenize } from "../lib/scalasem/lexer.js";
import {
  decodeTextDocuments,
  parseSymbol,
  readSemanticdbDir,
  semanticdbFacts
} from "../lib/scalasem/semanticdb.js";

const project = join(
  process.cwd(),
  "test-fixtures",
  "projects",
  "scala",
  "semanticdb"
);
const documents = readSemanticdbDir(join(project, "meta"));
assert.strictEqual(documents.length, 2, "the recorded documents");
const routes = documents.find((d) => d.uri.endsWith("Routes.scala"));
const store = documents.find((d) => d.uri.endsWith("Store.scala"));
assert.ok(routes.occurrences.length > 20 && routes.symbols.length > 0);
assert.ok(
  routes.synthetics.some((s) =>
    s.tree?.function?.symbol?.includes("_segmentStringToPathMatcher")
  ),
  "synthetic trees decoded"
);

// The symbol grammar, in the inspector's spelling of owners.
assert.deepStrictEqual(
  parseSymbol("java/security/MessageDigest#getInstance()."),
  {
    kind: "method",
    name: "getInstance",
    owner: "java.security.MessageDigest",
    fullName: "java.security.MessageDigest.getInstance",
    disambiguator: "()"
  }
);
assert.deepStrictEqual(parseSymbol("corpus/legacy/Store.find().(name)"), {
  kind: "parameter",
  name: "name",
  owner: "corpus.legacy.Store$.find",
  fullName: "corpus.legacy.Store$.find.name"
});
assert.strictEqual(
  parseSymbol("corpus/legacy/Store.db.").owner,
  "corpus.legacy.Store$"
);
assert.strictEqual(
  parseSymbol("akka/http/scaladsl/server/PathMatcher#`/`(+1).").name,
  "/",
  "a backquoted operator name"
);
assert.strictEqual(parseSymbol("a/C#m().[T]").kind, "typeParameter");
assert.strictEqual(parseSymbol("local12"), undefined);

// The lexer: positions, literals, interpolation holes, operators and argument lists.
const source = [
  "object A { val q = '\"'; val p = '('; val s = 'name",
  '  val t = s"""a ${b} $$c"""',
  '  f(g("x"), h)(using y) -> z',
  "}"
].join("\n");
const tokens = codeTokens(tokenize(source));
assert.deepStrictEqual(
  tokens.filter((t) => ["char", "symbol"].includes(t.type)).map((t) => t.text),
  ["'\"'", "'('", "'name"],
  "char and symbol literals"
);
const triple = tokens.find((t) => t.type === "interp");
assert.deepStrictEqual(triple.parts, ["a ", " $c"]);
assert.deepStrictEqual(
  triple.holes.map((h) => [h.name, h.line, h.nameColumn]),
  [["b", 1, 18]]
);
assert.ok(
  tokens.some((t) => t.text === "->"),
  "operators are one token"
);
const f = tokens.findIndex((t) => t.value === "f");
assert.deepStrictEqual(
  argumentLists(tokens, f).map((list) => list.args.length),
  [2, 1],
  "curried argument lists, split at their top level commas"
);

// The facts of the recorded module, in the inspector's shapes.
const routesFacts = semanticdbFacts(project, routes).facts;
const callsNamed = (facts, name) => facts.calls.filter((c) => c.name === name);
assert.deepStrictEqual(callsNamed(routesFacts, "pathPrefix")[0].args, [
  { index: 0, string: "legacy" }
]);
assert.strictEqual(
  callsNamed(routesFacts, "pathPrefix")[0].caller,
  "corpus.legacy.Routes$.route"
);
assert.deepStrictEqual(
  callsNamed(routesFacts, "pathPrefix")[0].endLine,
  23,
  "a directive reaches the end of the block it takes"
);
assert.ok(
  callsNamed(routesFacts, "_segmentStringToPathMatcher").some(
    (c) => c.args?.[0]?.string === "users"
  ),
  "implicit conversions are calls"
);
assert.deepStrictEqual(callsNamed(routesFacts, "getInstance")[0].args, [
  { index: 0, string: "SHA-1" }
]);
assert.deepStrictEqual(callsNamed(routesFacts, "digest")[0].args, undefined);
assert.ok(
  routesFacts.calls.every((c) => c.caller !== `${c.owner}.${c.name}`),
  "no parameter or definition reads as a self call"
);
assert.ok(
  routesFacts.references.some(
    (r) => r.refKind === "import" && r.symbol === "java.security.MessageDigest"
  ),
  "imports are references, not calls"
);
assert.deepStrictEqual(
  routesFacts.definitions.find((d) => d.name === "Routes").parents,
  ["scala.AnyRef"]
);

const storeFacts = semanticdbFacts(project, store).facts;
const find = storeFacts.definitions.find((d) => d.name === "find");
assert.deepStrictEqual(
  [find.owner, find.params],
  ["corpus.legacy.Store$", ["name"]]
);
assert.ok(
  callsNamed(storeFacts, "actionBasedSQLInterpolation")[0].args[0].parts.some(
    (p) => p?.param === "name" && p.paramIndex === 0
  ),
  "an interpolation hole that is a parameter"
);
assert.deepStrictEqual(
  callsNamed(storeFacts, "apply").find(
    (c) => c.owner === "akka.http.scaladsl.Http$"
  ).args,
  [{ index: 0, param: "system", paramIndex: 0 }]
);
assert.deepStrictEqual(callsNamed(storeFacts, "run")[0].recv, {
  ident: "db",
  sym: "corpus.legacy.Store$.db"
});
assert.ok(
  callsNamed(storeFacts, "forURL")[0].args.some(
    (arg) => arg.string === "jdbc:postgresql://legacy-db:5432/users"
  ),
  "a named argument keeps its position"
);

// Malformed input fails fast and costs only its own file.
assert.throws(
  () => decodeTextDocuments(Buffer.alloc(320 * 1024, 0xff)),
  /varint/
);
assert.throws(
  () => decodeTextDocuments(Buffer.from([0x0a, 0x7f, 0x12])),
  /past the end/
);
const unknown = Buffer.from([
  0x0a, 0x07, 0x12, 0x03, 0x61, 0x2e, 0x62, 0x30, 0x01
]);
assert.strictEqual(
  decodeTextDocuments(unknown)[0].uri,
  "a.b",
  "unknown fields are skipped"
);
const scratch = mkdtempSync(join(tmpdir(), "scalasem-sdb-"));
writeFileSync(join(scratch, "bad.semanticdb"), Buffer.from([0x0a, 0xff]));
assert.deepStrictEqual(
  readSemanticdbDir(scratch),
  [],
  "a broken file is skipped"
);

// TASTy no compiler can read falls back to the SemanticDB the build left for those sources.
mkdirSync(join(scratch, "classes", "corpus"), { recursive: true });
writeFileSync(join(scratch, "classes", "corpus", "Routes.tasty"), "");
const fallback = inspectModule(
  project,
  {
    id: "legacy",
    scalaVersion: "3.3.7",
    classDirs: [join(scratch, "classes")],
    semanticdbDirs: [join(project, "meta")],
    classpath: []
  },
  { installDeps: false }
);
assert.ok(
  fallback.diagnostics.some((d) => d.code === "compiler-unavailable"),
  "the unreadable TASTy is reported"
);
assert.strictEqual(fallback.factsSource, "semanticdb");
assert.deepStrictEqual(
  [...fallback.files.values()].map((f) => f.factsSource),
  ["semanticdb", "semanticdb"]
);
assert.ok(
  inspectModule(
    project,
    {
      id: "legacy",
      scalaVersion: "3.3.7",
      classDirs: [join(scratch, "classes")],
      semanticdbDirs: [join(project, "meta")],
      classpath: []
    },
    { installDeps: false, semanticdb: "never" }
  ).files.size === 0,
  "no fallback when SemanticDB is turned off"
);
rmSync(scratch, { recursive: true, force: true });
assert.strictEqual(
  semanticdbFacts(project, { ...store, uri: "../../../../package.json" }),
  undefined,
  "a document outside the project is not read"
);

console.log(
  `scalasem-semanticdb: ${documents.length} documents, ${routesFacts.calls.length} routes calls, ${storeFacts.calls.length} store calls`
);
