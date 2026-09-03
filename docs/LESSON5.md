# Lesson 5: Pinning PHP grammars and the legacy mode

## Learning Objective

Control which PHP grammar parses your code, understand when pinning matters, and use the legacy single-file passthrough for inspection work.

## Pre-requisites

[Lesson 4](LESSON4.md) completed, or any directory of PHP files parsed with `phpastgen -i`.

## Grammars, defaults, and emulation

The vendored parser accepts target grammars 8.0 through 8.5 and defaults to the newest. Language constructs land in minor versions (`enum` in 8.1, `readonly` properties in 8.2, property hooks in 8.5), so the default maximizes what parses. Token emulation is what makes the default safe on old runtimes: the parser rewrites new-token syntax itself, so PHP 8.1 can parse 8.5 code.

The default is therefore about coverage, not fidelity. Pinning is about reproducibility: the same grammar choice on every machine, regardless of the installed runtime.

## Pinning a grammar

Write two files that only newer grammars accept, an 8.1 enum and an 8.4 visibility modifier:

```shell
mkdir -p versions && cd versions

cat > v81.php << 'EOF'
<?php
enum Suit {
  case Hearts;
  case Spades;
}
EOF

cat > v84.php << 'EOF'
<?php
class Point {
  public private(set) int $x = 0;
}
EOF
```

The enum needs the 8.1 grammar; asymmetric visibility (`private(set)`) needs 8.4. Parse the directory pinned to the oldest supported grammar, then the newest:

```shell
phpastgen -i . -o pinned-80 --target-version 8.0
phpastgen -i . -o newest --target-version 8.5
```

Both runs parse both files: token emulation lets an older target grammar still accept newer syntax. Read the pinned manifest and note the recorded choice, `target_version: "8.0"`, then compare the trees:

```shell
diff pinned-80/v81.php.json newest/v81.php.json > /dev/null && echo "same tree" || echo "trees differ"
```

The trees differ. The grammar target changes how the parser's lexer and printer represent version-dependent constructs, even when the parse succeeds under both, which is precisely why the target belongs in the manifest. A consumer that caches or diffs trees should either pin the grammar or record it.

```shell
phpastgen -i . --target-version 7.4; echo "exit: $?"
```

```text
Unsupported --target-version '7.4'. Supported grammars: 8.0, 8.1, 8.2, 8.3, 8.4, 8.5.
exit: 1
```

No AST is emitted for a rejected invocation, which is deliberate: half an output tree with a wrong grammar is worse than none.

## When to pin

Pin in two situations. When output is cached or diffed across machines with different PHP runtimes, a pinned grammar makes trees comparable (recall from [Lesson 2](LESSON2.md) that the same concern exists for astgen type workers). And when your consumer encodes against a specific node shape, pinning keeps the shape from moving underneath it as the default grammar advances. Otherwise, leave the default.

## The legacy passthrough

Without `-i`, phpastgen forwards every argument to the vendored `php-parse` unchanged. This preserves the pre-upgrade single-file interface, and it is genuinely useful for inspection:

```shell
phpastgen --pretty-print versions/v81.php
phpastgen --json-dump versions/v84.php
phpastgen --with-recovery --dump versions/v84.php
```

`--pretty-print` round-trips the file through the printer (a quick sanity check that the parse is faithful), `--json-dump` prints the JSON encoding of the tree, and `--with-recovery` keeps going through errors. The passthrough runs with `ATOM_CWD` honored as its working directory and `ATOM_TIMEOUT` as its kill switch.

Think of the two modes as serving two audiences: batch mode writes files for a consumer; the passthrough prints to stdout for you.

## Where to go next

[Lesson 6](LESSON6.md) moves to Ruby, where the packaging story (a vendored gem bundle that needs no gem installs) is the interesting part.
