// Tests for the scalasem engine over recorded outputs: the inspector JSON lines of several
// compiler releases and a recorded report. No JVM is needed.
import { strict as assert } from "node:assert";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
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
import {
  readTastyHeader,
  semanticdbPluginVersion
} from "../lib/scalasem/compiler.js";
import { sortKeysDeep } from "../lib/scalasem/schema.js";
import {
  looksSecret,
  quotableLiteral,
  sanitizeUrl,
  jarCoordinate
} from "../lib/scalasem/util.js";

const here = process.cwd();
const projects = join(here, "test-fixtures", "projects", "scala");

function recordedLines(version) {
  return readFileSync(
    join(projects, "inspector", `showcase-${version}.jsonl`),
    "utf-8"
  )
    .split("\n")
    .filter((line) => line.trim());
}

function recordedFacts(version) {
  return parseFacts(
    join(process.cwd(), "test-fixtures", "projects", "scala", "showcase"),
    recordedLines(version)
  );
}

const versions = readdirSync(join(projects, "inspector"))
  .map((f) => /^showcase-(.+)\.jsonl$/.exec(f)?.[1])
  .filter(Boolean);

assert.ok(
  versions.length >= 2,
  "expected recordings for at least two compiler releases"
);

for (const version of versions) {
  const facts = recordedFacts(version);
  assert.ok(facts.size === 2, `${version}: expected the sources of two files`);
  const entry = facts.get("src/main/scala/showcase/Sample.scala");
  assert.ok(entry.calls.length > 20, `${version}: expected call facts`);
  assert.ok(
    entry.references.length > 40,
    `${version}: expected reference facts`
  );
  assert.ok(entry.definitions.length > 20, `${version}: expected definitions`);

  // Every fact carries a line and a column, and owners look like package paths.
  for (const call of entry.calls) {
    assert.ok(
      Number.isInteger(call.line) && call.line >= 1,
      `${version}: call line`
    );
    assert.ok(
      Number.isInteger(call.column) && call.column >= 1,
      `${version}: call column`
    );
    assert.ok(
      !call.owner.includes("$anonfun"),
      `${version}: anonymous owner folded`
    );
  }

  // The JCA call sites with their string and constant arguments.
  const cipherCall = entry.calls.find(
    (call) =>
      call.owner === "javax.crypto.Cipher$" && call.name === "getInstance"
  );
  assert.ok(cipherCall, `${version}: Cipher.getInstance call`);
  assert.deepStrictEqual(cipherCall.args, [
    { index: 0, const: "AES/GCM/NoPadding", sym: "showcase.Sample$.Algorithm" }
  ]);
  // A call in a local val belongs to the method around it, as the source reads.
  assert.strictEqual(
    cipherCall.caller,
    "showcase.Sample$.encrypt",
    `${version}: enclosing method`
  );
  // Calls inside the bodies the compiler generates for case classes are not source calls.
  assert.ok(
    !entry.calls.some((call) => call.caller.endsWith(".equals")),
    `${version}: synthetic bodies skipped`
  );
  // Imported members are references on the import line.
  assert.ok(
    entry.references.some(
      (r) =>
        r.kind === "import" &&
        r.symbol === "scala.annotation.tailrec" &&
        r.line === 3
    ),
    `${version}: imported member referenced`
  );
  const digestCall = entry.calls.find(
    (call) =>
      call.owner === "java.security.MessageDigest$" &&
      call.name === "getInstance"
  );
  assert.ok(digestCall, `${version}: MessageDigest.getInstance call`);
  assert.ok(
    digestCall.args.some((arg) => arg.const === "SHA-256"),
    `${version}: inline constant argument`
  );

  // The argument shapes of the second source: parameters, local values, receivers,
  // interpolation parts and the arguments of nested calls.
  const shapes = facts.get("src/main/scala/showcase/Shapes.scala");
  assert.ok(shapes, `${version}: shapes source read`);
  const helperArgs = shapes.calls
    .filter(
      (call) => call.owner === "showcase.Shapes$" && call.name === "digestWith"
    )
    .map((call) =>
      call.args?.find((arg) => arg.index === 0 && !arg.args && !arg.parts)
    );
  assert.ok(
    helperArgs.some((arg) => arg?.string === "SHA-1"),
    `${version}: literal argument of a project call`
  );
  assert.ok(
    helperArgs.some((arg) => arg?.const === "SHA-512"),
    `${version}: constant argument of a project call`
  );
  assert.ok(
    helperArgs.every(
      (arg) => arg === undefined || arg.string || arg.const || arg.param
    ),
    `${version}: first arguments of a project call carry a shape`
  );
  const apiCall = shapes.calls.find(
    (call) =>
      call.owner === "java.security.MessageDigest$" &&
      call.name === "getInstance" &&
      call.caller === "showcase.Shapes$.digestWith"
  );
  assert.deepStrictEqual(apiCall?.args, [
    { index: 0, param: "algorithm", paramIndex: 0 }
  ]);
  const receiverCall = shapes.calls.find(
    (call) =>
      call.owner === "java.security.MessageDigest" &&
      call.name === "digest" &&
      call.caller === "showcase.Shapes$.receiver"
  );
  assert.deepStrictEqual(receiverCall?.recv, {
    ident: "digest",
    sym: "showcase.Shapes$._$digest"
  });
  const interpolated = entry.calls.find((call) => call.name === "println");
  assert.ok(
    interpolated?.args?.some(
      (arg) =>
        Array.isArray(arg.parts) &&
        arg.parts.includes("encrypted ") &&
        arg.parts.includes(" bytes")
    ),
    `${version}: interpolation parts`
  );
  // The body of a lambda belongs to the method around it.
  assert.ok(
    shapes.calls.some(
      (call) =>
        call.owner === "java.lang.String" &&
        call.name === "length" &&
        call.caller === "showcase.Shapes$.lambdaBody"
    ),
    `${version}: lambda body calls fold to the enclosing method`
  );
  // Argument positions count across parameter lists, as parameter positions do.
  const callsOf = (owner, name, caller) =>
    shapes.calls.filter(
      (call) =>
        call.owner === owner &&
        call.name === name &&
        (!caller || call.caller === caller)
    );
  const argsOf = (calls) => calls.flatMap((call) => call.args || []);
  assert.deepStrictEqual(
    argsOf(callsOf("showcase.Shapes$", "curried"))
      .map((arg) => [arg.index, arg.string])
      .sort(),
    [
      [0, "not-an-algorithm"],
      [1, "SHA-384"]
    ],
    `${version}: curried arguments keep their own positions`
  );
  assert.deepStrictEqual(
    argsOf(
      callsOf(
        "java.security.MessageDigest$",
        "getInstance",
        "showcase.Shapes$.curried"
      )
    ),
    [{ index: 0, param: "algorithm", paramIndex: 1 }],
    `${version}: a parameter of the second list`
  );
  assert.deepStrictEqual(
    argsOf(
      callsOf(
        "java.security.MessageDigest$",
        "getInstance",
        "showcase.Shapes$.throughLocal"
      )
    ),
    [{ index: 0, param: "algorithm", paramIndex: 0 }],
    `${version}: a parameter used inside a local value`
  );
  const contextArgs = argsOf(callsOf("showcase.Shapes$", "withContext"));
  assert.ok(
    contextArgs.some((arg) => arg.index === 0 && arg.string === "SHA-224") &&
      contextArgs.some(
        (arg) => arg.index === 1 && arg.const === "context-label" && arg.defLine
      ),
    `${version}: a using argument follows the explicit ones`
  );
  assert.deepStrictEqual(
    argsOf(callsOf("showcase.Shapes$", "fetch", "showcase.Shapes$.holes")),
    [
      {
        index: 0,
        parts: [
          "https://api.example.com/users/",
          {},
          "/orders/",
          { param: "name", paramIndex: 1 },
          ""
        ]
      }
    ],
    `${version}: every interpolation hole keeps its place`
  );
  assert.deepStrictEqual(
    argsOf(callsOf("showcase.Shapes$", "block", "showcase.Shapes$.blockSite")),
    [],
    `${version}: literals inside a block argument stay out of its parts`
  );
  assert.ok(
    shapes.calls.some(
      (call) =>
        call.caller === "showcase.Shapes$.evaluated" && call.byName === 0
    ),
    `${version}: a by-name parameter read through a local value`
  );
  assert.deepStrictEqual(
    (shapes.constants || []).map((c) => c.sym),
    ["showcase.Shapes$.Host"],
    `${version}: only object members are constants, not locals, fields or vars`
  );
  // Extractor patterns carry their literal patterns.
  assert.ok(
    shapes.patterns.some(
      (p) => (p.name === "unapply" || p.name === "unapplySeq") && p.args?.length
    ),
    `${version}: pattern facts`
  );
  assert.ok(
    shapes.definitions.some(
      (d) => d.name === "digestWith" && d.params?.join(",") === "algorithm,data"
    ),
    `${version}: parameter names of a method`
  );
}

