# Output Formats

Every tool writes standalone files that a consumer can stream, glob, or load lazily. This page specifies the shapes, and the naming rule that holds the whole contract together.

## The naming rule

ASTs are `.json`. Everything that is not an AST, manifests and diagnostics, ends in `.jsonl`. A consumer that globs `*.json` under an output directory therefore gets trees and nothing else. This rule is load-bearing: downstream frontends like chen read every `*.json` under the output directory as an AST, so a side-record named `.json` would be misparsed as a tree.

## astgen

One file per source file, at `<output>/<relative-path>.json`:

```json
{
  "fullName": "/abs/path/project/src/index.js",
  "relativeName": "src/index.js",
  "ast": {
    "type": "File",
    "start": 0,
    "end": 6668,
    "loc": {},
    "errors": [],
    "program": {}
  }
}
```

The `ast` value is the standard Babel AST shape (`type`, `start`, `end`, `loc`, and typed children), including an `errors` array when the file parsed with recovered errors. BigInt literals serialize as strings, matching the Babel 7 shape.

With type generation on (the default), each file also gets `<relative-path>.typemap`, a flat JSON object mapping node start offsets to the checker's type string:

```json
{ "61": "(a: any, b: any) => any", "92": "number", "259": "3.14159" }
```

The key is the same `start` offset the AST node carries, so joining a node to its type is a lookup, not a search.

## phpastgen

Batch mode writes one file per parsed PHP file at `<output>/<relative-path>.json`:

```json
{
  "ast": [
    {
      "nodeType": "Stmt_Namespace",
      "attributes": { "startLine": 3, "startFilePos": 7 },
      "name": {},
      "stmts": []
    }
  ],
  "rel_file_path": "src/app.php",
  "encoding_scrubbed": true,
  "truncated_nodes": 0
}
```

The tree is the nikic/php-parser node shape: each node carries `nodeType`, positions in `attributes`, and typed child properties. Nodes may carry an additive `framework_facts` key (superglobal reads, declared attributes) and, at a depth boundary, the `__phpastgen_truncated__` marker. `encoding_scrubbed` and `truncated_nodes` are optional, present only when relevant.

The run records, both JSONL:

```text
phpastgen_manifest.jsonl    one line: input, output, php_version, parser_backend,
                            generator_version, generated_at, target_version,
                            files_parsed, files_failed, files_skipped_nonphp,
                            files_excluded, truncated_files, threads, max_depth

phpastgen_diagnostics.jsonl one line per failed file: file_path, rel_file_path,
                            parse_error { message, line, column, reason }
                            written only on failure, removed on a clean run
```

## rbastgen

One file per Ruby source (or DSL file matched by basename), at `<output>/<relative-path>.json`. The shape mirrors phpastgen's with Ruby-specific provenance and semantics:

```json
{
  "ast": {},
  "parser_backend": "prism",
  "generator_version": "2.0.1",
  "ruby_version": "3.4.2",
  "magic_comments": ["frozen_string_literal: true"],
  "encoding_scrubbed": false,
  "truncated_nodes": 0
}
```

Calls carry `call_operator` and `has_parentheses`; percent arrays and regexps carry `options`; heredocs carry body offsets; a `def` after a Sorbet `sig` carries `has_sig: true`; deep nodes hit `truncated: true` at the `--max-depth` boundary. The run records are `ruby_ast_gen_manifest.jsonl` and `ruby_ast_gen_diagnostics.jsonl`, same semantics as the PHP ones.

## scalasem

A single JSON document, keyed by source file with a reserved `config` entry:

```json
{
  "config": { "routes": [] },
  "app/User.scala": {
    "sourceFile": "app/User.scala",
    "tags": ["framework"],
    "usedTypes": ["play.api.mvc.Request"],
    "literals": ["id", "name"]
  }
}
```

See [scalasem](SCALASEM.md) for how tags and routes are derived.

## Version and provenance fields

Treat these as part of the format, not decoration. `astgen --version` is the AST format version that downstream parse caches fingerprint; the phpastgen and rbastgen manifests and per-file records pin the parser backend that produced them. If you diff output across machines, compare provenance first: most differences that are not bugs are a grammar or backend difference, visible in these fields.
