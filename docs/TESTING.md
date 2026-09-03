# Testing

The test suite is organized so that every behavioral claim the docs make has a script asserting it. All the JavaScript-side tests need nothing but Node; the Ruby and PHP workflows need their runtimes and a built `plugins/` directory.

## Running the suites

```shell
npm test                # astgen: type, JSON, Vue, shape-snapshot, evaluation
npm run test:php        # phpastgen: CLI, parser-info, discovery, provenance,
                        # framework facts, legacy, concurrency, regression,
                        # contract snapshot, property-based tests
npm run test:ruby       # rbastgen: end-to-end against test-fixtures/projects/ruby-parsing
bash build.sh --ruby-only && npm run test:ruby   # full local Ruby workflow
```

The Ruby and PHP suites skip themselves cleanly when the plugin bundle or the language runtime is missing, so `npm test` works on any machine with Node 22.

The single most useful thing to know locally: `ci/verify-packed-tarball.sh` is the release check, and it runs the same way on a laptop as in CI. It packs the tarball, installs it into a scratch project, and parses fixtures with the installed copy.

## What the tests assert

The suites deliberately assert what a consumer depends on rather than that a command ran. A few examples make the style concrete.

The Ruby regression asserts which files are discovered (including `Gemfile` and `Rakefile`, matched by basename, not extension), that `has_sig`, `magic_comments`, `percent_array`, and regexp `options` are emitted, that the manifest's counts reconcile, that a failed file lands in the diagnostics record while the run still exits 0, and that a clean run leaves no stale diagnostics file behind.

The phpastgen suite layers a contract snapshot (pinning the required key set of the output wrapper) over property-based tests: encoding scrubbing, depth truncation, failure isolation, manifest contents, side-record naming (`.jsonl`, never `.json`), stale-diagnostics removal, and framework facts each get a generator-driven test rather than a single fixture.

The astgen suite holds the line on output stability: a shape snapshot (`UPDATE_SHAPE_SNAPSHOT=1 npm run test:shape` to regenerate), JSON regression over fixtures, a Vue precision suite, and a type-inference regression set over inference edge cases.

## Fixtures

`test-fixtures/projects/` holds the language fixtures: `simple-js`, `typescript-parsing`, `vue-precision`, `inference-edge-cases`, `type-inference-regression`, `advanced-patterns`, `complex-patterns`, `php-parsing`, `php-contract`, and `ruby-parsing`. They are chosen to be adversarial in the ways real code is: mixed syntax, deep nesting, broken encodings, deliberate parse failures. When a bug report includes a file that parses wrong, the fix usually starts by adding that file (reduced) to the matching fixture project.

## CI shape

CI runs the full gauntlet on every push to main: the three suites, a global install with all four bin commands exercised, a Bun compatibility pass, `npm publish --dry-run`, and the packed-tarball check. A separate matrix builds the Ruby bundle with Ruby 3.4 and runs the Ruby suite under both 3.4 and 4.0, because a bundle that only works under the Ruby that built it is exactly the bug the matrix exists to catch. See [Packaging](PACKAGING.md) for the reasoning behind each gate.
