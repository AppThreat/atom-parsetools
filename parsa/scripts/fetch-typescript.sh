#!/bin/sh
# Fetch microsoft/TypeScript at the pinned commit (only the tsc/ directory)
# into parsa/_deps/TypeScript and apply parsa/patches/*.patch on top.
# Idempotent: does nothing when the checkout is already at the pin with the
# patches applied. Needs git and network access on first use.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
pin=$(tr -d ' \n' < "$here/third_party/typescript.pin")
dest="$here/_deps/TypeScript"
stamp="$dest/.atom-parsetools-applied"
want="$pin $(cat "$here"/patches/*.patch 2>/dev/null | shasum | cut -d' ' -f1)"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then
  exit 0
fi
rm -rf "$dest"
mkdir -p "$dest"
cd "$dest"
git init -q
git remote add origin "${TYPESCRIPT_REPO:-https://github.com/microsoft/TypeScript.git}"
git config core.sparseCheckout true
printf 'tsc/\n' > .git/info/sparse-checkout
git fetch -q --depth 1 origin "$pin"
git -c advice.detachedHead=false checkout -q FETCH_HEAD
for p in "$here"/patches/*.patch; do
  [ -f "$p" ] || continue
  git apply --whitespace=nowarn "$p"
done
printf '%s\n' "$want" > "$stamp"
