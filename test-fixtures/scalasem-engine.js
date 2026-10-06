// Tests for the scalasem engine over recorded outputs: the inspector JSON lines of several
// compiler releases and a recorded report. No JVM is needed.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

import {
  collectSections,
  detectBuildTool,
  expandVirtualPaths,
  ownValues,
  parseSbtProjects,
  sbtModules
} from "../lib/scalasem/build.js";
import { parseFacts } from "../lib/scalasem/inspect.js";
import { buildFileEntry } from "../lib/scalasem/facts.js";
import { parseProjectConfig } from "../lib/scalasem/config.js";
import { readTastyHeader } from "../lib/scalasem/compiler.js";
import { sortKeysDeep } from "../lib/scalasem/schema.js";
import { looksSecret, quotableLiteral, sanitizeUrl, jarCoordinate } from "../lib/scalasem/util.js";

const here = process.cwd();
const projects = join(here, "test-fixtures", "projects", "scala");

function recordedLines(version) {
  return readFileSync(join(projects, "inspector", `showcase-${version}.jsonl`), "utf-8")
    .split("\n")
    .filter((line) => line.trim());
}

function recordedFacts(version) {
  return parseFacts(join(process.cwd(), "test-fixtures", "projects", "scala", "showcase"), recordedLines(version));
}

const versions = readdirSync(join(projects, "inspector"))
  .map((f) => /^showcase-(.+)\.jsonl$/.exec(f)?.[1])
  .filter(Boolean);

assert.ok(versions.length >= 2, "expected recordings for at least two compiler releases");

for (const version of versions) {
  const facts = recordedFacts(version);
  assert.ok(facts.size === 1, `${version}: expected the sources of one file`);
  const entry = facts.get("src/main/scala/showcase/Sample.scala");
  assert.ok(entry.calls.length > 20, `${version}: expected call facts`);
  assert.ok(entry.references.length > 40, `${version}: expected reference facts`);
  assert.ok(entry.definitions.length > 20, `${version}: expected definitions`);

  // Every fact carries a line and a column, and owners look like package paths.
  for (const call of entry.calls) {
    assert.ok(Number.isInteger(call.line) && call.line >= 1, `${version}: call line`);
    assert.ok(Number.isInteger(call.column) && call.column >= 1, `${version}: call column`);
    assert.ok(!call.owner.includes("$anonfun"), `${version}: anonymous owner folded`);
  }

  // The JCA call sites with their string and constant arguments.
  const cipherCall = entry.calls.find(
    (call) => call.owner === "javax.crypto.Cipher$" && call.name === "getInstance"
  );
  assert.ok(cipherCall, `${version}: Cipher.getInstance call`);
  assert.deepStrictEqual(cipherCall.args, [
    { index: 0, const: "AES/GCM/NoPadding", sym: "showcase.Sample$.Algorithm" }
  ]);
  // A call in a local val belongs to the method around it, as the source reads.
  assert.strictEqual(cipherCall.caller, "showcase.Sample$.encrypt", `${version}: enclosing method`);
  // Calls inside the bodies the compiler generates for case classes are not source calls.
  assert.ok(!entry.calls.some((call) => call.caller.endsWith(".equals")), `${version}: synthetic bodies skipped`);
  // Imported members are references on the import line.
  assert.ok(
    entry.references.some((r) => r.kind === "import" && r.symbol === "scala.annotation.tailrec" && r.line === 3),
    `${version}: imported member referenced`
  );
  const digestCall = entry.calls.find(
    (call) => call.owner === "java.security.MessageDigest$" && call.name === "getInstance"
  );
  assert.ok(digestCall, `${version}: MessageDigest.getInstance call`);
  assert.ok(
    digestCall.args.some((arg) => arg.const === "SHA-256"),
    `${version}: inline constant argument`
  );
}

// Code inlined from a library carries the library's source positions; those are not project files.
const inlined = parseFacts(join(projects, "showcase"), [
  '{"kind":"call","file":"library/src/scala/quoted/Expr.scala","line":3,"column":1,"caller":"x","owner":"y","name":"z"}',
  '{"kind":"call","file":"/home/runner/work/utest/utest/src-3/utest/TestBuilder.scala","line":3,"column":1,"caller":"x","owner":"y","name":"z"}',
  '{"kind":"call","file":"src/main/scala/showcase/Sample.scala","line":12,"column":1,"caller":"x","owner":"y","name":"z"}'
]);
assert.deepStrictEqual([...inlined.keys()], ["src/main/scala/showcase/Sample.scala"]);

