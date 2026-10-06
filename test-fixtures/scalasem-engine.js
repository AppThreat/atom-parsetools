// Tests for the scalasem engine over recorded outputs: the inspector JSON lines of several
// compiler releases and a recorded report. No JVM is needed.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { detectBuildTool, expandVirtualPaths } from "../lib/scalasem/build.js";
import { parseFacts } from "../lib/scalasem/inspect.js";
import { buildFileEntry } from "../lib/scalasem/facts.js";
import { parseProjectConfig } from "../lib/scalasem/config.js";
import { readTastyHeader } from "../lib/scalasem/compiler.js";
import { quotableLiteral, sanitizeUrl, jarCoordinate } from "../lib/scalasem/util.js";

const here = process.cwd();
const projects = join(here, "test-fixtures", "projects", "scala");

function recordedLines(version) {
  return readFileSync(join(projects, "inspector", `showcase-${version}.jsonl`), "utf-8")
    .split("\n")
    .filter((line) => line.trim());
}

function recordedFacts(version) {
  return parseFacts("/src/showcase", recordedLines(version));
}

const versions = readdirSync(join(projects, "inspector"))
  .map((f) => /^showcase-(.+)\.jsonl$/.exec(f)?.[1])
  .filter(Boolean);

assert.ok(versions.length >= 2, "expected recordings for at least two compiler releases");

for (const version of versions) {
  const facts = recordedFacts(version);
  assert.ok(facts.size === 1, `${version}: expected the sources of one file`);
  const entry = facts.get("src/main/scala/showcase/Sample.scala");
  assert.ok(entry.calls.length > 40, `${version}: expected call facts`);
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
  assert.deepStrictEqual(cipherCall.args, [{ const: "AES/GCM/NoPadding", sym: "showcase.Sample$.Algorithm" }]);
  const digestCall = entry.calls.find(
    (call) => call.owner === "java.security.MessageDigest$" && call.name === "getInstance"
  );
  assert.ok(digestCall, `${version}: MessageDigest.getInstance call`);
  assert.ok(
    digestCall.args.some((arg) => arg.const === "SHA-256"),
    `${version}: inline constant argument`
  );
}

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

console.log(`scalasem-engine: ${versions.length} compiler recordings, ${entry.calls.length} calls checked`);
