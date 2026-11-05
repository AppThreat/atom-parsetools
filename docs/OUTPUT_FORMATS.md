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

For `.svelte` files the output stays within this shape: the template is expressed with stock Babel JSX nodes and synthesized nodes carry two additive keys - `svelteKind` (the Svelte construct a node was built from, e.g. `EachBlock`) and, where applicable, `svelteName` (the tag or snippet name). Consumers that do not know these keys ignore them; they exist so tooling can tell a mapped `{#each}` from a literal `.map()` call. Whole-file Svelte parse failures surface as `{ "svelteParse": true, "message": ... }` entries in `errors`.

For `.vue` files the record carries one more top-level key, `sfcCandidate`, naming the parse candidate that produced the AST:

```json
{
  "fullName": "/abs/path/project/src/Login.vue",
  "relativeName": "src/Login.vue",
  "sfcCandidate": "directive-full",
  "ast": { "...": "the Babel AST" }
}
```

Every candidate is the file masked to a same-length buffer, so every offset, line and column in the AST addresses the original file. The candidates, tried in order, are `directive-full` (directive values such as `v-html="x"` converted to expression containers), `full` (the whole file masked), `script-in-place` (the file with the template block's content masked to spaces, used when the template cannot be parsed; the template contributes nothing) and `template-only` (the file with the script blocks masked away; the script contributes nothing). A consumer that needs every script statement reads `sfcCandidate` and skips `template-only`; the positions need no adjustment for any candidate.

With type generation on (the default), each file also gets `<relative-path>.typemap`, a flat JSON object mapping node start offsets to the checker's type string:

```json
{ "61": "(a: any, b: any) => any", "92": "number", "259": "3.14159" }
```

The key is the same `start` offset the AST node carries, so joining a node to its type is a lookup, not a search.

That map holds one type per offset, and several nodes start at one offset: `svc`, `svc.load` and `svc.load(user)` share their entry, so the entry cannot say which of them it types. With `ASTGEN_TYPES=native` each file therefore also gets `<relative-path>.typespans`, a JSON object mapping `"start:end"` (the `start` and `end` the AST node carries) to the type of the node with exactly that extent:

```json
{ "680:686": "User", "680:691": "string", "680:714": "string" }
```

Nodes whose type is `any` or `unknown` are left out. A function or class declaration also has an entry for its extent without the leading `export` and `default` keywords, because Babel starts such a node after them. Single-file components (`.vue`, `.svelte`) get one too, keyed by offsets of the component. The `types` record in `astgen_manifest.jsonl` counts the type maps as `typemap_files` and the span files as `typespans_files`. TypeScript 6 (`ASTGEN_TYPES=ts6`) writes no `.typespans` file, and readers fall back to the `.typemap` alone.

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

A single JSON document. The reserved keys hold the metadata, the route table and
configuration values, the modules and the derived evidence; every other key is a source file.
The first four keys of a file entry are the version 1 keys, and the rest are the version 2
facts:

```json
{
  "_meta": { "schemaVersion": "scalasem/2", "generatedFrom": ["tasty"] },
  "config": { "routes": [], "values": [] },
  "modules": [],
  "crypto": [],
  "endpoints": [],
  "services": [],
  "entryPoints": [],
  "callGraph": { "edges": [] },
  "callStacks": [],
  "app/User.scala": {
    "sourceFile": "app/User.scala",
    "tags": ["framework"],
    "usedTypes": ["play.api.mvc.Request"],
    "literals": ["id", "name"],
    "module": "root",
    "platform": "jvm",
    "factsSource": "tasty",
    "scope": "main",
    "definitions": [],
    "calls": [
      {
        "line": 8,
        "column": 20,
        "caller": "controllers.User$.show",
        "owner": "play.api.mvc.Action$",
        "name": "apply"
      }
    ],
    "references": []
  }
}
```

The shape is defined by `lib/scalasem/scalasem-v2.schema.json`. See
[scalasem](SCALASEM.md) for how the facts, the evidence and the routes are derived.

## Version and provenance fields

Treat these as part of the format, not decoration. `astgen --version` is the AST format version that downstream parse caches fingerprint; the phpastgen and rbastgen manifests and per-file records pin the parser backend that produced them. If you diff output across machines, compare provenance first: most differences that are not bugs are a grammar or backend difference, visible in these fields.
