# scalasem: Scala semantics from the compiler

`scalasem` produces a semantics report for a Scala project: for every source file the build
compiled, the definitions, call sites and external references the compiler resolved, each with
the file, line and column it came from, plus the parsed Play route table and the endpoint
values of the configuration. Where the other tools of this package parse source text, scalasem
reads TASTy, the compiler's own output, so what it reports is what the compiler actually
resolved.

```shell
scalasem <directory> <out_file>
```

For example, from a project root:

```shell
scalasem "$(pwd)" slices.json
```

## Pipeline

```text
  project dir
      |
      |  discover the build: sbt, mill, maven, scala-cli, or none
      v
  module inventory: scala version, class directories, source roots,
      |             compiler jars, dependency classpath
      v
  compile when the build produced no output yet (skipped by --no-compile)
      |
      v
  read each TASTy header: the version triplet and the compiler that wrote the file
      |
      |  resolve that compiler's jars and scala3-tasty-inspector:
      |  from the build, then the Coursier and Maven caches
      v
  compile lib/scalasem/inspector/ScalasemInspector.scala once per compiler
      |  version into a cache directory
      v
  java -cp <compiler, inspector, helper> ScalasemInspector
      |  --classpath-file <module classpath> <tasty files>
      v
  JSON lines: call, def, ref, const and diag facts
      |
      |  normalise paths, drop project internal references, cap and sort
      v
  out_file (schema scalasem/2)
```

The debug printer behind `scalac -print-tasty` is never used: it crashes on TASTy newer than
the compiler that reads it and one crash ends the whole batch. The TASTy Inspector API reads
through the compiler's real unpickler instead, which is why the compiler that wrote the files
is resolved first: its version is recorded in every TASTy header.

Scala 2 builds produce class files only. They are reported through a diagnostic and no facts,
because the SemanticDB based reader for them ships in a later release.

## The build tools

- **sbt.** The project list comes from sbt itself. One further session per build asks every
  project for its compiler instance, class directory, source roots and dependency classpath,
  with the commands joined into a single argument, the only form sbt 2 parses correctly. A
  project that sbt cannot describe, for example one with an unresolvable dependency, is
  reported as `sbt-project-failed`. The class directories its last build left are read
  instead. sbt 2 runs in-process (`--server`), because its default thin client prints nothing
  when a server, an IDE's for example, is already running for the build. That server is left
  alone. On Windows, where `sbt.bat` has no such option, a server started by the inventory is
  shut down afterwards.
- **Mill.** The wrapper script is preferred over a mill on the PATH, `__.compile` is the
  compile target, and the module data comes from the files under `out/`, including cross
  build directories such as `out/cask/3.3.4` and the classes of upstream modules. The build
  script's own output under `out/mill-build` is skipped, and test modules are read only with
  `--include-tests`.
- **Maven.** The pom names the compiler version, `dependency:build-classpath` the classpath,
  and `compile` runs first when `target/classes` holds no TASTy yet. Without a build tool run,
  the classpath is the pom's direct dependencies found in the local Maven repository.
- **scala-cli.** Outputs under `.scala-build/` are read directly; when runs are allowed the
  classpath comes from `compile --server=false --print-class-path`, which leaves no Bloop
  server behind.
- **none.** No build tool runs at all. The class directories the last build left are walked,
  their TASTy headers give the compiler, and each module's classpath comes from the file the
  previous build exported next to it (sbt 1 `<module>/target/streams`, sbt 2
  `target/out/<platform>/scala-<v>/<module>/streams`, Mill `out/<module>/*.json`). When a cross
  build left several Scala 3 trees for one module, the newest is read and the choice is
  recorded as a `no-build-scala-version` diagnostic.

Only the class directories the build reports are read. A cross build keeps several
`target/scala-<v>` trees side by side, and a directory walk would mix them; the build says
which one is current. `SCALA_VERSION` is honoured the same way: when it names a Scala 2
release and the build defaults to Scala 3, the TASTy output is not read and a diagnostic is
recorded instead.

## Options