// Code inlined from a library carries the library's source positions; those are not project files.
const inlined = parseFacts(join(projects, "showcase"), [
  '{"kind":"call","file":"library/src/scala/quoted/Expr.scala","line":3,"column":1,"caller":"x","owner":"y","name":"z"}',
  '{"kind":"call","file":"/home/runner/work/utest/utest/src-3/utest/TestBuilder.scala","line":3,"column":1,"caller":"x","owner":"y","name":"z"}',
  '{"kind":"call","file":"src/main/scala/showcase/Sample.scala","line":12,"column":1,"caller":"x","owner":"y","name":"z"}'
]);
assert.deepStrictEqual(
  [...inlined.keys()],
  ["src/main/scala/showcase/Sample.scala"]
);

// Reports built from the recordings are deterministic.
const module = { id: "showcase", platform: "jvm", scalaVersion: "3.3.7" };
const buildOnce = () => {
  const out = {};
  for (const [file, facts] of recordedFacts(versions[0])) {
    out[file] = buildFileEntry(facts, module, file, {});
  }
  return out;
};
assert.deepStrictEqual(
  buildOnce(),
  buildOnce(),
  "building the entry twice differs"
);

const entry = buildOnce()["src/main/scala/showcase/Sample.scala"];
assert.ok(
  entry.literals.includes("AES/GCM/NoPadding"),
  "algorithm literal kept"
);
assert.ok(entry.literals.includes("SHA-256"), "digest literal kept");
assert.ok(
  entry.literals.every((l) => !l.includes("changeme")),
  "secret like literal dropped"
);
assert.ok(
  entry.usedTypes.every(
    (t) => !t.startsWith("java.") && !t.startsWith("scala.")
  ),
  "platform types excluded"
);
assert.strictEqual(entry.scope, "main");
assert.strictEqual(entry.platform, "jvm");
assert.ok(
  entry.definitions.some(
    (d) =>
      d.kind === "class" && d.name === "Envelope" && d.flags.includes("case")
  ),
  "case class definition"
);
assert.ok(
  entry.definitions.some((d) => d.kind === "object" && d.name === "Sample"),
  "object definition"
);
assert.ok(
  entry.constants.some(
    (c) =>
      c.sym === "showcase.Sample$.Algorithm" && c.value === "AES/GCM/NoPadding"
  ),
  "constant value"
);

