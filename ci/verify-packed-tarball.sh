#!/usr/bin/env bash
#
# Installs the packed npm tarball into a scratch project and parses a fixture with it, so a missing
# entry in package.json "files" — or a plugin bundle that only loads on the Ruby that built it —
# cannot reach a release. Runs the same way locally as in CI.
#
# Usage: ci/verify-packed-tarball.sh [tarball]
#
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$PWD"
FIXTURE="$ROOT_DIR/test-fixtures/projects/ruby-parsing"

log() { echo "==> $*"; }
die() {
  echo "ERROR: $*" >&2
  exit 1
}

CONSUMER=""
TARBALL="${1:-}"
PACKED_HERE=0
cleanup() {
  [ -n "$CONSUMER" ] && rm -rf "$CONSUMER"
  [ "$PACKED_HERE" -eq 1 ] && rm -f "$TARBALL"
  return 0
}
trap cleanup EXIT

if [ -z "$TARBALL" ]; then
  log "Packing the tarball"
  TARBALL="$ROOT_DIR/$(npm pack --silent | tail -1)"
  PACKED_HERE=1
fi
[ -f "$TARBALL" ] || die "tarball not found: $TARBALL"

# The Ruby bundle must be inside the tarball, and nothing in it may be a compiled extension: those
# are built per ABI and per platform, which is what would pin the package to one Ruby version.
tar tzf "$TARBALL" | grep -q "package/plugins/rubyastgen/bundle/ruby/" ||
  die "the packed tarball carries no Ruby bundle"
if tar tzf "$TARBALL" | grep -E "plugins/rubyastgen/.*\.(so|bundle|dll)$"; then
  die "the packed Ruby bundle contains compiled extensions"
fi

CONSUMER="$(mktemp -d)"
log "Installing $(basename "$TARBALL") into $CONSUMER"
(
  cd "$CONSUMER"
  npm init -y > /dev/null
  npm install --silent "$TARBALL"
)
RBASTGEN="$CONSUMER/node_modules/.bin/rbastgen"
[ -x "$RBASTGEN" ] || die "rbastgen was not installed by the tarball"

log "Parser capabilities as the installed package sees them"
"$RBASTGEN" --parser-info | sed 's/^/    /'

log "Parsing the Ruby fixture project"
"$RBASTGEN" -i "$FIXTURE" -o "$CONSUMER/ast" > "$CONSUMER/run.log" 2>&1 ||
  die "rbastgen failed to run ($(cat "$CONSUMER/run.log"))"
for expected in lib/typed_api.rb.json app/models/user.rb.json Gemfile.json Rakefile.json \
  ruby_ast_gen_manifest.jsonl; do
  [ -f "$CONSUMER/ast/$expected" ] ||
    die "the installed package produced no $expected ($(cat "$CONSUMER/run.log"))"
done
grep -q '"files_parsed":4' "$CONSUMER/ast/ruby_ast_gen_manifest.jsonl" ||
  die "unexpected manifest counts: $(cat "$CONSUMER/ast/ruby_ast_gen_manifest.jsonl")"

log "Packed tarball parses Ruby correctly under $(ruby -e 'print RUBY_DESCRIPTION')"
