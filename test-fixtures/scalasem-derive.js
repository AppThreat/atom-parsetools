// The evidence derivation over recorded facts: the merged facts of compiled projects under
// test-fixtures/projects/scala/evidence (re-recorded with record-scalasem-evidence.js), the
// showcase inspector recordings, and facts written out by hand for the shapes no fixture
// project has. No compiler runs.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { CANONICAL_ALGORITHMS } from "../lib/scalasem/derive/algorithms.js";
import { deriveContext, deriveEvidence } from "../lib/scalasem/derive/index.js";
import { parseFacts } from "../lib/scalasem/inspect.js";

const projects = join(process.cwd(), "test-fixtures", "projects", "scala");

function recorded(name) {
  const recording = JSON.parse(
    readFileSync(join(projects, "evidence", `${name}.facts.json`), "utf-8")
  );
  return deriveEvidence(
    deriveContext(new Map(Object.entries(recording.files)), recording.config, {
      projectDir: join(projects, "evidence", name)
    })
  );
}

function fromFacts(files, config = {}) {
  return deriveEvidence(deriveContext(new Map(Object.entries(files)), config));
}

const at = (findings, file, line) =>
  findings.filter((f) => f.file.endsWith(file) && f.line === line);

// Crypto over the JCA, BouncyCastle, jwt-scala and bcrypt fixture.
const crypto = recorded("crypto-jvm").crypto;
const summary = (f) =>
  [f.algorithm, f.mode, f.padding, f.keySize, f.curve, f.weak ? "weak" : ""]
    .filter((x) => x !== undefined && x !== "")
    .join(" ");
const expected = {
  "JcaOps.scala:13": "AES GCM NoPadding",
  "JcaOps.scala:19": "DES ECB PKCS5Padding weak",
  "JcaOps.scala:25": "AES CBC PKCS5Padding",
  "JcaOps.scala:30": "MD5 weak",
  "JcaOps.scala:32": "SHA-256",
  "JcaOps.scala:36": "SHA-1 weak",
  "JcaOps.scala:46": "SHA-512",
  "JcaOps.scala:50": "SHA-384",
  "JcaOps.scala:55": "HmacSHA256",
  "JcaOps.scala:61": "RSA 2048",
  "JcaOps.scala:67": "EC secp256r1",
  "JcaOps.scala:70": "SHA256withECDSA",
  "JcaOps.scala:77": "PBKDF2WithHmacSHA256",
  "JcaOps.scala:82": "AES 256",
  "TokenOps.scala:8": "HS256",
  "TokenOps.scala:11": "HS512",
  "TokenOps.scala:14": "bcrypt"
};
for (const [where, want] of Object.entries(expected)) {
  const [file, line] = where.split(":");
  const found = at(crypto, file, Number(line)).map(summary);
  assert.ok(found.includes(want), `${where}: expected ${want}, got ${found}`);
}
// Values that travel through calls and local values keep their chain, within four
// boundaries; the fifth boundary leaves the call unresolved.
const viaLines = (file, line) =>
  at(crypto, file, line)
    .find((f) => f.via)
    ?.via.map((v) => v.line);
assert.deepStrictEqual(viaLines("JcaOps.scala", 46), [40, 47, 46]);
assert.deepStrictEqual(viaLines("JcaOps.scala", 50), [40, 41, 42, 50]);
assert.ok(
  !crypto.some((f) => f.algorithm === "SHA-224"),
  "a value five boundaries away is not resolved"
);
// Strings that only mention an algorithm are not findings.
assert.ok(
  crypto.every(
    (f) => !f.algorithm || CANONICAL_ALGORITHMS.includes(f.algorithm)
  ),
  `only canonical names: ${crypto.map((f) => f.algorithm).filter(Boolean)}`
);

