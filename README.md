# atom-parsetools

atom-parsetools is the set of parsers that [atom](https://github.com/AppThreat/atom) and
[chen](https://github.com/AppThreat/chen) run to turn source code into AST JSON and type
information. It installs four commands:

- `astgen` writes the AST of JavaScript, TypeScript, Vue, Svelte, Astro and Ember projects, plus a
  type map of every file.
- `phpastgen` writes the AST of PHP projects with a vendored nikic/php-parser.
- `rbastgen` writes the AST of Ruby projects with AppThreat's
  [`ruby_ast_gen`](https://github.com/AppThreat/ruby_ast_gen) gem (2.0.1).
- `scalasem` writes a Scala semantics report from the compiler's own output.

Version 2 adds native type maps. `parsa` ("parse for atom") is a Go binary built on TypeScript 7's
checker, and astgen uses it to write the `.typemap` of each JavaScript and TypeScript file. It is
several times faster than TypeScript 6 on large projects, and it types each nested project with that
project's own configuration. Babel still parses every file, so the AST JSON is unchanged, and Node
stays a requirement.

## Installing

```shell
npm install -g @appthreat/atom-parsetools
```

npm also installs `parsa` from one of six platform packages, `@appthreat/parsa-<os>-<cpu>` for
Linux, macOS and Windows on x64 and arm64, which this package lists as optional dependencies. The
Linux packages serve glibc and musl alike. astgen finds the binary on its own, so atom, chen and
cdxgen need no setting. On a host without a package (32-bit ARM, riscv64, ppc64), or after
`npm install --omit=optional`, astgen writes the type maps with TypeScript 6 instead, as 1.x did.

The `parsa` binaries are also attached to each [GitHub release](https://github.com/AppThreat/atom-parsetools/releases)
with `.sha256` files and build provenance, and published to `ghcr.io/appthreat/parsa`. Each release
and each platform package carries `sbom-parsa-postbuild.cdx.json`, a CycloneDX SBOM of the Go
modules the binaries were built from and the pinned TypeScript commit with its patches.
[docs/PACKAGING.md](docs/PACKAGING.md) describes the packages and how they are published.

`atom --version` (atom 4.0 and later) prints the atom-parsetools and `parsa` versions that a run
will use.

## Upgrading from 1.x

Native type maps are the default. With `ASTGEN_TYPES` unset, astgen runs `parsa` when it finds it
and TypeScript 6 when it does not. Set `ASTGEN_TYPES=ts6` to keep 1.x's type strings on every
machine. TypeScript 7 prints some types differently, for example union and object member order and
the source's quote style in literal types; the [astgen guide](docs/ASTGEN.md) lists every
difference. `ASTGEN_VERSION` moved to 4.7.1, so caches keyed on it, such as chen's parse cache, are
rebuilt once.

Each run with types on appends a record to `astgen_manifest.jsonl` in the output directory with
the engine that wrote the type maps, the reason for a fallback, and, for a native run, the
TypeScript commit and any file that reached a budget. chen reads it to know which engine ran.
[CHANGELOG.md](CHANGELOG.md) has the full list of changes, including the two output path fixes that
affect runs with `-i .`.

## Documentation

The full documentation is at [appthreat.github.io/atom-parsetools](https://appthreat.github.io/atom-parsetools/):
a guide per tool, the output formats, the environment variables, packaging notes and ten tutorials.
The pages are rendered from the [`docs`](docs/) directory.

## Runtimes

The commands run on [Node.js](https://nodejs.org) 22 or later (required by `@babel/parser` 8) and
on [Bun](https://bun.sh). CI runs the commands and the regression suites under both, so
`bun astgen.js -i .` works as well as `node astgen.js -i .`. `rbastgen` also needs Ruby, and
`phpastgen` needs PHP.

## Commands

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
  -h, --help     Show help                                             [boolean]
```

Each source file becomes an AST JSON document and a `.typemap` of the type of each node, keyed by
its offsets. A native run also writes a `.typespans` per file, keyed by `"start:end"`, so a consumer
can look a node up by its own extent. Test files and `node_modules` are skipped by default. The
type map engine is chosen with `ASTGEN_TYPES` (`native` or `ts6`), `ASTGEN_NATIVE_BIN` names a
`parsa` binary to use instead of the packaged one, and `ASTGEN_NATIVE_MEMORY_MB` caps its heap
(6,144 MB by default). The [astgen guide](docs/ASTGEN.md) covers every option and environment
variable.

`.vue` and `.svelte` single-file components are flattened into the same Babel shape as any other
file: script statements at the top level of the `Program`, and the template as standard JSX nodes.
Svelte components are split with `svelte/compiler`, and every offset is a byte position in the
component source, so a consumer that slices the original file for `code` fields gets the real text
back. Control flow maps onto its JSX equivalent (`{#if}` to a `ConditionalExpression`, `{#each}` to
`.map()` with an arrow function, `{#await}` to `.then()`), so no framework-specific node types are
emitted. The astgen guide has the full mapping and the accepted losses.

`parsa` can also be run on its own; astgen runs it the same way:

```text
parsa js --types-only -i SRC -o OUT [--workers N] [--report FILE]
parsa --version
```

It types every file through TypeScript 7's checker in one process, with up to eight checkers per
program, and its output does not depend on the number of checkers. Each file has a work, time and
memory budget, and a file past one keeps the entries written before it and is listed in the
report.

### phpastgen

```text
node phpastgen.js --help

Usage: phpastgen [options] [-- <legacy php-parse args>]

Options:
  -i, --input <path>          input file or directory (batch mode)
  -o, --output <dir>          output directory (default: '.ast')
  -e, --exclude <regex>       exclusion regex (default: '^(tests?|vendor|Tests?)')
  -l, --log <level>           debug | info | warn | error (default: info)
  -d, --debug                 same as --log debug
      --target-version <x.y>  pin PHP grammar (alias: --parser-target)
      --max-depth <n>         depth cap before truncation (default: 250)
      --threads <n>           worker processes for directory runs (default: 10)
      --files-per-process <n> files one PHP interpreter parses in a directory run (max 100; default: sized to the tree, 1 = one php-parse per file)
      --include-vendor        also parse vendor/ and node_modules/ (skipped by default)
      --fail-on-error         exit non-zero if any file failed
      --parser-info           print parser/runtime capability report and exit 0
      --version               print generator version and exit 0
      --help                  print usage
```

The PHP parser (nikic/php-parser 5.9.0, grammars 8.0 to 8.5) is vendored under `plugins/`, so only
a PHP runtime is needed. A batch run writes one JSON per file plus `phpastgen_manifest.jsonl` and,
when a file fails, `phpastgen_diagnostics.jsonl`. Details are in the [phpastgen guide](docs/PHPASTGEN.md).

### rbastgen

`rbastgen` needs Ruby 3.4.x or 4.0.x on the `PATH`, or `ATOM_RUBY_HOME` pointing at an install. The
gem and its pure-Ruby dependencies are bundled under `plugins/rubyastgen`, so nothing has to be
installed with `gem`, and one build of this package runs under every supported Ruby: the bundle
reaches the interpreter through `GEM_PATH` rather than bundler's standalone loader, which resolved
its paths from the ABI of the Ruby that built it.

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

A file that fails to parse is reported and skipped; only usage errors (a missing `-i`, an unusable
`--exclude` regex, an invalid `--parser-target`) exit non-zero. `rbastgen` does not pass on the
generator's exit status, so `--fail-on-error` is reported in the log while the wrapper still exits
0; call the gem directly when a CI job must fail on a parse error. Discovery includes Ruby DSL files
(`Gemfile`, `Rakefile`, `.gemspec`, `.rake` and more), and each run writes
`ruby_ast_gen_manifest.jsonl` and, when a file fails, `ruby_ast_gen_diagnostics.jsonl`. Details are
in the [rbastgen guide](docs/RBASTGEN.md).

### scalasem

```text
scalasem <directory> <slices_file>
```

For example:

```shell
scalasem $(pwd) slices.json
```

scalasem finds the build (sbt, mill, maven, scala-cli, or the output of an earlier build), reads
Scala 3 TASTy through the compiler that wrote it and Scala 2 SemanticDB, and reports definitions,
call sites and references with file and line, Play routes, endpoint configuration values, and the
crypto, endpoint, service and call stack evidence derived from them. `--no-build` analyses without
starting a build tool. The [scalasem guide](docs/SCALASEM.md) covers the pipeline and the report
schema.

## Testing

`npm test` covers the JavaScript and TypeScript side and needs only Node. The native type map tests
(`npm run test:native`, `test:native-types` and `test:hostile`) need Go to build `parsa` and skip
themselves without a binary. Before a release, every type map difference between the two engines
on a corpus of 19 JavaScript and TypeScript projects is classified by `lib/typemap/diff.mjs` and
bounded in `test-fixtures/typemap-allow.json`, and the output is compared at one and eight
checkers.

The Ruby and PHP workflows need their runtimes and a built plugin bundle, and skip themselves when
either is missing:

```shell
bash build.sh --ruby-only
npm run test:ruby
```

The Ruby tests check what a consumer depends on rather than only that the command ran: which files
are discovered (including `Gemfile` and `Rakefile`, matched by name), that `has_sig`,
`magic_comments`, `percent_array` and regexp `options` are written, that the manifest's counts add
up, that a failed file lands in the diagnostics record while the run still exits 0, that a clean run
leaves no stale record behind, and that the bundle contains no compiled extension. CI runs them
under Ruby 3.4 and Ruby 4.0 against a bundle built with 3.4.

`ci/verify-packed-tarball.sh` is the release check: it packs the tarball, installs it into a scratch
project and parses the fixtures with the installed copy, checking that the Ruby bundle is present
and has no compiled extensions. CI runs it, and it runs the same way locally. The
[testing guide](docs/TESTING.md) maps all the suites.

## License

MIT
