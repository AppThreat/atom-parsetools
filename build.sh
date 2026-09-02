#!/usr/bin/env bash
#
# Builds the bundled plugins that this package ships: the PHP parser (composer) and the Ruby
# ruby_ast_gen bundle (bundler, standalone). Both land under plugins/, which is gitignored and
# packed into the npm tarball at release time.
#
# Usage: build.sh [--php-only|--ruby-only] [--skip-smoke]
#
set -euo pipefail

# Pins. PHP_PARSER_VERSION must stay in sync with build.ps1, which builds the Windows package.
PHP_PARSER_VERSION="5.7.0"
# Ruby ABIs the rbastgen wrapper claims to support (see RUBY_VERSIONS_NEEDED in rbastgen.js).
# A standalone bundle is only loadable under the ABI it was built with, so this is a release-shaping
# constraint rather than a cosmetic one.
SUPPORTED_RUBY_ABIS="3.4.0 4.0.0"

BUILD_PHP=1
BUILD_RUBY=1
RUN_SMOKE=1
for arg in "$@"; do
  case "$arg" in
    --php-only) BUILD_RUBY=0 ;;
    --ruby-only) BUILD_PHP=0 ;;
    --skip-smoke) RUN_SMOKE=0 ;;
    -h | --help)
      cat << 'USAGE'
Usage: build.sh [--php-only|--ruby-only] [--skip-smoke]

Builds the plugins this package ships: the PHP parser (composer) and the standalone
ruby_ast_gen bundle (bundler). Both land under the gitignored plugins/ directory and are
smoke tested afterwards unless --skip-smoke is given.
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# Work from the repository root regardless of the caller's directory.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$PWD"

log() { echo "==> $*"; }
warn() { echo "WARNING: $*" >&2; }
die() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup() {
  rm -f "$ROOT_DIR/composer-setup.php" "$ROOT_DIR/composer.phar"
  rm -rf "$SMOKE_DIR"
}
SMOKE_DIR=""
trap cleanup EXIT

# Only clear what this invocation rebuilds: plugins/bin holds binstubs for both toolchains, so
# wiping it wholesale during a --ruby-only run would remove the PHP parser command.
if [ "$BUILD_PHP" -eq 1 ] && [ "$BUILD_RUBY" -eq 1 ]; then
  rm -rf plugins/bin plugins/rubyastgen/bundle/
elif [ "$BUILD_RUBY" -eq 1 ]; then
  rm -rf plugins/rubyastgen/bundle/
  rm -f plugins/bin/ruby_ast_gen plugins/bin/bundle plugins/bin/bundler
elif [ "$BUILD_PHP" -eq 1 ]; then
  rm -f plugins/bin/php-parse
fi

if [ "$BUILD_PHP" -eq 1 ]; then
  if command -v php > /dev/null 2>&1; then
    log "Building PHP plugin (nikic/php-parser $PHP_PARSER_VERSION) with $(php -r 'echo PHP_VERSION;')"
    php -r "copy('https://getcomposer.org/installer', 'composer-setup.php');"
    # Verify the installer against the signature composer publishes for the current release, the
    # way upstream documents. build.ps1 pins a hash for a single installer build instead, which
    # goes stale; fetching the signature keeps the check working without maintenance.
    EXPECTED_SIGNATURE="$(php -r "echo trim(file_get_contents('https://composer.github.io/installer.sig'));")"
    ACTUAL_SIGNATURE="$(php -r "echo hash_file('sha384', 'composer-setup.php');")"
    [ -n "$EXPECTED_SIGNATURE" ] || die "could not fetch the composer installer signature"
    [ "$EXPECTED_SIGNATURE" = "$ACTUAL_SIGNATURE" ] ||
      die "composer installer checksum mismatch (expected $EXPECTED_SIGNATURE, got $ACTUAL_SIGNATURE)"

    php composer-setup.php --quiet
    rm -f composer-setup.php
    export COMPOSER_VENDOR_DIR=plugins
    php composer.phar require "nikic/php-parser:$PHP_PARSER_VERSION" --ignore-platform-reqs --optimize-autoloader
    rm -f composer.phar
    mv composer.json composer.lock plugins/

    # Clean up unnecessary files from PHP parser
    find plugins/nikic -type f \( -name "*.md" -o -name "*.yml" -o -name "*.yaml" \) -delete
    find plugins/nikic -type d \( -name "test" -o -name "tests" -o -name "spec" -o -name "doc" -o -name "docs" -o -name ".git" \) -exec rm -rf {} + 2> /dev/null || true

    [ -f plugins/bin/php-parse ] || die "plugins/bin/php-parse is missing after the composer build"
  else
    echo "PHP plugins not built."
  fi
fi

