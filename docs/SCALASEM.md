# scalasem: Scala semantics from the compiler

`scalasem` produces a semantics report for a Scala project. For every source file the build
compiled it lists the definitions, call sites and external references the compiler resolved,
each with the file, line and column it came from. On top of those facts it derives the
evidence a bill of materials needs: crypto use, HTTP endpoints, outbound services, entry
points and the call stacks that reach library code. Where the other tools of this package
parse source text, scalasem reads what the compiler wrote: TASTy for Scala 3 and SemanticDB
for Scala 2.

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
      |             compiler jars, dependency classpath, SemanticDB directories
      v
  compile when the build produced no output yet (skipped by --no-compile)
      |
      +-- Scala 3 ---------------------------------+-- Scala 2 ------------------------+
      |                                            |                                   |
      v                                            v                                   |
  read each TASTy header: the compiler          produce SemanticDB in a target of      |
  that wrote the file                           its own, or read what the build left   |
      |                                            |                                   |
      v                                            v                                   |
  resolve that compiler and its tasty           decode the documents, lex the sources  |
  inspector, compile the helper once            and recover callers and arguments      |
  per release into the cache                       |                                   |
      |                                            |                                   |
      v                                            |                                   |
  java ScalasemInspector <tasty files>             |                                   |
      |                                            |                                   |
      +--------------------+-----------------------+-----------------------------------+
                           |
                           v
  per file facts: definitions, calls, references, constants
                           |
                           |  merge cross built sources, derive the evidence,
                           |  redact, cap and sort
                           v
  out_file (schema scalasem/2)
```

The debug printer behind `scalac -print-tasty` is never used: it crashes on TASTy newer than
the compiler that reads it, and one crash ends the whole batch. The TASTy Inspector API reads
through the compiler's real unpickler instead. That is why the compiler that wrote the files is
resolved first; its version is recorded in every TASTy header.

## SemanticDB

Scala 2 writes class files only, so its facts come from SemanticDB. When the build may compile,
scalasem asks it for SemanticDB without touching a build file and without disturbing the
project's own output:

- **sbt** gets `semanticdbEnabled`, a `semanticdbVersion` pinned to the plugin release for the
  module's exact Scala version, and the synthetics flag on its command line, scoped to the
  Scala 2 projects. Each of them compiles into a target directory of its own under the
  scalasem cache, so the project's build output and its incremental compiler state stay as
  they are and the next run is incremental.
- **Mill** runs its own `semanticDbData` task for each Scala 2 module.
- **Maven** compiles the module once more with the plugin jar, the synthetics flag and a
  target root in the scalasem cache, all given through the scala-maven-plugin's
  `addScalacArgs`. The class files it writes are the ones the normal build writes.

The plugin release comes from the local caches or, when installs are allowed, from Maven
Central. A module whose Scala version has no plugin release in reach reports
`semanticdb-unavailable`, and one that compiled without SemanticDB reports
`semanticdb-missing`. Without a build tool run, the SemanticDB a previous build left is read
from the places the build tools write it: sbt's `meta` and `test-meta` directories, Mill's
`semanticDbData.dest` and `META-INF/semanticdb` next to the classes.

SemanticDB also covers Scala 3 sources whose TASTy cannot be read, for example when no
compiler of that release can be resolved, as long as the build left SemanticDB for them.
`--semanticdb always` or `SCALASEM_COMPILER=none` reads SemanticDB for every module instead of
TASTy, and `--semanticdb never` turns the reader off.

SemanticDB records symbols and positions but no trees. The source lexer recovers the extent of
each definition and the arguments of each call, so the callers of SemanticDB facts follow the
source layout rather than the compiler's trees, and every call graph edge they produce carries
`confidence: approximate`.

## The build tools

- **sbt.** The project list comes from sbt itself. One further session per build asks every
  project for its compiler instance, class directory, source roots and dependency classpath,
  with the commands joined into a single argument, the only form sbt 2 parses correctly. A
  project that sbt cannot describe, for example one with an unresolvable dependency, is
  reported as `sbt-project-failed`, and the class directories its last build left are read
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
- **scala-cli.** Outputs under `.scala-build/` are read directly, from one build: scala-cli
  keeps a directory per project hash, and an older hash leaves the classes of the same
  sources behind. When runs are allowed, the classpath comes from
  `compile --server=false --print-class-path`, which leaves no Bloop server behind and names
  the current build. Without a run, the build whose Bloop project file lists a classpath is
  read with that classpath.
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

| Option                | Effect                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--no-build`          | Never start a build tool; read what the last build left on disk.                                                                    |
| `--no-compile`        | Build tools may run for the inventory, but nothing is compiled.                                                                     |
| `--build <tool>`      | Force one build tool instead of detecting it: `sbt`, `mill`, `maven`, `scala-cli` or `none`.                                        |
| `--semanticdb <mode>` | `auto` reads SemanticDB for Scala 2 modules and produces it when missing; `always` reads it for every module; `never` turns it off. |
| `--include-tests`     | Include test sources in the report.                                                                                                 |
| `--pretty`            | Indent the output.                                                                                                                  |
| `--max-<cap>=N`       | Override a writer cap, for example `--max-calls-per-file=5000`.                                                                     |

