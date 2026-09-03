# Lesson 10: Building and verifying a release

## Learning Objective

Build the vendored plugins, understand what the build refuses to ship, run the release gauntlet locally, and know exactly which failure each check exists to catch.

## Pre-requisites

A checkout of this repository, plus for the full build: PHP with Composer downloadable, and Ruby with bundler. Node 22 or newer.

```shell
git clone https://github.com/AppThreat/atom-parsetools
cd atom-parsetools
npm install
```

## What build.sh does and refuses to do

Run the whole build:

```shell
bash build.sh
```

Two plugins land under `plugins/`, which is gitignored: the Composer-installed nikic/php-parser (with the `php-parse` binstub under `plugins/bin`) and the standalone ruby_ast_gen bundle under `plugins/rubyastgen/bundle/ruby/<abi>`. Read the log while it runs; the interesting lines are the refusals.

The Ruby phase enforces two rules that look pedantic and are not. First, nothing native may remain: the build dies if any `.so`, `.bundle`, or `.dll` survives cleanup, because a C extension is built per ABI and platform, and shipping one would silently pin the package to the Ruby that built it. `racc` arrives as a dependency and is removed for exactly this reason; every supported Ruby carries it as a default gem. Second, the gem specifications are kept even while other metadata is stripped, because the bundle is activated through `GEM_PATH` and RubyGems needs the specs (prism's translation layer asks for `gem "parser"` explicitly).

The build then smoke-tests what it produced, on the principle that cleanup deleted files inside the bundles, so a finished build is not evidence of a working one: a trivial PHP file must parse through `plugins/bin/php-parse`, and a trivial Ruby directory, including a `Gemfile` to exercise basename discovery, must parse through `rbastgen.js` with `files_failed: 0` in its manifest.

Partial builds compose: `--php-only` and `--ruby-only` rebuild one side without wiping the other's binstubs, and `--skip-smoke` exists for composing builds, not for skipping verification.

## The consumer's-eye check

The release check a maintainer runs before publishing is also a local command:

```shell
bash ci/verify-packed-tarball.sh
```

It packs the tarball with `npm pack`, installs it into a scratch project, and parses fixtures with the installed copy, asserting that the Ruby bundle is present and free of compiled extensions. This is the check that catches the gap between "works in my checkout" and "works from npm": a pruned `plugins/` directory, an `.npmignore` pattern that eats the bundle, or a bundle that only loads under the Ruby that built it.

## The Ruby ABI matrix

One build must serve every supported Ruby, and only running the same artifact under both proves it:

```shell
bash build.sh --ruby-only        # build with Ruby 3.4 (oldest supported)
npm run test:ruby                # under 3.4

# then switch the interpreter (rbenv, mise, or a second install) to 4.0
npm run test:ruby                # same bundle, Ruby 4.0
```

CI runs exactly this as a matrix: build once with 3.4, test under 3.4 and 4.0. If you change anything about the bundle, this matrix is the acceptance test.

## The full local gauntlet

Before a release, the complete sequence, matching CI:

```shell
npm test                 # astgen suites
npm run test:php         # phpastgen suites including property-based tests
bash build.sh            # plugins + smoke tests
npm run test:ruby        # ruby workflow against the built bundle
sudo npm install -g .    # the four bin commands from the packed layout
astgen --version && phpastgen --help && rbastgen --help
npm publish --dry-run    # what will actually ship
bash ci/verify-packed-tarball.sh
```

Two details in that sequence earn their place. The global install exercises the layout npm actually creates (symlinked bins, resolved `plugins/` paths), which a local `node astgen.js` never touches. And `npm publish --dry-run` prints the tarball contents: read it once and confirm `plugins/` appears and no test fixture or build artifact leaked.

Releases themselves happen from tags in CI (`npm publish --provenance`), so the local gauntlet is about never needing a second try.

## Where to go next

[Packaging](PACKAGING.md) covers the release machinery in depth, and [Contributing](CONTRIBUTING.md) lists the conventions (version fingerprint, `.jsonl` naming, pure-Ruby bundle) that reviews enforce.
