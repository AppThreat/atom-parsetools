# Performance

These tools regularly run over monorepos and framework codebases with tens of thousands of files. This page collects the knobs that matter, what each costs, and how to reason about a slow run.

## astgen

Three phases dominate astgen's runtime: file discovery, parsing (Babel, in-process), and type generation (the TypeScript checker, in-process). Parsing is easy to make fast; the checker is where big projects spend their time, because a program must be built over the whole project before a single file's types can be resolved.

The one big lever is `ASTGEN_TYPE_WORKERS`. The checker is single-threaded, so astgen parallelizes by dealing files round-robin to worker threads, each of which builds its own program over the full project set and processes only its shard. Cross-file resolution stays identical to the single-threaded path. The trade-off is byte-stability: sharding changes TypeScript's internal type-id ordering, which reorders the members of a small number of inferred union types (`A | B` prints as `B | A`; semantically identical). The guidance follows from that:

| Situation                                                        | Setting                           |
| ---------------------------------------------------------------- | --------------------------------- |
| Output is diffed, cached, or checksummed across machines         | leave `ASTGEN_TYPE_WORKERS` unset |
| One-off analysis of a large project, output consumed immediately | `ASTGEN_TYPE_WORKERS=auto`        |

`ASTGEN_CONCURRENCY` (default 10) bounds how many files the in-thread loop holds between `gc()` passes. Peak memory, not speed, is what it tunes: a lower value trades a little throughput for a flatter heap. If a container OOMs mid-run, this is the first knob to lower.

Input volume is the other lever. Test files are excluded from type generation by default precisely because they are heavy and low-value; `ASTGEN_INCLUDE_TEST_FILES=true` restores them at a visible cost. `node_modules` is skipped entirely unless you opt into bundle entrypoints.

A worker that fails does not abort the run; astgen falls back to inline processing and says so on stderr. Writes are idempotent, so the fallback is safe, just slower: if you see the fallback message, the fix is usually memory, not retries.

## phpastgen

Directory runs spawn up to `--threads` concurrent `php-parse` subprocesses (default 10, range 1 to 64; out-of-range values warn and fall back to the default). Because each worker is a separate PHP process, memory scales with the thread count, and the practical ceiling on a CI runner is memory, not CPU.

Two other knobs interact with speed and fidelity. `--max-depth` (default 250) caps tree depth; pathological nested arrays in legacy code are the usual reason to lower it. Grammar choice matters little for speed but matters for stability: pin `--target-version` only when you want reproducible output across runtimes.

## rbastgen

The gem side parallelizes with `--threads` worker threads (default 10) for directory runs. The wrapper adds process startup cost (one Ruby interpreter), which is trivial next to parsing. If Ruby startup itself is the bottleneck in a loop you control, invoking the gem directly (via `RUBY_ASTGEN_BIN`) removes the Node layer entirely.

## scalasem

scalasem's cost is dominated by the compile step it may run and by `scalac -print-tasty` per class file. `ATOM_MAX_BUFFER` (default 100 MB) must exceed the largest printed TASTy output or that file's dump fails; the symptom is a missing entry, with the stderr logged. Timeouts apply per subprocess (`ATOM_TIMEOUT`), so a slow compile can be bounded without bounding the whole run.

## Timeouts everywhere

`ATOM_TIMEOUT` (or `ASTGEN_TIMEOUT`, with `ATOM_TIMEOUT` winning) kills a spawned subprocess after that many milliseconds. It protects pipelines from pathological inputs; per-file failures are already non-fatal in the batch tools, so a timeout surfaces as a diagnostic, not a crash. A non-numeric value is ignored rather than guessed at.