`--build` and `--semanticdb` take their value either as the next word or after `=`. The
command line the pinned atom version runs, `scalasem <dir> <outFile>` with no flags, keeps
working and exits 0 on success.

## What the report contains

```json
{
  "_meta": {
    "schemaVersion": "scalasem/2",
    "generatedFrom": ["tasty"],
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
        {
          "group": "org.bouncycastle",
          "artifact": "bcprov-jdk18on",
          "version": "1.86"
        }
      ]
    }
  ],
  "crypto": [
    {
      "algorithm": "AES",
      "mode": "GCM",
      "padding": "NoPadding",
      "primitive": "ae",
      "kind": "algorithm",
      "api": "JCA",
      "provider": "jdk",
      "resolution": "constant",
      "file": "src/main/scala/app/Main.scala",
      "line": 25
    }
  ],
  "endpoints": [],
  "services": [],
  "entryPoints": [],
  "callGraph": { "edges": [] },
  "callStacks": [],
  "src/main/scala/app/Main.scala": {
    "sourceFile": "src/main/scala/app/Main.scala",
    "tags": ["crypto"],
    "usedTypes": ["org.bouncycastle.crypto.generators.Argon2BytesGenerator"],
    "literals": ["AES/GCM/NoPadding"],
    "module": "root",
    "platform": "jvm",
    "factsSource": "tasty",
    "scope": "main",
    "definitions": [
      { "id": "20:3:argon2", "kind": "def", "name": "argon2", "line": 20 }
    ],
    "calls": [
      {
        "line": 25,
        "column": 18,
        "caller": "corpus.crypto.BouncyCastleOps$.argon2",
        "owner": "javax.crypto.Cipher$",
        "name": "getInstance",
        "args": [
          {
            "index": 0,
            "const": "AES/GCM/NoPadding",
            "sym": "corpus.crypto.JcaOps$.Gcm"
          }
        ]
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
        "sym": "corpus.crypto.JcaOps$.Gcm",
        "value": "AES/GCM/NoPadding",
        "tpe": "string",
        "line": 6
      }
    ]
  }
}
```

The full shape is described by `lib/scalasem/scalasem-v2.schema.json`, and every report the
tests build is validated against it. Keys and set-like arrays are sorted, so two runs over the
same tree produce the same bytes; call arguments, call stack frames and classpaths keep their
order.

### File entries

The first four keys of a file entry are the version 1 keys, kept so existing consumers keep
working. `usedTypes` is derived from the version 2 references, `literals` from the arguments
of calls and the constants, and `tags` also carries the crypto, framework route, database,
messaging, cloud and HTTP client tags of the derived evidence. A file compiled into several
modules of a cross build lists the platforms it targets in `platforms`; otherwise `platform`
names the one. `factsSource` says which reader produced the facts of the file, `tasty` or
`semanticdb`.

**Callers** name the method a call sits in as the source reads: closures, local vals and
template statements resolve to the method or class around them. The bodies the compiler
generates for case classes and enums are not reported. **References** cover types, terms and
imports. Every imported member is a reference on its import line, and a wildcard import
references the package or object it opens.

**Arguments** are numbered across all parameter lists, so `f(a)(b)` passes `b` at index 1. An
argument is a literal (`string`, `int`, `long`, `boolean`), a constant (`const` with its `sym`,
and `defLine` for a local value), a parameter of the enclosing method (`param` and
`paramIndex`), another value (`ident` and `sym`), the pieces of a string interpolation
(`parts`, with an object for each hole), or a call with literal arguments (`call` and `args`).

