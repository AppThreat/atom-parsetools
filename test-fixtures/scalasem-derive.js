// The evidence derivation over recorded facts: the merged facts of compiled projects under
// test-fixtures/projects/scala/evidence (re-recorded with record-scalasem-evidence.js), the
// showcase inspector recordings, and facts written out by hand for the shapes no fixture
// project has. No compiler runs.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { CANONICAL_ALGORITHMS } from "../lib/scalasem/derive/algorithms.js";
import {
  deriveContext,
  deriveEvidence
} from "../lib/scalasem/derive/index.js";
import { parseFacts } from "../lib/scalasem/inspect.js";

const projects = join(process.cwd(), "test-fixtures", "projects", "scala");

function recorded(name) {
  const recording = JSON.parse(
    readFileSync(join(projects, "evidence", `${name}.facts.json`), "utf-8")
  );
  return deriveEvidence(
    deriveContext(new Map(Object.entries(recording.files)), recording.config)
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
  crypto.every((f) => !f.algorithm || CANONICAL_ALGORITHMS.includes(f.algorithm)),
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
  call(line, caller, "java.security.MessageDigest$", "getInstance", args, extra);

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
      call(7, "p.A$.useTwo", "p.A$", "mac", [
        { index: 0, string: "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY" },
        { index: 1, string: "data" }
      ], { signature: "(java.lang.String,java.lang.String)java.lang.Object" })
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
        { index: 0, string: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl" }
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
      call(4, "p.E$.keys", "java.security.KeyPairGenerator", "initialize", [
        { index: 0, int: 4096 }
      ], { recv: { ident: "rsa", sym: "p.E$._$rsa" } }),
      call(5, "p.E$.keys", "java.security.KeyPairGenerator", "initialize", [
        { index: 0, int: 1024 }
      ], { recv: { ident: "dsa", sym: "p.E$._$dsa" } })
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
      { line: 1, column: 1, symbol: "pdi.jwt.JwtAlgorithm$.HS256", refKind: "import" },
      { line: 5, column: 30, symbol: "pdi.jwt.JwtAlgorithm$.RS512", refKind: "term" },
      { line: 5, column: 40, symbol: "pdi.jwt.JwtAlgorithm$.allHmac", refKind: "term" }
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

console.log(
  `scalasem-derive: ${crypto.length} crypto findings, ${CANONICAL_ALGORITHMS.length} canonical names`
);
