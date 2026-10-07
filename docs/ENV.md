# Environment Variables

Every knob these tools expose beyond the command line, in one table per tool. Three conventions hold across all of them: `ATOM_TIMEOUT` beats `ASTGEN_TIMEOUT` when both are set (a non-numeric value is ignored, meaning no timeout), `ATOM_CWD` overrides the working directory used for spawned processes, which is what relative paths resolve against, and `ATOM_PARENT_PID` (set for you by atom's npm wrapper and by cdxgen) names a supervising process: a tool stops, together with the processes it started, once that process or the tool's own parent has exited.

## astgen

| Variable                              | Default   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ASTGEN_TYPE_WORKERS`                 | `1` (off) | Worker threads for the TypeScript type-generation phase, or `auto` to derive from available CPUs. Opt-in: sharding changes TypeScript's internal type-id ordering, which reorders the members of a small number of inferred union types (for example `A \| B` to `B \| A`; semantically identical). Leave unset for byte-identical output; set it to trade that cosmetic reordering for a large speedup on big projects. |
| `ASTGEN_INCLUDE_TEST_FILES`           | `false`   | When `true`, include test files (`*.poku.js`, `*.test.*`, `*.spec.*`, `*.e2e.*`, `__tests__/`, `__mocks__/`) in AST and type generation.                                                                                                                                                                                                                                                                                 |
| `ASTGEN_CONCURRENCY`                  | `10`      | Chunk size for the in-thread file loop; bounds peak memory between `gc()` passes.                                                                                                                                                                                                                                                                                                                                        |
| `ASTGEN_INCLUDE_NODE_MODULES_BUNDLES` | `false`   | When `true`, also parse bundled entrypoints inside `node_modules` (files matching `*.(bundle\|dist\|index\|min\|app).(js\|cjs\|mjs)`).                                                                                                                                                                                                                                                                                   |
| `ASTGEN_IGNORE_DIRS`                  | unset     | Directories to ignore. Side effect: when set to a non-empty list that does not contain `node_modules`, the bundle entrypoints above are included.                                                                                                                                                                                                                                                                        |
| `ASTGEN_TIMEOUT`                      | unset     | Shared kill timeout in milliseconds (see convention above).                                                                                                                                                                                                                                                                                                                                                              |

## phpastgen

| Variable                          | Default                          | Purpose                                                                                        |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `PHP_PARSER_BIN`                  | vendored `plugins/bin/php-parse` | The php-parse binary to invoke. Point it at a checkout to test an unreleased nikic/php-parser. |
| `PHP_CMD`                         | `php`                            | PHP interpreter to invoke.                                                                     |
| `ATOM_CWD`                        | `process.cwd()`                  | Working directory for the parser process.                                                      |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout)               | Milliseconds before a parser subprocess is killed.                                             |

## rbastgen

| Variable                          | Default                 | Purpose                                                                                                                         |
| --------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ATOM_RUBY_HOME`                  | unset                   | Ruby install directory when a suitable `ruby` is not on the `PATH`; its `bin` is prepended to `PATH` for the child process.     |
| `RUBY_CMD`                        | `ruby`                  | Ruby interpreter to invoke. Set this or `ATOM_RUBY_HOME` when the detected version is not 3.4.x or 4.0.x.                       |
| `RUBY_ASTGEN_BIN`                 | vendored `ruby_ast_gen` | The generator script to run. Point it at a checkout's `exe/ruby_ast_gen` to test unreleased code.                               |
| `ATOM_CWD`                        | `process.cwd()`         | Working directory for the generator; relative `-i` and `-o` resolve against it.                                                 |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout)      | Milliseconds before the generator process is killed.                                                                            |
| `GEM_PATH`                        | unset                   | Preserved and appended to the vendored bundle, so gems installed on the machine (a newer `prism`, for instance) stay reachable. |

## scalasem

| Variable                          | Default             | Purpose                                                                                                                               |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `SCALA_VERSION`                   | unset               | Analyse this Scala version instead of the build default.                                                                              |
| `SBT_CMD`                         | `sbt`               | sbt executable.                                                                                                                       |
| `MILL_CMD`                        | `mill`              | mill executable when the project has no wrapper.                                                                                      |
| `MVN_CMD`                         | `mvn`               | maven executable.                                                                                                                     |
| `SBT_COMPILE_COMMAND`             | `compile`           | Compile command when the build tool is sbt.                                                                                           |
| `MILL_COMPILE_COMMAND`            | `__.compile`        | Compile command when a `build.mill` selects mill.                                                                                     |
| `SCALASEM_NO_BUILD`               | unset               | Same as `--no-build`: never start a build tool.                                                                                       |
| `SCALASEM_NO_COMPILE`             | unset               | Same as `--no-compile`: inventory only, no compilation.                                                                               |
| `SCALASEM_NO_INSTALL`             | unset               | Never download a missing compiler, tasty inspector or SemanticDB plugin.                                                              |
| `SCALASEM_INCLUDE_TESTS`          | unset               | Same as `--include-tests`.                                                                                                            |
| `SCALASEM_SEMANTICDB`             | `auto`              | Same as `--semanticdb`.                                                                                                               |
| `SCALASEM_COMPILER`               | unset               | `none` reads SemanticDB for every module instead of TASTy, and produces it when the build may compile.                                |
| `SCALASEM_CACHE_DIR`              | `~/.cache/scalasem` | Where the compiled helper and the SemanticDB targets are kept.                                                                        |
| `SCALASEM_TIMEOUT`                | unset               | Milliseconds the whole run may take, builds included. When the time is up, scalasem stops them, then itself, and writes no report.    |
| `SCALASEM_MAX_*`                  | see the guide       | Writer caps, for example `SCALASEM_MAX_CALLS_PER_FILE`.                                                                               |
| `JAVA_HOME`                       | unset               | The JVM the helper runs with.                                                                                                         |
| `ATOM_CWD`                        | `process.cwd()`     | Working directory for the build tool invocations.                                                                                     |
| `ATOM_TIMEOUT` / `ASTGEN_TIMEOUT` | unset (no timeout)  | Milliseconds before a subprocess is killed.                                                                                           |