// Build tool detection.
assert.deepStrictEqual(detectBuildTool(join(projects, "showcase")), {
  tool: "sbt",
  version: "1.10.11"
});
assert.strictEqual(detectBuildTool(join(projects, "playish")).tool, "none");
assert.strictEqual(
  detectBuildTool(join(projects, "no-such-project")).tool,
  "none"
);

// The sbt 2 virtual classpath form expands to real paths.
const expanded = expandVirtualPaths(
  "List(${CSR_CACHE}/https/repo1.maven.org/maven2/org/scala-lang/scala3-library_3/3.9.0/scala3-library_3-3.9.0.jar)",
  "/src/app"
);
assert.ok(!expanded.includes("${"), "virtual path variables expanded");

// Play routes and endpoint configuration values.
const config = parseProjectConfig(join(projects, "playish"));
assert.deepStrictEqual(
  config.routes
    .filter((r) => r.file === "conf/admin.routes")
    .map((r) => r.pattern),
  ["/admin/stats", "/admin/users"],
  "mounted sub-router routes carry the mount prefix"
);
assert.ok(
  !config.routes.some((r) => r.pattern === "/stats"),
  "sub-router route is not emitted at the root"
);
assert.strictEqual(
  config.routes.find((r) => r.pattern === "/").controllerMethod,
  "controllers.HomeController.index"
);
assert.ok(
  config.values.some(
    (v) => v.key === "db.url" && !v.value.includes("password")
  ),
  "credentials dropped from configuration values"
);
assert.ok(
  !config.values.some((v) => v.value.includes("changeme")),
  "secret value not collected"
);

// TASTy headers: the version triplet and the compiler that wrote the file.
const header = readTastyHeader(
  join(
    projects,
    "showcase",
    "target",
    "scala-3.3.7",
    "classes",
    "showcase",
    "Sample.tasty"
  )
);
assert.ok(header, "tasty header read");
assert.strictEqual(header.major, 28);
assert.strictEqual(header.toolVersion, "3.3.7");

// The sanitizers of the writer.
assert.strictEqual(
  sanitizeUrl("https://user:pass@example.com/a?x=1#f"),
  "https://example.com/a"
);
assert.strictEqual(quotableLiteral("AES/GCM/NoPadding"), true);
assert.strictEqual(quotableLiteral("correct horse battery staple"), false);
assert.strictEqual(quotableLiteral("user@example.com"), false);
assert.deepStrictEqual(
  jarCoordinate(
    "/cache/https/repo1.maven.org/maven2/com/github/jwt-scala/jwt-core_3/11.0.4/jwt-core_3-11.0.4.jar"
  ),
  {
    group: "com.github.jwt-scala",
    artifact: "jwt-core_3",
    version: "11.0.4"
  }
);

