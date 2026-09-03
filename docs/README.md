# atom-parsetools

atom-parsetools is a collection of parsing commands that complement the [atom](https://github.com/AppThreat/atom) code analysis project. Each command takes a source tree and emits JSON that a downstream consumer can load without embedding a parser of its own: abstract syntax trees for JavaScript, TypeScript, PHP, and Ruby, type maps for TypeScript, and semantic slices for Scala.

The package exposes four bin commands.

| Command     | Languages                                | Parser backend                                     |
| ----------- | ---------------------------------------- | -------------------------------------------------- |
| `astgen`    | JavaScript, TypeScript, Vue, Svelte, EJS | Babel 8, hermes-parser, TypeScript 6 checker       |
| `phpastgen` | PHP 8.0 to 8.5                           | vendored nikic/php-parser 5.8.0                    |
| `rbastgen`  | Ruby 1.8 to 4.x syntax                   | vendored ruby_ast_gen 2.0.1, prism and parser gems |
| `scalasem`  | Scala 3                                  | scalac TASTy printer                               |

All commands run on both [Node.js](https://nodejs.org) (>= 22, required by `@babel/parser` 8) and [Bun](https://bun.sh). The full regression suite runs under both runtimes in CI, so `node astgen.js -i .` and `bun astgen.js -i .` are interchangeable.

## Why a separate package

Atom frontends such as chen turn source into a code property graph. They need three things from a parser: it must accept messy real-world code, its output must be stable enough to cache, and it must not drag the whole analysis stack into every parse. These commands isolate that concern. Each one is a thin, deliberately boring wrapper around a proven parser, with the packaging work (vendoring the PHP parser, bundling pure-Ruby gems, pinning grammars) done once at build time so the consumer does neither at runtime.

The contract is deliberately simple: files in, JSON files out, one JSON document per input file. Anything that is not an AST gets a `.jsonl` name so a consumer globbing `*.json` never mistakes a run manifest for a tree.

## Install

```shell
npm install -g @appthreat/atom-parsetools
```

Or as a dependency of your own tool:

```shell
npm install @appthreat/atom-parsetools
```

PHP and Ruby parsing need their language runtimes available (`php` on the PATH, and Ruby 3.4.x or 4.0.x on the PATH or under `ATOM_RUBY_HOME`), but nothing else: the parser and the gem bundle ship inside the package under `plugins/`.

## Quick tour

Parse a JavaScript or TypeScript project into per-file AST JSON plus TypeScript type maps:

```shell
astgen -i /path/to/project
```

Batch-parse a PHP project with a worker pool and a per-run manifest:

```shell
phpastgen -i /path/to/project -o php-ast
```

Generate Ruby ASTs, including DSL files like `Gemfile` and `Rakefile`:

```shell
rbastgen -i /path/to/project -o ruby-ast
```

Produce semantic slices for a Scala project, compiling it first if needed:

```shell
scalasem /path/to/project slices.json
```

## Where to go next

[Getting Started](GETTING_STARTED.md) walks through installation and a first run. The tool pages ([astgen](ASTGEN.md), [phpastgen](PHPASTGEN.md), [rbastgen](RBASTGEN.md), [scalasem](SCALASEM.md)) document every option and environment variable, [Output Formats](OUTPUT_FORMATS.md) specifies the JSON shapes, and [Architecture](ARCHITECTURE.md) shows how the pieces connect to atom and cdxgen. If you learn best by doing, start with [Lesson 1](LESSON1.md).
