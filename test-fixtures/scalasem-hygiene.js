// Every value the report emits is walked: a URL may carry no query, fragment or
// userinfo, a data store address no credentials, and no string may name a machine
// path. The walks cover the recorded report of a real project and the reports the
// writer builds over the recorded facts of the evidence projects, the services one
// included, whose fixture carries a URL with credentials and a JDBC address with a
// password to prove they are dropped.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { buildFileEntry } from "../lib/scalasem/facts.js";
import { buildReport, reportCaps } from "../lib/scalasem/schema.js";
import { deriveContext, deriveEvidence } from "../lib/scalasem/derive/index.js";

const projects = join(process.cwd(), "test-fixtures", "projects", "scala");

// The shapes a report string may take. Values are checked line by line, since
// multi valued properties join their entries with newlines.
function violations(line) {
  const found = [];
  // URLs: credentials ride in the authority, a signature in a query or fragment.
  const url = /^([a-z][a-z0-9+.-]*):\/{2}([^/?#\s]*)(.*)$/i.exec(line);
  if (url) {
    if (line.includes("?")) {
      found.push("URL query");
    }
    if (line.includes("#")) {
      found.push("URL fragment");
    }
    if (url[2].includes("@")) {
      found.push("URL userinfo");
    }
  }
  if (/user=|password=/i.test(line)) {
    found.push("credential parameter");
  }
  // Some drivers take the user and password before the host of the address:
  // jdbc:oracle:thin:admin/hunter2@db.internal:1521:orcl.
  if (/^jdbc:[^/]*\//i.test(line) && line.includes("@")) {
    found.push("URL userinfo");
  }
  // Machine paths: the report names the project it was made from and nothing
  // else on this computer.
  if (
    /^\/(Users|home|tmp|var|private|root|coursier)\//.test(line) ||
    /^[A-Za-z]:[\\/]/.test(line) ||
    /%LOCALAPPDATA%/i.test(line) ||
    line.startsWith("~/") ||
    /(^|\/)\.cache\//.test(line) ||
    line.includes("Library/Caches")
  ) {
    found.push("machine path");
  }
  if (/(^|\/)\.\.($|\/)/.test(line)) {
    found.push("path outside the project");
  }
  if (found.length) {
    return found;
  }
  // A value the consumer reads must be one of: prose, an identifier or a
  // spelling of an algorithm, object identifier, version or hash, a route
  // path, file path, host, topic, or a sanitized URL, the id or signature of
  // a definition, or a symbolic operator name. Anything else means a value
  // reached the report unshaped.
  const shaped =
    /\s/.test(line) ||
    /^[A-Za-z0-9_$+.<>-]+([.:][=!+/*%<>&|~^:-]+)*$/.test(line) ||
    /^[A-Za-z0-9_./:${}<>#*-]+$/.test(line) ||
    /^[A-Za-z0-9_$()[\],.<> *-]*$/.test(line) ||
    /^[=!+/*%<>&|~^:-]+$/.test(line) ||
    // A Scala name that ends in an operator after an underscore, the setter
    // of a var (`count_=`) or a prefix operator (`unary_!`), alone or in the
    // line:column:name id of a definition.
    /^([0-9]+:[0-9]+:)?[A-Za-z0-9_$]*_[=!+/*%<>&|~^:-]+$/.test(line);
  if (!shaped) {
    found.push("string outside the allowed shapes");
  }
  return found;
}

function walk(value, path, out) {
  if (typeof value === "string") {
    for (const line of value.split("\n")) {
      if (!line) {
        continue;
      }
      for (const why of violations(line)) {
        out.push(`${path}: ${why}: ${JSON.stringify(line)}`);
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // The build inventory points at the jars of the dependency classpath,
      // which live in the caches of this machine; the evidence never does.
      if (/^\$\.modules\[\d+\]$/.test(path) && key === "classpath") {
        continue;
      }
      // The project path is the root atom and atom-tools resolve the relative
      // source paths against, and the one absolute path a report names.
      if (path === "$._meta" && key === "projectPath") {
        continue;
      }
      walk(item, `${path}.${key}`, out);
    }
  }
}

function assertClean(report, label) {
  const out = [];
  walk(report, "$", out);
  assert.deepStrictEqual(
    out,
    [],
    `${label} carries unshaped or machine specific values:\n${out.join("\n")}`
  );
}

// The walker must catch what it is here for, so the bad shapes are tried as well.
assert.deepStrictEqual(violations("https://user:token@host/x").sort(), [
  "URL userinfo"
]);
assert.deepStrictEqual(violations("https://host/x?sig=9f8e7d6c#keys").sort(), [
  "URL fragment",
  "URL query"
]);
assert.deepStrictEqual(
  violations("jdbc:mysql://db.internal:3306/db?user=admin&password=secret"),
  ["credential parameter"]
);
assert.deepStrictEqual(
  violations("jdbc:oracle:thin:admin/hunter2@db.internal:1521:orcl"),
  ["URL userinfo"]
);
assert.deepStrictEqual(violations("/Users/prabhu/.cache/coursier/x.jar"), [
  "machine path"
]);
assert.deepStrictEqual(violations("C:\\Users\\x\\AppData\\Local\\Coursier"), [
  "machine path"
]);
assert.deepStrictEqual(violations("%LOCALAPPDATA%\\Coursier"), [
  "machine path"
]);
assert.deepStrictEqual(violations("../outside/file.scala"), [
  "path outside the project"
]);
assert.deepStrictEqual(violations("token|value"), [
  "string outside the allowed shapes"
]);
// And the shapes the report may emit must all pass.
for (const value of [
  "https://host/x",
  "jdbc:postgresql://db.internal:5432/reports",
  "kafka.internal:9092",
  "kafka:order-events",
  "/accounts/{id}",
  "src/main/scala/app/Main.scala#8:main:corpus.flow.Main$.main",
  "AES/GCM/NoPadding",
  "secg/secp256r1",
  "1.2.840.113549.1.1.11",
  "()java.lang.Object",
  "(scala.Int,scala.Int)scala.Int",
  "scala.Int.==",
  ":+",
  "cdx:scalasem:usageScopes",
  "3.3.7",
  "count_=",
  "67:3:count_=",
  "unary_!"
]) {
  assert.deepStrictEqual(
    violations(value),
    [],
    `"${value}" is a shape the report may emit`
  );
}

// A report of a real project, recorded with its paths neutralised.
assertClean(
  JSON.parse(readFileSync(join(projects, "reports", "showcase.json"), "utf-8")),
  "the recorded showcase report"
);

// The reports the writer builds over the recorded facts of the evidence projects.
for (const name of [
  "callstack-app",
  "crypto-jvm",
  "mill-cask",
  "play-app",
  "scalajs-app",
  "scala-native-app",
  "services-jvm"
]) {
  const recording = JSON.parse(
    readFileSync(join(projects, "evidence", `${name}.facts.json`), "utf-8")
  );
  const context = deriveContext(
    new Map(Object.entries(recording.files)),
    recording.config,
    { projectDir: `/src/${name}` }
  );
  const evidence = deriveEvidence(context);
  const moduleOf = new Map(
    [...context.files.keys()].map((file) => [
      file,
      { id: name, platform: "jvm" }
    ])
  );
  const fileEntries = {};
  for (const [file, facts] of context.files) {
    fileEntries[file] = buildFileEntry(facts, moduleOf.get(file), file, {
      caps: reportCaps()
    });
  }
  const report = buildReport({
    projectDir: `/src/${name}`,
    tool: "sbt",
    modules: [
      {
        id: name,
        platform: "jvm",
        classDirs: ["target/scala-3.3.7/classes"],
        sourceRoots: ["src/main/scala"],
        classpath: []
      }
    ],
    fileEntries,
    config: recording.config,
    diagnostics: [],
    toolchains: [],
    evidence
  });
  assertClean(report, `the built ${name} report`);
}

// A fresh run over a copy of a checked in project, with nothing rewritten: the
// recording above has its paths neutralised, so only a real report shows what a
// run emits on this machine.
const work = mkdtempSync(join(tmpdir(), "scalasem-hygiene-"));
try {
  const project = join(work, "showcase");
  cpSync(join(projects, "showcase"), project, { recursive: true });
  const out = join(work, "report.json");
  const run = spawnSync(
    process.execPath,
    [join(process.cwd(), "scalasem.js"), project, out, "--no-build"],
    { encoding: "utf-8" }
  );
  if (run.status === 0 && existsSync(out)) {
    const report = JSON.parse(readFileSync(out, "utf-8"));
    assert.ok(
      Object.keys(report).some((key) => key.endsWith(".scala")),
      "the fresh report has file entries to walk"
    );
    assertClean(report, "a fresh report of the showcase project");
  } else {
    // Without a JDK or a cached compiler there is no analysis to walk, as in
    // the command line test.
    console.log(
      `scalasem-hygiene: fresh report skipped, analysis unavailable (${(run.stderr || "").split("\n")[0]})`
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  "scalasem-hygiene: every value of the recorded, the built and a fresh report is shaped and machine free"
);
