# Lesson 4: Your first PHP batch run

## Learning Objective

Run `phpastgen` in batch mode over a PHP project, read the manifest, and understand the two failure behaviors (scrubbing and truncation) that keep a run alive when files misbehave.

## Pre-requisites

```text
PHP on the PATH (any 8.x runtime works for any target grammar)
atom-parsetools installed
```

No Composer, no nikic/php-parser install: the parser is vendored inside the package. Start by asking the machine what it will use:

```shell
phpastgen --parser-info
```

```text
Parser backend: nikic/php-parser@5.8.0
PHP version: 8.5.8
Generator version: 2.0.0
Supported target versions: 8.0, 8.1, 8.2, 8.3, 8.4, 8.5 (default)
Token emulation: enabled (parse target grammars up to 8.5 without a matching PHP runtime)
```

That last line is worth internalizing: the runtime does not need to match the code you parse, because the vendored parser emulates newer tokens itself.

## Getting started

Clone a real PHP project and batch-parse it:

```shell
git clone --depth 1 https://github.com/slimphp/Slim
cd Slim

phpastgen -i . -o php-ast
```

Ten `php-parse` worker processes run concurrently by default. Each PHP file becomes `php-ast/<relative-path>.json`, and the run writes its records:

```shell
cat php-ast/phpastgen_manifest.jsonl | python3 -m json.tool
```

```json
{
  "input": ".",
  "output": "php-ast",
  "php_version": "8.5.8",
  "parser_backend": "nikic/php-parser@5.8.0",
  "generator_version": "2.0.0",
  "target_version": null,
  "files_parsed": 148,
  "files_failed": 0,
  "files_skipped_nonphp": 0,
  "files_excluded": 62,
  "truncated_files": 0,
  "threads": 10,
  "max_depth": 250
}
```

Reconcile those numbers before anything else: `files_excluded` is the default regex `^(tests?|vendor|Tests?)` at work, `files_skipped_nonphp` counts files without a PHP open tag, and `truncated_files` counts trees cut at the depth cap.

## Reading a tree

```shell
python3 -c "
import json
d = json.load(open('php-ast/Slim/App.php.json'))
print(d['rel_file_path'], d['ast'][0]['nodeType'])
"
```

The tree is the nikic shape: `nodeType` on every node, positions under `attributes` (`startLine`, `endLine`, file and token offsets). Optional keys appear only when relevant: `encoding_scrubbed` when undecodable bytes were scrubbed, `truncated_nodes` when the depth cap cut the tree. Nodes may also carry a `framework_facts` key; grep for one:

```shell
grep -rl "framework_facts" php-ast --include="*.json" | head -3
```

On a web project you will find reads of `$_GET`, `$_POST`, and friends tagged as facts, including whether the superglobal carries externally controlled request data, which is the raw material a taint consumer needs.

## Meet the diagnostics record

Make a file fail on purpose and observe that the run survives:

```shell
mkdir -p broken && printf '<?php function ( { %%^\n' > broken/mangled.php
phpastgen -i . -o php-ast
cat php-ast/phpastgen_diagnostics.jsonl
```

The manifest now shows `files_failed: 1`, the diagnostics line carries the message, line, and column, and the exit code is still 0. Delete the broken file and rerun: the diagnostics file is gone, because a clean run removes it. A diagnostics file on disk therefore always describes the latest run, never history.

For a CI job where failures must fail the build:

```shell
phpastgen -i . -o php-ast --fail-on-error; echo "exit: $?"
```

## Where to go next

[Lesson 5](LESSON5.md) pins a grammar for reproducible output and exercises the legacy single-file mode.
