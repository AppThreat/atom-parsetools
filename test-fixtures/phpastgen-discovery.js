import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  DEFAULT_EXCLUDE,
  PHP_EXTENSIONS,
  VENDOR_DIRS,
  discoverFiles,
  hasPhpOpenTag,
  isRecognizedPhp
} from "../phpastgen.js";

// Unit tests for phpastgen batch-mode file discovery (Requirements 2.2, 2.9; design §2.2).
// `discoverFiles`, `isRecognizedPhp`, and `hasPhpOpenTag` are exercised against real temp fixture
// trees built in the OS temp dir (no PHP runtime or vendored parser required). They pin:
//   - known PHP extensions (.php/.phtml/.inc etc.) are recognized;
//   - extensionless files whose leading bytes carry a `<?php`/`<?=` open tag are sniffed as PHP;
//   - non-PHP files are counted in skippedNonPhpCount;
//   - files matching the exclude regex are counted in excludedCount, matched relative to input;
//   - VENDOR_DIRS subtrees (vendor, node_modules, .git, ...) are skipped wholesale.

// Track every temp root created so we can clean up even if an assertion throws.
const tempRoots = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "phpastgen-discovery-"));
  tempRoots.push(root);
  return root;
}

function write(root, relPath, contents = "") {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

function cleanup() {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// The exclusion regex is authored by the caller; discovery is given a RegExp. Use the shipped
// default so the tests exercise the real production pattern.
const excludeRe = new RegExp(DEFAULT_EXCLUDE);

// Sort helper so included-set assertions do not depend on walk order.
const sorted = (arr) => [...arr].sort();

try {
  // 1. Extension recognition: every known PHP extension is recognized; a representative non-PHP
  //    extension is not (Requirement 2.2).
  {
    for (const ext of PHP_EXTENSIONS) {
      assert.equal(
        isRecognizedPhp(`/some/where/file${ext}`),
        true,
        `${ext} is recognized as PHP by extension`
      );
      // Extension matching is case-insensitive (design §2.2: compared lower-cased).
      assert.equal(
        isRecognizedPhp(`/some/where/FILE${ext.toUpperCase()}`),
        true,
        `${ext} recognized case-insensitively`
      );
    }
    for (const nonPhp of [".js", ".txt", ".json", ".md", ".py"]) {
      assert.equal(
        isRecognizedPhp(`/some/where/file${nonPhp}`),
        false,
        `${nonPhp} is not recognized as PHP by extension`
      );
    }
    console.log("ok known PHP extensions are recognized, non-PHP are not");
  }

  // 2. Extensionless sniff: a file with no extension is recognized only when its leading bytes
  //    contain a PHP open tag; the sniff reads the real file (Requirement 2.2).
  {
    const root = makeTempRoot();
    const phpTag = write(root, "bin-php", "<?php echo 1;\n");
    const shortTag = write(root, "bin-short", "<?= $x ?>\n");
    const notPhp = write(root, "bin-shell", "#!/bin/sh\necho hi\n");
    const empty = write(root, "bin-empty", "");

    assert.equal(hasPhpOpenTag(phpTag), true, "<?php open tag is sniffed");
    assert.equal(hasPhpOpenTag(shortTag), true, "<?= short open tag is sniffed");
    assert.equal(hasPhpOpenTag(notPhp), false, "shell script has no PHP open tag");
    assert.equal(hasPhpOpenTag(empty), false, "empty file has no PHP open tag");

    assert.equal(
      isRecognizedPhp(phpTag),
      true,
      "extensionless file with <?php is recognized as PHP"
    );
    assert.equal(
      isRecognizedPhp(notPhp),
      false,
      "extensionless non-PHP file is not recognized"
    );
    console.log("ok extensionless files are sniffed for a PHP open tag");
  }

  // 3. Directory walk: recognized PHP files (by extension and by extensionless sniff) are
  //    included; non-PHP files land in skippedNonPhpCount (Requirements 2.2, 2.9).
  {
    const root = makeTempRoot();
    const a = write(root, "src/a.php", "<?php\n");
    const b = write(root, "src/lib/b.phtml", "<?php\n");
    const c = write(root, "src/legacy.inc", "<?php\n");
    const extensionless = write(root, "src/console", "<?php echo 'cli';\n");
    // Non-PHP files: one plain, one extensionless without an open tag.
    write(root, "src/readme.md", "# hi\n");
    write(root, "src/data.json", "{}\n");
    write(root, "src/Makefile", "all:\n\techo hi\n");

    const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
      root,
      excludeRe
    );

    assert.deepEqual(
      sorted(included),
      sorted([a, b, c, extensionless]),
      "all recognized PHP files (by extension + sniff) are included"
    );
    assert.equal(excludedCount, 0, "nothing matched the exclude regex here");
    assert.equal(
      skippedNonPhpCount,
      3,
      "three non-PHP files are counted as skipped"
    );
    console.log("ok directory walk includes PHP files and counts non-PHP skips");
  }

  // 4. Exclusion counting: the exclude regex is matched against the path RELATIVE to the input,
  //    so a `tests/` or `Tests/` directory name drops its PHP files into excludedCount, while an
  //    unrelated absolute-path segment does not (Requirements 2.2, 2.9).
  {
    const root = makeTempRoot();
    const included1 = write(root, "app/Controller.php", "<?php\n");
    const included2 = write(root, "app/Service.php", "<?php\n");
    // Excluded by the default regex `^(tests?|vendor|Tests?)` applied to the relative path.
    write(root, "tests/UnitTest.php", "<?php\n");
    write(root, "test/OtherTest.php", "<?php\n");
    write(root, "Tests/CapTest.php", "<?php\n");

    const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
      root,
      excludeRe
    );

    assert.deepEqual(
      sorted(included),
      sorted([included1, included2]),
      "only files outside excluded dirs are included"
    );
    assert.equal(
      excludedCount,
      3,
      "the three PHP files under tests/test/Tests are counted as excluded"
    );
    assert.equal(skippedNonPhpCount, 0, "no non-PHP files present");
    console.log("ok exclude regex is matched relative to input and counted");
  }

  // 4b. Exclusion is anchored to the input-relative path, not the absolute path: an input dir that
  //     itself lives under a directory literally named `tests` must still discover its files,
  //     because the regex sees only the relative portion.
  {
    const outer = makeTempRoot();
    const input = join(outer, "tests", "project");
    const p = write(outer, "tests/project/Main.php", "<?php\n");
    const { included, excludedCount } = discoverFiles(input, excludeRe);
    assert.deepEqual(
      included,
      [p],
      "a `tests` segment ABOVE the input does not exclude files (relative match)"
    );
    assert.equal(
      excludedCount,
      0,
      "nothing excluded when the tests segment is outside the input path"
    );
    console.log("ok exclusion matches the input-relative path, not the absolute path");
  }

  // 5. Vendor-dir skipping: entire VENDOR_DIRS subtrees are skipped wholesale — their files count
  //    toward neither included, excludedCount, nor skippedNonPhpCount (Requirement 2.9).
  {
    const root = makeTempRoot();
    const keep = write(root, "src/App.php", "<?php\n");
    // Files buried inside vendor dirs must be skipped entirely, even nested and even PHP.
    write(root, "vendor/pkg/Vendor.php", "<?php\n");
    write(root, "node_modules/dep/index.php", "<?php\n");
    write(root, ".git/hooks/pre-commit.php", "<?php\n");
    write(root, "src/.idea/workspace.php", "<?php\n");
    write(root, "vendor/nested/deep/Deep.php", "<?php\n");

    const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
      root,
      excludeRe
    );

    assert.deepEqual(
      included,
      [keep],
      "only the non-vendor file is included; vendor subtrees are skipped wholesale"
    );
    // Vendor subtrees are pruned before the exclude/skip accounting, so their PHP files do not
    // inflate either counter (the default regex would also exclude `vendor`, but the pruning must
    // hold regardless of the regex — verified next).
    assert.equal(
      skippedNonPhpCount,
      0,
      "vendor subtree files are not counted as skipped non-PHP"
    );
    console.log("ok VENDOR_DIRS subtrees are skipped wholesale");
  }

  // 5b. Vendor pruning is independent of the exclude regex: even with a regex that would NOT match
  //     the vendor dir names, the VENDOR_DIRS subtrees are still skipped, and their files never
  //     appear in any counter (Requirement 2.9).
  {
    const root = makeTempRoot();
    const keep = write(root, "app.php", "<?php\n");
    write(root, "node_modules/dep/keep.php", "<?php\n");
    write(root, ".git/config.php", "<?php\n");
    // A regex that matches nothing in this tree, so exclusion cannot explain the pruning.
    const neverMatch = /^__never__/;
    const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
      root,
      neverMatch
    );
    assert.deepEqual(
      included,
      [keep],
      "vendor dirs pruned even when the exclude regex does not match them"
    );
    assert.equal(excludedCount, 0, "no exclusions with a never-matching regex");
    assert.equal(
      skippedNonPhpCount,
      0,
      "vendor files never contribute to skippedNonPhpCount"
    );
    // Sanity: every configured vendor dir name is a directory component we prune.
    assert.ok(
      VENDOR_DIRS.has("vendor") &&
        VENDOR_DIRS.has("node_modules") &&
        VENDOR_DIRS.has(".git"),
      "VENDOR_DIRS includes the well-known vendor directories"
    );
    console.log("ok vendor pruning is independent of the exclude regex");
  }

  // 6. Combined accounting on a mixed tree: included + excludedCount + skippedNonPhpCount reflect
  //    exactly the files walked outside vendor subtrees (Requirements 2.2, 2.9).
  {
    const root = makeTempRoot();
    const inc1 = write(root, "src/One.php", "<?php\n");
    const inc2 = write(root, "src/nested/Two.phtml", "<?php\n");
    write(root, "tests/Skip.php", "<?php\n"); // excluded
    write(root, "src/notes.txt", "hi\n"); // skipped non-PHP
    write(root, "vendor/lib/V.php", "<?php\n"); // pruned, uncounted

    const { included, excludedCount, skippedNonPhpCount } = discoverFiles(
      root,
      excludeRe
    );

    assert.deepEqual(
      sorted(included),
      sorted([inc1, inc2]),
      "two PHP files included outside excluded/vendor dirs"
    );
    assert.equal(excludedCount, 1, "one file excluded (tests/)");
    assert.equal(skippedNonPhpCount, 1, "one non-PHP file skipped");
    console.log("ok combined accounting sums included/excluded/skipped correctly");
  }

  // 7. Single-file input: exclusion is matched against the basename, and a recognized PHP file is
  //    included while a non-PHP file is counted as skipped (Requirement 2.2, single-file path).
  {
    const root = makeTempRoot();
    const single = write(root, "solo.php", "<?php\n");
    const nonPhp = write(root, "solo.txt", "hi\n");
    const excludedName = write(root, "vendor.php", "<?php\n"); // basename matches ^vendor

    assert.deepEqual(
      discoverFiles(single, excludeRe),
      { included: [single], excludedCount: 0, skippedNonPhpCount: 0 },
      "single recognized PHP file is included"
    );
    assert.deepEqual(
      discoverFiles(nonPhp, excludeRe),
      { included: [], excludedCount: 0, skippedNonPhpCount: 1 },
      "single non-PHP file is counted as skipped"
    );
    assert.deepEqual(
      discoverFiles(excludedName, excludeRe),
      { included: [], excludedCount: 1, skippedNonPhpCount: 0 },
      "single file whose basename matches the exclude regex is counted as excluded"
    );
    // Guard against accidental separator assumptions in the fixtures.
    assert.ok(single.includes(sep), "temp fixture paths use the OS separator");
    console.log("ok single-file input handles inclusion, skip, and exclusion");
  }

  console.log("phpastgen-discovery: all checks passed");
} finally {
  cleanup();
}
