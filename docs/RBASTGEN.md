# rbastgen: Ruby

`rbastgen` generates Ruby ASTs by driving AppThreat's [ruby_ast_gen](https://github.com/AppThreat/ruby_ast_gen) gem (2.0.1), which is vendored into the package together with its pure-Ruby dependencies. The command is a Node wrapper that finds a suitable Ruby, exposes the vendored bundle to it, and forwards your arguments; the gem does the parsing.

```text
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

## One build, every supported Ruby

The interesting engineering in rbastgen is the packaging. A naive approach, bundler's standalone loader, resolves its load paths through `Gem.ruby_api_version` at runtime, which pins the package to the exact Ruby ABI it was built with. rbastgen instead exposes the vendored bundle through `GEM_PATH`, which does not care about ABIs, so a single build of the package runs under every supported Ruby (3.4.x and 4.0.x).

```text
        rbastgen.js
             |
             |  GEM_PATH = <vendored bundle>/<abi dirs> + caller's GEM_PATH
             v
   +-------------------+     picks up runtime's own     +-------------------+
   | vendored bundle   |     prism, racc (default gems, |  ruby 3.4 or 4.0  |
   | pure Ruby only:   |<---- C extensions NOT -------+ |  (detected via    |
   | ruby_ast_gen 2.0.1|     vendored, by design)     |  PATH or          |
   | parser, etc.      |                              |  ATOM_RUBY_HOME)  |
   +-------------------+                              +-------------------+
```

`prism` and `racc` are deliberately not vendored. Both carry C extensions, which are built per ABI and per platform, and both are default gems in every supported Ruby, so the runtime's own copies serve instead. One consequence is visible: the newest grammar available follows the interpreter's prism, so Ruby 3.4 tops out lower than Ruby 4.0 (grammar 3.5 versus 4.1 at the time of writing). Installing a newer `prism` gem on the machine raises the ceiling, because the caller's `GEM_PATH` is preserved and appended, letting machine-installed gems win.

`rbastgen --parser-info` shows exactly which copies a machine will use. `Parser gem` and `Prism gem` name the versions actually loaded, the vendored `parser` and the runtime's `prism`, and read `unavailable` only when a library genuinely is not loaded.

## Discovery beyond .rb

Ruby projects keep executable and declarative Ruby in files that do not end in `.rb`, so discovery matches by basename as well as extension. `Rakefile`, `Gemfile`, `Capfile`, `Vagrantfile`, `Fastfile` and friends are matched by name, and the extensions `.gemspec`, `.rake`, `.ru`, `.rbi`, `.thor`, `.jbuilder`, `.axlsx`, and `.rabl` are matched as Ruby. Vendor and tool directories (`.git`, `.bundle`, `.venv`, and similar) are skipped. The default exclude regex `^(tests?|vendor|spec)` drops the rest of the obvious noise.

## What the JSON records

Every output file records how it was produced: `parser_backend`, `generator_version`, and `ruby_version` at the top level. That answers provenance questions after the fact, which matters because the backend can vary per machine.

Around the tree itself, the generator records semantics that a consumer would otherwise have to re-derive from positions. Calls carry `call_operator` and `has_parentheses`. Percent arrays and regexps carry their `options`. Heredocs carry body offsets. A `def` preceded by a Sorbet `sig` block carries `has_sig: true`. The `magic_comments` array collects declarations like Sorbet `typed:` levels and `frozen_string_literal`.

Two survival behaviors match phpastgen. Non-UTF-8 sources keep going: `# coding:` magic comments are honored and undecodable bytes are scrubbed, marked `encoding_scrubbed: true`, rather than dropping the file. Deeply nested source is truncated at `--max-depth`, with `truncated: true` on the boundary node and a `truncated_nodes` count at the top level.

Each run also writes `ruby_ast_gen_manifest.jsonl` (one object: input and output, backend, counts of parsed, failed, skipped, excluded and truncated files, threads, max depth) and, only when something failed, `ruby_ast_gen_diagnostics.jsonl` with one object per failed file. Both end in `.jsonl` so a `*.json` glob never mistakes them for ASTs, and a later clean run removes the stale diagnostics file.

## Grammar selection and retries

When `prism` is available, the newest grammar its translation layer supports is used, so a Ruby 3.4 runtime parses Ruby 4.0 and 4.1 syntax. Pin a grammar with `--parser-target x.y`; the vendored `parser` gem reaches back as far as 1.8 syntax. A file that fails under the selected grammar is retried once with the newest available grammar before being counted as failed, which keeps a single exotic file from failing a pinned run.

## Failure and exit behavior

Problems with individual files are reported and skipped, never fatal. Only usage errors (a missing `-i`, an unusable `--exclude` regex, an invalid `--parser-target`) exit non-zero. One caveat belongs in CI scripts: the wrapper does not propagate the generator's exit status, so `--fail-on-error` is reported in the log but the wrapper still exits 0. A job that must fail on parse errors should read `files_failed` from the manifest, or invoke the gem directly.

## Environment variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `ATOM_RUBY_HOME` | unset | Ruby install directory; its `bin` is prepended to `PATH` for the child. |
| `RUBY_CMD` | `ruby` | Interpreter to invoke; set when the detected version is not 3.4.x or 4.0.x. |
| `RUBY_ASTGEN_BIN` | vendored `ruby_ast_gen` | Generator script to run; point at a checkout's `exe/ruby_ast_gen` to test unreleased code. |
| `ATOM_CWD` | `process.cwd()` | Working directory; relative `-i` and `-o` paths resolve against it. |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout) | Milliseconds before the generator is killed. `ATOM_TIMEOUT` wins. |
| `GEM_PATH` | unset | Preserved and appended to the vendored bundle, so machine gems stay reachable. |
