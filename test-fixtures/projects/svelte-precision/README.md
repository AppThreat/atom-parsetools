# svelte-precision

Fixture project for astgen's Svelte support. Each component isolates one area
of the Svelte language so a regression points at a specific construct. The
components are intentionally small and hand-written; realistic corpora are used
for smoke runs elsewhere, not for assertions.

| File | What it covers |
| --- | --- |
| `counter-runes.svelte` | Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props` with a typed interface), `{#if}` / `{:else if}` / `{:else}`, an `onclick` handler, an `{@html}` sink |
| `list-each.svelte` | `{#each}` with a destructuring context, an index, a keyed expression, `{:else}` fallback, `{@const}`, a nested `{#each}` |
| `async-await.svelte` | `{#await}` with pending/then/catch branches, `{#key}`, an async helper imported from `api-client.ts` |
| `snippet-render.svelte` | `{#snippet}` with typed parameters, `{@render}`, `<slot>`, `<svelte:fragment>` with `let:` |
| `directives.svelte` | Every directive form (`on:`, `bind:`, `class:`, `style:`, `use:`, `transition:`, `in:`, `out:`, `animate:`, `let:`), a spread attribute, and the `{value}` shorthand attribute |
| `special-elements.svelte` | `<svelte:head>`, `<svelte:window>`, `<svelte:body>`, `<svelte:document>`, `<svelte:element this={...}>`, `<svelte:boundary>`, `<title>` |
| `legacy-props.svelte` | Svelte 4 style: `export let` props, a `$:` reactive statement, `on:click`, `createEventDispatcher` |
| `module-script.svelte` | A `<script module>` block and an instance `<script>` block in one file, with an export from the module block |
| `ts-template.svelte` | TypeScript inside template expressions (requires `lang="ts"`): an `as` cast and a non-null assertion |
| `void-and-quirks.svelte` | Void elements written unclosed (`<br>`, `<img>`, `<input>`), an attribute with mixed text and interpolation, a boolean shorthand attribute, an HTML comment, a quoted `>` inside an attribute value |
| `broken-template.svelte` | A deliberately malformed template expression: the whole-file fallback path must still emit a (script-only) AST with a recorded parse error |
| `api-client.ts` | Typed async helpers imported by the components, so cross-file type inference is exercised |
| `store.svelte.ts` | A `.svelte.ts` rune module (plain TypeScript to astgen); confirms discovery and rune typing outside components |
| `types.ts` | The interfaces used by `$props()` destructuring |

The regression test living in `test-fixtures/astgen-svelte-regression.js` runs
astgen over this project and asserts, per construct, that the emitted AST node
ranges slice back to the exact source text.
