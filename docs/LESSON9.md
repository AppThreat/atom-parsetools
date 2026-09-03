# Lesson 9: Consuming AST output programmatically

## Learning Objective

Write a small consumer that walks an output directory, joins ASTs to type maps, skips side-records correctly, and computes something a security tool would actually want: which functions read request input.

## Pre-requisites

[Lesson 1](LESSON1.md) and [Lesson 4](LESSON4.md) output directories on disk (or regenerate them). Any language for the consumer; this lesson uses Python because it reads JSON tersely.

## The contract you are consuming

Three rules hold across every tool, and a consumer that respects them survives format additions:

One `.json` file per source file, at `<output>/<relative-path>.json`, with provenance alongside the tree. Side-records end in `.jsonl`, so a `*.json` glob never sees them. Type maps are `<relative-path>.typemap`, keyed by node `start` offset.

Globbing the directory, not walking with assumptions, is the whole trick:

```python
import json
from pathlib import Path

def load_asts(out_dir):
    for path in sorted(Path(out_dir).rglob("*.json")):
        yield path, json.loads(path.read_text())
```

`rglob("*.json")` cannot pick up `phpastgen_manifest.jsonl` or a diagnostics file no matter how many runs wrote them, which is the point of the naming rule.

## Joining ASTs to type maps

For astgen output, the join is an offset lookup. Here is a consumer that lists every function-like declaration and its type, then flags the ones taking parameters:

```python
import json
from pathlib import Path

def node_iter(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from node_iter(value)
    elif isinstance(node, list):
        for item in node:
            yield from node_iter(item)

out = Path("ast_out")
for ast_path in sorted(out.rglob("*.json")):
    typemap_path = ast_path.with_suffix(".typemap")
    types = json.loads(typemap_path.read_text()) if typemap_path.exists() else {}
    doc = json.loads(ast_path.read_text())
    for node in node_iter(doc["ast"]):
        if node.get("type") in ("FunctionDeclaration", "ArrowFunctionExpression"):
            sig = types.get(node.get("start"), "?")
            name = (node.get("id") or {}).get("name", "<anonymous>")
            print(f'{doc["relativeName"]}: {name}: {sig}')
```

Note the graceful `.typemap` handling: files that produced no interesting types get no map, and type generation can be off entirely (`--no-tsTypes`), so absence must not be an error.

## A taint seed from PHP output

The `framework_facts` key exists so consumers do not re-derive request inputs from names. Finding every function that reads a request superglobal is a short walk:

```python
import json
from pathlib import Path

def walk(node, fn):
    if isinstance(node, dict):
        fn(node)
        for value in node.values():
            walk(value, fn)
    elif isinstance(node, list):
        for item in node:
            walk(item, fn)

def seeds(out_dir):
    for path in sorted(Path(out_dir).rglob("*.json")):
        doc = json.loads(path.read_text())
        hits = []
        def visit(node):
            facts = node.get("framework_facts")
            if facts:
                hits.append(node)
        walk(doc.get("ast"), visit)
        if hits:
            yield doc["rel_file_path"], len(hits)

for rel, count in seeds("php-ast"):
    print(f"{rel}: {count} framework fact node(s)")
```

Open one hit and you will find the fact naming the superglobal and whether it is request-borne (`$_GET` yes, `$_SERVER` ambient), which is exactly the distinction a taint rule needs and exactly what a name-based heuristic gets wrong.

## Trusting the manifest, not the log

The manifest is machine-readable truth about a run. A consumer that caches parse output should fingerprint its cache on it:

```python
import json, hashlib
from pathlib import Path

def run_fingerprint(out_dir):
    for name in ("phpastgen_manifest.jsonl", "ruby_ast_gen_manifest.jsonl"):
        p = Path(out_dir) / name
        if p.exists():
            record = json.loads(p.read_text())
            keys = ("parser_backend", "generator_version", "php_version", "ruby_version", "target_version")
            identity = {k: record[k] for k in keys if k in record}
            return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return None
```

Two runs with the same fingerprint were produced by the same backend and versions; two runs with different fingerprints may legitimately differ, and you reparse instead of diffing. This mirrors what chen does with `astgen --version` for its parse cache.

## Where to go next

[Lesson 10](LESSON10.md) closes the loop: building the package with its vendored plugins and verifying the artifact a consumer actually installs.
