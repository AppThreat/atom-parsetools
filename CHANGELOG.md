# Changelog

Every release lists what changed and, under "Breaking changes", what a consumer of atom-parsetools
(chen, atom, cdxgen, or a script of your own) has to change. Releases before 2.0.0 are described on
the GitHub releases page.

## 2.0.0 (unreleased)

The first release of the native rewrite: `parsa` ("parse for atom"), one Go binary that is to
replace `astgen`, `phpastgen`, `rbastgen` and `scalasem` with a subcommand per language. In this
release it writes JavaScript and TypeScript type maps with TypeScript 7's checker (typescript-go),
and astgen uses it when asked to. Babel still parses every file, and without `ASTGEN_TYPES=native`
astgen behaves as in 1.10.6 apart from the breaking changes below.

### Breaking changes

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
  variables as astgen for discovery. `parsa js` without `--types-only` (the AST) is not available
  yet and exits with an error.
- `ASTGEN_TYPES=native` makes astgen write type maps with `parsa` instead of TypeScript 6, and fall
  back to TypeScript 6 with one warning when the binary is missing, fails, times out or its output
  cannot be moved into place. `ASTGEN_NATIVE_BIN` names the binary (otherwise astgen looks next to
  `astgen.js`, then on `PATH`), and `ASTGEN_NATIVE_MEMORY_MB` caps its heap for the whole run
  (default 6,144 MB).
- `.typespans` (native runs only): the type of each node keyed by `"start:end"`, so a consumer can
  look a node up by its own extent instead of its start offset. See `docs/OUTPUT_FORMATS.md`.
- `astgen_manifest.jsonl` (native runs only): one record per run with the engine used, the reason
  for a fallback, the TypeScript commit `parsa` was built from, the checker count, the tsconfig it
  used, the files that hit a budget and why, and the number of types given up.
- `lib/typemap/diff.mjs` compares two type map trees after normalizing member order and quote
  style, and fails on any difference class not on its allow-list (`test-fixtures/typemap-allow.json`).

### Differences in native type maps

Consumers that read `.typemap` files written with `ASTGEN_TYPES=native` should expect:

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

## Planned breaking changes

As the rest of the rewrite lands in later 2.x releases, the Node commands are replaced by `parsa`
subcommands, with no wrappers under the old names:

| today | after the rewrite |
|---|---|
| `astgen` | `parsa js` |
| `phpastgen` | `parsa php` |
| `rbastgen` | `parsa rb` |
| `scalasem` | `parsa scala` |

`parsa` will need no Node, PHP or Ruby runtime (`parsa scala` still runs its TASTy helper on the
JVM). It ships as a binary on GitHub releases and through `@cdxgen/cdxgen-plugins-bin` for Linux
glibc and musl (x64, arm64), macOS (arm64, x64) and Windows (x64, arm64), and not as npm packages.
Each release that removes or changes a command lists the replacement and every changed flag,
environment variable and output difference here.
