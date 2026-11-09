# Changelog

Every release lists what changed and, under "Breaking changes", what a consumer of atom-parsetools
(chen, atom, cdxgen, or a script of your own) has to change. Releases before 2.0.0 are described on
the GitHub releases page.

## 2.0.0 (unreleased)

Pre-releases of 2.0.0 (`2.0.0-rc.1` first) are published to npm under the `next` dist-tag
(`npm install @appthreat/atom-parsetools@next`), with the `parsa` binaries attached to their GitHub
releases.

The first release with native type maps: `parsa` ("parse for atom"), a Go binary that writes
JavaScript and TypeScript type maps with TypeScript 7's checker (typescript-go). astgen calls it by
default and falls back to TypeScript 6 in this process when the binary is missing or fails, so a
plain `npm install` still works and always produces types. Babel still parses every file, the four
commands keep their names, and Node stays a requirement.

The npm package does not carry `parsa`, and there are no npm packages for it. The binaries are
attached to each GitHub release (see `docs/PACKAGING.md`), and consumers that ship them, such as
cdxgen with the platform packages of `@cdxgen/cdxgen-plugins-bin` and atom's container images,
point astgen at the binary through `ASTGEN_NATIVE_BIN` or place it next to `astgen.js`. 1.x keeps getting
fixes on the `release/1.x` branch, published under the npm dist-tag `release-1.x`.

### Breaking changes

- **Native type maps are the default.** With `ASTGEN_TYPES` unset or empty, astgen now requests the
  `parsa` binary instead of TypeScript 6, so every consumer that did not set `ASTGEN_TYPES` gets
  TypeScript 7's type strings (union and object member order, quote style, function signatures;
  see "Differences in native type maps" below) when the binary is present, and the TypeScript 6
  strings when it is not. Set `ASTGEN_TYPES=ts6` to keep the previous output on every machine.
  `ASTGEN_VERSION` goes to 4.7.0, and to 4.7.1 with the nested TypeScript projects below, so caches
  keyed on it, such as chen's parse cache, are rebuilt.
- **Output file names when astgen runs with `-i .`** (how chen runs it). Names were computed with
  the regular expression `"^" + src + "/"`, which with `src` set to `.` removed the first character
  and slash of every path, so `a/b.js` was written as `b.js`. Names are now relative to the source
  directory, so such projects get different, correct, output paths. `ASTGEN_VERSION` goes to 4.6.0
  so that caches keyed on it, such as chen's parse cache, are rebuilt.
- **Top-level `__tests__` and `__mocks__` directories are skipped with `-i .`.** The test-file
  rule needed a separator before the directory name, so with `-i .` a top-level `__mocks__` or
  `__tests__` was parsed and typed, while with an absolute `-i` it was not. Both are now skipped
  either way unless `ASTGEN_INCLUDE_TEST_FILES` is set. On outline this removes five mock files
  from the output.

### Added

- `parsa js --types-only -i SRC -o OUT` writes a `.typemap` and a `.typespans` for every file astgen
  would type. It runs every file through TypeScript 7's checker in one process, with one checker per
  CPU (at most 8), and its output does not depend on the checker count. It reads the same `ASTGEN_*`
  variables as astgen for discovery. `parsa js` without `--types-only` exits with an error: astgen
  writes the AST.
- `ASTGEN_TYPES` chooses the type map engine: unset or empty means `native` (the new default),
  `ts6` chooses TypeScript 6, `native` names the default explicitly, and an unknown value warns and
  means `ts6`. When the binary is missing (the normal case after a plain `npm install`), fails,
  times out or its output cannot be moved into place, astgen types with TypeScript 6 instead: under
  the default with one quiet line on stderr, after an explicit `ASTGEN_TYPES=native` with one
  warning. `ASTGEN_NATIVE_BIN` names the binary (otherwise astgen looks next to `astgen.js`, then
  on `PATH`), and `ASTGEN_NATIVE_MEMORY_MB` caps its heap for the whole run (default 6,144 MB).
- `.typespans` (native runs only): the type of each node keyed by `"start:end"`, so a consumer can
  look a node up by its own extent instead of its start offset. See `docs/OUTPUT_FORMATS.md`.
- `astgen_manifest.jsonl`: one record per run with types on, whichever engine ran. It says what was
  requested (`requested`: `native` or `ts6`) and by whom (`requestedBy`: `default` or `env`), which
  engine ran (`engine`), and the reason of a fallback; a native record also carries the TypeScript
  commit `parsa` was built from, the checker count, the tsconfig it used, the files that hit a
  budget and why, and the number of types given up. A file astgen could not parse at all gets a
  `{"kind":"file_error"}` record with the file and the reason.
- Budgets on the TypeScript 6 type phase: `ASTGEN_TYPE_FILE_TIMEOUT_MS` (default 60,000) for one
  file's types and `ASTGEN_TYPE_PROGRAM_TIMEOUT_MS` (default 300,000) for building the program. The
  phase runs in a worker thread that astgen stops past a budget; a file past it keeps its AST and
  gets no types, and the run carries on. Each case is a `type_budget` record in
  `astgen_manifest.jsonl`. cdxgen's own `scanOnePathInner` and large bundles that redeclare the same
  names no longer hold a run for minutes. A 10 MB minified bundle, which before this release ended
  the TypeScript 6 phase only when the caller's timeout killed the run, now ends it with a
  `program-wall-time` budget record and the run finishes with its ASTs.
