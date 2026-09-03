# Lesson 2: TypeScript type maps

## Learning Objective

Understand what the `.typemap` files contain, how types join back to AST nodes, and when to turn on worker sharding, which is the one setting that can change your output.

## Pre-requisites

[Lesson 1](LESSON1.md) completed, or any project parsed with `astgen` using default options (type generation is on unless you pass `--no-tsTypes`).

## Getting started

Make a small TypeScript project with genuinely inferable types:

```shell
mkdir hello-types && cd hello-types
npm init -y > /dev/null

cat > shapes.ts << 'EOF'
interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function makePoint(x: number, y: number) {
  return { x, y };
}
EOF

astgen -i .
```

Inspect the type map:

```shell
python3 -m json.tool ast_out/shapes.ts.typemap
```

You will see a flat object mapping numbers to type strings:

```json
{
  "83": "(a: Point, b: Point) => number",
  "121": "Point",
  "169": "(x: number, y: number) => { x: number; y: number; }"
}
```

## Joining types to nodes

The keys are node `start` offsets: the same numbers the AST nodes carry. The type of any node is therefore a lookup, not a search:

```shell
python3 - << 'EOF'
import json
doc = json.load(open("ast_out/shapes.ts.json"))
types = json.load(open("ast_out/shapes.ts.typemap"))

def walk(node):
    if isinstance(node, dict):
        start = node.get("start")
        if start in types and node.get("type") in ("Identifier", "CallExpression", "BinaryExpression"):
            print(f'{node["type"]} at {start}: {types[start]}')
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for item in node:
            walk(item)

walk(doc["ast"])
EOF
```

Every match prints the checker's inferred or declared type for that exact node. That join, offsets to types, is the whole point of the format: a consumer gets checker-quality types without running a checker.

## How the types are produced

Type generation builds a real TypeScript program over your project, not a per-file approximation. If a `tsconfig.json` or `jsconfig.json` exists at or above the source root, it shapes the program, and its root file names expand the parse set, so files reachable only through the config are parsed too. In `shapes.ts`, the return type of `makePoint` was inferred structurally, `{ x: number; y: number; }`, which no regex or per-file parse would produce.

The engine is `@typescript/typescript6`, the TS 6 compiler. TypeScript 7 (the Go port) currently lacks the programmatic API this requires, which is why the dependency looks one major behind: it is the officially supported bridge, and it keeps AST shapes and inference identical to TS 6.

## Workers and the one caveat

The checker is single-threaded, so on large projects astgen can shard files across worker threads: `ASTGEN_TYPE_WORKERS=auto astgen -i .`. Each worker builds its own program over the full project set, so cross-file resolution is unchanged, with one documented cosmetic difference: sharding changes TypeScript's internal type-id ordering, so a few inferred union types print members in a different order (`A | B` as `B | A`). Semantically identical, textually different.

Verify it on this project:

```shell
ASTGEN_TYPE_WORKERS=auto astgen -i . -o ast_out_parallel
diff ast_out/shapes.ts.typemap ast_out_parallel/shapes.ts.typemap && echo identical
```

Small projects usually come out byte-identical because the reorderings need enough type aliases to matter. The rule to carry away: leave the variable unset when output is diffed, cached, or fingerprinted; set it when a one-off large scan is too slow.

## Where to go next

[Lesson 3](LESSON3.md) scales this to monorepos, where type generation gets interesting for a different reason: input volume.
