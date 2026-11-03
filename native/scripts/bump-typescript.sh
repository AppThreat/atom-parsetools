#!/bin/sh
# bump-typescript.sh [<commit> | --head]
# Move the microsoft/TypeScript pin (native/third_party/typescript.pin), refetch
# tsc/, apply native/patches, regenerate native/shim, then build and run the
# type map tests. Every heavy step runs under the watchdog. On failure the old
# pin is restored. Needs git, go and network access.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
pinfile="$here/third_party/typescript.pin"
old=$(tr -d ' \n' < "$pinfile")
case "${1:---head}" in
  --head) new=$(git ls-remote "${TYPESCRIPT_REPO:-https://github.com/microsoft/TypeScript.git}" HEAD | cut -f1) ;;
  *) new=$1 ;;
esac
[ -n "$new" ] || { echo "cannot resolve the new commit" >&2; exit 2; }
echo "pin: $old -> $new"
restore() { echo "$old" > "$pinfile"; cp "$pinfile" "$here/internal/typemap/pin.txt"; "$here/scripts/fetch-typescript.sh" || true; echo "restored pin $old" >&2; }
trap 'rc=$?; [ $rc -eq 0 ] || restore' EXIT
echo "$new" > "$pinfile"
cp "$pinfile" "$here/internal/typemap/pin.txt"  # embedded in the binary
start=$(date +%s)
"$here/scripts/fetch-typescript.sh"
wd="$here/scripts/wd.sh"
cd "$here"
# The generator is its own module so that the main module does not depend on x/tools.
(cd tools/gen_shims && "$wd" -t 300 -m 4096 -- go build -o "$here/_deps/bin/gen_shims" .)
GOFLAGS=-mod=mod "$wd" -t 600 -m 4096 -- "$here/_deps/bin/gen_shims"
(cd shim && GOFLAGS=-mod=mod "$wd" -t 300 -m 2048 -- go mod tidy)
GOFLAGS=-mod=mod "$wd" -t 300 -m 2048 -- go mod tidy
"$wd" -t 600 -m 4096 -- go vet ./... github.com/microsoft/TypeScript/tsc/shim/...
"$wd" -t 120 -m 2048 -- go test ./...
echo "bump took $(( $(date +%s) - start )) s"