// Arguments of a second parameter list and of a using clause, from the showcase recording.
const showcaseFacts = parseFacts(
  join(projects, "showcase"),
  readFileSync(join(projects, "inspector", "showcase-3.3.7.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
);
const showcase = deriveEvidence(deriveContext(showcaseFacts, {})).crypto;
const algorithmsOf = (findings) =>
  findings.map((f) => f.algorithm).filter(Boolean);
assert.ok(
  algorithmsOf(showcase).includes("SHA-384") &&
    algorithmsOf(showcase).includes("SHA-224") &&
    !algorithmsOf(showcase).includes("not-an-algorithm") &&
    !algorithmsOf(showcase).includes("context-label"),
  `curried and using arguments reach their own parameters: ${algorithmsOf(showcase)}`
);

// Facts written out by hand.
const call = (line, caller, owner, name, args, extra = {}) => ({
  line,
  column: 5,
  caller,
  owner,
  name,
  ...(args ? { args } : {}),
  ...extra
});
const digest = (line, caller, args, extra) =>
  call(
    line,
    caller,
    "java.security.MessageDigest$",
    "getInstance",
    args,
    extra
  );

// Overloads of one method: the parameter of `mac(algorithm)` reaches the call sites of that
// overload only, never the secret passed to `mac(secret, data)`.
const overloads = fromFacts({
  "A.scala": {
    definitions: [],
    calls: [
      digest(3, "p.A$.mac", [{ index: 0, param: "algorithm", paramIndex: 0 }], {
        callerSignature: "(java.lang.String)java.lang.Object"
      }),
      call(6, "p.A$.useOne", "p.A$", "mac", [{ index: 0, string: "SHA-256" }], {
        signature: "(java.lang.String)java.lang.Object"
      }),
      call(
        7,
        "p.A$.useTwo",
        "p.A$",
        "mac",
        [
          { index: 0, string: "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY" },
          { index: 1, string: "data" }
        ],
        { signature: "(java.lang.String,java.lang.String)java.lang.Object" }
      )
    ]
  }
}).crypto;
assert.deepStrictEqual(
  overloads.map((f) => [f.line, f.algorithm]),
  [[6, "SHA-256"]],
  "an overload's call sites only"
);

// Two methods declare a local value of the same name; each keeps its own.
const locals = fromFacts({
  "B.scala": {
    calls: [
      digest(4, "p.B$.weak", [
        { index: 0, const: "MD5", sym: "p.B$._$alg", defLine: 3 }
      ]),
      digest(8, "p.B$.strong", [
        { index: 0, const: "SHA-256", sym: "p.B$._$alg", defLine: 7 }
      ])
    ],
    constants: []
  }
}).crypto;
assert.deepStrictEqual(
  locals.map((f) => [f.line, f.algorithm, f.via?.[0].line, Boolean(f.weak)]),
  [
    [4, "MD5", 3, true],
    [8, "SHA-256", 7, false]
  ]
);

// A value that is not shaped like an algorithm name never reaches the report.
const secret = fromFacts({
  "C.scala": {
    calls: [
      digest(2, "p.C$.run", [
        {
          index: 0,
          string: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"
        }
      ])
    ]
  }
}).crypto;
assert.deepStrictEqual(
  secret.map((f) => [f.resolution, f.algorithm]),
  [["unresolved", undefined]],
  "a secret shaped argument is reported unresolved, without its value"
);

// A local value and four calls are five boundaries.
const hops = [];
for (let i = 1; i <= 4; i++) {
  hops.push(
    call(10 + i, `p.D$.h${i + 1}`, "p.D$", `h${i}`, [
      { index: 0, param: "a", paramIndex: 0 }
    ])
  );
}
const budget = fromFacts({
  "D.scala": {
    calls: [
      digest(10, "p.D$.h1", [{ index: 0, param: "a", paramIndex: 0 }]),
      ...hops,
      call(20, "p.D$.start", "p.D$", "h5", [
        { index: 0, const: "SHA-384", sym: "p.D$._$a", defLine: 19 }
      ])
    ]
  }
}).crypto;
assert.ok(
  !budget.some((f) => f.algorithm),
  `five boundaries are out of reach: ${JSON.stringify(budget)}`
);

// Configuration calls reach the instance they configure, not the other finding of the method.
const configured = fromFacts({
  "E.scala": {
    definitions: [
      { kind: "val", name: "rsa", owner: "p.E$.keys", line: 2 },
      { kind: "val", name: "dsa", owner: "p.E$.keys", line: 3 }
    ],
    calls: [
      call(2, "p.E$.keys", "java.security.KeyPairGenerator$", "getInstance", [
        { index: 0, string: "RSA" }
      ]),
      call(3, "p.E$.keys", "java.security.KeyPairGenerator$", "getInstance", [
        { index: 0, string: "DSA" }
      ]),
      call(
        4,
        "p.E$.keys",
        "java.security.KeyPairGenerator",
        "initialize",
        [{ index: 0, int: 4096 }],
        { recv: { ident: "rsa", sym: "p.E$._$rsa" } }
      ),
      call(
        5,
        "p.E$.keys",
        "java.security.KeyPairGenerator",
        "initialize",
        [{ index: 0, int: 1024 }],
        { recv: { ident: "dsa", sym: "p.E$._$dsa" } }
      )
    ]
  }
}).crypto;
assert.deepStrictEqual(
  configured.map((f) => [f.algorithm, f.keySize, Boolean(f.weak)]),
  [
    ["RSA", 4096, false],
    ["DSA", 1024, true]
  ]
);

// An algorithm object the jwt library is given names an algorithm; an import does not.
const jwt = fromFacts({
  "F.scala": {
    calls: [call(5, "p.F$.sign", "pdi.jwt.JwtCirce$", "encode", [])],
    references: [
      {
        line: 1,
        column: 1,
        symbol: "pdi.jwt.JwtAlgorithm$.HS256",
        refKind: "import"
      },
      {
        line: 5,
        column: 30,
        symbol: "pdi.jwt.JwtAlgorithm$.RS512",
        refKind: "term"
      },
      {
        line: 5,
        column: 40,
        symbol: "pdi.jwt.JwtAlgorithm$.allHmac",
        refKind: "term"
      }
    ]
  }
}).crypto;
assert.deepStrictEqual(
  jwt.map((f) => [f.line, f.algorithm, f.primitive]),
  [[5, "RS512", "signature"]]
);

// The weakness policy.
const weakOf = (algorithm, extra = {}) =>
  Boolean(
    fromFacts({
      "G.scala": {
        calls: [
          call(1, "p.G$.run", "javax.crypto.Cipher$", "getInstance", [
            { index: 0, string: algorithm }
          ]),
          ...(extra.calls || [])
        ]
      }
    }).crypto[0]?.weak
  );
assert.ok(weakOf("DESede/CBC/PKCS5Padding"), "triple DES is weak");
assert.ok(weakOf("AES/ECB/PKCS5Padding"), "ECB is weak for a block cipher");
assert.ok(
  !weakOf("RSA/ECB/OAEPWithSHA-256AndMGF1Padding"),
  "ECB names no mode for RSA"
);
assert.ok(!weakOf("AES/GCM/NoPadding"));

// Outbound services and data stores of the services fixture.
const services = recorded("services-jvm").services;
const located = (s) =>
  `${s.file.split("/").pop()}:${s.line} ${s.kind} ${s.client} ${s.url || s.host || s.topic}`;
for (const want of [
  "DataStores.scala:11 datastore jdbc jdbc:postgresql://db.internal:5432/orders",
  "DataStores.scala:15 messaging kafka kafka.internal:9092",
  "DataStores.scala:19 messaging kafka order-events",
  "Http4sClients.scala:9 http-client http4s https://payments.example.com/v2/charges",
  "OutboundClients.scala:14 http-client java.net.uri https://auth.example.com/oauth/token",
  "OutboundClients.scala:19 http-client pekko-http https://inventory.example.com/api/stock",
  "SttpClients.scala:10 http-client sttp https://api.github.com/repos/scala/scala3",
  "SttpClients.scala:15 http-client sttp https://config.example.com/v1/settings"
]) {
  assert.ok(services.map(located).includes(want), `service ${want}`);
}
assert.ok(
  recorded("scalajs-app").services.some(
    (s) => s.kind === "websocket" && s.url === "wss://stream.example.com/events"
  ),
  "a ws URL is a websocket"
);
assert.ok(
  recorded("play-app").services.some(
    (s) =>
      s.resolution === "config" && s.url === "https://api.stripe.com/v1/charges"
  ),
  "a URL read from the configuration"
);

// Values that are not endpoints, and credentials anywhere in the ones that are.
const servicesOf = (calls, config = {}) =>
  fromFacts({ "S.scala": { calls } }, config).services.map(located);
assert.deepStrictEqual(
  servicesOf([
    call(1, "p.S$.a", "java.net.URI$", "create", [
      { index: 0, string: "/login" }
    ]),
    call(2, "p.S$.a", "java.net.URI$", "create", [
      { index: 0, string: "urn:isbn:0451450523" }
    ]),
    call(3, "p.S$.a", "org.mongodb.scala.bson.BsonString$", "apply", [
      { index: 0, string: "hello world" }
    ]),
    call(
      4,
      "p.S$.a",
      "software.amazon.awssdk.auth.credentials.AwsBasicCredentials$",
      "create",
      [{ index: 0, string: "AKIAIOSFODNN7EXAMPLE" }]
    )
  ]),
  [],
  "relative paths, URNs, documents and credentials are not services"
);
assert.deepStrictEqual(
  servicesOf([
    call(1, "p.S$.a", "java.net.URI$", "create", [
      {
        index: 0,
        string:
          "https://hooks.slack.com/services/T0000/B0000/hT5ab9XAMPLEkEY2nB7mPqR"
      }
    ]),
    call(2, "p.S$.a", "java.util.Properties", "put", [
      { index: 0, string: "bootstrap.servers" },
      { index: 1, string: "SASL_SSL://alice:s3cr3t@broker:9093" }
    ]),
    call(
      3,
      "p.S$.a",
      "software.amazon.awssdk.services.s3.S3Client$",
      "builder",
      []
    )
  ]),
  [
    "S.scala:1 http-client java.net.uri https://hooks.slack.com/services/T0000/B0000/{}",
    "S.scala:2 messaging kafka broker:9093",
    "S.scala:3 cloud aws-sdk undefined"
  ]
);
// Every call site of a helper is a service of its own, and a configuration path names its URL.
assert.deepStrictEqual(
  servicesOf(
    [
      call(1, "p.S$.get", "java.net.URI$", "create", [
        { index: 0, param: "url", paramIndex: 0 }
      ]),
      call(5, "p.S$.a", "p.S$", "get", [
        { index: 0, string: "https://a.example.com" }
      ]),
      call(6, "p.S$.b", "p.S$", "get", [
        { index: 0, string: "https://b.example.com" }
      ]),
      call(
        7,
        "p.S$.c",
        "slick.jdbc.JdbcBackend$DatabaseFactoryDef",
        "forConfig",
        [{ index: 0, string: "db.default" }]
      )
    ],
    {
      values: [
        {
          key: "db.default.url",
          value: "jdbc:postgresql://db:5432/app",
          file: "conf/application.conf",
          line: 3
        },
        {
          key: "db.default.url",
          value: "env:DATABASE_URL",
          file: "conf/application.conf",
          line: 4
        }
      ]
    }
  ),
  [
    "S.scala:1 http-client java.net.uri https://a.example.com",
    "S.scala:1 http-client java.net.uri https://b.example.com",
    "S.scala:7 datastore slick jdbc:postgresql://db:5432/app"
  ]
);

// Endpoints of every route DSL the services fixture uses, read from the source tokens and
// confirmed by the compiler's symbols; the decoy string in Http4sRoutes is not a route.
const endpoints = recorded("services-jvm").endpoints;
const routeOf = (e) =>
  `${e.file.split("/").pop()}:${e.line} ${e.framework} ${e.method} ${e.path}`;
assert.deepStrictEqual(endpoints.map(routeOf), [
  "CaskRoutes.scala:4 cask GET /cask/hello/{name}",
  "CaskRoutes.scala:7 cask POST /cask/echo",
  "Http4sRoutes.scala:10 http4s GET /api/users/{id}",
  "Http4sRoutes.scala:11 http4s POST /api/users",
  "Http4sRoutes.scala:12 http4s DELETE /api/users/{}",
  "PekkoRoutes.scala:10 pekko-http GET /orders/{}",
  "PekkoRoutes.scala:11 pekko-http POST /orders",
  "PekkoRoutes.scala:13 pekko-http GET /health",
  "TapirEndpoints.scala:6 tapir GET /api/v1/items/{id}",
  "TapirEndpoints.scala:7 tapir POST /api/v1/items",
  "ZioRoutes.scala:7 zio-http GET /zio/health",
  "ZioRoutes.scala:8 zio-http GET /zio/users/{id}"
]);
assert.ok(
  endpoints.every((e) => !String(e.handler).includes("$anonfun")),
  "handlers are the members routes are declared in"
);
assert.deepStrictEqual(
  recorded("play-app").endpoints.map(routeOf),
  [
    "admin.routes:1 play GET /admin/stats",
    "routes:3 play GET /",
    "routes:5 play GET /accounts/{id}",
    "routes:7 play POST /accounts",
    "routes:9 play GET /files/{path}",
    "routes:11 play GET /admin/stats",
    "routes:12 play GET /assets/{file}"
  ],
  "a mounted router's route at its own line and at its mount, with the mount prefix"
);

// The same readers over Scala 2 facts from SemanticDB.
const { semanticdbModuleFacts } = await import("../lib/scalasem/semanticdb.js");
const legacyDir = join(projects, "semanticdb");
const legacy = deriveEvidence(
  deriveContext(
    semanticdbModuleFacts(legacyDir, {
      semanticdbDirs: [join(legacyDir, "meta")]
    }),
    {},
    { projectDir: legacyDir }
  )
);
assert.deepStrictEqual(legacy.endpoints.map(routeOf), [
  "Routes.scala:11 akka-http GET /legacy/users/{}",
  "Routes.scala:16 akka-http POST /legacy/hash"
]);
assert.ok(
  legacy.callStacks.some(
    (stack) =>
      stack.sink.name === "run" &&
      stack.frames.map((f) => f.line).join(",") === "9,13,15"
  ),
  "a Scala 2 call stack from the route through Store.find to slick"
);
assert.ok(
  legacy.callGraph.edges.length &&
    legacy.callGraph.edges.every((edge) => edge.confidence === "approximate"),
  "callers recovered from SemanticDB are approximate"
);

// Call stacks: the shortest route first, no dispatch through a library supertype, and no
// test as an entry.
const graphFacts = (extra = {}) =>
  fromFacts({
    "src/main/scala/p/App.scala": {
      definitions: [
        { kind: "object", owner: "p", name: "App", line: 1, endLine: 30 },
        { kind: "def", owner: "p.App$", name: "main", line: 2, endLine: 4 },
        { kind: "def", owner: "p.App$", name: "a", line: 5, endLine: 8 },
        { kind: "def", owner: "p.App$", name: "b", line: 9, endLine: 10 },
        { kind: "def", owner: "p.App$", name: "t", line: 11, endLine: 12 },
        {
          kind: "object",
          owner: "p",
          name: "Purge",
          line: 20,
          endLine: 22,
          parents: ["scala.Function1"]
        },
        { kind: "def", owner: "p.Purge$", name: "apply", line: 21, endLine: 22 }
      ],
      calls: [
        call(3, "p.App$.main", "p.App$", "a"),
        call(6, "p.App$.a", "p.App$", "t"),
        call(7, "p.App$.a", "p.App$", "b"),
        call(10, "p.App$.b", "p.App$", "t"),
        call(12, "p.App$.t", "okhttp3.OkHttpClient", "newCall"),
        call(4, "p.App$.main", "scala.Function1", "apply"),
        call(
          22,
          "p.Purge$.apply",
          "org.apache.commons.io.FileUtils$",
          "deleteDirectory"
        )
      ],
      ...extra
    }
  }).callStacks;
const stackLines = graphFacts().map((st) =>
  st.frames.map((f) => f.line).join(">")
);
assert.deepStrictEqual(
  stackLines[0],
  "2>3>6>12",
  "the shortest route comes first"
);
assert.ok(
  !graphFacts().some((st) => st.sink.name === "deleteDirectory"),
  "a library function type does not dispatch to a project object"
);

// Normalized paths.
const { normalizePath } = await import("../lib/scalasem/derive/endpoints.js");
assert.deepStrictEqual(
  ["/:userName.atom", "/item/$id<[0-9]+>", "/files/*rest", "users/${id}/"].map(
    normalizePath
  ),
  ["/{userName}.atom", "/item/{id}", "/files/{rest}", "/users/{id}"]
);

// The configuration reader: nested keys, comments, environment overrides, one line blocks.
const { hoconAssignments } = await import("../lib/scalasem/config.js");
assert.deepStrictEqual(
  hoconAssignments(
    [
      "db {",
      "  default {",
      '    url = "jdbc:postgresql://db:5432/app" # primary',
      "    url = ${?DATABASE_URL}",
      "  }",
      "}",
      'payments.url = "https://api.example.com/v1"   // gateway',
      'kafka { bootstrap.servers = "k1:9092,k2:9092", topic = orders }'
    ].join("\n")
  ).map((a) => `${a.key}=${a.value}`),
  [
    "db.default.url=jdbc:postgresql://db:5432/app",
    "db.default.url=${?DATABASE_URL}",
    "payments.url=https://api.example.com/v1",
    "kafka.bootstrap.servers=k1:9092,k2:9092",
    "kafka.topic=orders"
  ]
);

console.log(
  `scalasem-derive: ${crypto.length} crypto findings, ${services.length} services, ${endpoints.length} endpoints, ${CANONICAL_ALGORITHMS.length} canonical names`
);
