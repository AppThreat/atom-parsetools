# astgen: JavaScript and TypeScript

`astgen` turns a JavaScript or TypeScript source tree into one AST JSON file per source file, plus one type map per file produced by the TypeScript checker. It is the parsing half of atom's JavaScript frontend: fast, tolerant of broken code, and stable enough that its output can be cached and fingerprinted.

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
  -h, --help     Show help                                             [boolean]
```

## The parser stack

Three parsers sit behind one entry point, each covering what the others miss.

| Parser                    | Role                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `@babel/parser` 8         | Primary. Parses modern ECMAScript, TypeScript, and JSX with error recovery.                   |
| `hermes-parser`           | Flow. Used first when the project type is `flow`, and as the last resort for everything else. |
| `@typescript/typescript6` | Not a parser but the checker. Produces the type map when `--tsTypes` is on.                   |

The TypeScript dependency is the TS 6 engine, not TS 7. TypeScript 7 is the native Go port and currently ships without the programmatic compiler API that type maps need (`createProgram`, `getTypeChecker`, `forEachChild`, and friends), so `@typescript/typescript6` is the supported bridge until the API returns. AST shapes and type inference stay identical to TS 6 as a result.

Every parse runs with error recovery enabled, so a file with syntax problems still yields a tree, with the problems recorded in the `errors` array of the output. A failed parse is logged and skipped, never fatal to the run.

## Project types and detection

Without `-t`, astgen looks for a `package.json` or `rush.json` in the source directory to recognize a JavaScript or TypeScript project. With `-t` you can be explicit, which also changes parsing strategy:

| `-t` value                                       | Behavior                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `nodejs`, `js`, `javascript`, `typescript`, `ts` | Standard path: Babel with TypeScript and JSX syntax first.       |
| `flow`                                           | Flow path: hermes-parser first, then Babel with the Flow plugin. |
| `vue`                                            | `.vue` files only.                                               |

When the type cannot be detected and no `package.json` or `rush.json` exists, the run reports `unknown project type` and exits.

## The fallback chain

Real repositories contain files that no single configuration parses: JSX in `.js`, Flow types in `.ts`, decade-old ES5, and everything in between. astgen tries configurations in order and keeps the first tree that parses:

```text
                 +---------------------------------------+
                 |  Babel standard (TS + ESNext + JSX)   |
                 +--------------------+------------------+
                                      |
             .ts/.mts/.cts/.js files  |  failed?
             +------------------------v-------------------+
             |  Non-JSX retry: TypeScript plugin without  |
             |  JSX, disallowAmbiguousJSXLike on          |
             +--------------------+-----------------------+
                                  |
                                  v  failed?
                 +---------------------------------------+
                 |  Babel with Flow plugin                |
                 +--------------------+------------------+
                                      |  failed?
                 +---------------------------------------+
                 |  Babel safe mode (sourceType: module)  |
                 +--------------------+------------------+
                                      |  failed?
                 +---------------------------------------+
                 |  Babel safe mode with Flow             |
                 +--------------------+------------------+
                                      |  failed?
                 +---------------------------------------+
                 |  hermes-parser (Flow, all)             |
                 +---------------------------------------+