| Option            | Effect                                                           |
| ----------------- | ---------------------------------------------------------------- |
| `--no-build`      | Never start a build tool; read what the last build left on disk. |
| `--no-compile`    | Build tools may run for the inventory, but nothing is compiled.  |
| `--build=<tool>`  | Force one build tool instead of detecting it.                    |
| `--include-tests` | Include test sources in the report.                              |
| `--pretty`        | Indent the output.                                               |
| `--max-<cap>=N`   | Override a writer cap, for example `--max-calls-per-file=5000`.  |

The command line the pinned atom version runs, `scalasem <dir> <outFile>` with no flags,
keeps working and exits 0 on success.

## What the report contains

```json
{
  "_meta": {
    "schemaVersion": "scalasem/2",
    "build": { "tool": "sbt", "version": "1.10.11" },
    "compilers": [{ "version": "3.3.7", "source": "sbt" }],
    "counts": { "calls": 110, "files": 5, "references": 217 }
  },
  "config": {
    "routes": [
      {
        "method": "GET",
        "pattern": "/admin/stats",
        "controllerMethod": "controllers.admin.StatsController.stats",
        "file": "conf/admin.routes",
        "line": 1
      }
    ]
  },
  "modules": [
    {
      "id": "root",
      "platform": "jvm",
      "scalaVersion": "3.3.7",
      "classDirs": ["target/scala-3.3.7/classes"],
      "classpath": [
        { "group": "org.bouncycastle", "artifact": "bcprov-jdk18on", "version": "1.86" }
      ]
    }
  ],
  "src/main/scala/app/Main.scala": {
    "sourceFile": "src/main/scala/app/Main.scala",
    "tags": [],
    "usedTypes": ["org.bouncycastle.crypto.generators.Argon2BytesGenerator"],
    "literals": ["AES/GCM/NoPadding"],
    "module": "root",
    "platform": "jvm",
    "scope": "main",
    "definitions": [{ "id": "20:3:argon2", "kind": "def", "name": "argon2", "line": 20 }],
    "calls": [
      {
        "line": 22,
        "column": 21,
        "caller": "corpus.crypto.BouncyCastleOps$.argon2",
        "owner": "org.bouncycastle.crypto.generators.Argon2BytesGenerator",
        "name": "<init>"
      },
      {
        "line": 25,
        "column": 18,
        "caller": "corpus.crypto.BouncyCastleOps$.argon2",
        "owner": "javax.crypto.Cipher$",
        "name": "getInstance",
        "args": [{ "index": 0, "const": "AES/GCM/NoPadding", "sym": "corpus.crypto.JcaOps$.Gcm" }]
      }
    ],
    "references": [
      {
        "line": 22,
        "column": 18,
        "symbol": "org.bouncycastle.crypto.generators.Argon2BytesGenerator",
        "kind": "type"
      }
    ],
    "constants": [
      {
        "sym": "corpus.crypto.JcaOps$.CbcTransform",
        "value": "AES/CBC/PKCS5Padding",
        "tpe": "string",
        "line": 10
      }
    ]
  }
}
```

The first four keys of a file entry are the version 1 keys, kept so existing consumers keep
working. `usedTypes` is derived from the version 2 references, `literals` from the arguments
of calls and the constants. `endpoints`, `services`, `crypto`, `callStacks` and `callGraph`
are part of the schema and stay empty until the analysis passes that fill them are released.

- **Callers** name the method a call sits in as the source reads: closures, local vals and
  template statements resolve to the method or class around them. The bodies the compiler
  generates for case classes and enums are not reported.
- **References** cover types, terms and imports. Every imported member is a reference on its
  import line; a wildcard import references the package or object it opens.
- **Literals.** String arguments, constants and annotation arguments are quoted only when they
  are identifiers, algorithm spellings, object identifiers, route paths or URLs, and URLs lose
  their userinfo, query and fragment (a JDBC URL keeps its driver, host and database). Values
  that look like key material, such as JWTs, long hex or base64 runs and high entropy tokens,
  are never quoted. A string argument that is not quoted keeps its `index` and is marked
  `"redacted": "string"`; a constant keeps its symbol and is marked `"redacted": true`. The
  Names table of the old format carried every string constant of the program, secrets
  included.
