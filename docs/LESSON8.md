# Lesson 8: Scala semantic slices

## Learning Objective

Run `scalasem` over a Play application, understand why it reads the compiler's TASTy output instead of parsing source, and read the tags and routes it extracts.

## Pre-requisites

```text
scala and scalac on the PATH
sbt (or mill, for projects with a build.mill)
a JDK suitable for the Scala 3 project you scan
```

## Why TASTy and not source

Parsing Scala source with an external parser is a losing game: the language's grammar is entangled with its type system, macros, and given/using resolution. `scalasem` therefore asks the compiler itself. Scala 3 compilation emits `.tasty` files next to the class files, and `scalac -print-tasty` dumps them as readable text. The slice is then parsed out of that dump: literals from the Names section, referenced types from `Signature(...)` entries in the Trees section. What you get reflects what the compiler actually resolved, not what a foreign parser guessed.

```text
  source (.scala)
       |
       |  sbt compile  (skipped if .tasty already exists)
       v
  .tasty  ---- scalac -print-tasty ---->  printed dump
       |                                     |
       |                          Names section  -> literals
       |                          Trees section  -> usedTypes, tags
       |                          routes file    -> config.routes
       v
  slices.json
```

## Getting started

Use the official Play seed template (or any Play project you have; an existing build works as-is because compilation is skipped when `.tasty` files are present):

```shell
sbt new playframework/play-scala-seed.g8 --name=play-demo
cd play-demo
scalasem "$(pwd)" slices.json
```

The tool logs the compile step (version selection from `build.sbt` or `SCALA_VERSION`, or the default `compile` command overridden by `SBT_COMPILE_COMMAND`), then the number of IR files obtained, and finally:

```text
Slices file slices.json created successfully with N entries.
```

Inspect the shape:

```shell
python3 -c "
import json
s = json.load(open('slices.json'))
print('config routes:', len(s.get('config', {}).get('routes', [])))
for key in list(s)[1:4]:
    print(key, '->', s[key]['tags'])
"
```

## Reading a slice

Each entry holds four fields. `sourceFile` is where the entry's types came from. `usedTypes` lists the non-trivial signatures the code uses, with `scala.`, `java.`, and `javax.inject.` noise dropped, so `play.api.mvc.Request` survives while `java.lang.String` does not. `literals` collects the names in the Names section, which is why string constants that made it into the compiled program appear. `tags` is the framework knowledge, derived from those types:

| Tag | Triggered by |
| --- | ------------- |
| `framework` | any `play.api.` usage |
| `framework-input` | `play.api.data.Form`, `play.api.mvc.Request`, `play.twirl.api` |
| `framework-output` | `play.twirl.api.Html`, `play.api.mvc.Result`, `play.api.mvc.Action` |
| `framework-route` | `play.api.routing.`, `play.core.routing`, `router.RoutesPrefix` |
| `database` | `slick.sql.`, `slick.jdbc.`, `play.db.` |
| `generated` | file lives under `target/` |

A consumer grading attack surface reads these tags directly: `framework-input` marks where request data enters, `database` marks where it lands, and the routes table says which URLs reach which controller methods.

## The routes table

The reserved `config` entry holds the parsed Play `routes` file. Each verb line becomes `{method, pattern, controllerMethod}`. Comments are dropped, `/webjars` asset routes are dropped, and a `->` splat, which forwards every verb, is expanded into GET, PATCH, POST, DELETE, and PUT entries so reachability matching has concrete methods to work with. If your project has no routes file, `config.routes` is simply empty.

## Compile trouble

The compile step is a real sbt build and fails the way sbt builds fail; its stderr is printed. Two knobs help in CI: `SCALA_VERSION` skips the `build.sbt` version detection (the tool prefixes the command with `++<version>`), and `ATOM_TIMEOUT` bounds each subprocess. If a slice entry is missing but compilation succeeded, check `ATOM_MAX_BUFFER` (default 100 MB): a class file whose printed dump exceeds the buffer fails silently into the log.

## Where to go next

[Lesson 9](LESSON9.md) returns to the AST tools and shows how to consume their output from your own code.
