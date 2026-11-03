#!/bin/sh
# Runs the Go tests of native/ under the watchdog. Skips, with a reason and exit
# status 0, when Go or git is missing (the Node tests must not need them).
#
# Caps: compiling the checker needs more memory than running a test, so the build
# step has its own cap (15 minutes, 6 GB); the tests then run under the 2 minute,
# 2 GB cap for unit and fixture runs.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
if ! command -v go >/dev/null 2>&1; then echo "skip: go is not installed"; exit 0; fi
if ! command -v git >/dev/null 2>&1; then echo "skip: git is not installed"; exit 0; fi
./scripts/fetch-typescript.sh
wd=./scripts/wd.sh
$wd -t 900 -m 6144 -- go build ./...
$wd -t 900 -m 6144 -- go vet ./... github.com/microsoft/TypeScript/tsc/shim/...
# -p 1: one test binary is compiled and linked at a time, which keeps the tree under the cap.
$wd -t 120 -m 2048 -- go test -p 1 -count=1 ./...