```

When `-t flow` is given, the first two Flow-flavored attempts are promoted to the front of the chain. The order is not arbitrary: the standard configuration accepts the widest range of modern code, so it wins by default, and the niche configurations only engage on failure.

## File discovery

Discovery accepts `js`, `jsx`, `cjs`, `mjs`, `ts`, `tsx`, `mts`, `cts`, `vue`, `svelte`, `xsjs`, `xsjslib`, and `ejs`, recursively. Two categories are excluded by default.

Test files are skipped because they are typically the heaviest, lowest-value input for type generation: each is often a full twin of a source module wrapped in test scaffolding. The pattern covers `*.poku.js`, `*.test.*`, `*.spec.*`, `*.e2e.*`, `*.integration.*`, `*.it.*`, and the `__tests__/` and `__mocks__/` directories. Set `ASTGEN_INCLUDE_TEST_FILES=true` to restore them.

`node_modules` is skipped entirely. Set `ASTGEN_INCLUDE_NODE_MODULES_BUNDLES=true` to also parse bundled entrypoints inside it, meaning files matching `*.(bundle|dist|index|min|app).(js|cjs|mjs)`. Note the side effect of `ASTGEN_IGNORE_DIRS`: when it is set to a non-empty list that does not contain `node_modules`, those bundle entrypoints are included as well, on the reasoning that a custom ignore list implies you thought about the question.

## Vue

`.vue` files are single-file components where script, template, and style share one document. astgen parses them with a masking strategy that preserves positions: everything that is not script or template (comments, style blocks, stray tags) is replaced with spaces and newlines, so a token on line 40 of the component is still on line 40 of the parse input. Template expressions like `{{ item.name }}` are rewritten to `{ item.name }` and bindings are normalized before parsing.

Directive attributes carry a JavaScript expression in a quoted string - `v-html="rawContent"`, `:src="image.url"`, `@click="save"`. A quoted value parses as a StringLiteral, which would sever the data flow from the script binding into the template (the most security-relevant shape, `v-html`, would have no reference to the binding it renders). Before masking, every directive value inside the root `<template>` block that parses as an expression is therefore converted to a length-preserving JSX expression container: `v-html="rawContent"` becomes `v-html={rawContent}` - same length, so offsets still map onto the original file, and the emitted attribute value is a real expression AST. Only convertible values are rewritten: `v-for="item in items"` is not an expression and keeps its string value, and plain attributes (`title="About"`) are untouched. The conversion is scoped to the template block so a directive-looking string inside `<script>` can never be rewritten.

If the whole-document candidate does not parse, astgen builds progressively simpler candidates, in order: script content concatenated with the masked template, then the masked template alone, then the script content alone. The first candidate that yields a tree wins; the directive-converted variants are tried first, with these plain candidates retained as fallbacks.

Type generation over Vue files uses a virtual source: the component code is masked position-preserving, the script content is left intact, and a shim declaring the compiler macros (`defineProps`, `defineEmits`, `defineModel`, `withDefaults`, and a minimal `vue` module) is prepended so the checker sees declarations instead of errors.

## Svelte

`.svelte` files get first-class support built on `svelte/compiler` (the `svelte` npm dependency, pinned to an exact version so the AST shape cannot drift under us). The Svelte compiler is used purely as a *segmenter* - its modern-mode parse returns a tree whose every node carries an absolute byte range into the original file - and the emitted output is 100% stock Babel AST:

1. **Scripts.** A buffer the same length as the file, with everything outside the `<script>` bodies blanked to spaces (newlines preserved), is handed to Babel in one parse. Nothing moves, so the resulting statement offsets are already absolute. The instance and `module` scripts flatten into one `Program`.
2. **Template.** The template tree is re-emitted as standard Babel JSX nodes: elements (including `svelte:*` specials and components) become `JSXElement`, text becomes `JSXText`, and every `{...}` tag becomes a `JSXExpressionContainer`. `{#if}`/`{:else if}`/`{:else}` becomes a `ConditionalExpression` chain, `{#each xs as x, i (k)}` becomes `xs.map((x, i) => ...)`, `{#await p}` becomes `p.then(onFulfilled, onRejected)`, and `{#snippet name(params)}` becomes `name = (params) => ...`. Directives map onto Babel's native namespaced attribute form (`on:click={h}` is a `JSXAttribute` whose name is the `JSXNamespacedName` `on:click`), so a directive's `[start, end)` range slices to its exact source text. Mixed text/interpolation attribute values (`class="a {b} c"`) become a `JSXExpressionContainer` over the whole quoted value wrapping a `TemplateLiteral`, with empty zero-width quasis inserted where two interpolations are adjacent.
3. **Expressions.** Every template expression, binding pattern and `{@const}` initializer is re-parsed by Babel from its own source substring and shifted back into file coordinates. A failed sub-parse costs that one expression - it is replaced by the identifier `__astgen_unparsed` and recorded on `File.errors` - never the file.

Every synthesized node additionally carries `svelteKind` (the Svelte construct it came from, e.g. `EachBlock`) and, where applicable, `svelteName` (the tag or snippet name). These are additive keys; consumers ignore them.

If `svelte/compiler` rejects the whole file (a genuinely broken template), astgen falls back to parsing just the script blocks over a position-preserving masked buffer - every byte outside the `<script>` contents blanked to a space, newlines kept. Nothing moves, so the emitted statement offsets are still absolute byte positions into the original file and line numbers stay correct; the template is unrecoverable. The whole-file failure is recorded as `{ svelteParse: true, message }` on `File.errors`.

Type generation uses the same virtual-source strategy as Vue, with Svelte-specific shims: ambient declarations for the runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`, `$inspect`, `$host`) plus minimal `svelte` and `svelte/store` modules, so rune calls type-check instead of erroring. `.svelte.ts` rune modules are parsed as ordinary TypeScript.

Svelte 4 (legacy, non-runes) components are fully covered - the Svelte 5 parser handles `export let`, `$:` reactive statements, `on:` handlers and `let:` directives unchanged.

### Known, accepted losses

The mapping is deliberately lossy in places; these are documented trade-offs, not bugs:

| Loss | Consequence |
| --- | --- |
| `{@const}` becomes an assignment, not a declaration | the binding looks like an implicit global downstream |
| `{#each}` `{:else}` is a sibling fragment, not a conditional branch | fallback DOM is unconditionally reachable in the CPG |
| `{#await}` pending children are emitted as siblings | same |
| a `{#snippet}` name binding is an assignment whose source text starts with `{#snippet` | closure-naming passes that match on `const ` will not rename it |
| HTML comments are dropped | no comment nodes for them |
| `<style>` blocks are dropped | no CSS analysis |
| template expressions have no typemap entries | type recovery falls back to inference (same gap as Vue) |
| the two `<script>` blocks flatten into one `Program` | module-vs-instance scope distinction is lost |

## Type maps and worker sharding

With `--tsTypes` on (the default), astgen builds a TypeScript program over the project, resolves a checker, and for each file records the inferred type string of interesting nodes, keyed by node start offset:

```json
{
  "61": "(a: any, b: any) => any",
  "92": "number",
  "108": "(a: number, b: number) => number"
}
```

A `tsconfig.json` or `jsconfig.json` found at or above the source root shapes the program, and its root file names expand the parse set beyond what filename discovery found, so files referenced only through the config are still parsed.

The checker is single-threaded, so parallelism comes from sharding: files are dealt round-robin to workers, and each worker builds its own program over the full project file set before processing its shard. Cross-file resolution is therefore identical to the single-threaded path, with one cosmetic difference: a small number of inferred union types may print their members in a different order (`A | B` becomes `B | A`, semantically identical). Leave `ASTGEN_TYPE_WORKERS` unset for byte-identical output across machines; set it to `auto` or a number to trade that cosmetic reordering for a large speedup on big projects. If any worker fails, the run falls back to inline processing, which is safe because writes are idempotent.

## Environment variables

| Variable                              | Default   | Purpose                                                                                |
| ------------------------------------- | --------- | -------------------------------------------------------------------------------------- |
| `ASTGEN_TYPE_WORKERS`                 | `1` (off) | Worker threads for the type-generation phase, or `auto` to derive from available CPUs. |
| `ASTGEN_INCLUDE_TEST_FILES`           | `false`   | When `true`, include test files in AST and type generation.                            |
| `ASTGEN_CONCURRENCY`                  | `10`      | Chunk size for the in-thread file loop; bounds peak memory between `gc()` passes.      |
| `ASTGEN_INCLUDE_NODE_MODULES_BUNDLES` | `false`   | When `true`, parse bundled entrypoints inside `node_modules`.                          |
| `ASTGEN_IGNORE_DIRS`                  | unset     | Directories to ignore; setting it without `node_modules` also enables bundle parsing.  |

## Output and the version contract

Each source file becomes `<output>/<relative-path>.json` with the shape `{"fullName", "relativeName", "ast"}`, and each type-mapped file also gets `<relative-path>.typemap`. See [Output Formats](OUTPUT_FORMATS.md).

`astgen --version` prints the AST format version (currently 4.2.0). It is not decorative: downstream frontends such as chen's `jssrc2cpg` fold it into their parse-cache fingerprint, so it must be bumped whenever the emitted AST or type shape changes. A stale version number means stale cached parses get silently reused, which is the one bug this contract exists to prevent.
