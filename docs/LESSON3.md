# Lesson 3: Monorepos, tests, and node_modules

## Learning Objective

Learn what astgen includes and excludes by default on a large repository, and how each exclusion is reversed, so a "missing files" surprise never costs you an afternoon.

## Pre-requisites

```text
Node.js >= 22
atom-parsetools installed
any large JavaScript or TypeScript monorepo
```

The examples use a checkout of [express](https://github.com/expressjs/express), which is small enough to finish quickly and still shows every default in action. Any repository with tests and dependencies works.

## Getting started

```shell
git clone --depth 1 https://github.com/expressjs/express
cd express
npm install

astgen -i .
```

Count what you got:

```shell
find ast_out -name "*.json" | wc -l
find ast_out -name "*.json" | grep -c "test"
find ast_out -path "*node_modules*" | wc -l
```

The second and third numbers are zero, and that is the lesson. Discovery walked every package directory recursively, but two categories were dropped on purpose.

## The two default exclusions

Test files are excluded because they are the heaviest, lowest-value input for type generation: each is often a full twin of a source module wrapped in scaffolding. The pattern covers `*.poku.js`, `*.test.*`, `*.spec.*`, `*.e2e.*`, `*.integration.*`, `*.it.*`, and the `__tests__/` and `__mocks__/` directories.

`node_modules` is skipped entirely, which on an installed repository is the difference between hundreds of files and hundreds of thousands.

## Reversing each exclusion

Restore test files when a downstream consumer wants them analyzed:

```shell
ASTGEN_INCLUDE_TEST_FILES=true astgen -i . -o ast_out_with_tests
find ast_out_with_tests -name "*.json" | grep -c test
```

Opt into dependency bundles, meaning entrypoints matching `*.(bundle|dist|index|min|app).(js|cjs|mjs)` inside `node_modules`, when you care about shipped code rather than source:

```shell
ASTGEN_INCLUDE_NODE_MODULES_BUNDLES=true astgen -i . -o ast_out_bundles
find ast_out_bundles -path "*node_modules*" -name "*.json" | head
```

Note the subtlety with `ASTGEN_IGNORE_DIRS`: setting it to a non-empty list that does not contain `node_modules` also enables the bundles, on the reasoning that a custom ignore list implies you already thought about what to skip. If you set `ASTGEN_IGNORE_DIRS=dist,coverage` and are surprised by dependency files, that is why.

## Recursion and project detection

`-r/--recurse` (default true) is what makes one invocation cover a monorepo: every `package.json`-bearing subtree is traversed, not just the root. Detection itself needs a `package.json` or `rush.json` at the source root; with neither, astgen reports `unknown project type`. A Yarn or pnpm workspace, or a rush monorepo, needs no special flags, only the root manifest that detection reads.

## A tuning pass for very large repositories

Two settings matter when a monorepo parse starts to hurt. `ASTGEN_TYPE_WORKERS=auto` shards type generation across CPU cores (recall from [Lesson 2](LESSON2.md) that sharded output can reorder a few union types, so keep it off when output is fingerprinted). `ASTGEN_CONCURRENCY` (default 10) bounds how many files the in-thread loop holds between garbage collections; if a container run dies on memory, lower it before anything else.

```shell
ASTGEN_TYPE_WORKERS=auto astgen -i . -o ast_out_fast
```

## Where to go next

The JavaScript stack runs in-process; the batch tools shell out to worker pools instead. [Lesson 4](LESSON4.md) shows the PHP side of that trade.
