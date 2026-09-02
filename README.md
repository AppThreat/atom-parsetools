# Introduction

This package hosts a collection of parsing tools that complement the `@appthreat/atom` project. These tools offer parsing and analysis-related functionalities such as generating AST and semantics information in JSON format. The full list of tools and bin commands exposed by this package is below:

- astgen - Generates AST for JavaScript and TypeScript projects in JSON format
- phpastgen - Generates AST for PHP projects using `php-parse` command from `nikic/php-parser`
- rbastgen - Generates AST for Ruby projects using AppThreat's [`ruby_ast_gen`](https://github.com/AppThreat/ruby_ast_gen) gem (2.0.0)
- scalasem - Generates a custom semantics slice for Scala Projects by utilising scalac command.

## Runtime support

These tools run on both [Node.js](https://nodejs.org) (>= 22, required by `@babel/parser` 8) and [Bun](https://bun.sh). All commands and the accompanying regression test-suite are exercised under both runtimes in CI, so the commands below can be invoked with either `node` or `bun` interchangeably (for example `bun astgen.js -i .`).

## Command usages

### astgen

```text
node astgen.js -h
Options:
  -i, --src      Source directory                                 [default: "."]
  -o, --output   Output directory for generated AST JSON files
                                                            [default: "ast_out"]
  -t, --type     Project type. Default auto-detect
  -r, --recurse  Recurse mode suitable for mono-repos  [boolean] [default: true]
      --tsTypes  Generate type mappings using the TypeScript Compiler API
                                                       [boolean] [default: true]
      --version  Show version number                                   [boolean]
  -h             Show help                                             [boolean]
```

#### Environment variables

| Variable                              | Default   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASTGEN_TYPE_WORKERS`                 | `1` (off) | Number of worker threads for the TypeScript type-generation phase, or `auto` to derive it from the available CPUs. The TypeScript checker is single-threaded, so parallelism comes from sharding files across workers, each building its own program. **Opt-in:** sharding changes TypeScript's internal type-id ordering, which reorders the members of a small number of inferred union types (e.g. `A \| B` → `B \| A`; semantically identical). Leave unset for byte-identical output; set it (e.g. `auto` or `8`) to trade that cosmetic reordering for a large speedup on big projects. |
| `ASTGEN_INCLUDE_TEST_FILES`           | `false`   | When `true`, do not exclude test files (`*.poku.js`, `*.test.*`, `*.spec.*`, `*.e2e.*`, `__tests__/`, `__mocks__/`) from AST and type generation. They are excluded by default because they are typically the heaviest, lowest-value inputs for type generation.                                                                                                                                                                                                                                                                                                                              |
| `ASTGEN_CONCURRENCY`                  | `10`      | Chunk size for the in-thread file loop (bounds peak memory between `gc()` passes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ASTGEN_INCLUDE_NODE_MODULES_BUNDLES` | `false`   | When `true`, also parse bundled entrypoints inside `node_modules` (files matching `*.(bundle\|dist\|index\|min\|app).(js\|cjs\|mjs)`). Off by default; `node_modules` is otherwise skipped entirely.                                                                                                                                                                                                                                                                                                                                                                                          |
| `ASTGEN_IGNORE_DIRS`                  | unset     | Comma/space-separated list of directories to ignore. As a side effect, when it is set and does **not** contain `node_modules`, the `node_modules` bundle entrypoints above are included (equivalent to `ASTGEN_INCLUDE_NODE_MODULES_BUNDLES=true`).                                                                                                                                                                                                                                                                                                                                           |

### phpastgen

```text
node phpastgen.js --help

Usage: phpastgen [operations] file1.php [file2.php ...]
   or: phpastgen [operations] "<?php code"
Turn PHP source code into an abstract syntax tree.

Operations is a list of the following options (--dump by default):

    -d, --dump              Dump nodes using NodeDumper
    -p, --pretty-print      Pretty print file using PrettyPrinter\Standard
    -j, --json-dump         Print json_encode() result
        --var-dump          var_dump() nodes (for exact structure)
    -N, --resolve-names     Resolve names using NodeVisitor\NameResolver
    -c, --with-column-info  Show column numbers for errors (if available)
    -P, --with-positions    Show positions in node dumps
    -r, --with-recovery     Use parsing with error recovery
    -h, --help              Display this page

```

### rbastgen

Requires Ruby 3.4.x or 4.0.x on the `PATH`, or `ATOM_RUBY_HOME` pointing at an install. The gem
itself is bundled under `plugins/rubyastgen`, so nothing needs to be gem-installed.

```text
node rbastgen.js --help
Usage:
  -i, --input <path>       The input file or directory (required)
  -o, --output <dir>       The output directory (default: '.ast')
  -e, --exclude <regex>    The exclusion regex (default: '^(tests?|vendor|spec)')
  -l, --log <level>        The logging level: debug, info, warn or error (default: info)
  -d, --debug              Enable debug logging (same as --log debug)
      --parser-target <x.y>
                           Parse with a specific Ruby grammar (e.g. 3.4, 4.0) instead
                           of the newest available
      --max-depth <n>      Maximum AST depth before truncation (default: 250)
      --threads <n>        Worker threads for a directory run (default: 10)
      --fail-on-error      Exit non-zero when any input file failed to parse
      --parser-info        Print parser/runtime capability information
      --version            Print the version
      --help               Print usage
```

Problems with individual files are reported and skipped, never fatal; only usage errors (a missing
`-i`, an unusable `--exclude` regex, an invalid `--parser-target`) exit non-zero. Note that
`rbastgen` does not propagate the generator's exit status, so `--fail-on-error` is reported in the
log but the wrapper still exits 0 — call the gem directly if a CI job needs to fail on a parse
error.

#### What the bundled generator emits (ruby_ast_gen 2.0.0)

- **Parsing is decoupled from the running Ruby.** When `prism` is available the newest grammar its
  translation layer supports is used, so a 3.4 runtime parses Ruby 4.0/4.1 syntax. `--parser-target
x.y` pins a grammar instead (down to 1.8 through the `parser` gem), and a file that fails under
  the selected grammar is retried once with the newest one. Every JSON file records the backend
  that produced it in `parser_backend`, alongside `generator_version` and `ruby_version`.
- **Ruby DSL files are discovered, not just `.rb`.** `Rakefile`, `Gemfile`, `Capfile`,
  `Vagrantfile`, `Fastfile` and friends are matched by basename, plus the `.gemspec`, `.rake`,
  `.ru`, `.rbi`, `.thor`, `.jbuilder`, `.axlsx` and `.rabl` extensions. Vendor and tool
  directories (`.git`, `.bundle`, `.venv`, …) are skipped.
- **Non-UTF-8 sources survive.** `# coding:` magic comments are honoured and undecodable bytes are
  scrubbed rather than dropping the file, marked with `encoding_scrubbed: true`.
- **Deeply nested source is truncated, not dropped**, with `truncated: true` on the boundary node
  and a `truncated_nodes` count at the top level (`--max-depth`).
- **Semantic metadata for consumers**: a `magic_comments` array (Sorbet `typed:` levels,
  `frozen_string_literal`, …), `call_operator`/`has_parentheses` on calls, `percent_array` and
  regexp `options`, heredoc body offsets, and `has_sig: true` on a `def` preceded by a Sorbet `sig`
  block.
- **Two side-records per run, written inside the output directory**, both ending in `.jsonl` so a
  consumer globbing `*.json` for ASTs never mistakes them for one:
  `ruby_ast_gen_manifest.jsonl` (one object: input/output, backend, counts of parsed, failed,
  skipped, excluded and truncated files, threads, max depth) and
  `ruby_ast_gen_diagnostics.jsonl` (one object per failed file with message, line, column), the
  latter written only when something failed and removed when a later run is clean.

To check which backend a machine will use:

```shell
rbastgen --parser-info
```

The two gem-version lines in that output read `unavailable` here even though the gems are present:
the bundle is standalone, so `Gem.loaded_specs` is empty. The `Parser backend` and
`Grammar version` lines are the authoritative ones.

#### Environment variables

| Variable                          | Default                | Purpose                                                                                                                                                |
| --------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ATOM_RUBY_HOME`                  | unset                  | Ruby install directory to use when a suitable `ruby` is not on the `PATH`; its `bin` is prepended to `PATH` for the child process.                     |
| `RUBY_CMD`                        | `ruby`                 | Ruby interpreter to invoke. Set this (or `ATOM_RUBY_HOME`) when the detected version is not 3.4.x/4.0.x.                                               |
| `RUBY_ASTGEN_BIN`                 | bundled `ruby_ast_gen` | The generator script to run. Point it at a checkout's `exe/ruby_ast_gen` to test an unreleased `ruby_ast_gen` without touching this package.           |
| `ATOM_CWD`                        | `process.cwd()`        | Working directory for the generator, which is what relative `-i`/`-o` paths resolve against.                                                           |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout)     | Milliseconds before the generator process is killed. `ATOM_TIMEOUT` wins; a non-numeric value is ignored. Also honoured by `phpastgen` and `scalasem`. |

### scalasem

```text
scalasem <directory> <slices_file>
```

Example:

```shell
scalasem $(pwd) slices.json
```

## License

MIT