**Literals** are quoted only when they are identifiers, algorithm spellings, object
identifiers, route paths or URLs. URLs lose their userinfo, query and fragment, and path
segments that look like tokens become `{}`; a JDBC URL keeps its driver, host and database.
Values that look like key material, such as JWTs, long hex or base64 runs and high entropy
tokens, are never quoted, and neither is any string passed to a call or held by a constant
whose name says it carries a credential. A string argument that is not quoted keeps its
`index` and is marked `"redacted": "string"` or `"redacted": "const"`; a constant keeps its
symbol and is marked `"redacted": true`.

### Evidence

- **crypto** names the algorithm, protocol, key store, random generator or native binding, in
  one canonical spelling per algorithm (`SHA-256` for `sha256` and `SHA256`), with the
  primitive, mode, padding, key size, curve, GCM tag length (`bits`), API, provider and the
  weak flag where they apply. Scala Native bindings and calls also carry the function `name`.
  An algorithm passed in as a parameter is followed to the call sites and local values that
  supply it, across at most four boundaries, inside project code. The finding then sits
  where the literal appears, and `via` lists the steps from the API call to it. An API call
  whose argument stays unknown is kept with `resolution: "unresolved"` and no algorithm.
- **endpoints** are read from the route structure in the source, and a token counts only when
  the compiler resolved it to the framework: Play route files, with mounted routers reported
  at their mount point including routers written in Scala, Play SIRD, Akka and Pekko
  directives, http4s patterns with router prefixes, tapir endpoints, ZIO HTTP routes, cask
  annotations and Scalatra actions. Path captures are written `{name}`, or `{}` when the
  capture has no name.
- **services** are outbound HTTP and websocket clients, data stores, messaging topics and
  cloud clients, with the URL, host or topic sanitized as above. Values resolve through
  literals, constants, call sites, interpolation pieces and configuration keys, and
  `resolution` says which.
- **entryPoints** are main methods, application objects, route handlers and the actions the
  route table names.
- **callGraph** holds the edges between project methods. A call dispatches through the
  project's own parent types only, never through a library supertype such as a function
  type, and such dispatched edges carry `confidence: approximate`.
- **callStacks** walk the call graph from entry points to library calls, shortest route
  first, at most three stacks per library owner and twelve frames deep. Tests are never an
  entry.
- **jsModules** and **nativeBindings** list the JavaScript modules the Scala.js facades import
  and the native libraries the Scala Native extern objects bind to.

### Play routes and configuration

Files under `conf/` ending in `.routes` are parsed into `config.routes`. A `-> /mount
router.Routes` line is resolved to the mounted file and its paths carry the mount prefix,
each entry with the file and line it was declared at. Webjars and comments are dropped.

`config.values` holds the configuration keys whose value names an endpoint, a URL or a host
with its port, with credentials, queries and fragments removed. The `.conf` and `.properties`
files of every `conf/` directory and of every module's main resources are read, nested HOCON
blocks included. A key set to a `${?NAME}` override records `env:NAME`, and when the same key
also has a literal value, the evidence uses the literal. Keys that do not look like endpoints
are not collected, and other values are dropped.

### Diagnostics

`_meta.diagnostics` lists what limited the report, per module, with the `tool` that failed
where one did:

| Code                                                                           | Meaning                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `sbt-inventory-failed`, `sbt-projects-failed`, `sbt-project-failed`            | sbt could not list the projects, or could not describe one of them.                            |
| `build-compile-failed`, `scala-cli-compile-failed`, `maven-classpath-failed`   | The build tool failed to compile or to print the classpath.                                    |
| `semanticdb-unavailable`, `semanticdb-missing`, `semanticdb-compile-failed`    | No plugin release for the Scala version, or a compile that wrote no SemanticDB.                |
| `scala2-unsupported`                                                           | A Scala 2 module with no SemanticDB to read.                                                   |
| `compiler-unavailable`, `tasty-inspector-unavailable`, `helper-compile-failed` | The TASTy of a compiler release could not be read.                                             |
| `unreadable-tasty`                                                             | TASTy files the compiler could not load.                                                       |
| `scala-version-mismatch`, `no-build-scala-version`                             | `SCALA_VERSION` names a release the build output does not hold, or a cross build left several. |
| `unresolved-symbols`, `walker-failed`                                          | Counts of symbols the helper could not resolve and files its walker could not finish.          |

