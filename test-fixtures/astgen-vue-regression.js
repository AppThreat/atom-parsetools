import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOutputRoot,
  runAstgen,
  countUnresolved,
  expectType,
  loadFixtureSet
} from "./vue-regression-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputRoot = createOutputRoot();

const precisionFixtureRoot = join(__dirname, "projects", "vue-precision");

const broadVueFiles = [
  "counter-setup.vue",
  "typed-modal.vue",
  "provide-consume.vue",
  "model-form.vue",
  "slot-panel.vue",
  "async-profile.vue"
];

const precisionFiles = [
  "counter-setup.vue",
  "typed-modal.vue",
  "provide-consume.vue",
  "model-form.vue",
  "slot-panel.vue",
  "async-profile.vue",
  "use-auth.ts",
  "table-utils.ts"
];

const BROAD_MIN_FILE_ENTRIES = 40;
const BROAD_MIN_TOTAL_ENTRIES = 320;
const BROAD_MAX_UNRESOLVED_RATIO = 0.2;
const PRECISION_MIN_FILE_ENTRIES = 40;
const PRECISION_MAX_UNRESOLVED_RATIO = 0.15;

function evaluateBroadCorpus() {
  const broadOutputRoot = join(outputRoot, "broad");
  runAstgen(precisionFixtureRoot, broadOutputRoot);

  let broadTotalEntries = 0;
  let broadUnresolved = 0;
  for (const relativeName of broadVueFiles) {
    const source = readFileSync(join(precisionFixtureRoot, relativeName), "utf8");
    const fixture = loadFixtureSet(
      precisionFixtureRoot,
      broadOutputRoot,
      [relativeName],
      BROAD_MIN_FILE_ENTRIES
    )[relativeName];
    const unresolved = countUnresolved(fixture.typemap);
    broadTotalEntries += Object.keys(fixture.typemap).length;
    broadUnresolved += unresolved;
    assert.ok(source.length > 0, `${relativeName} source should not be empty`);
  }

  assert.ok(
    broadTotalEntries >= BROAD_MIN_TOTAL_ENTRIES,
    `Vue broad corpus typemap precision dropped below threshold: ${broadTotalEntries}`
  );
  assert.ok(
    broadUnresolved / Math.max(broadTotalEntries, 1) < BROAD_MAX_UNRESOLVED_RATIO,
    `Vue broad corpus unresolved ratio is too high: ${broadUnresolved}/${broadTotalEntries}`
  );
}

function evaluatePrecisionAssertions() {
  const precisionOutputRoot = join(outputRoot, "precision");
  runAstgen(precisionFixtureRoot, precisionOutputRoot);
  const fixtures = loadFixtureSet(
    precisionFixtureRoot,
    precisionOutputRoot,
    precisionFiles,
    PRECISION_MIN_FILE_ENTRIES
  );

  const precisionEntries = precisionFiles.reduce(
    (total, file) => total + Object.keys(fixtures[file].typemap).length,
    0
  );
  const precisionUnresolved = precisionFiles.reduce(
    (total, file) => total + countUnresolved(fixtures[file].typemap),
    0
  );
  assert.ok(
    precisionUnresolved / Math.max(precisionEntries, 1) <
      PRECISION_MAX_UNRESOLVED_RATIO,
    `Vue precision unresolved ratio is too high: ${precisionUnresolved}/${precisionEntries}`
  );

  expectType(fixtures["counter-setup.vue"], "count", "{ value: number; }");
  expectType(fixtures["counter-setup.vue"], "label", "{ readonly value: string; }");
  expectType(fixtures["counter-setup.vue"], "increment", "() => number");

  expectType(
    fixtures["typed-modal.vue"],
    "props",
    "ModalProps<UserRecord> & { visible: boolean; }"
  );
  expectType(fixtures["typed-modal.vue"], "titleLabel", "{ readonly value: string; }");
  expectType(
    fixtures["typed-modal.vue"],
    "closeModal",
    '(reason: "confirm" | "cancel") => void'
  );

  expectType(fixtures["provide-consume.vue"], "injectedSession", "Session");
  expectType(fixtures["provide-consume.vue"], "isAdmin", "{ readonly value: boolean; }");
  expectType(fixtures["provide-consume.vue"], "switchRole", '() => "admin" | "user"');

  expectType(fixtures["model-form.vue"], "modelValue", "{ value: string; }");
  expectType(fixtures["model-form.vue"], "normalizedModel", "{ readonly value: string; }");
  expectType(fixtures["model-form.vue"], "resetModel", "() => string");

  expectType(fixtures["slot-panel.vue"], "props", "{ rows: Array<SlotRow>; }");
  expectType(fixtures["slot-panel.vue"], "totalScore", "{ readonly value: number; }");
  expectType(fixtures["slot-panel.vue"], "hasFooterSlot", "() => boolean");
  expectType(
    fixtures["slot-panel.vue"],
    "slots",
    "{ default(props: { row: SlotRow; index: number; }): unknown; footer?(props: { total: number; }): unknown; }"
  );

  expectType(fixtures["async-profile.vue"], "profile", "Profile");
  expectType(fixtures["async-profile.vue"], "roleSummary", "{ readonly value: string; }");
  expectType(fixtures["async-profile.vue"], "isAdmin", "(profileToCheck: Profile) => boolean");

  expectType(
    fixtures["use-auth.ts"],
    "createAuthToken",
    "(userId: string) => { ok: true; token: string; expiresAt: number; } | { ok: false; reason: string; }"
  );
  expectType(
    fixtures["use-auth.ts"],
    "readAuthMessage",
    "(result: { ok: true; token: string; expiresAt: number; } | { ok: false; reason: string; }) => string"
  );

  expectType(
    fixtures["table-utils.ts"],
    "summarizeRows",
    "(rows: Array<Row>) => { total: number; average: number; ids: Set<string>; }"
  );
  expectType(fixtures["table-utils.ts"], "scores", "Array<number>");
  expectType(fixtures["table-utils.ts"], "ids", "Set<string>");
}

try {
  evaluateBroadCorpus();
  evaluatePrecisionAssertions();

  console.log("astgen Vue inference regression tests passed");
} finally {
  rmSync(outputRoot, { recursive: true, force: true });
}
