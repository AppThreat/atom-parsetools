# Contributing

Contributions that fix parsing of real-world code are the lifeblood of this package: every fixture here started life as a bug report. This page covers the workflow, the conventions reviews enforce, and the route to the biggest contribution, a new language generator.

## Setup

```shell
git clone https://github.com/AppThreat/atom-parsetools
cd atom-parsetools
npm install
npm test
```

Ruby and PHP work need their runtimes and a plugin build:

```shell
bash build.sh            # or --php-only / --ruby-only
npm run test:php
npm run test:ruby
```

Before sending a PR, run `npm run pretty` (prettier with `--trailing-comma=none`) and the suites your change touches. If your change affects a snapshot suite, regenerate deliberately with `UPDATE_SHAPE_SNAPSHOT=1 npm run test:shape` (or `UPDATE_PHP_CONTRACT_SNAPSHOT=1 npm run test:php:contract`) and say so in the PR; an unexplained snapshot diff is the parsing equivalent of a failed test.

## Conventions the reviews enforce

The version fingerprint. `ASTGEN_VERSION` in `astgen.js` must be bumped whenever the emitted AST or type shape changes, and only then, because chen's parse cache fingerprints it. A PR that changes shapes without bumping, or bumps without changing, will be asked to fix that first.

The side-record naming rule. Manifests and diagnostics end in `.jsonl`, never `.json`, because consumers glob `*.json` for trees. The write helpers reject a `.json` name for a side-record; do not work around that.

Per-file failure is not fatal. Batch tools report, count, and continue. A change that makes one bad file abort a run needs a strong argument.

Provenance travels with output. New generators record their backend, generator version, and language runtime version in the manifest and ideally per file, the way rbastgen does, so output can be compared across machines.

Pure-Ruby only in the bundle. Nothing with a C extension may be vendored; the build fails if one survives. Gems that are default gems in every supported Ruby are used from the runtime instead.

## Testing an unreleased engine

You do not need to release to test a new parser. `RUBY_ASTGEN_BIN` points rbastgen at a checkout's `exe/ruby_ast_gen` (its `lib` goes on the load path), `PHP_PARSER_BIN` points phpastgen at any `php-parse` binary, and `ASTGEN_*` variables tune astgen without code changes. This is the intended workflow for iterating on ruby_ast_gen itself against this package's fixtures.

## Adding a new language generator

The phpastgen and rbastgen split is the template: a language-side generator that owns parsing and survival behavior (encoding scrubbing, depth truncation, manifest and diagnostics), and a Node wrapper in this repo that owns runtime detection, path resolution, and the CLI. Match the established contract rather than inventing a new one.

```text
1. Generator  one .json per source file, provenance keys, optional
              encoding_scrubbed / truncated_nodes
2. Wrapper    CLI mirrors the rbastgen surface: -i, -o, -e, -l, --threads,
              --max-depth, --fail-on-error, --parser-info, --version
3. Discovery  real-world files, not just the canonical extension
              (see how rbastgen matches Rakefile and Gemfile by basename)
4. Records    <tool>_manifest.jsonl, <tool>_diagnostics.jsonl (removed on a
              clean run), both .jsonl
5. Build      vendored under plugins/, no compiled extensions, smoke-tested
              by build.sh
6. Tests      a fixture project, a regression suite, a contract snapshot,
              property-based tests for the survival behaviors
```

Write the fixture project first, adversarial in the ways real code in that language is, and let the suites fail against the unimplemented generator. That ordering keeps the contract, not the implementation, in charge.

## Publishing this site

The documentation is docsify under `docs/`: markdown pages, `_sidebar.md`, `_coverpage.md`, and `index.html`. Mermaid diagrams render client-side; keep them in fenced `mermaid` code blocks. Pages are served by GitHub Pages from the `docs` folder of the default branch; `.nojekyll` must remain, or the underscore files disappear. When adding a page, link it from `_sidebar.md` and, where it fits, from the cover page.
