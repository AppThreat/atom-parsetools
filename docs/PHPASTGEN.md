# phpastgen: PHP

`phpastgen` parses PHP source into AST JSON using a vendored copy of nikic/php-parser 5.8.0. It has two modes: batch mode, selected by `-i`, which walks a directory with a worker pool and writes one JSON file per PHP file plus run records; and a legacy passthrough, used when `-i` is absent, which forwards every argument to the vendored `php-parse` command unchanged.

```text
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

## What is vendored and why

The parser ships inside the package under `plugins/`, installed by Composer at build time (see [Packaging](PACKAGING.md)). The `php-parse` binary lands in `plugins/bin/php-parse` and the library under `plugins/nikic/`. You never run Composer: PHP on the PATH is the only requirement. Set `PHP_PARSER_BIN` to point at a different `php-parse`, and `PHP_CMD` to select the interpreter.

`--parser-info` reports the exact backend, which matters when comparing output across machines:

```text
Parser backend: nikic/php-parser@5.8.0
PHP version: 8.4.14
Generator version: 2.0.0
Supported target versions: 8.0, 8.1, 8.2, 8.3, 8.4, 8.5 (default)
Token emulation: enabled (parse target grammars up to 8.5 without a matching PHP runtime)
```

## Grammar pinning and token emulation

PHP grammars change every minor version. The vendored parser accepts target grammars 8.0 through 8.5, defaults to the newest, and uses token emulation to parse a newer grammar on an older runtime: an 8.4 runtime can parse 8.5 syntax because the parser rewrites the new tokens itself. You rarely need the runtime to match the code you are parsing.

Pin a grammar with `--target-version 8.1` (alias `--parser-target`) when reproducibility matters more than coverage; a version outside the supported set is rejected before any file is read, with a non-zero exit and no AST emitted.

## Discovery

Discovery recognizes the extensions `php`, `phtml`, `php3`, `php4`, `php5`, `phps`, and `inc`. Files with no recognized extension are sniffed: if the first 512 bytes contain `<?php` or `<?=`, the file is treated as PHP. This catches things like legacy `.lib` and template files that PHP projects accumulate.

The directories `.git`, `.svn`, `.hg`, `vendor`, `node_modules`, `.idea`, and `.vscode` are skipped wholesale, matched as exact path components and never followed through symlinks. On top of that, the `--exclude` regex (default `^(tests?|vendor|Tests?)`) drops matching relative paths.

## Batch output

Each parsed file becomes `<output>/<relative-path>.json` with the shape:

```json
{
  "ast": [ { "nodeType": "Stmt_Namespace", "attributes": {...}, ... } ],
  "rel_file_path": "src/app.php",
  "encoding_scrubbed": true,
  "truncated_nodes": 2
}
```

The tree is the nikic node shape: every node carries `nodeType`, positions live in `attributes` (startLine, endLine, file offsets, token positions). Two optional keys record survival behavior: `encoding_scrubbed` when undecodable bytes had to be scrubbed instead of dropping the file, and `truncated_nodes` when the tree exceeded `--max-depth` and was cut, with the boundary node carrying the marker key `__phpastgen_truncated__`. Truncation and scrubbing are how the generator keeps a pathological file from poisoning the run.

Each node can also carry a `framework_facts` key. It is strictly additive: when a node represents a read of a PHP superglobal (`$_GET`, `$_POST`, `$_REQUEST`, `$_COOKIE`, `$_FILES`, `$_SERVER`, `$_SESSION`, `$_ENV`, `GLOBALS`), the fact records which one it is and whether it carries externally controlled request data, so taint consumers do not have to re-derive that from names. Attributes declared on a node (`#[Route(...)]` and friends) are collected into the fact as well.

## Run records

Every batch run writes two side-records into the output directory, both ending in `.jsonl` so a consumer globbing `*.json` never mistakes them for ASTs.

`phpastgen_manifest.jsonl` is a single line describing the run: input and output paths, PHP version, parser backend, generator version, target grammar, and the counts of files parsed, failed, skipped as non-PHP, excluded, and truncated, plus the thread count and depth cap in effect. Reconciling these counts against expectations is the first debugging step for any surprising run.

`phpastgen_diagnostics.jsonl` holds one object per failed file with the message, line, and column. It is written only when something failed, and a later clean run removes it, so a diagnostics file on disk always describes the latest run.

## Concurrency and failure behavior

Directory runs spawn up to `--threads` concurrent `php-parse` subprocesses (default 10, clamped to 1 through 64). Values outside the range warn and fall back to the default rather than failing.

A file that fails to parse is reported, counted in the manifest, and skipped. The run completes and exits zero. Pass `--fail-on-error` to make the exit status reflect per-file failures in CI contexts.

## Legacy passthrough

Without `-i`, every argument is forwarded to the vendored `php-parse` as-is, which preserves the pre-upgrade single-file interface:

```shell
phpastgen --json-dump path/to/file.php
phpastgen --with-recovery --pretty-print old/broken.php
```

The passthrough prepends the vendored binary and runs it with `php`, with `ATOM_CWD` honored as the working directory. Use it for one-off inspection; use batch mode for anything a consumer will read.

## Environment variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PHP_PARSER_BIN` | vendored `php-parse` | Path to the php-parse binary to invoke. |
| `PHP_CMD` | `php` | PHP interpreter to invoke. |
| `ATOM_CWD` | `process.cwd()` | Working directory for the parser process. |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout) | Milliseconds before a parser subprocess is killed. `ATOM_TIMEOUT` wins; non-numeric values are ignored. |
