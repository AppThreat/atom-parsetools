#!/bin/sh
# build-release.sh [outdir]   Cross-compiles parsa for every released target into outdir
# (default _deps/dist), with a .sha256 file next to each binary.
#
# parsa has no cgo yet, so one machine builds every target and the Linux binaries are static: the
# same file runs on glibc and musl. Each build runs under the watchdog with the cap the CI build
# uses. PARSA_VERSION sets the version parsa reports (default: package.json's version plus "-dev").
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
out=${1:-_deps/dist}
version=${PARSA_VERSION:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../package.json)-dev}
./scripts/fetch-typescript.sh
mkdir -p "$out"
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi
}
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  goos=${target%/*}
  goarch=${target#*/}
  name="parsa-$goos-$goarch"
  [ "$goos" = windows ] && name="$name.exe"
  # GOOS and GOARCH go to the inner build only, so wd.sh still builds the watchdog for this machine.
  ./scripts/wd.sh -t 900 -m 6144 -- env CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -buildvcs=false -ldflags "-s -w -buildid= -X main.version=$version" \
    -o "$out/$name" ./cmd/parsa
  (cd "$out" && sha256 "$name" > "$name.sha256")
done
ls -l "$out"
