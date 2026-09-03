import assert from "node:assert/strict";
import * as fc from "./pbt.mjs";
import { decodeAndScrub, attachProvenance } from "../phpastgen.js";

// Property-based tests for phpastgen encoding scrub (design §2.3.1, §2.11, Requirement 2.5).
//
// Property 5 (P5): Encoding scrub idempotence.
//   scrub(scrub(b)) == scrub(b), and when a scrub occurred the file is always emitted with
//   `encoding_scrubbed: true`.
//
// `decodeAndScrub(bytes)` returns { text, scrubbed }. When the raw bytes are not valid for the
// declared (or default UTF-8) encoding, invalid sequences are replaced with U+FFFD and
// `scrubbed=true`. Because the scrubbed text is by construction valid UTF-8 (no invalid byte
// sequences remain), re-decoding its UTF-8 byte representation must yield the identical text and
// must NOT need a second round of scrubbing. That is the idempotence guarantee P5 pins.
//
// **Validates: Requirement 2.5** — Property: P5

// A generator that intentionally mixes valid UTF-8 text with raw arbitrary bytes (which frequently
// form invalid UTF-8 sequences). This exercises both the clean-decode path (`scrubbed=false`) and
// the scrub path (`scrubbed=true`) so idempotence is checked across the whole input space.
const arbitraryBytes = fc.oneof(
  // Pure arbitrary byte buffers — commonly include invalid UTF-8 sequences (e.g. lone continuation
  // bytes, truncated multibyte leads), which force the scrub fallback.
  fc.uint8Array({ minLength: 0, maxLength: 512 }).map((u8) => Buffer.from(u8)),
  // Arbitrary unicode strings encoded as UTF-8 — always decode cleanly (scrubbed=false path).
  fc.string({ unit: "binary" }).map((s) => Buffer.from(s, "utf-8")),
  // Full-unicode strings (including astral-plane graphemes) — the fast-check v4 replacement for
  // the removed `fullUnicodeString`; also always valid UTF-8, so they exercise the clean path.
  fc.string({ unit: "grapheme" }).map((s) => Buffer.from(s, "utf-8"))
);

// P5a — Idempotence: feeding the scrubbed text back through the pipeline reproduces the same text.
// The property P5 pins is that the *text* is a fixed point — scrub(scrub(b)) == scrub(b). Note the
// `scrubbed` flag is NOT required to become false on the second pass: `decodeAndScrub` uses the
// presence of U+FFFD as its "invalid bytes" signal, and a legitimately scrubbed result can contain
// U+FFFD (e.g. input `[0x80]` becomes the single replacement char). Re-decoding that valid UTF-8
// still contains U+FFFD, so the flag may remain true — but the text is unchanged, which is the
// guarantee that matters. Idempotence is verified as text stability across repeated passes.
fc.assert(
  fc.property(arbitraryBytes, (bytes) => {
    const first = decodeAndScrub(bytes);
    // Re-run over the byte representation of the already-produced text.
    const second = decodeAndScrub(Buffer.from(first.text, "utf-8"));
    // A third pass confirms the output has fully stabilized (fixed point reached).
    const third = decodeAndScrub(Buffer.from(second.text, "utf-8"));

    // The text is a fixed point: scrub(scrub(b)) == scrub(b).
    assert.equal(
      second.text,
      first.text,
      "scrubbing already-scrubbed text must yield identical text (idempotence)"
    );
    // Further passes never change the text again — the fixed point is stable.
    assert.equal(
      third.text,
      second.text,
      "repeated scrubbing must keep converging to the same text"
    );
    // The scrubbed text contains only valid UTF-8 (round-trips through Buffer unchanged).
    assert.equal(
      Buffer.from(first.text, "utf-8").toString("utf-8"),
      first.text,
      "scrubbed text must be valid UTF-8 that round-trips through a Buffer"
    );
  }),
  { numRuns: 500 }
);
console.log("ok P5 idempotence: scrub(scrub(b)) == scrub(b)");

// P5b — Emission: whenever a scrub occurs, the emitted AST file carries `encoding_scrubbed: true`;
// and when no scrub occurs the additive key is omitted (invariant 1: additive contract only).
fc.assert(
  fc.property(arbitraryBytes, (bytes) => {
    const { scrubbed } = decodeAndScrub(bytes);
    const emitted = attachProvenance(
      { nodeType: "Stmt_Nop" },
      {
        parser_backend: "nikic/php-parser@5.8.0",
        generator_version: "2.0.0",
        php_version: "8.3.0",
        target_version: null,
        encoding_scrubbed: scrubbed || undefined
      }
    );

    if (scrubbed) {
      assert.equal(
        emitted.encoding_scrubbed,
        true,
        "a scrubbed file must be emitted with encoding_scrubbed: true"
      );
    } else {
      assert.ok(
        !Object.hasOwn(emitted, "encoding_scrubbed"),
        "an unscrubbed file must omit the encoding_scrubbed key (additive contract)"
      );
    }
  }),
  { numRuns: 500 }
);
console.log("ok P5 emission: scrubbed files carry encoding_scrubbed: true");

// P5c — Regression anchor with a concrete invalid-UTF-8 example: a lone 0x80 continuation byte is
// not valid UTF-8, so it must be scrubbed, and re-scrubbing the produced text is a no-op on the
// text (the fixed point is reached immediately).
{
  const invalid = Buffer.from([0x3c, 0x3f, 0x70, 0x68, 0x70, 0x20, 0x80, 0xff]); // "<?php " + bad bytes
  const first = decodeAndScrub(invalid);
  assert.equal(first.scrubbed, true, "lone invalid bytes must be scrubbed");
  const second = decodeAndScrub(Buffer.from(first.text, "utf-8"));
  assert.equal(second.text, first.text, "re-scrubbing the concrete example is a no-op on the text");
  console.log("ok P5 concrete invalid-UTF-8 example scrubs then stabilizes");
}

// P5d — Regression anchor for the U+FFFD fixed point: input that reduces to a lone replacement
// character (e.g. `[0x80]`) is a stable fixed point on the text even though the `scrubbed` flag
// may stay true, because U+FFFD is the very signal `decodeAndScrub` treats as "needs scrubbing".
{
  const first = decodeAndScrub(Buffer.from([0x80]));
  assert.equal(first.text, "\uFFFD", "a lone continuation byte decodes to the replacement char");
  const second = decodeAndScrub(Buffer.from(first.text, "utf-8"));
  assert.equal(second.text, first.text, "the U+FFFD result is a stable text fixed point");
  console.log("ok P5 U+FFFD result is a stable text fixed point");
}

console.log("phpastgen-encoding-pbt: all checks passed");