// Reports built from the recordings are deterministic.
const module = { id: "showcase", platform: "jvm", scalaVersion: "3.3.7" };
const buildOnce = () => {
  const out = {};
  for (const [file, facts] of recordedFacts(versions[0])) {
    out[file] = buildFileEntry(facts, module, file, {});
  }
  return out;
};
assert.deepStrictEqual(buildOnce(), buildOnce(), "building the entry twice differs");

const entry = buildOnce()["src/main/scala/showcase/Sample.scala"];
assert.ok(entry.literals.includes("AES/GCM/NoPadding"), "algorithm literal kept");
assert.ok(entry.literals.includes("SHA-256"), "digest literal kept");
assert.ok(entry.literals.every((l) => !l.includes("changeme")), "secret like literal dropped");
assert.ok(entry.usedTypes.every((t) => !t.startsWith("java.") && !t.startsWith("scala.")), "platform types excluded");
assert.strictEqual(entry.scope, "main");
assert.strictEqual(entry.platform, "jvm");
assert.ok(entry.definitions.some((d) => d.kind === "class" && d.name === "Envelope" && d.flags.includes("case")), "case class definition");
assert.ok(entry.definitions.some((d) => d.kind === "object" && d.name === "Sample"), "object definition");
assert.ok(entry.constants.some((c) => c.sym === "showcase.Sample$.Algorithm" && c.value === "AES/GCM/NoPadding"), "constant value");

// Build tool detection.
assert.deepStrictEqual(detectBuildTool(join(projects, "showcase")), { tool: "sbt", version: "1.10.11" });
assert.strictEqual(detectBuildTool(join(projects, "playish")).tool, "none");
assert.strictEqual(detectBuildTool(join(projects, "no-such-project")).tool, "none");

// The sbt 2 virtual classpath form expands to real paths.
const expanded = expandVirtualPaths(
  "List(${CSR_CACHE}/https/repo1.maven.org/maven2/org/scala-lang/scala3-library_3/3.9.0/scala3-library_3-3.9.0.jar)",
  "/src/app"
);
assert.ok(!expanded.includes("${"), "virtual path variables expanded");

// Play routes and endpoint configuration values.
const config = parseProjectConfig(join(projects, "playish"));
assert.deepStrictEqual(
  config.routes.filter((r) => r.file === "conf/admin.routes").map((r) => r.pattern),
  ["/admin/stats", "/admin/users"],
  "mounted sub-router routes carry the mount prefix"
);
assert.ok(!config.routes.some((r) => r.pattern === "/stats"), "sub-router route is not emitted at the root");
assert.strictEqual(config.routes.find((r) => r.pattern === "/").controllerMethod, "controllers.HomeController.index");
assert.ok(
  config.values.some((v) => v.key === "db.url" && !v.value.includes("password")),
  "credentials dropped from configuration values"
);
assert.ok(!config.values.some((v) => v.value.includes("changeme")), "secret value not collected");

// TASTy headers: the version triplet and the compiler that wrote the file.
const header = readTastyHeader(join(projects, "showcase", "target", "scala-3.3.7", "classes", "showcase", "Sample.tasty"));
assert.ok(header, "tasty header read");
assert.strictEqual(header.major, 28);
assert.strictEqual(header.toolVersion, "3.3.7");

// The sanitizers of the writer.
assert.strictEqual(sanitizeUrl("https://user:pass@example.com/a?x=1#f"), "https://example.com/a");
assert.strictEqual(quotableLiteral("AES/GCM/NoPadding"), true);
assert.strictEqual(quotableLiteral("correct horse battery staple"), false);
assert.strictEqual(quotableLiteral("user@example.com"), false);
assert.deepStrictEqual(jarCoordinate("/cache/https/repo1.maven.org/maven2/com/github/jwt-scala/jwt-core_3/11.0.4/jwt-core_3-11.0.4.jar"), {
  group: "com.github.jwt-scala",
  artifact: "jwt-core_3",
  version: "11.0.4"
});

