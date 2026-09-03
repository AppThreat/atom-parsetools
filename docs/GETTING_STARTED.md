# Getting Started

This page takes you from a clean machine to generated AST files for a real project, and tells you what to check at each step.

## Prerequisites

Node.js 22 or newer is required, because `@babel/parser` 8 requires it. Bun works as an alternative runtime. Everything else depends on which languages you parse.

| You want to parse | You need on the machine | You do not need |
| ----------------- | ----------------------- | --------------- |
| JavaScript, TypeScript, Vue, Svelte | Node.js >= 22 or Bun | nothing else |
| PHP | PHP on the PATH | Composer, nikic/php-parser |
| Ruby | Ruby 3.4.x or 4.0.x, or `ATOM_RUBY_HOME` | gem installs, bundler |
| Scala | scala and scalac, plus sbt or mill for compilation | nothing else |

The PHP parser and the Ruby gem bundle are vendored into the npm package under `plugins/`, so `npm install` is the only setup step.

## Install

```shell
npm install -g @appthreat/atom-parsetools
```

Verify all four commands respond. Each has its own version or capability report:

```shell
astgen --version
phpastgen --parser-info
rbastgen --parser-info
scalasem --help
```

`--parser-info` is the one worth reading on a new machine. It prints which parser backend will run, which language runtime was detected, and which grammar versions are available, which answers most "why did my parse come out different" questions before they come up.

## Your first run

Pick any JavaScript or TypeScript project. From its root:

```shell
astgen -i .
```

The default output directory is `ast_out` under the source directory, so you now have:

```text
your-project/
  ast_out/
    src/index.js.json
    src/index.js.typemap
    src/utils/date.ts.json
    src/utils/date.ts.typemap
```

One `.json` per source file holding the AST, and one `.typemap` per file holding the TypeScript checker's inferred types, keyed by node position. [Lesson 1](LESSON1.md) dissects these files; [Output Formats](OUTPUT_FORMATS.md) specifies them.

For PHP, Ruby, or Scala the flow is the same with a different command:

```shell
phpastgen -i . -o php-ast
rbastgen -i . -o ruby-ast
scalasem "$(pwd)" slices.json
```

## What to check after a run

Each tool reports what it did, and the batch tools (phpastgen, rbastgen) also write a manifest into the output directory. A healthy run has three properties.

First, the file count should make sense. The manifest records `files_parsed`, `files_failed`, and `files_excluded`, so a number that looks wrong is usually an exclusion regex or a discovery rule, not a parser bug.

Second, failures should be explainable. Individual file failures are never fatal in batch mode; they land in the diagnostics side-record (`*_diagnostics.jsonl`) with a message, line, and column, and the run still exits zero.

Third, the output should be consumable. Every AST is a standalone `.json`; every side-record ends in `.jsonl`. If your consumer globs `*.json` it gets trees and nothing else. That naming rule is a documented contract, covered in [Lesson 9](LESSON9.md).

## Where to go next

Read the page for the tool you use most, then [Environment Variables](ENV.md) for the tuning knobs. The [Tutorials](LESSON1.md) are self-contained and each one ends with a working artifact you can inspect.