if [ "$BUILD_RUBY" -eq 1 ]; then
  if command -v ruby > /dev/null 2>&1 && command -v bundle > /dev/null 2>&1; then
    RUBY_ABI="$(ruby -e 'print RbConfig::CONFIG["ruby_version"]')"
    log "Building Ruby plugin with $(ruby -e 'print RUBY_DESCRIPTION') (ABI $RUBY_ABI)"
    # A --standalone bundle resolves its load paths through Gem.ruby_api_version at runtime, so the
    # published package only works on the ABI built here: bundle/ruby/$RUBY_ABI. Building with a
    # Ruby outside the wrapper's supported set produces a package that fails for every user.
    case " $SUPPORTED_RUBY_ABIS " in
      *" $RUBY_ABI "*) ;;
      *) warn "Ruby ABI $RUBY_ABI is not one of: $SUPPORTED_RUBY_ABIS. rbastgen will fail for users on those versions." ;;
    esac

    (cd plugins/rubyastgen && bash setup.sh)
    # Binstubs bundler generates for gems we do not expose as commands.
    rm -f plugins/bin/racc plugins/bin/ruby-parse plugins/bin/ruby-rewrite

    # Clean up Ruby bundle bloat - remove documentation, tests, and build artifacts
    RUBY_BUNDLE="plugins/rubyastgen/bundle/ruby"
    find "$RUBY_BUNDLE" -type d \( -name "test" -o -name "tests" -o -name "spec" -o -name "doc" -o -name "docs" \) -exec rm -rf {} + 2> /dev/null || true
    find "$RUBY_BUNDLE" -type f \( -name "*.md" -o -name "*.txt" -o -name "*.yml" -o -name "*.yaml" -o -name "*.gemspec" -o -name "Rakefile" -o -name "Gemfile*" \) -delete
    rm -rf "$RUBY_BUNDLE"/*/build_info
    rm -rf "$RUBY_BUNDLE"/*/cache
    rm -rf "$RUBY_BUNDLE"/.bundle 2> /dev/null || true
    find "$RUBY_BUNDLE" -type d -name ".git*" -exec rm -rf {} + 2> /dev/null || true

    [ -f plugins/bin/ruby_ast_gen ] || die "plugins/bin/ruby_ast_gen is missing after the bundler build"
    [ -d "$RUBY_BUNDLE/$RUBY_ABI" ] || die "$RUBY_BUNDLE/$RUBY_ABI is missing after the bundler build"
  else
    echo "Ruby plugins not built."
  fi
fi

# Smoke tests. The cleanup steps above delete files inside the vendored bundles, so "the build
# finished" is not evidence that the plugins still run: exercise them the way the wrappers do.
if [ "$RUN_SMOKE" -eq 1 ]; then
  SMOKE_DIR="$(mktemp -d)"

  if [ -f plugins/bin/php-parse ]; then
    log "Smoke testing phpastgen"
    # shellcheck disable=SC2016  # $name is PHP source, not shell
    printf '<?php\nfunction hello(string $name): string { return "hi $name"; }\n' > "$SMOKE_DIR/hello.php"
    # php-parse puts its progress headers on stderr and the AST on stdout.
    node phpastgen.js --json-dump "$SMOKE_DIR/hello.php" > "$SMOKE_DIR/php.json" 2> "$SMOKE_DIR/php.log" ||
      die "phpastgen failed on a trivial file ($(cat "$SMOKE_DIR/php.log"))"
    grep -q '"nodeType"' "$SMOKE_DIR/php.json" ||
      die "phpastgen produced no AST nodes ($(cat "$SMOKE_DIR/php.log"))"
  fi

  if [ -f plugins/bin/ruby_ast_gen ]; then
    log "Smoke testing rbastgen"
    mkdir -p "$SMOKE_DIR/rb"
    printf '# typed: true\nsig { returns(String) }\ndef hello = "hi"\n' > "$SMOKE_DIR/rb/hello.rb"
    printf 'source "https://rubygems.org"\n' > "$SMOKE_DIR/rb/Gemfile"
    node rbastgen.js -i "$SMOKE_DIR/rb" -o "$SMOKE_DIR/rb_out" > "$SMOKE_DIR/rb.log" 2>&1 ||
      die "rbastgen failed to run ($(cat "$SMOKE_DIR/rb.log"))"
    # rbastgen never exits non-zero for per-file problems, so assert on the output instead: the
    # .rb file, the Gemfile (basename-matched, not an extension) and the run manifest.
    [ -f "$SMOKE_DIR/rb_out/hello.rb.json" ] ||
      die "rbastgen produced no AST for hello.rb ($(cat "$SMOKE_DIR/rb.log"))"
    [ -f "$SMOKE_DIR/rb_out/Gemfile.json" ] ||
      die "rbastgen did not parse the Gemfile ($(cat "$SMOKE_DIR/rb.log"))"
    grep -q '"files_failed":0' "$SMOKE_DIR/rb_out/ruby_ast_gen_manifest.jsonl" ||
      die "rbastgen reported parse failures: $(cat "$SMOKE_DIR/rb_out/ruby_ast_gen_manifest.jsonl")"
    node rbastgen.js --parser-info | sed 's/^/    /'
  fi
fi

if [ -d plugins ]; then
  log "Bundled plugin sizes"
  du -sh plugins/* 2> /dev/null | sed 's/^/    /'
  log "Total: $(du -sh plugins | cut -f1)"
fi
