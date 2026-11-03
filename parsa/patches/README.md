# Patches on microsoft/TypeScript tsc/

`scripts/fetch-typescript.sh` applies every `NNNN-*.patch` with `git apply` on top of the commit in
`third_party/typescript.pin`. The first line of each patch is a comment (git ignores everything before
the first `diff --git`) that says why the patch exists. A bump that makes a patch fail stops and restores the old pin.

| patch | reason |
| --- | --- |
| 0001-checker-printing-budget-interrupt-and-cache-release | Bound type printing (node builder call budget `VerbosityContext.MaxBuilderCalls`), let another goroutine interrupt a running query (`Checker.SetInterrupt`, polled in flow analysis, expression checking and the node builder), and release the printer caches (`Checker.ReleasePrinterCaches`). `Checker.SetWorkLimit` adds a deterministic work limit (same stopping point on every run). Also restores `serializationLevel` and drops the node builder when a write panics. All of it is opt-in: with no interrupt set and no budget the checker behaves as before. |
