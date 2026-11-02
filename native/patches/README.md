# Patches on microsoft/TypeScript tsc/

Each `NNNN-*.patch` is applied with `git apply` by `scripts/fetch-typescript.sh` on top of the commit in
`third_party/typescript.pin`. The first line of each patch's header comment states why it exists.

None yet: the shim over the unmodified pin loads a project and prints types (see
`internal/tsgo/smoke_test.go`).
