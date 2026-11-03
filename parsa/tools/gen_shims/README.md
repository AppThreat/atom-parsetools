# Shim generator

Adapted from oxc-project/tsgolint `tools/gen_shims` (MIT, see `LICENSE.tsgolint`). Two changes: the
import prefix is `github.com/microsoft/TypeScript/tsc/internal/` and the package list is the one
`parsa/` needs. The same technique is used by web-infra-dev/rslint (MIT).

The shim module `github.com/microsoft/TypeScript/tsc/shim` lives in `parsa/shim`. Its path starts with
the path of the `tsc` module, which is what lets it import `tsc/internal/...` packages. Each shimmed
package re-exports types, constants and variables as aliases and exports functions through
`//go:linkname`. Private functions, methods and struct fields are exposed through an
`extra-shim.json` in the shim package directory (keys `ExtraFunctions`, `ExtraMethods`, `ExtraFields`,
`IgnoreFunctions`).

Generate (from `parsa/`, after `scripts/fetch-typescript.sh`):

    (cd tools/gen_shims && go build -o ../../_deps/bin/gen_shims .)
    GOFLAGS=-mod=mod _deps/bin/gen_shims

or run `scripts/bump-typescript.sh` to do everything. Use the watchdog for both (about 27 s and 2.7 GB).
