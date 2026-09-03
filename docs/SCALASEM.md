# scalasem: Scala

`scalasem` produces a semantics slice for a Scala project: one JSON entry per source file holding the literals, referenced types, and framework tags that atom's Scala frontend needs, plus the parsed route table when the project is a Play application. Where the other tools parse source text, scalasem reads the compiler's own output format, TASTy, so what it reports is what the compiler actually resolved.

```shell
scalasem <directory> <slices_file>
```

For example, from a project root:

```shell
scalasem "$(pwd)" slices.json
```

## Pipeline

```text
  project dir
      |
      |  .tasty files present?
      |         no: run `sbt compile` (or `mill`), version from build.sbt
      |             or SCALA_VERSION, command from SBT_COMPILE_COMMAND
      |             / MILL_COMPILE_COMMAND
      v
  *.tasty files
      |
      |  scalac -print-tasty -color:never   (SCALAC_CMD overrides scalac)
      v
  printed TASTy text
      |
      |  Names section  -> literals (strings, symbols)
      |  Trees section  -> Signature(...) -> usedTypes, framework tags
      v
  slices.json
```

Compilation is skipped when `.tasty` files already exist, for example after a normal build. Cross-builds are handled by picking the Scala 3 version from `build.sbt` (`val` lines and `crossScalaVersions`) or from the `SCALA_VERSION` environment variable, and prefixing the compile command with `++<version>`. A `build.mill` at the root switches the build tool from sbt to mill.

## What a slice contains

The output is a JSON object keyed by source file, with a special `config` entry:

```json
{
  "config": {
    "routes": [
      { "method": "GET", "pattern": "/", "controllerMethod": "Home.index" }
    ]
  },
  "app/controllers/HomeController.scala": {
    "sourceFile": "app/controllers/HomeController.scala",
    "tags": ["framework", "framework-input"],
    "usedTypes": [
      "play.api.mvc.MessagesAbstractController",
      "play.api.mvc.Request"
    ],
    "literals": ["/", "index"]
  }
}
```

`usedTypes` comes from the signatures the TASTy printer records: argument and return types minus `scala.`, `java.`, and `javax.inject.` noise. `literals` comes from the Names section, which is why string constants that survive into the compiled program appear here.

The `tags` array is where Play framework knowledge lives, derived from the types used: `framework` for general `play.api.` usage, `framework-input` for controller inputs (`play.api.data.Form`, `play.api.mvc.Request`, `play.twirl.api`), `framework-output` for results (`Html`, `Result`, `Action`), `framework-route` for routing types, and `database` for `slick` and `play.db` types. Files under `target/` get the `generated` tag so consumers can deprioritize them.

## Play routes

Files named `routes` are parsed into the `config` entry. Each HTTP verb line becomes `{method, pattern, controllerMethod}`. Static asset routes (`/webjars`) and comments are dropped, and a `->` splat route, which forwards every verb, is expanded into GET, PATCH, POST, DELETE, and PUT entries so downstream reachability has concrete methods to match against.

## Environment variables

| Variable                                       | Default            | Purpose                                                                                       |
| ---------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `SCALA_VERSION`                                | unset              | Scala version to compile with under sbt (`++<version>`); otherwise detected from `build.sbt`. |
| `SBT_COMPILE_COMMAND` / `MILL_COMPILE_COMMAND` | `compile`          | Compile command for the detected build tool.                                                  |
| `SCALAC_CMD`                                   | `scalac`           | Compiler command used for `-print-tasty`.                                                     |
| `ATOM_MAX_BUFFER`                              | `104857600`        | Max stdout size in bytes for a single `scalac` invocation; large class files need room.       |
| `ATOM_CWD`                                     | `process.cwd()`    | Working directory for the compile and print steps.                                            |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT`              | unset (no timeout) | Milliseconds before a subprocess is killed. `ATOM_TIMEOUT` wins.                              |
