# Lesson 1: Your first JavaScript AST

## Learning Objective

Run `astgen` over a small project, then read the two files it produces per source file, so that every later artifact (type maps, consumer joins, cache fingerprints) has a concrete shape in your head.

## Pre-requisites

```text
Node.js >= 22 (or Bun)
atom-parsetools installed: npm install -g @appthreat/atom-parsetools
```

## Getting started

Create a two-file project with one deliberate oddity, because astgen is built for messy code and the lesson should show that:

```shell
mkdir hello-ast && cd hello-ast
npm init -y > /dev/null

cat > math.js << 'EOF'
export function add(a, b) {
  return a + b;
}

const PI = 3.14159;
export { PI };
EOF

cat > broken.js << 'EOF'
// redeclared on purpose: the parser recovers and records the error
const greeting = "hello";
const greeting = "world";
console.log(greeting);
EOF
```

Parse it:

```shell
astgen -i .
```

The output lands in `./ast_out` (the default is `ast_out` under the source directory):

```text
ast_out/
  math.js.json
  math.js.typemap
  broken.js.json
  broken.js.typemap
```

## Reading the AST file

`math.js.json` is one JSON object:

```shell
python3 -m json.tool ast_out/math.js.json | head -30
```

Three keys. `fullName` is the absolute path, `relativeName` the path under the source root, and `ast` is the standard Babel tree: a `File` node wrapping a `Program`, with `start`, `end`, and `loc` positions on every node. Positions are the currency of this whole package; remember that `start` offsets exist, because Lesson 2 joins on them.

Now the interesting file. Inspect `broken.js.json` and search for `errors`:

```shell
python3 -c "import json; d=json.load(open('ast_out/broken.js.json')); print(json.dumps(d['ast']['errors'], indent=2))"
```

You will see a `BABEL_PARSER_SYNTAX_ERROR` with reason code `VarRedeclaration` and a location, and yet the tree is complete: astgen parses with error recovery everywhere, so broken code yields a tree plus a record of what went wrong, which is precisely what an analysis frontend wants from real repositories. A file is only skipped when every configuration in the fallback chain (Babel standard, non-JSX TypeScript, Flow, safe modes, hermes) fails.

## What you did not configure

You ran no parser selection and no project type. astgen auto-detected the JavaScript project from `package.json`, chose the Babel-with-TypeScript-and-JSX configuration first, and only would have fallen back had the parse failed. When a repository is Flow-typed, `-t flow` flips the order so hermes-parser and Babel Flow run first.

## Where to go next

[Lesson 2](LESSON2.md) explains the `.typemap` files sitting next to your ASTs, and [Output Formats](OUTPUT_FORMATS.md) specifies every key you just saw.