- Nested TypeScript projects are typed with their own configuration. A repository that keeps a
  second project in a subdirectory with its own `tsconfig.json` (juice-shop's Angular app in
  `frontend/`) had that project typed with the root's compiler options, and the root's files could
  pick up the nested project's packages through the one shared program. Each project now gets a
  program of its own. Both engines do this: astgen's TypeScript 6 path and `parsa`, which find the
  projects the same way (following `references` as `tsc -b` does, so Angular's solution-style
  `frontend/tsconfig.json` hands `frontend/src` to `tsconfig.app.json`) and type them one after
  another. A `parsa` report for such a run lists each program under `projects`. A project's own
  compiler options also win over astgen's defaults (`moduleResolution`, `module`, `target`, `lib`,
  `jsx`, `exactOptionalPropertyTypes`), so a package reachable only through `exports` under bundler
  resolution is typed, and a project whose `lib` leaves out the DOM no longer gets DOM types.
  `ASTGEN_VERSION` goes to 4.7.1 so caches keyed on it, such as chen's parse cache, are rebuilt.
- A class member declared with `accessor` (`accessor x = 1`, decorated or not) parses: the
  `decoratorAutoAccessors` plugin is in the syntax list and in both Flow lists, where the member
  used to fail the whole file's parse.
- `parsa` binaries for Linux, macOS and Windows on x64 and arm64, attached to each GitHub release with
  a `.sha256` file, build provenance and a post-build CycloneDX SBOM, and published to `ghcr.io/appthreat/parsa` (see
  `docs/PACKAGING.md`). The npm package does not include them.
- `lib/typemap/diff.mjs` compares two type map trees after normalizing member order and quote
  style, and fails on any difference class not on its allow-list (`test-fixtures/typemap-allow.json`).

### Removed

- `plugins/log4j2.xml`. Nothing in atom-parsetools read it; atom configures logging with its own
  `log4j2.xml`.
- The `combined` and `script-only` Vue parse candidates, and `directive-template-only`. Their
  buffers moved the script to the top, so every line and column in the json was wrong for the file,
  and nothing in the output said so. A component whose template still cannot be parsed now falls
  back to `script-in-place` (the whole file with the template block's content masked to spaces),
  which keeps the script at its lines. `.vue` json files carry a top-level `sfcCandidate` naming
  the candidate that parsed; see `docs/OUTPUT_FORMATS.md`.

### Fixed

- An AST's JSON is written in chunks instead of as one string, with the same bytes. A 10 MB minified
  bundle's AST (about 700 MB of JSON, longer than V8's largest string) was recorded as a failed
  file; it is now written. A file whose AST does not fit in the heap astgen has left is parsed in a
  child process with a larger heap (`ASTGEN_LARGE_FILE_HEAP_MB`), where it used to end astgen with
  an out-of-memory abort on smaller heaps. The replacer that leaves out objects reached twice now
  marks them instead of keeping a set, which halves its memory on large files.
- When the TypeScript 6 program budget stops the type worker, astgen waits for the worker to exit
  before it writes the ASTs, so the two no longer hold memory at the same time.
- Every HTML void element left unclosed in a Vue template (`<input type="text">`, `<hr>`) and the
  slot shorthand (`#name`, `#[expr]`, a bare `v-slot:name`) are masked without changing the
  buffer's length, so the whole-file candidate parses them and positions address the file instead
  of falling back to a candidate that relocated the script (AppThreat/atom#320).
- Vue attribute names that JSX rejects, such as UnoCSS attributify utilities (`bg-black:90`,
  `md:90`) and a valueless `@submit.prevent`, are masked the same way, so such templates are no
  longer dropped.

### Differences in native type maps

Consumers that read `.typemap` files written by `parsa` (the default when the binary is present)
should expect:

- Union and object members in TypeScript 7's order (`"ADMIN" | "USER"` where TypeScript 6 wrote
  `"USER" | "ADMIN"`) and literal types in the source's quote style. chen's `TypeStringNormalizer`
  spells both engines' strings the same way.
- JavaScript functions printed as their signature where TypeScript 6 printed `typeof name`.
- More nodes typed: `export default` expressions, the right part of qualified names such as
  `React.ReactNode`, and nodes TypeScript 6 left untyped or as `any`.
- A bare import specifier that resolves only through `baseUrl` is not typed: TypeScript 7 no
  longer treats `baseUrl` as a module root. `paths` aliases still resolve.
- Each file has a work, time and memory budget. A file that exceeds one has no entries after the
  point where it stopped, and is listed in `astgen_manifest.jsonl`.
- A file the TypeScript 7 parser cannot parse cleanly (Flow annotations, `do` expressions,
  `export v from "m"`) gets no entries, and is listed in `astgen_manifest.jsonl` with the reason
  `syntax-not-parsed`: the checker would type a recovered tree whose positions need not match
  Babel's nodes. TypeScript 6 typed such files from its own recovered tree.
- Fewer nodes typed in JavaScript that builds classes from constructor functions assigned to an
  untyped global (`THREE.OrbitControls = function () { this.target = ...; }`): TypeScript 7 does not
  infer the `this` members there, so those members and the calls through them have no entries.