- **Diagnostics** in `_meta` count unresolved symbols, files the walker could not finish and
  TASTy files the compiler could not load, per module.

The full shape is described by `lib/scalasem/scalasem-v2.schema.json`, and every report the
tests build is validated against it. Keys and set-like arrays are sorted, so two runs over the
same tree produce the same bytes; call arguments, call stack frames and classpaths keep their
order.

### Play routes

Files under `conf/` ending in `.routes` are parsed into `config.routes`. A `-> /mount
router.Routes` line is resolved to the mounted file and its paths carry the mount prefix,
each entry with the file and line it was declared at. Webjars and comments are dropped.

### Configuration values

`config.values` holds HOCON keys whose value names an endpoint, with credentials, queries and
fragments removed: URLs keep scheme, host and path, a JDBC URL keeps its host and database.
Keys that do not look like endpoints are not collected, and values that are not URLs are
dropped.

## Caching

The compiled helper is cached under `$XDG_CACHE_HOME/scalasem` (or `~/.cache/scalasem`, or the
system temporary directory when neither is writable), keyed by the compiler version and the
content of the helper source, so a project is analysed without recompiling it again.
`SCALASEM_CACHE_DIR` moves the cache. When the compiler or the tasty inspector of a release is
missing from the local caches and installs are allowed, a throwaway sbt project fetches them,
with its own global base so the user's global sbt plugins stay out of it.

## Environment variables

| Variable                                       | Default             | Purpose                                                                                                                                                          |
| ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALA_VERSION`                                | unset               | Analyse this Scala version instead of the build default.                                                                                                         |
| `SBT_CMD`                                      | `sbt`               | sbt executable.                                                                                                                                                  |
| `MILL_CMD`                                     | `mill`              | mill executable when the project has no wrapper.                                                                                                                 |
| `MVN_CMD`                                      | `mvn`               | maven executable.                                                                                                                                                |
| `SBT_COMPILE_COMMAND`                          | `compile`           | Compile command when the build tool is sbt.                                                                                                                      |
| `MILL_COMPILE_COMMAND`                         | `__.compile`        | Compile command when the build tool is mill.                                                                                                                     |
| `SCALASEM_NO_BUILD`                            | unset               | Same as `--no-build`.                                                                                                                                            |
| `SCALASEM_NO_COMPILE`                          | unset               | Same as `--no-compile`.                                                                                                                                          |
| `SCALASEM_NO_INSTALL`                          | unset               | Never download a missing compiler or tasty inspector jar.                                                                                                        |
| `SCALASEM_INCLUDE_TESTS`                       | unset               | Same as `--include-tests`.                                                                                                                                       |
| `SCALASEM_CACHE_DIR`                           | `~/.cache/scalasem` | Where the compiled helper is cached.                                                                                                                             |
| `SCALASEM_MAX_*`                               | see below           | Writer caps: `SCALASEM_MAX_CALLS_PER_FILE`, `SCALASEM_MAX_REFERENCES_PER_FILE` and `SCALASEM_MAX_DEFINITIONS_PER_FILE` (2000 each), `SCALASEM_MAX_LITERALS_PER_FILE` (100), `SCALASEM_MAX_FILES` (5000). |
| `JAVA_HOME`                                    | unset               | The JVM the helper runs with.                                                                                                                                    |
| `ATOM_CWD`                                     | `process.cwd()`     | Working directory for the build tool invocations.                                                                                                                |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT`              | unset (no timeout)  | Milliseconds before a subprocess is killed.                                                                                                                      |

`SCALAC_CMD` from the old printer based releases is no longer read.

## Testing

`npm run test:scala` covers the engine without a JVM, using recorded inspector output for
several compiler releases and recorded sbt 1 and sbt 2 inventory sessions, and runs the helper
end to end when a JDK is present. The JVM part compiles the helper with every release the local
caches hold; with `CI` or `SCALASEM_TEST_FETCH` set it fetches the first release when the
caches are empty. After a change to the helper, `npm run test:scala:record` re-records the
inspector output the engine tests read.
