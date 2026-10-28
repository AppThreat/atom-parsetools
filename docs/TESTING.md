# Testing

The test suite is organized so that every behavioral claim the docs make has a script asserting it. All the JavaScript-side tests need nothing but Node; the Ruby and PHP workflows need their runtimes and a built `plugins/` directory.

## Running the suites

```shell
npm test                # astgen: type, JSON, Vue, Svelte, shape-snapshot,
                        # evaluation
npm run test:svelte     # astgen: Svelte offset/template/typemap regression
npm run test:php        # phpastgen: CLI, parser-info, discovery, provenance,
                        # framework facts, legacy, concurrency, regression,
                        # contract snapshot, property-based tests
npm run test:scala     # scalasem: engine over recorded inspector output, plus a
                       # JVM run when a JDK and a cached compiler are available
npm run test:ruby       # rbastgen: end-to-end against test-fixtures/projects/ruby-parsing
bash build.sh --ruby-only && npm run test:ruby   # full local Ruby workflow
```

The Ruby and PHP suites skip themselves cleanly when the plugin bundle or the language runtime is missing, so `npm test` works on any machine with Node 22.

The single most useful thing to know locally: `ci/verify-packed-tarball.sh` is the release check, and it runs the same way on a laptop as in CI. It packs the tarball, installs it into a scratch project, and parses fixtures with the installed copy.

## The local accuracy check

The fixture suites run scalasem over small projects, which no new Scala or sbt release can be trusted against alone. `test-fixtures/scalasem-accuracy.js` is the by-hand check over a large, current Scala code base, for example over a checkout of [chen](https://github.com/AppThreat/chen); run it before a release and after a change to the inventory, the compiler handling or the derivation rules. It is not part of CI and not part of `npm test`.

```shell
node test-fixtures/scalasem-accuracy.js ~/work/chen --out accuracy.json
node test-fixtures/scalasem-accuracy.js ~/work/chen --no-build \
    --baseline accuracy.json --out accuracy-new.json
```

The script builds the project with sbt unless `--no-build` is given (the sbt build may need `GITHUB_TOKEN`), runs scalasem, and scores the report against facts that do not come from scalasem:

- **Coverage** per module is the share of main source files that have facts in the report.
- **Diagnostics** are all listed; a `helper-compile-failed` or `stale-output` diagnostic counts as a failure and fails the run.
- **Library usage** is read from the class files themselves: a constant pool reader collects the classes every compiled class file names, they are mapped to the jars of the module's classpath through the jars' zip central directories, and that set is compared against the types, owners and symbols the report names. A library the class files use but the report never mentions is a miss; one the report names without a class file reference lands in a review list. Inline methods and constants folded at compile time make the class files an imperfect ground truth, which is why the review list is not a failure. The project's own upstream modules are not libraries and stay out of the scoring.
- **Call sites** are spot checked: a sample of the reported calls is checked for the called name appearing on the reported line of the source file.

The numbers, the commit of the project and the scalasem version go to the `--out` JSON file, and a summary goes to stdout. With `--baseline`, the file of an earlier run, every number is shown against that run and a regression — less coverage, fewer calls, a diagnostic that appears — is called out.

## What the tests assert

The suites deliberately assert what a consumer depends on rather than that a command ran. A few examples make the style concrete.

The Ruby regression asserts which files are discovered (including `Gemfile` and `Rakefile`, matched by basename, not extension), that `has_sig`, `magic_comments`, `percent_array`, and regexp `options` are emitted, that the manifest's counts reconcile, that a failed file lands in the diagnostics record while the run still exits 0, and that a clean run leaves no stale diagnostics file behind.

The phpastgen suite layers a contract snapshot (pinning the required key set of the output wrapper) over property-based tests: encoding scrubbing, depth truncation, failure isolation, manifest contents, side-record naming (`.jsonl`, never `.json`), stale-diagnostics removal, and framework facts each get a generator-driven test rather than a single fixture.

The astgen suite holds the line on output stability: a shape snapshot (`UPDATE_SHAPE_SNAPSHOT=1 npm run test:shape` to regenerate), JSON regression over fixtures, a Vue precision suite, a Svelte suite asserting that every emitted range slices back to the exact `.svelte` source text and that only stock Babel node types appear, and a type-inference regression set over inference edge cases.

## Fixtures

`test-fixtures/projects/` holds the language fixtures: `simple-js`, `typescript-parsing`, `vue-precision`, `svelte-precision`, `inference-edge-cases`, `type-inference-regression`, `advanced-patterns`, `complex-patterns`, `php-parsing`, `php-contract`, and `ruby-parsing`. They are chosen to be adversarial in the ways real code is: mixed syntax, deep nesting, broken encodings, deliberate parse failures. When a bug report includes a file that parses wrong, the fix usually starts by adding that file (reduced) to the matching fixture project.

## CI shape

CI runs the full gauntlet on every push to main: the three suites, a global install with all four bin commands exercised, a Bun compatibility pass, `npm publish --dry-run`, and the packed-tarball check. A separate matrix builds the Ruby bundle with Ruby 3.4 and runs the Ruby suite under both 3.4 and 4.0, because a bundle that only works under the Ruby that built it is exactly the bug the matrix exists to catch. See [Packaging](PACKAGING.md) for the reasoning behind each gate.
