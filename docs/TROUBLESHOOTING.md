# Troubleshooting

Most failures fall into three groups: a runtime was not found, the output surprised you, or the package itself is incomplete. Work down this page in order; the checks are cheap and the expensive mistakes usually fall out early.

## A tool reports the language is missing

`phpastgen` prints `PHP is not installed!`, `rbastgen` prints `Ruby is not installed!`, `scalasem` prints `Scala is not installed!`. For Ruby, the supported versions are 3.4.x and 4.0.x; either put such a `ruby` on the `PATH` or point `ATOM_RUBY_HOME` at the install directory. `RUBY_CMD` selects a different interpreter by name. For PHP, ensure `php` is on the `PATH` or set `PHP_CMD`. For Scala, both `scala` and `scalac` are needed (plus sbt or mill when compilation must run).

Note that `phpastgen --version` and `--parser-info` answer without a PHP runtime (the capability report prints `PHP is not installed` and exits non-zero), which is useful in capability probes.

## The output has fewer files than expected

Count first, then explain. Both batch tools write a manifest with `files_parsed`, `files_failed`, `files_skipped_nonphp`, `files_excluded`, and `truncated_files`; reconcile those against what you expected. The usual explanations, by tool:

| Symptom                                                                  | Usual cause                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| astgen: no test files parsed                                             | test files are excluded by default; `ASTGEN_INCLUDE_TEST_FILES=true`                                                      |
| astgen: `node_modules` bundles missing                                   | bundles are opt-in; `ASTGEN_INCLUDE_NODE_MODULES_BUNDLES=true`                                                            |
| phpastgen: `vendor/` or `tests/` absent                                  | the default `--exclude` regex; pass `-e NOMATCH` to disable                                                               |
| rbastgen: `Gemfile`, `Rakefile` missing from a _different_ tool's output | basename-discovered DSL files are a rbastgen feature; check you ran rbastgen and that the manifest did not exclude them   |
| scalasem: entries missing                                                | `scalac -print-tasty` failed for that file; check `ATOM_MAX_BUFFER` against very large class files, and stderr in the log |

## A specific file produces no AST

Per-file failures are never fatal in batch mode. Look in the diagnostics side-record (`phpastgen_diagnostics.jsonl`, `ruby_astgen_diagnostics.jsonl`) for the message, line, and column. Remember the naming contract: diagnostics exist only for the latest run, and a clean run deletes the file, so a stale diagnostics file on disk means something failed in the run you just did.

Two file-level behaviors are sometimes mistaken for bugs. Non-UTF-8 sources are scrubbed and marked `encoding_scrubbed: true` rather than dropped. Trees deeper than `--max-depth` (default 250) are truncated with a `truncated_nodes` count rather than emitted whole or dropped.

## Output differs between machines

Compare provenance before debugging parsers. `rbastgen --parser-info` shows which `parser` and `prism` copies a machine loads; the Ruby grammar ceiling follows the runtime's prism (grammar 3.5 on Ruby 3.4 versus 4.1 on Ruby 4.0 at the time of writing), and a newer machine-installed prism raises it because `GEM_PATH` is preserved. Per-file JSON records `parser_backend`, `generator_version`, and `ruby_version` for exactly this comparison. On the PHP side, pin `--target-version` if you need byte-identical trees across PHP runtimes. On the astgen side, remember that `ASTGEN_TYPE_WORKERS` can reorder members of inferred union types; unset it when output is diffed or cached.

## The exit code lied to you

`rbastgen` does not propagate the generator's exit status: the wrapper exits 0 even when files failed, and `--fail-on-error` is only reported in the log. A CI job that must fail on Ruby parse errors should read `files_failed` from `ruby_ast_gen_manifest.jsonl` or invoke the gem directly. `phpastgen` honors `--fail-on-error` in its exit status.

## Parsing worked from the repo, fails from the installed package

That gap is what `ci/verify-packed-tarball.sh` exists for; run it. The usual root cause is a missing or pruned `plugins/` directory in the tarball (the Ruby bundle must be present and free of compiled extensions). If the message says `ruby_ast_gen was not found under ...`, reinstall the package or set `RUBY_ASTGEN_BIN` to a checkout's `exe/ruby_ast_gen`.

## astgen type workers fell back to inline processing

The message `Falling back to single-threaded type generation after worker failure` means a worker thread died (usually memory) and the run completed correctly but slower. Lower `ASTGEN_CONCURRENCY` to flatten the heap, or reduce parallelism and retry. The fallback is safe: writes are idempotent and the inline path produces the same output modulo the union-order caveat.