## Caching

Everything scalasem keeps lives under `$XDG_CACHE_HOME/scalasem` (or `~/.cache/scalasem`, or
the system temporary directory when neither is writable), and `SCALASEM_CACHE_DIR` moves it.
The compiled helper is keyed by the compiler version and the content of the helper source, so
a project is analysed without compiling the helper again. The SemanticDB targets are kept per
project, module and Scala version, so the next run compiles incrementally and a cross build's
versions never mix. When the compiler or the tasty
inspector of a release is missing from the local caches and installs are allowed, a throwaway
sbt project fetches them, with its own global base so the user's global sbt plugins stay out
of it.

## Environment variables

| Variable                          | Default             | Purpose                                                                                                                                                                                                  |
| --------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALA_VERSION`                   | unset               | Analyse this Scala version instead of the build default.                                                                                                                                                 |
| `SBT_CMD`                         | `sbt`               | sbt executable.                                                                                                                                                                                          |
| `MILL_CMD`                        | `mill`              | mill executable when the project has no wrapper.                                                                                                                                                         |
| `MVN_CMD`                         | `mvn`               | maven executable.                                                                                                                                                                                        |
| `SBT_COMPILE_COMMAND`             | `compile`           | Compile command when the build tool is sbt.                                                                                                                                                              |
| `MILL_COMPILE_COMMAND`            | `__.compile`        | Compile command when the build tool is mill.                                                                                                                                                             |
| `SCALASEM_NO_BUILD`               | unset               | Same as `--no-build`.                                                                                                                                                                                    |
| `SCALASEM_NO_COMPILE`             | unset               | Same as `--no-compile`.                                                                                                                                                                                  |
| `SCALASEM_NO_INSTALL`             | unset               | Never download a missing compiler, tasty inspector or SemanticDB plugin.                                                                                                                                 |
| `SCALASEM_INCLUDE_TESTS`          | unset               | Same as `--include-tests`.                                                                                                                                                                               |
| `SCALASEM_SEMANTICDB`             | `auto`              | Same as `--semanticdb`.                                                                                                                                                                                  |
| `SCALASEM_COMPILER`               | unset               | `none` reads SemanticDB for every module instead of TASTy, and produces it when the build may compile.                                                                                                   |
| `SCALASEM_CACHE_DIR`              | `~/.cache/scalasem` | Where the compiled helper and the SemanticDB targets are kept.                                                                                                                                           |
| `SCALASEM_TIMEOUT`                | unset               | Milliseconds the whole run may take, the builds it starts included. When the time is up, scalasem stops those builds and then itself.                                                                    |
| `SCALASEM_MAX_*`                  | see the purpose     | Writer caps: `SCALASEM_MAX_CALLS_PER_FILE`, `SCALASEM_MAX_REFERENCES_PER_FILE` and `SCALASEM_MAX_DEFINITIONS_PER_FILE` (2000 each), `SCALASEM_MAX_LITERALS_PER_FILE` (100), `SCALASEM_MAX_FILES` (5000). |
| `JAVA_HOME`                       | unset               | The JVM the helper runs with.                                                                                                                                                                            |
| `ATOM_CWD`                        | `process.cwd()`     | Working directory for the build tool invocations.                                                                                                                                                        |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout)  | Milliseconds before a subprocess is killed.                                                                                                                                                              |

`SCALAC_CMD` from the old printer based releases is no longer read.

## Testing

`npm run test:scala` covers the engine without a JVM. It uses recorded inspector output for
several compiler releases, recorded sbt 1 and sbt 2 inventory sessions, recorded SemanticDB
documents of a Scala 2 module, and the recorded facts of compiled fixture projects for the
evidence rules. It also runs the helper end to end when a JDK is present. The JVM part
compiles the helper with every release the local caches hold; with `CI` or
`SCALASEM_TEST_FETCH` set, it fetches the first release when the caches are empty. After a
change to the helper, `npm run test:scala:record` re-records the inspector output the engine
tests read, and `node test-fixtures/record-scalasem-evidence.js <dir> <name>` re-records the
facts of a compiled fixture project.
