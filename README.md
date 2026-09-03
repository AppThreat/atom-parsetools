# atom-parsetools

This package hosts a collection of parsing tools that complement the `@appthreat/atom` project. These tools offer parsing and analysis-related functionalities such as generating AST and semantics information in JSON format. The full list of tools and bin commands exposed by this package is below:

- astgen - Generates AST for JavaScript and TypeScript projects in JSON format
- phpastgen - Generates AST for PHP projects using `php-parse` command from `nikic/php-parser`
- rbastgen - Generates AST for Ruby projects using AppThreat's [`ruby_ast_gen`](https://github.com/AppThreat/ruby_ast_gen) gem (2.0.1)
- scalasem - Generates a custom semantics slice for Scala Projects by utilising scalac command.

## Documentation

The full documentation lives at [https://appthreat.github.io/atom-parsetools/](https://appthreat.github.io/atom-parsetools/): per-tool guides, the output format specification, environment variable reference, packaging notes, and ten hands-on tutorials. The pages are rendered from the [`docs`](docs/) directory of this repository.

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

Each source file becomes an AST JSON document plus a `.typemap` of inferred types keyed by node offsets. Test files and `node_modules` are excluded by default; the [astgen guide](docs/ASTGEN.md) covers every option and env variable (`ASTGEN_TYPE_WORKERS`, `ASTGEN_INCLUDE_TEST_FILES`, and friends).

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
      --fail-on-error         exit non-zero if any file failed
      --parser-info           print parser/runtime capability report and exit 0
      --version               print generator version and exit 0
      --help                  print usage
```

The PHP parser (nikic/php-parser 5.8.0, grammars 8.0 to 8.5) is vendored under `plugins/`, so only a PHP runtime on the machine is required. Batch runs write one JSON per file plus `phpastgen_manifest.jsonl` and, on failure, `phpastgen_diagnostics.jsonl`. Details in the [phpastgen guide](docs/PHPASTGEN.md).

### rbastgen

Requires Ruby 3.4.x or 4.0.x on the `PATH`, or `ATOM_RUBY_HOME` pointing at an install. The gem and its pure-Ruby dependencies are bundled under `plugins/rubyastgen`, so nothing needs to be gem-installed, and one build of this package runs under every supported Ruby: the bundle is exposed to the interpreter through `GEM_PATH` rather than through bundler's standalone loader, which resolved its paths from the ABI of the Ruby that built it.

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

Problems with individual files are reported and skipped, never fatal; only usage errors (a missing `-i`, an unusable `--exclude` regex, an invalid `--parser-target`) exit non-zero. Note that `rbastgen` does not propagate the generator's exit status, so `--fail-on-error` is reported in the log but the wrapper still exits 0; call the gem directly if a CI job needs to fail on a parse error. Discovery covers Ruby DSL files (`Gemfile`, `Rakefile`, `.gemspec`, `.rake`, and more), and each run writes `ruby_ast_gen_manifest.jsonl` and, on failure, `ruby_ast_gen_diagnostics.jsonl`. Details in the [rbastgen guide](docs/RBASTGEN.md).

### scalasem

```text
scalasem <directory> <slices_file>
```

Example:

```shell
scalasem $(pwd) slices.json
```

Compiles the project with sbt or mill if no `.tasty` files exist, then extracts literals, used types, and Play framework tags into a semantic slice. The [scalasem guide](docs/SCALASEM.md) covers the pipeline.

## Testing

`npm test` covers the JavaScript/TypeScript side and needs nothing but Node. The Ruby and PHP workflows need their runtimes and a built plugin bundle, and they skip themselves cleanly when either is missing:

```shell
bash build.sh --ruby-only
npm run test:ruby
```

`ci/verify-packed-tarball.sh` is the release check: it packs the tarball, installs it into a scratch project and parses the fixture with the installed copy, asserting along the way that the Ruby bundle is present and free of compiled extensions. CI runs it, and it runs the same way locally.

They assert what a consumer depends on rather than that the command ran: which files are discovered (including `Gemfile` and `Rakefile`, matched by basename), that `has_sig`, `magic_comments`, `percent_array` and regexp `options` are emitted, that the manifest's counts reconcile, that a failed file lands in the diagnostics record while the run still exits 0, that a clean run leaves no stale record behind, and that the bundle contains no compiled extension. CI runs them under both Ruby 3.4 and Ruby 4.0 against a bundle built with 3.4, and separately installs the packed tarball and parses with that, which is the check that catches a bundle usable only on the Ruby that built it. The [testing guide](docs/TESTING.md) maps the suites.

## License

MIT
