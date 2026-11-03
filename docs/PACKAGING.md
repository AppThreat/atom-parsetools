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

## The parsa binaries

`parsa` is not part of the npm package. `.github/workflows/parsa-release.yml` cross-compiles it on one Linux machine with `parsa/scripts/build-release.sh`, which needs no cgo yet: Linux, macOS and Windows on x64 and arm64, six files of about 19 MB, each with a `.sha256` file. The Linux binaries are static, so the same file runs on glibc and musl. The build is reproducible (`-trimpath`, no build id, no VCS stamp): building the same commit twice gives the same bytes. The job then runs the Linux arm64, Windows x64 and macOS x64 (Intel) binaries on their own runners, and for a release every binary, Apple silicon and Windows arm64 included.

The same job writes a post-build SBOM, `sbom-parsa-postbuild.cdx.json`, of what the binaries link: cdxgen reads `parsa/go.mod`, `parsa/scripts/prune-go-sbom.js` (shared with cdxgen-plugins-bin) keeps the modules the binaries' build info names, and `parsa/scripts/annotate-sbom.js` records microsoft/TypeScript by its pinned commit, with the patches in `parsa/patches` as its pedigree. The Go standard library is not listed; the Go release a binary was built with is part of its build, which `go version -m` on the binary shows. `cdx-validate` fails the build on a schema or reference error.

Each push to main that touches `parsa/` publishes the binaries to `ghcr.io/appthreat/parsa` with oras, each with its `.sha256` file and the SBOM, tagged `<os>-<arch>-<commit>` and `<os>-<arch>-main`, so atom, chen and cdxgen-plugins-bin can test a build before it is released:

```shell
oras pull ghcr.io/appthreat/parsa:linux-amd64-main
sha256sum -c parsa-linux-amd64.sha256
```

A published GitHub release gets the binaries, their `.sha256` files and the SBOM as assets, with build provenance (`gh attestation verify parsa-linux-amd64 --repo AppThreat/atom-parsetools`), and on ghcr.io the tags `<os>-<arch>-<version>`. cdxgen-plugins-bin downloads the release assets, checks the hashes and bakes the binaries into its platform packages. Once cgo arrives (the Prism parser for `parsa rb`), each target has to build on its own runner instead.

## Publishing this documentation site

The docs site is plain [docsify](https://docsify.js.org) under `docs/`, served by GitHub Pages from the `docs` folder of the default branch, the same model cdxgen uses. The `.nojekyll` file must stay: Pages would otherwise run the files through Jekyll, which drops the underscore-prefixed `_sidebar.md` and `_coverpage.md` that docsify needs. If the site 404s after a merge, check the repository's Pages settings first: source should be the default branch with `/docs`.