assert.strictEqual(
  sanitizeUrl(
    "jdbc:postgresql://app:secret@db.internal:5432/orders?password=x"
  ),
  "jdbc:postgresql://db.internal:5432/orders"
);
assert.strictEqual(
  sanitizeUrl("jdbc:sqlserver://db:1433;user=sa;password=x"),
  "jdbc:sqlserver://db:1433"
);
assert.strictEqual(
  sanitizeUrl("jdbc:oracle:thin:scott/tiger@db:1521:ORCL"),
  "jdbc:oracle:thin:@db:1521:ORCL"
);
assert.strictEqual(quotableLiteral("jdbc:mysql://root:pw@localhost/app"), true);
for (const secret of [
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
  "AKIAIOSFODNN7EXAMPLE",
  "sk_live_51HxYz9AbCdEf0123456789",
  "0123456789abcdef0123456789abcdef"
]) {
  assert.ok(
    looksSecret(secret) && !quotableLiteral(secret),
    `${secret} treated as a secret`
  );
}
for (const name of [
  "PBKDF2WithHmacSHA256",
  "SHA3-512",
  "TLSv1.3",
  "secp256r1",
  "1.2.840.113549.1.1.11"
]) {
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
      {
        sym: "app.Db.Token",
        value: "sk_live_51HxYz9AbCdEf0123456789",
        tpe: "string",
        line: 2
      },
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
assert.ok(
  !JSON.stringify(redacted).includes("sk_live"),
  "secret constant left the report"
);

// URLs lose credentials that sit anywhere in them, and token shaped path segments.
for (const [url, clean] of [
  ["jdbc:mysql://root:pa/ss@db:3306/app", "jdbc:mysql://db:3306/app"],
  ["SASL_SSL://alice:s3cr3t@broker:9093", "SASL_SSL://broker:9093"],
  ["mongodb://u:p@h1,h2/db?x=1", "mongodb://h1,h2/db"],
  ["https://host:8080/v1/items", "https://host:8080/v1/items"],
  [
    "https://hooks.slack.com/services/T0000/B0000/hT5ab9XAMPLEkEY2nB7mPqR",
    "https://hooks.slack.com/services/T0000/B0000/{}"
  ],
  [
    "https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage",
    "https://api.telegram.org/{}/sendMessage"
  ]
]) {
  assert.strictEqual(sanitizeUrl(url), clean);
}

// Interpolation pieces keep their shape, and a call or constant named for a credential
// never has its strings quoted.
const pieces = buildFileEntry(
  {
    calls: [
      {
        line: 3,
        column: 5,
        caller: "app.Auth.setup",
        owner: "app.Client",
        name: "fetch",
        args: [
          {
            index: 0,
            parts: [
              "https://user:pw@api.example.com/users/",
              { ident: "id" },
              ""
            ]
          }
        ]
      },
      {
        line: 4,
        column: 5,
        caller: "app.Auth.setup",
        owner: "org.pac4j.oidc.config.OidcConfiguration",
        name: "setSecret",
        args: [{ index: 0, string: "unXK_RSCbCXLTic2JACTiAo9" }]
      }
    ],
    constants: [
      {
        sym: "app.Auth.ClientSecret",
        value: "pac4j-demo-passwd",
        tpe: "string",
        line: 2
      }
    ]
  },
  module,
  "app/Auth.scala",
  {}
);
assert.deepStrictEqual(pieces.calls[0].args[0].parts, [
  "https://api.example.com/users/",
  { ident: "id" },
  ""
]);
assert.deepStrictEqual(pieces.calls[1].args, [
  { index: 0, redacted: "string" }
]);
assert.ok(
  !JSON.stringify(pieces).includes("unXK") &&
    !JSON.stringify(pieces).includes("pac4j-demo-passwd"),
  "credentials named by their call or value stay out of the report"
);

// The writer sorts set-like arrays but keeps positional ones in order.
const sorted = sortKeysDeep({
  "b.scala": {
    calls: [
      {
        line: 9,
        args: [
          { index: 1, int: 2 },
          { index: 0, int: 1 }
        ]
      },
      { line: 3 }
    ]
  },
  callStacks: [{ frames: [{ line: 30 }, { line: 10 }] }]
});
assert.deepStrictEqual(
  sorted["b.scala"].calls.map((c) => c.line),
  [3, 9]
);
assert.deepStrictEqual(
  sorted["b.scala"].calls[1].args.map((a) => a.index),
  [1, 0]
);
assert.deepStrictEqual(
  sorted.callStacks[0].frames.map((f) => f.line),
  [30, 10]
);

// Recorded sbt 1 and sbt 2 inventory sessions.
const sessions = join(projects, "sbt-sessions");
const session = (name) => ({
  projects: parseSbtProjects(
    readFileSync(join(sessions, `${name}-projects.txt`), "utf-8")
  ),
  sections: collectSections(
    readFileSync(join(sessions, `${name}-inventory.txt`), "utf-8")
  )
});
const sbt1 = session("crypto-jvm");
assert.deepStrictEqual(sbt1.projects, ["root"]);
const sbt1Modules = sbtModules(
  sbt1.sections,
  sbt1.projects,
  "/src/crypto-jvm",
  true
);
assert.deepStrictEqual(
  sbt1Modules.map((m) => [m.id, m.scope, m.scalaVersion, m.classDirs[0]]),
  [
    ["root", "main", "3.3.7", "/src/crypto-jvm/target/scala-3.3.7/classes"],
    [
      "root-test",
      "test",
      "3.3.7",
      "/src/crypto-jvm/target/scala-3.3.7/test-classes"
    ]
  ],
  "sbt 1 modules, test configuration included"
);
assert.ok(
  sbt1Modules[0].classpath.some(
    (c) => c.group === "org.bouncycastle" && c.artifact === "bcprov-jdk18on"
  ),
  "sbt 1 dependency classpath"
);
const sbt2 = session("bootzooka");
assert.deepStrictEqual(sbt2.projects, ["backend", "docker", "root", "ui"]);
const sbt2Modules = sbtModules(
  sbt2.sections,
  sbt2.projects,
  "/src/bootzooka",
  false
);
const byId = Object.fromEntries(sbt2Modules.map((m) => [m.id, m]));
assert.deepStrictEqual(Object.keys(byId), ["backend", "docker", "root", "ui"]);
assert.strictEqual(byId.backend.scalaVersion, "3.9.0");
assert.deepStrictEqual(byId.root.classDirs, [
  "/src/bootzooka/target/out/jvm/scala-3.9.0/bootzooka/classes"
]);
assert.deepStrictEqual(
  byId.root.sourceRoots,
  [
    "/src/bootzooka/src/main/scala",
    "/src/bootzooka/src/main/scala-3",
    "/src/bootzooka/src/main/java"
  ],
  "an aggregating root keeps only its own source roots"
);
assert.ok(
  byId.root.classpath.length < byId.backend.classpath.length,
  "aggregate root keeps only its own classpath"
);
assert.ok(
  byId.docker.classpath.some(
    (c) =>
      c.path ===
      "/src/bootzooka/target/out/jvm/scala-3.9.0/backend/backend_3-893fceb.jar"
  ),
  "sbt 2 output jars of sibling modules expand to real paths"
);
assert.ok(
  sbt2Modules.every((m) => m.classpath.every((c) => !c.path.includes("${"))),
  "no virtual paths left"
);
assert.deepStrictEqual(ownValues(["/a/classes"]), ["/a/classes"]);
assert.deepStrictEqual(
  ownValues([
    "core / Compile / classDirectory",
    "/core/classes",
    "Compile / classDirectory",
    "/root/classes"
  ]),
  ["/root/classes"]
);

// Mill and leftover build outputs, laid out the way the tools write them.
const scratch = mkdtempSync(join(tmpdir(), "scalasem-engine-"));
const write = (rel, content = "") => {
  mkdirSync(dirname(join(scratch, rel)), { recursive: true });
  writeFileSync(join(scratch, rel), content);
};
const millValue = (value) =>
  JSON.stringify({ value, valueHash: 1, inputsHash: 1 });
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
  millValue([
    {
      classes: `ref:v0:722b91f7:${join(scratch, mill, "out/util/jvm/3.3.4/compile.dest/classes")}`
    }
  ])
);
write(join(mill, "app/src/app/http/Routes.scala"));
write(
  join(mill, "out/app/3.3.4/allSources.json"),
  millValue([`ref:v0:0741a394:${join(scratch, mill, "app/src")}`])
);
write(
  join(mill, "out/app/3.3.4/allSourceFiles.json"),
  millValue([
    `ref:v0:250ffa4a:${join(scratch, mill, "app/src/app/http/Routes.scala")}`
  ])
);
write(
  join(mill, "out/util/jvm/3.3.4/allSourceFiles.json"),
  millValue([`ref:v0:8c609c5a:${join(scratch, mill, "util/src/util/U.scala")}`])
);
// A source compiled for several platforms keeps each fact once.
const { mergeFacts } = await import("../lib/scalasem/collect.js");
const mergedFiles = new Map();
const mergeSeen = new Map();
const sharedFacts = () => ({
  definitions: [
    { kind: "def", owner: "a.B$", name: "run", line: 3, column: 7 }
  ],
  calls: [
    {
      line: 4,
      column: 5,
      owner: "a.C$",
      name: "go",
      args: [{ index: 0, string: "x" }]
    }
  ],
  references: [{ line: 1, column: 8, symbol: "a.C", refKind: "import" }],
  constants: [{ sym: "a.B$.Name", line: 2, value: "n", tpe: "string" }],
  patterns: []
});
mergeFacts(mergedFiles, mergeSeen, "Shared.scala", sharedFacts());
const jsFacts = sharedFacts();
jsFacts.calls.push({
  line: 5,
  column: 5,
  owner: "a.D$",
  name: "only",
  args: []
});
mergeFacts(mergedFiles, mergeSeen, "Shared.scala", jsFacts);
const merged = mergedFiles.get("Shared.scala");
assert.deepStrictEqual(
  [
    merged.definitions.length,
    merged.calls.length,
    merged.references.length,
    merged.constants.length
  ],
  [1, 2, 1, 1],
  "facts shared by two compilations are kept once, the platform specific ones added"
);

