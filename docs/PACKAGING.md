# Packaging and Release

The npm package ships code that is not in git. The `plugins/` directory, the vendored PHP parser and the Ruby gem bundle, is built by `build.sh` at release time and included in the tarball via the `files` list in `package.json`. This page explains what the build does, why it is strict about what it ships, and how the release checks catch the failures that matter.

## What build.sh produces

```text
build.sh [--php-only|--ruby-only] [--skip-smoke]

  plugins/
    bin/php-parse              binstub for the vendored parser
    composer.json, composer.lock, installed.php, autoload.php
    nikic/                     nikic/php-parser 5.8.0 (tests and docs stripped)
    rubyastgen/
      bundle/ruby/<abi>/       pure-Ruby gems: ruby_ast_gen 2.0.1, parser, ...
      setup.sh
```

The PHP side downloads the Composer installer, verifies it against the signature Composer publishes for the current release, and installs the pinned parser version with `--ignore-platform-reqs` so the build machine's PHP does not constrain consumers. Bloat (markdown, tests, CI configs) is stripped.

The Ruby side runs `plugins/rubyastgen/setup.sh` to build a standalone bundle, then enforces the rules that make one build serve every supported Ruby:

```text
  rule                              why
  --------------------------------  ----------------------------------------
  no native extensions (.so,       a C extension is built per ABI and platform;
  .bundle, .dll) anywhere in       the build FAILS if one survives cleanup
  the bundle                        (racc arrives as a dependency and is
                                     removed; the runtime's default-gem copy
                                     serves instead)
  specifications/*.gemspec kept     the bundle is activated through GEM_PATH,
                                     and RubyGems needs the specs to activate
                                     (prism's translation layer asks for
                                     `gem "parser"` explicitly)
  bundler binstubs and the          they hardcode the ABI of the building Ruby
  standalone loader deleted         and would be broken commands for consumers
```

The build then smoke-tests what it produced, on the theory that cleanup deleted files inside the bundles, so "the build finished" is not evidence the plugins still run: a trivial PHP file must parse through `plugins/bin/php-parse`, and a trivial Ruby directory (with a `Gemfile`, to exercise basename discovery) must parse through `rbastgen.js` with `files_failed: 0` in the manifest. `--skip-smoke` exists for composing builds, not for skipping the check.

Windows builds use `build.ps1`, which pins the parser version in lockstep; `PHP_PARSER_VERSION` must stay in sync between the two scripts.

## Why GEM_PATH instead of bundler standalone

A bundler standalone bundle resolves its load paths through `Gem.ruby_api_version` at runtime, so a package built this way only loads under the one Ruby ABI it was built with. The shipped bundle is instead exposed through `GEM_PATH`, which RubyGems resolves without ABI pinning, and `ruby_ast_gen` itself (installed as a git gem, which RubyGems cannot activate from `GEM_PATH`) goes on the load path directly. One build therefore runs under Ruby 3.4.x and 4.0.x alike, with `prism` and `racc` coming from the runtime's own default gems.

## The release gauntlet

Three checks gate a release, each targeting a failure mode the others cannot see.

`ci/verify-packed-tarball.sh` is the consumer's-eye check: it packs the tarball with `npm pack`, installs it into a scratch project, and parses fixtures with the installed copy, asserting along the way that the Ruby bundle is present and free of compiled extensions. This is what catches "works in the repo, broken in the tarball", including a plugins directory that was never built or was pruned by `.npmignore`.

The CI ruby matrix builds the bundle once with the oldest supported Ruby (3.4) and runs the Ruby workflow tests against both 3.4 and 4.0. Building and testing on a single interpreter cannot show that one build serves every Ruby; only running the same artifact under both does.

The main CI job exercises the whole surface under both runtimes: `npm test` and the php and ruby suites, then `npm install -g .` and the four bin commands, a Bun compatibility pass over the astgen suite, `npm publish --dry-run` on every push, and the real publish (with provenance) on tags.

## Publishing this documentation site

The docs site is plain [docsify](https://docsify.js.org) under `docs/`, served by GitHub Pages from the `docs` folder of the default branch, the same model cdxgen uses. The `.nojekyll` file must stay: Pages would otherwise run the files through Jekyll, which drops the underscore-prefixed `_sidebar.md` and `_coverpage.md` that docsify needs. If the site 404s after a merge, check the repository's Pages settings first: source should be the default branch with `/docs`.
