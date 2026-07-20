# Introduction

This package hosts a collection of parsing tools that complement the `@appthreat/atom` project. These tools offer parsing and analysis-related functionalities such as generating AST and semantics information in JSON format. The full list of tools and bin commands exposed by this package is below:

- astgen - Generates AST for JavaScript and TypeScript projects in JSON format
- phpastgen - Generates AST for PHP projects using `php-parse` command from `nikic/php-parser`
- rbastgen - Generates AST for Ruby projects using the AppThreat's `ruby_ast_gen` gem
- scalasem - Generates a custom semantics slice for Scala Projects by utilising scalac command.

## Runtime support

These tools run on both [Node.js](https://nodejs.org) (>= 16) and [Bun](https://bun.sh). All commands and the accompanying regression test-suite are exercised under both runtimes in CI, so the commands below can be invoked with either `node` or `bun` interchangeably (for example `bun astgen.js -i .`).

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

| Variable                    | Default   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASTGEN_TYPE_WORKERS`       | `1` (off) | Number of worker threads for the TypeScript type-generation phase, or `auto` to derive it from the available CPUs. The TypeScript checker is single-threaded, so parallelism comes from sharding files across workers, each building its own program. **Opt-in:** sharding changes TypeScript's internal type-id ordering, which reorders the members of a small number of inferred union types (e.g. `A \| B` → `B \| A`; semantically identical). Leave unset for byte-identical output; set it (e.g. `auto` or `8`) to trade that cosmetic reordering for a large speedup on big projects. |
| `ASTGEN_INCLUDE_TEST_FILES` | `false`   | When `true`, do not exclude test files (`*.poku.js`, `*.test.*`, `*.spec.*`, `*.e2e.*`, `__tests__/`, `__mocks__/`) from AST and type generation. They are excluded by default because they are typically the heaviest, lowest-value inputs for type generation.                                                                                                                                                                                                                                                                                                                              |
| `ASTGEN_CONCURRENCY`        | `10`      | Chunk size for the in-thread file loop (bounds peak memory between `gc()` passes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

```text
node rbastgen.js --help
Usage:
  -i, --input      The input file or directory (required)
  -o, --output     The output directory (default: '.ast')
  -e, --exclude    The exclusion regex (default: '^(tests?|vendor|spec)')
  -d, --debug      Enable debug logging
      --version    Print the version
      --help       Print usage
```

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