const { inventory } = await import("../lib/scalasem/build.js");
const millModules = (await inventory(join(scratch, mill), { noBuild: true }))
  .modules;
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
  millModules[1].classpath.some((c) =>
    c.path.endsWith(join("util", "jvm", "3.3.4", "compile.dest", "classes"))
  ),
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
const millWithTests = (
  await inventory(join(scratch, mill), { noBuild: true, includeTests: true })
).modules;
assert.ok(
  millWithTests.some((m) => m.id === "app/test" && m.scope === "test"),
  "Mill test modules on request"
);
// A Scala 2 Mill module reads the SemanticDB its `semanticDbData` task left, and a run that
// may build asks Mill for it, by the module's selector.
write(
  join(mill, "out/app/2.13.15/semanticDbData.dest/data/META-INF/semanticdb/A.scala.semanticdb")
);
assert.deepStrictEqual(
  (await inventory(join(scratch, mill), { noBuild: true })).modules[0].semanticdbDirs,
  [join(scratch, mill, "out/app/2.13.15/semanticDbData.dest")]
);
if (process.platform !== "win32") {
  const millLog = join(scratch, "mill-stub.log");
  write(
    "mill-stub.js",
    `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(millLog)}, process.argv.slice(2).join(" ") + "\\n");
`
  );
  chmodSync(join(scratch, "mill-stub.js"), 0o755);
  await inventory(join(scratch, mill), {
    millCommand: join(scratch, "mill-stub.js"),
    installDeps: false
  });
  assert.ok(
    readFileSync(millLog, "utf-8").split("\n").includes("--no-server app[2.13.15].semanticDbData"),
    "SemanticDB for the Scala 2 module only"
  );

  // A Scala 2 Maven build compiles once more with the cached plugin, through the
  // scala-maven-plugin's addScalacArgs, writing into the scalasem cache.
  write(
    join("maven-legacy", "pom.xml"),
    "<project><properties><scala.version>2.13.12</scala.version></properties>" +
      "<build><plugins><plugin><artifactId>scala-maven-plugin</artifactId></plugin></plugins></build></project>"
  );
  const legacyJar = join(
    scratch,
    "m2-cache",
    "https/repo1.maven.org/maven2/org/scalameta/semanticdb-scalac_2.13.12/4.9.9/semanticdb-scalac_2.13.12-4.9.9.jar"
  );
  mkdirSync(dirname(legacyJar), { recursive: true });
  writeFileSync(legacyJar, Buffer.alloc(2048));
  const mvnLog = join(scratch, "mvn-stub.log");
  write(
    "mvn-stub.js",
    `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(mvnLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
`
  );
  chmodSync(join(scratch, "mvn-stub.js"), 0o755);
  const cacheBefore = process.env.COURSIER_CACHE;
  process.env.COURSIER_CACHE = join(scratch, "m2-cache");
  process.env.MVN_CMD = join(scratch, "mvn-stub.js");
  process.env.SCALASEM_CACHE_DIR = join(scratch, "scalasem-cache-mvn");
  const legacy = await inventory(join(scratch, "maven-legacy"), { installDeps: false });
  delete process.env.MVN_CMD;
  delete process.env.SCALASEM_CACHE_DIR;
  if (cacheBefore === undefined) {
    delete process.env.COURSIER_CACHE;
  } else {
    process.env.COURSIER_CACHE = cacheBefore;
  }
  const compileWith = readFileSync(mvnLog, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((args) => args.some((a) => a.startsWith("-DaddScalacArgs=")));
  const scalacArgs = compileWith
    .find((a) => a.startsWith("-DaddScalacArgs="))
    .slice("-DaddScalacArgs=".length)
    .split("|");
  assert.ok(
    scalacArgs.includes(`-Xplugin:${legacyJar}`) &&
      scalacArgs.some((a) =>
        a.startsWith(`-P:semanticdb:targetroot:${join(scratch, "scalasem-cache-mvn")}`)
      ),
    `plugin and target root: ${scalacArgs}`
  );
  assert.ok(
    legacy.diagnostics.some((d) => d.code === "semanticdb-missing"),
    "a compile that wrote nothing is reported"
  );
}

// The plugin release is looked up once per Scala version, and a Maven Central that cannot be
// reached is not asked again for the next version.
{
  const { createServer } = await import("node:http");
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (req.url.includes("_2.13.97/")) {
      res.end(
        "<metadata><versioning><release>4.99.1</release></versioning></metadata>"
      );
    } else {
      req.socket.destroy();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  process.env.MAVEN_CENTRAL_URL = `http://127.0.0.1:${server.address().port}/maven2`;
  const lookups = await Promise.all([
    semanticdbPluginVersion("2.13.97"),
    semanticdbPluginVersion("2.13.97")
  ]);
  assert.deepStrictEqual(lookups, ["4.99.1", "4.99.1"]);
  assert.strictEqual(requests, 1, "one request per Scala version");
  assert.strictEqual(await semanticdbPluginVersion("2.13.98"), undefined);
  assert.strictEqual(await semanticdbPluginVersion("2.13.99"), undefined);
  assert.strictEqual(requests, 2, "an unreachable Maven Central is asked once");
  delete process.env.MAVEN_CENTRAL_URL;
  server.close();
}

const sbt2Left = join("sbt2-left");
write(join(sbt2Left, "build.sbt"));
write(join(sbt2Left, "project", "build.properties"), "sbt.version=2.0.10\n");
write(join(sbt2Left, "target/out/jvm/scala-3.9.0/backend/classes/app/B.tasty"));
write(
  join(sbt2Left, "target/out/jvm/scala-3.8.4/sbt2-left-build/classes/R.tasty")
);
const leftCp = join(scratch, sbt2Left, "lib", "dep_3-1.0.jar");
write(join(sbt2Left, "lib", "dep_3-1.0.jar"));
write(
  join(
    sbt2Left,
    "target/out/jvm/scala-3.9.0/backend/streams/compile/dependencyClasspath/_global/streams/export"
  ),
  `List(${leftCp})`
);
const sbt2Left1 = (await inventory(join(scratch, sbt2Left), { noBuild: true }))
  .modules;
assert.deepStrictEqual(
  sbt2Left1.map((m) => m.id),
  ["backend"],
  "sbt 2 build definition output skipped"
);
assert.deepStrictEqual(
  sbt2Left1[0].classpath.map((c) => c.path),
  [leftCp],
  "per module exported classpath"
);

const cross = join("cross-left");
write(join(cross, "build.sbt"));
write(join(cross, "project", "build.properties"), "sbt.version=1.10.11\n");
write(join(cross, "target/scala-3.3.7/classes/a/b/X.tasty"));
write(join(cross, "target/scala-3.5.2/classes/a/b/X.tasty"));
write(join(cross, "target/scala-3.5.2/classes/a/c/Y.tasty"));
const crossDiagnostics = [];
const { modules: crossModules, diagnostics: crossDiag } = await inventory(
  join(scratch, cross),
  { noBuild: true }
);
assert.deepStrictEqual(
  crossModules.map((m) =>
    m.classDirs.map((d) => d.replace(join(scratch, cross), ""))
  ),
  [[join("/target", "scala-3.5.2", "classes")]],
  "one class root per module, the newest Scala 3 tree of a cross build"
);
assert.ok(
  crossDiag.some(
    (d) => d.code === "no-build-scala-version" && d.detail === "3.5.2"
  ),
  "choice recorded"
);
assert.deepStrictEqual(crossModules[0].sourceRoots, [join(scratch, cross)]);
crossDiagnostics.length = 0;

// Scala.js and Scala Native write their IR inside the package directories; a module without
// IR files is placed by the libraries it linked.
const platforms = join("platforms-left");
write(join(platforms, "build.sbt"));
write(join(platforms, "js/target/scala-3.3.7/classes/app/web/A.tasty"));
write(join(platforms, "js/target/scala-3.3.7/classes/app/web/A.sjsir"));
write(join(platforms, "native/target/scala-3.3.7/classes/app/cli/B.tasty"));
write(join(platforms, "native/target/scala-3.3.7/classes/app/cli/B.nir"));
write(join(platforms, "linked/target/scala-3.3.7/classes/app/C.tasty"));
const nativelib = join(
  scratch,
  platforms,
  "lib",
  "nativelib_native0.5_3-0.5.8.jar"
);
write(join(platforms, "lib", "nativelib_native0.5_3-0.5.8.jar"));
write(
  join(
    platforms,
    "linked/target/streams/compile/dependencyClasspath/_global/streams/export"
  ),
  nativelib
);
const platformModules = (
  await inventory(join(scratch, platforms), { noBuild: true })
).modules;
assert.deepStrictEqual(
  platformModules.map((m) => [m.id, m.platform]),
  [
    ["js", "js"],
    ["linked", "native"],
    ["native", "native"]
  ],
  "leftover platforms from IR files and linked libraries"
);

// sbt stops a joined session at the first failing command; the projects after it are queried
// again and the failing one is reported. A stub stands in for sbt.
if (process.platform !== "win32") {
  const stubBuild = "stub-build";
  write(join(stubBuild, "build.sbt"));
  write(
    join(stubBuild, "project", "build.properties"),
    "sbt.version=1.10.11\n"
  );
  // Leftover output: the current tree of a, an older Scala version of a, and the tree of the
  // project the inventory cannot describe.
  write(
    join(stubBuild, "a", "target", "scala-3.3.7", "classes", "a", "A.tasty")
  );
  write(
    join(stubBuild, "a", "target", "scala-3.1.3", "classes", "a", "Old.tasty")
  );
  write(
    join(stubBuild, "bad", "target", "scala-3.3.7", "classes", "b", "B.tasty")
  );
  const stubDir = join(scratch, stubBuild);
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
  if (key?.endsWith("classDirectory")) console.log(\`${stubDir}/\${project}/target/scala-3.3.7/classes\`);
}
`
  );
  chmodSync(stub, 0o755);
  const stubbed = await inventory(stubDir, {
    sbtCommand: stub,
    noCompile: true
  });
  const stubbedIds = stubbed.modules.map((m) => m.id);
  assert.deepStrictEqual(
    stubbedIds,
    ["a", "c", "bad"],
    "projects around the failure, and the leftover output of the failing one"
  );
  assert.deepStrictEqual(
    stubbed.modules[2].classDirs,
    [join(stubDir, "bad", "target", "scala-3.3.7", "classes")],
    "only the tree of the project the build could not describe"
  );
  assert.ok(
    stubbed.diagnostics.some(
      (d) => d.code === "sbt-project-failed" && d.module === "bad"
    ),
    "the failing project is reported"
  );

  // sbt 2 runs in-process, so a server that was already running is neither used nor stopped.
  // A server that appears during the inventory is stopped. The stub records its arguments.
  const sbt2Build = join(scratch, "sbt2-server");
  write(join("sbt2-server", "build.sbt"));
  write(
    join("sbt2-server", "project", "build.properties"),
    "sbt.version=2.0.10\n"
  );
  const sbt2Log = join(scratch, "sbt2-stub.log");
  const serverFile = join(sbt2Build, "project", "target", "active.json");
  write(
    "sbt2-stub.js",
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(sbt2Log)}, process.argv.slice(2).join(" ") + "\\n");
if (process.env.STUB_STARTS_SERVER) fs.writeFileSync(${JSON.stringify(serverFile)}, "{}");
`
  );
  const sbt2Stub = join(scratch, "sbt2-stub.js");
  chmodSync(sbt2Stub, 0o755);
  write(join("sbt2-server", "project", "target", "active.json"), "{}");
  await inventory(sbt2Build, { sbtCommand: sbt2Stub, noCompile: true });
  const kept = readFileSync(sbt2Log, "utf-8").trim().split("\n");
  assert.ok(
    kept.every((line) => line.startsWith("--server -batch")),
    `in-process sbt 2: ${kept}`
  );
  assert.ok(
    !kept.some((line) => line.endsWith("shutdown")),
    "a running server is left alone"
  );
  rmSync(serverFile);
  rmSync(sbt2Log);
  process.env.STUB_STARTS_SERVER = "1";
  await inventory(sbt2Build, { sbtCommand: sbt2Stub, noCompile: true });
  delete process.env.STUB_STARTS_SERVER;
  assert.ok(
    readFileSync(sbt2Log, "utf-8")
      .trim()
      .endsWith("-batch -no-colors shutdown"),
    "a server the inventory started is stopped"
  );

  // A Scala 2 module compiles once more with SemanticDB, into a target directory of its own,
  // with the plugin release cached for its exact Scala version. Scala 3 modules are left out
  // and nothing is ever cleaned.
  const scala2Build = join(scratch, "scala2-build");
  write(join("scala2-build", "build.sbt"));
  write(
    join("scala2-build", "project", "build.properties"),
    "sbt.version=1.10.11\n"
  );
  const pluginJar = join(
    scratch,
    "csr",
    "https/repo1.maven.org/maven2/org/scalameta/semanticdb-scalac_2.13.12/4.9.9/semanticdb-scalac_2.13.12-4.9.9.jar"
  );
  mkdirSync(dirname(pluginJar), { recursive: true });
  writeFileSync(pluginJar, Buffer.alloc(2048));
  const scala2Log = join(scratch, "scala2-stub.log");
  write(
    "scala2-stub.js",
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
fs.appendFileSync(${JSON.stringify(scala2Log)}, args.join(" ") + "\\n");
const commands = args.join(" ").split("; ");
if (commands[0] === "projects") {
  console.log("[info] In file:/build/\\n[info] \\t * legacy\\n[info] \\t   modern\\n[info] \\t   util-lib");
  process.exit(0);
}
for (const command of commands) {
  const mark = /^eval println\\("(.+)"\\)$/.exec(command);
  if (mark) { console.log(mark[1]); continue; }
  const [verb, key] = command.split(" ");
  const project = (key || "").split("/")[0];
  const version = project === "modern" ? "3.3.7" : "2.13.12";
  if (key?.endsWith("scalaInstance")) console.log(\`Scala instance { version label \${version}, actual version \${version}, library jars: , compiler jars: , other jars: }\`);
  if (key?.endsWith("classDirectory")) console.log(\`${scala2Build}/\${project}/target/classes\`);
}
`
  );
  const scala2Stub = join(scratch, "scala2-stub.js");
  chmodSync(scala2Stub, 0o755);
  const cacheBefore = process.env.COURSIER_CACHE;
  process.env.COURSIER_CACHE = join(scratch, "csr");
  process.env.SCALASEM_CACHE_DIR = join(scratch, "scalasem-cache");
  await inventory(scala2Build, {
    sbtCommand: scala2Stub,
    installDeps: false
  });
  if (cacheBefore === undefined) {
    delete process.env.COURSIER_CACHE;
  } else {
    process.env.COURSIER_CACHE = cacheBefore;
  }
  delete process.env.SCALASEM_CACHE_DIR;
  const semanticdbRun = readFileSync(scala2Log, "utf-8")
    .split("\n")
    .find((line) => line.includes("semanticdbEnabled"));
  assert.ok(semanticdbRun, "a SemanticDB compile runs for the Scala 2 modules");
  assert.ok(
    semanticdbRun.includes(
      'set LocalProject("util-lib") / semanticdbVersion := "4.9.9"'
    ) &&
      semanticdbRun.includes(
        'set LocalProject("legacy") / semanticdbVersion := "4.9.9"'
      ),
    `plugin pinned per module: ${semanticdbRun}`
  );
  assert.ok(
    semanticdbRun.includes(
      `set LocalProject("legacy") / target := file(${JSON.stringify(join(scratch, "scalasem-cache", "semanticdb"))}`.slice(
        0,
        -1
      )
    ),
    "compiled into the scalasem cache"
  );
  assert.ok(
    !semanticdbRun.includes("modern") && !/\bclean\b/.test(semanticdbRun),
    "Scala 3 modules stay out and nothing is cleaned"
  );
  assert.ok(
    semanticdbRun.endsWith("legacy/compile; util-lib/compile"),
    "only the Scala 2 modules compile"
  );
}
rmSync(scratch, { recursive: true, force: true });

console.log(
  `scalasem-engine: ${versions.length} compiler recordings, ${entry.calls.length} calls checked`
);
