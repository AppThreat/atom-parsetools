#!/bin/sh
# wd.sh [-t secs] [-m mb] -- cmd...   Run a command under the watchdog, building it on first use.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$here/_deps/bin/watchdog"
if [ ! -x "$bin" ] || [ "$here/tools/watchdog/main.go" -nt "$bin" ]; then
  mkdir -p "$here/_deps/bin"
  (cd "$here" && go build -o "$bin" ./tools/watchdog)
fi
exec "$bin" "$@"