assert.strictEqual(
  sanitizeUrl("jdbc:postgresql://app:secret@db.internal:5432/orders?password=x"),
  "jdbc:postgresql://db.internal:5432/orders"
);
assert.strictEqual(sanitizeUrl("jdbc:sqlserver://db:1433;user=sa;password=x"), "jdbc:sqlserver://db:1433");
assert.strictEqual(sanitizeUrl("jdbc:oracle:thin:scott/tiger@db:1521:ORCL"), "jdbc:oracle:thin:@db:1521:ORCL");
assert.strictEqual(quotableLiteral("jdbc:mysql://root:pw@localhost/app"), true);
for (const secret of [
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
  "AKIAIOSFODNN7EXAMPLE",
  "sk_live_51HxYz9AbCdEf0123456789",
  "0123456789abcdef0123456789abcdef"
]) {
  assert.ok(looksSecret(secret) && !quotableLiteral(secret), `${secret} treated as a secret`);
}
for (const name of ["PBKDF2WithHmacSHA256", "SHA3-512", "TLSv1.3", "secp256r1", "1.2.840.113549.1.1.11"]) {
  assert.ok(quotableLiteral(name), `${name} quotable`);
}

// String arguments and constants outside the allowed shapes keep their position, not their value.
const redacted = buildFileEntry(
  {
    calls: [
      {
        line: 4,
        column: 5,
        caller: "app.Db.connect",
        owner: "java.sql.DriverManager$",
        name: "getConnection",
        args: [
          { index: 0, string: "jdbc:postgresql://app:pw@db:5432/orders" },
          { index: 1, string: "app" },
          { index: 2, string: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" }
        ]
      }
    ],
    constants: [
      { sym: "app.Db.Token", value: "sk_live_51HxYz9AbCdEf0123456789", tpe: "string", line: 2 },
      { sym: "app.Db.Alg", value: "SHA-256", tpe: "string", line: 3 }
    ]
  },
  module,
  "app/Db.scala",
  {}
);
assert.deepStrictEqual(redacted.calls[0].args, [
  { index: 0, string: "jdbc:postgresql://db:5432/orders" },
  { index: 1, string: "app" },
  { index: 2, redacted: "string" }
]);
assert.deepStrictEqual(redacted.constants, [
  { sym: "app.Db.Token", tpe: "string", line: 2, redacted: true },
  { sym: "app.Db.Alg", value: "SHA-256", tpe: "string", line: 3 }
]);
assert.ok(!JSON.stringify(redacted).includes("sk_live"), "secret constant left the report");

// The writer sorts set-like arrays but keeps positional ones in order.
const sorted = sortKeysDeep({
  "b.scala": { calls: [{ line: 9, args: [{ index: 1, int: 2 }, { index: 0, int: 1 }] }, { line: 3 }] },
  callStacks: [{ frames: [{ line: 30 }, { line: 10 }] }]
});
assert.deepStrictEqual(sorted["b.scala"].calls.map((c) => c.line), [3, 9]);
assert.deepStrictEqual(sorted["b.scala"].calls[1].args.map((a) => a.index), [1, 0]);
assert.deepStrictEqual(sorted.callStacks[0].frames.map((f) => f.line), [30, 10]);

// Recorded sbt 1 and sbt 2 inventory sessions.
const sessions = join(projects, "sbt-sessions");
const session = (name) => ({
  projects: parseSbtProjects(readFileSync(join(sessions, `${name}-projects.txt`), "utf-8")),
  sections: collectSections(readFileSync(join(sessions, `${name}-inventory.txt`), "utf-8"))
});
const sbt1 = session("crypto-jvm");
assert.deepStrictEqual(sbt1.projects, ["root"]);
const sbt1Modules = sbtModules(sbt1.sections, sbt1.projects, "/src/crypto-jvm", true);
assert.deepStrictEqual(
  sbt1Modules.map((m) => [m.id, m.scope, m.scalaVersion, m.classDirs[0]]),
  [
    ["root", "main", "3.3.7", "/src/crypto-jvm/target/scala-3.3.7/classes"],
    ["root-test", "test", "3.3.7", "/src/crypto-jvm/target/scala-3.3.7/test-classes"]
  ],
  "sbt 1 modules, test configuration included"
);
assert.ok(
  sbt1Modules[0].classpath.some((c) => c.group === "org.bouncycastle" && c.artifact === "bcprov-jdk18on"),
  "sbt 1 dependency classpath"
);
const sbt2 = session("bootzooka");
assert.deepStrictEqual(sbt2.projects, ["backend", "docker", "root", "ui"]);
const sbt2Modules = sbtModules(sbt2.sections, sbt2.projects, "/src/bootzooka", false);
const byId = Object.fromEntries(sbt2Modules.map((m) => [m.id, m]));
assert.deepStrictEqual(Object.keys(byId), ["backend", "docker", "root", "ui"]);
assert.strictEqual(byId.backend.scalaVersion, "3.9.0");
assert.deepStrictEqual(byId.root.classDirs, ["/src/bootzooka/target/out/jvm/scala-3.9.0/bootzooka/classes"]);
assert.deepStrictEqual(
  byId.root.sourceRoots,
  ["/src/bootzooka/src/main/scala", "/src/bootzooka/src/main/scala-3", "/src/bootzooka/src/main/java"],
  "an aggregating root keeps only its own source roots"
);
assert.ok(byId.root.classpath.length < byId.backend.classpath.length, "aggregate root keeps only its own classpath");
assert.ok(
  byId.docker.classpath.some((c) => c.path === "/src/bootzooka/target/out/jvm/scala-3.9.0/backend/backend_3-893fceb.jar"),
  "sbt 2 output jars of sibling modules expand to real paths"
);
assert.ok(sbt2Modules.every((m) => m.classpath.every((c) => !c.path.includes("${"))), "no virtual paths left");
assert.deepStrictEqual(ownValues(["/a/classes"]), ["/a/classes"]);
assert.deepStrictEqual(
  ownValues(["core / Compile / classDirectory", "/core/classes", "Compile / classDirectory", "/root/classes"]),
  ["/root/classes"]
);

// Mill and leftover build outputs, laid out the way the tools write them.
const scratch = mkdtempSync(join(tmpdir(), "scalasem-engine-"));
const write = (rel, content = "") => {
  mkdirSync(dirname(join(scratch, rel)), { recursive: true });
  writeFileSync(join(scratch, rel), content);
};
const millValue = (value) => JSON.stringify({ value, valueHash: 1, inputsHash: 1 });
const mill = join("mill-app");
write(join(mill, "build.mill"), "//| mill-version: 1.0.6\n");
for (const [moduleDir, version] of [
  ["out/app/3.3.4", "3.3.4"],
  ["out/app/2.13.15", "2.13.15"],
  ["out/app/3.3.4/test", "3.3.4"],
  ["out/util/jvm/3.3.4", "3.3.4"],
  ["out/mill-build", "3.7.3"]
]) {
  write(join(mill, moduleDir, "scalaVersion.json"), millValue(version));
  write(join(mill, moduleDir, "compile.dest", "classes", "app", "A.tasty"));
}
write(
  join(mill, "out/app/3.3.4/upstreamCompileOutput.json"),
  millValue([{ classes: `ref:v0:722b91f7:${join(scratch, mill, "out/util/jvm/3.3.4/compile.dest/classes")}` }])
);
write(join(mill, "app/src/app/http/Routes.scala"));
write(
  join(mill, "out/app/3.3.4/allSources.json"),
  millValue([`ref:v0:0741a394:${join(scratch, mill, "app/src")}`])
);
write(
  join(mill, "out/app/3.3.4/allSourceFiles.json"),
  millValue([`ref:v0:250ffa4a:${join(scratch, mill, "app/src/app/http/Routes.scala")}`])
);
write(
  join(mill, "out/util/jvm/3.3.4/allSourceFiles.json"),
  millValue([`ref:v0:8c609c5a:${join(scratch, mill, "util/src/util/U.scala")}`])
);
const { inventory } = await import("../lib/scalasem/build.js");
const millModules = (await inventory(join(scratch, mill), { noBuild: true })).modules;
assert.deepStrictEqual(
  millModules.map((m) => [m.id, m.scalaVersion, m.scope]),
  [
    ["app", "2.13.15", "main"],
    ["app", "3.3.4", "main"],
    ["util/jvm", "3.3.4", "main"]
  ],
  "Mill cross and nested modules, test modules and the build script left out"
);
assert.ok(
  millModules[1].classpath.some((c) => c.path.endsWith(join("util", "jvm", "3.3.4", "compile.dest", "classes"))),
  "upstream module classes on the classpath"
);
assert.deepStrictEqual(
  millModules[1].sourceRoots,
  [join(scratch, mill, "app/src")],
  "Mill source roots from the module's sources, not each package directory"
);
assert.deepStrictEqual(
  millModules[2].sourceRoots,
  [join(scratch, mill, "util/src/util")],
  "Mill source file directories when the sources are not recorded"
);
const millWithTests = (await inventory(join(scratch, mill), { noBuild: true, includeTests: true })).modules;
assert.ok(millWithTests.some((m) => m.id === "app/test" && m.scope === "test"), "Mill test modules on request");

const sbt2Left = join("sbt2-left");
write(join(sbt2Left, "build.sbt"));
write(join(sbt2Left, "project", "build.properties"), "sbt.version=2.0.10\n");
write(join(sbt2Left, "target/out/jvm/scala-3.9.0/backend/classes/app/B.tasty"));
write(join(sbt2Left, "target/out/jvm/scala-3.8.4/sbt2-left-build/classes/R.tasty"));
const leftCp = join(scratch, sbt2Left, "lib", "dep_3-1.0.jar");
write(join(sbt2Left, "lib", "dep_3-1.0.jar"));
write(
  join(sbt2Left, "target/out/jvm/scala-3.9.0/backend/streams/compile/dependencyClasspath/_global/streams/export"),
  `List(${leftCp})`
);
const sbt2Left1 = (await inventory(join(scratch, sbt2Left), { noBuild: true })).modules;
assert.deepStrictEqual(sbt2Left1.map((m) => m.id), ["backend"], "sbt 2 build definition output skipped");
assert.deepStrictEqual(sbt2Left1[0].classpath.map((c) => c.path), [leftCp], "per module exported classpath");

const cross = join("cross-left");
write(join(cross, "build.sbt"));
write(join(cross, "project", "build.properties"), "sbt.version=1.10.11\n");
write(join(cross, "target/scala-3.3.7/classes/a/b/X.tasty"));
write(join(cross, "target/scala-3.5.2/classes/a/b/X.tasty"));
write(join(cross, "target/scala-3.5.2/classes/a/c/Y.tasty"));
const crossDiagnostics = [];
const { modules: crossModules, diagnostics: crossDiag } = await inventory(join(scratch, cross), { noBuild: true });
assert.deepStrictEqual(
  crossModules.map((m) => m.classDirs.map((d) => d.replace(join(scratch, cross), ""))),
  [[join("/target", "scala-3.5.2", "classes")]],
  "one class root per module, the newest Scala 3 tree of a cross build"
);
assert.ok(crossDiag.some((d) => d.code === "no-build-scala-version" && d.detail === "3.5.2"), "choice recorded");
assert.deepStrictEqual(crossModules[0].sourceRoots, [join(scratch, cross)]);
crossDiagnostics.length = 0;

// sbt stops a joined session at the first failing command; the projects after it are queried
// again and the failing one is reported. A stub stands in for sbt.
if (process.platform !== "win32") {
  const stubBuild = "stub-build";
  write(join(stubBuild, "build.sbt"));
  write(join(stubBuild, "project", "build.properties"), "sbt.version=1.10.11\n");
  write(join(stubBuild, "target", "scala-3.3.7", "classes", "a", "A.tasty"));
  const stub = join(scratch, "sbt-stub.js");
  write(
    "sbt-stub.js",
    `#!${process.execPath}
const commands = process.argv.slice(2).filter((a) => !a.startsWith("-")).join(" ").split("; ");
if (commands[0] === "projects") {
  console.log("[info] In file:/build/\\n[info] \\t * a\\n[info] \\t   bad\\n[info] \\t   c");
  process.exit(0);
}
for (const command of commands) {
  const mark = /^eval println\\("(.+)"\\)$/.exec(command);
  if (mark) { console.log(mark[1]); continue; }
  const [verb, key] = command.split(" ");
  const project = (key || "").split("/")[0];
  if (project === "bad" && key.endsWith("dependencyClasspath")) {
    console.log("[error] unresolved dependency");
    process.exit(1);
  }
  if (key?.endsWith("scalaInstance")) console.log("Scala instance { version label 3.3.7, actual version 3.3.7, library jars: , compiler jars: , other jars: }");
  if (key?.endsWith("classDirectory")) console.log(\`/build/\${project}/target/scala-3.3.7/classes\`);
}
`
  );
  chmodSync(stub, 0o755);
  const stubbed = await inventory(join(scratch, stubBuild), { sbtCommand: stub, noCompile: true });
  const stubbedIds = stubbed.modules.map((m) => m.id);
  assert.ok(stubbedIds.includes("a") && stubbedIds.includes("c"), `projects around the failure: ${stubbedIds}`);
  assert.ok(
    stubbed.diagnostics.some((d) => d.code === "sbt-project-failed" && d.module === "bad"),
    "the failing project is reported"
  );
}
rmSync(scratch, { recursive: true, force: true });

console.log(`scalasem-engine: ${versions.length} compiler recordings, ${entry.calls.length} calls checked`);
