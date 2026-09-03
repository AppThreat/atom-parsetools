import assert from "node:assert/strict";
import { attachProvenance } from "../phpastgen.js";

// Unit tests for attachProvenance (design §2.3, Tier 2 contract; Requirements 4.1, 2.5, 2.6, 6.1).
//
// These pin the additive JSON shape the generator emits per AST file. nikic/php-parser emits a
// top-level array, which cannot carry sibling keys, so provenance is attached by wrapping the array
// under `ast` with provenance keys as siblings. The four required keys are always present; optional
// keys (`rel_file_path`, `encoding_scrubbed`, `truncated_nodes`) appear only when their fact holds.

const sampleAst = [{ nodeType: "Stmt_Nop", attributes: { startLine: 1 } }];

// Required keys are always present; the AST array is preserved verbatim under `ast`.
{
  const out = attachProvenance(sampleAst, {
    parser_backend: "nikic/php-parser@5.8.0",
    generator_version: "2.0.0",
    php_version: "8.3.10",
    target_version: null
  });
  assert.deepEqual(out.ast, sampleAst, "the nikic array must be carried verbatim under `ast`");
  assert.equal(out.parser_backend, "nikic/php-parser@5.8.0");
  assert.equal(out.generator_version, "2.0.0");
  assert.equal(out.php_version, "8.3.10");
  assert.equal(
    Object.hasOwn(out, "target_version"),
    true,
    "target_version is a required key and must always be present"
  );
  console.log("ok provenance: required keys always present, AST preserved under `ast`");
}

// target_version is null when unset (unset must not omit the required key).
{
  const unset = attachProvenance(sampleAst, {
    parser_backend: "b",
    generator_version: "v",
    php_version: "p"
  });
  assert.equal(unset.target_version, null, "target_version must be null when unset");

  const set = attachProvenance(sampleAst, {
    parser_backend: "b",
    generator_version: "v",
    php_version: "p",
    target_version: "8.4"
  });
  assert.equal(set.target_version, "8.4", "a provided target_version is recorded verbatim");
  console.log("ok provenance: target_version is null when unset, recorded when provided");
}

// encoding_scrubbed appears ONLY when true; omitted otherwise (additive invariant 1).
{
  const scrubbed = attachProvenance(sampleAst, {
    parser_backend: "b",
    generator_version: "v",
    php_version: "p",
    encoding_scrubbed: true
  });
  assert.equal(scrubbed.encoding_scrubbed, true);

  for (const falsey of [false, undefined]) {
    const out = attachProvenance(sampleAst, {
      parser_backend: "b",
      generator_version: "v",
      php_version: "p",
      encoding_scrubbed: falsey
    });
    assert.equal(
      Object.hasOwn(out, "encoding_scrubbed"),
      false,
      "encoding_scrubbed must be omitted when no scrub occurred"
    );
  }
  console.log("ok provenance: encoding_scrubbed emitted only when true");
}

// truncated_nodes appears ONLY when count > 0; omitted for 0 or undefined (additive invariant 1).
{
  const truncated = attachProvenance(sampleAst, {
    parser_backend: "b",
    generator_version: "v",
    php_version: "p",
    truncated_nodes: 3
  });
  assert.equal(truncated.truncated_nodes, 3);

  for (const nonPositive of [0, undefined]) {
    const out = attachProvenance(sampleAst, {
      parser_backend: "b",
      generator_version: "v",
      php_version: "p",
      truncated_nodes: nonPositive
    });
    assert.equal(
      Object.hasOwn(out, "truncated_nodes"),
      false,
      "truncated_nodes must be omitted when the count is not > 0"
    );
  }
  console.log("ok provenance: truncated_nodes emitted only when count > 0");
}

// rel_file_path is optional: present when provided, omitted when absent.
{
  const withRel = attachProvenance(sampleAst, {
    parser_backend: "b",
    generator_version: "v",
    php_version: "p",
    rel_file_path: "src/greeter.php"
  });
  assert.equal(withRel.rel_file_path, "src/greeter.php");

  const withoutRel = attachProvenance(sampleAst, {
    parser_backend: "b",
    generator_version: "v",
    php_version: "p"
  });
  assert.equal(
    Object.hasOwn(withoutRel, "rel_file_path"),
    false,
    "rel_file_path must be omitted when not provided"
  );
  console.log("ok provenance: rel_file_path present when provided, omitted otherwise");
}

console.log("phpastgen-provenance: all checks passed");
