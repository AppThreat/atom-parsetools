// Writes the table of examples chen's TypeStringNormalizerTests reads, from canon.mjs, so the two
// normalizers are tested against the same cases:
//
//   node lib/typemap/export-for-chen.mjs <chen>/platform/frontends/jssrc2cpg/src/test/resources/typemap-normalization.json
import { writeFileSync } from "node:fs";
import { CANONICAL_FORMS, NORMALIZATIONS } from "./canon.mjs";

const out = process.argv[2];
if (!out) {
  console.error("usage: export-for-chen.mjs <typemap-normalization.json>");
  process.exit(2);
}
const rows = [];
for (const n of NORMALIZATIONS) {
  // chen does not interpret `typeof` against a signature or the byte order mark shift
  if (["typeof-vs-signature", "bom-shift"].includes(n.id)) continue;
  for (const [a, b] of n.equal) rows.push({ normalization: n.id, a, b, same: true });
  for (const [a, b] of n.different) rows.push({ normalization: n.id, a, b, same: false });
}
const forms = CANONICAL_FORMS.map(([input, canonical]) => ({ input, canonical }));
writeFileSync(
  out,
  `${JSON.stringify(
    {
      description:
        "Generated from atom-parsetools lib/typemap/canon.mjs by lib/typemap/export-for-chen.mjs (NORMALIZATIONS and CANONICAL_FORMS). rows: pairs that name the same type (same=true) and pairs that do not (same=false); forms: a string and the exact canonical spelling it must have.",
      rows,
      forms
    },
    null,
    1
  )}\n`
);
console.log(`${rows.length} rows, ${forms.length} forms`);
