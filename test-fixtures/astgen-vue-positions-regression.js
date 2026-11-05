// Positions of a Vue single-file component must address the file, whatever the
// template holds (atom-parsetools#82, AppThreat/atom#320). An unclosed HTML
// void element or a slot shorthand used to reject the whole-file candidate,
// and the fallback put the script first, so every line in the json was wrong
// for the file. These fixtures pin the opposite: the import keeps its line,
// one template binding keeps its line and column, the json says which parse
// candidate produced it, and every candidate preserves the file's geometry
// (same length, every newline at the same index, `\r` included).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import * as fc from "./pbt.mjs";
import {
  buildVueParseCandidates,
  vueGeometryPreserved
} from "../astgen.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = dirname(__dirname);

const fixtureRoot = mkdtempSync(join(tmpdir(), "atom-parsetools-vue-positions-"));
const outputRoot = join(fixtureRoot, "ast_out");

// Every fixture's script starts with the same import, so the expected line of
// the import is counted from the fixture text, never remembered.
const SCRIPT = "import axios from 'axios'\n\nexport const send = () => axios.post('/y')\n";

const sfc = (templateInner, script = SCRIPT) =>
  `<template>\n${templateInner}</template>\n\n<script setup lang="ts">\n${script}</script>\n`;

const lineOf = (code, offset) => {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (code[index] === "\n") {
      line++;
    }
  }
  return line;
};

const columnOf = (code, offset) => {
  const lastNewline = code.lastIndexOf("\n", offset - 1);
  return offset - (lastNewline + 1);
};

// Collect every AST node that carries a loc.
const collectNodes = (ast) => {
  const nodes = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") {
      return;
    }
    if (node.type) {
      nodes.push(node);
    }
    Object.values(node).forEach(walk);
  };
  walk(ast);
  return nodes;
};

const loadAst = (name) => {
  const jsonPath = join(outputRoot, `${name}.json`);
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  return data;
};

// One fixture case: content, the candidate expected to parse it, and a
// template binding to locate (`needle` + `shift` gives the offset of
// `bindingText` in the fixture; `name` for a masked name whose slice no
// longer matches the file, e.g. `v-slot:footer` masked to `v-slot-footer`).
const cases = [];

// Item A: each HTML void element, unclosed, with an attribute binding. The
// whole-file candidate must parse it with every position kept.
for (const tag of [
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]) {
  cases.push({
    name: `void-${tag}.vue`,
    content: sfc(`  <form>\n    <${tag} :disabled="isDisabled" type="text">\n  </form>\n`),
    candidate: null,
    needle: ':disabled="isDisabled"',
    shift: ':disabled="'.length,
    bindingText: "isDisabled"
  });
}

// Item A good twins: shapes that were already fine and must stay untouched.
const voidTwin = (name, tag, markup, needle, shift, bindingText) => ({
  name,
  content: sfc(`  <form>\n    ${markup}\n  </form>\n`),
  candidate: ["full", "directive-full"],
  needle,
  shift,
  bindingText,
  keepElement: tag
});
cases.push(
  voidTwin(
    "void-twin-selfclosed.vue",
    "input",
    '<input :disabled="isDisabled" type="text"/>',
    ':disabled="isDisabled"',
    ':disabled="'.length,
    "isDisabled"
  ),
  voidTwin(
    "void-twin-selfclosed-space.vue",
    "input",
    '<input :disabled="isDisabled" type="text" />',
    ':disabled="isDisabled"',
    ':disabled="'.length,
    "isDisabled"
  ),
  voidTwin(
    "void-twin-explicit-close.vue",
    "input",
    '<input :disabled="isDisabled" type="text"></input>',
    ':disabled="isDisabled"',
    ':disabled="'.length,
    "isDisabled"
  ),
  voidTwin(
    "void-twin-component.vue",
    "Input",
    '<Input :label="inLabel">child</Input>',
    ':label="inLabel"',
    ':label="'.length,
    "inLabel"
  )
);
cases.push({
  name: "void-twin-script-string.vue",
  content: sfc(
    `  <form>\n    <hr :disabled="isDisabled">\n  </form>\n`,
    `const html = '<input type="text">'\n${SCRIPT}`
  ),
  candidate: null,
  needle: "'<input type=\"text\">'",
  shift: 0,
  bindingText: "'<input type=\"text\">'"
});
cases.push({
  name: "void-twin-comment.vue",
  content: sfc(
    `  <!-- <input type="text"> -->\n  <form>\n    <hr :disabled="isDisabled">\n  </form>\n`
  ),
  candidate: null,
  needle: ':disabled="isDisabled"',
  shift: ':disabled="'.length,
  bindingText: "isDisabled"
});
// A quoted `>` inside an attribute value must not end the tag.
cases.push({
  name: "void-quoted-gt.vue",
  content: sfc(`  <form>\n    <input :disabled="a > b" type="text">\n  </form>\n`),
  candidate: null,
  needle: ':disabled="a > b"',
  shift: ':disabled="'.length,
  bindingText: "a > b"
});
// The same, with a value Babel cannot parse as an expression, so it stays a
// quoted string in every candidate: the scanner's quote handling is the only
// thing keeping the `>` from ending the tag.
cases.push({
  name: "void-quoted-unparseable-gt.vue",
  content: sfc(
    `  <form>\n    <input :probe="1 >" :disabled="isDisabled" type="text">\n  </form>\n`
  ),
  candidate: null,
  needle: ':disabled="isDisabled"',
  shift: ':disabled="'.length,
  bindingText: "isDisabled"
});

// Item B: the slot shorthand and a bare v-slot, in the shapes vue3-realworld
// uses inside a <Suspense>.
const suspenseBody = (slot) =>
  `  <Suspense>\n    <template ${slot}>\n      <div>panel</div>\n    </template>\n  </Suspense>\n`;
cases.push({
  name: "slot-fallback.vue",
  content: sfc(suspenseBody("#fallback")),
  candidate: null,
  needle: "#fallback",
  shift: 1,
  bindingText: "fallback"
});
cases.push({
  name: "slot-item-destructured.vue",
  content: sfc(suspenseBody('#item="{ row }"')),
  candidate: null,
  needle: '#item="{ row }"',
  shift: "#item=".length,
  bindingText: '"{ row }"'
});
cases.push({
  name: "slot-dynamic.vue",
  content: sfc(suspenseBody("#[name]")),
  candidate: null,
  needle: "#[name]",
  shift: 2,
  bindingText: "name"
});
cases.push({
  name: "slot-v-slot-named.vue",
  content: sfc(suspenseBody("v-slot:footer")),
  candidate: null,
  needle: "v-slot:footer",
  shift: 0,
  bindingText: "v-slot-footer",
  maskedName: true
});
cases.push({
  name: "slot-v-slot-bare.vue",
  content: sfc(suspenseBody("v-slot")),
  candidate: null,
  needle: "div>panel",
  shift: "div>".length,
  bindingText: "panel"
});
// Item B good twins: a `#` in an attribute value or an interpolation is not a
// slot and must survive byte for byte.
cases.push({
  name: "slot-twin-href.vue",
  content: sfc(`  <a href="#top" :title="linkTitle">top</a>\n`),
  candidate: ["full", "directive-full"],
  needle: 'href="#top"',
  shift: 'href='.length,
  bindingText: '"#top"'
});
cases.push({
  name: "slot-twin-interpolation.vue",
  content: sfc(`  <div :class="cls">{{ '#x' }}</div>\n`),
  candidate: ["full", "directive-full"],
  needle: "'#x'",
  shift: 0,
  bindingText: "'#x'"
});

// Item C: the finding's addendum. A script before an unparseable template used
// to lose its imports to `template-only` or get them relocated by
// `script-only`; `script-in-place` keeps the script at its lines.
cases.push({
  name: "script-first-unparseable.vue",
  content:
    "<script setup>\nimport axios from 'axios'\nexport const y = 2;\n</script><template><div>{{ y</div></template>\n",
  candidate: "script-in-place",
  needle: "import axios",
  shift: 0,
  bindingText: "import axios from 'axios'"
});
// The one-line addendum shape parses with the whole-file candidate.
cases.push({
  name: "script-first-one-line.vue",
  content:
    '<script setup>import axios from \'axios\';</script><template><div>{{ y\n}}</div></template>\n',
  candidate: "full",
  needle: "import axios",
  shift: 0,
  bindingText: "import axios from 'axios';"
});

// CRLF twins of one case per item: same lines, same columns.
const crlf = (testCase, suffix) => ({
  ...testCase,
  name: testCase.name.replace(/\.vue$/, suffix),
  content: testCase.content.replace(/\n/g, "\r\n")
});
const crlfCases = [
  crlf(cases.find((c) => c.name === "void-input.vue"), "-crlf.vue"),
  crlf(cases.find((c) => c.name === "slot-fallback.vue"), "-crlf.vue"),
  crlf(cases.find((c) => c.name === "script-first-unparseable.vue"), "-crlf.vue")
];

const allCases = [...cases, ...crlfCases];

function runAstgenOnce() {
  for (const testCase of allCases) {
    writeFileSync(join(fixtureRoot, testCase.name), testCase.content, "utf8");
  }
  execFileSync(
    process.execPath,
    [join(repoRoot, "astgen.js"), "-i", fixtureRoot, "-o", outputRoot, "-t", "js"],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function evaluateCase(testCase) {
  // Geometry, asserted for every candidate of every fixture: no candidate may
  // move the script or lose a line, because Babel's loc then stops addressing
  // the file.
  const candidates = buildVueParseCandidates(testCase.content);
  assert.ok(candidates.length > 0, `${testCase.name}: no parse candidates built`);
  for (const candidate of candidates) {
    assert.ok(
      vueGeometryPreserved(testCase.content, candidate.code),
      `${testCase.name}: candidate "${candidate.name}" does not preserve the file's geometry`
    );
  }

  const data = loadAst(testCase.name);
  assert.ok(data.ast?.program, `${testCase.name}: AST payload missing`);

  // The import's line comes from counting the fixture's lines.
  const importOffset = testCase.content.indexOf("import axios");
  assert.notEqual(importOffset, -1, `${testCase.name}: fixture has no import`);
  const importLine = lineOf(testCase.content, importOffset);
  const importNode = data.ast.program.body.find(
    (node) => node.type === "ImportDeclaration"
  );
  assert.ok(importNode, `${testCase.name}: import missing from the AST`);
  assert.equal(
    importNode.loc.start.line,
    importLine,
    `${testCase.name}: import line ${importNode.loc.start.line}, file has it on ${importLine}`
  );
  assert.equal(
    importNode.loc.start.column,
    columnOf(testCase.content, importOffset),
    `${testCase.name}: import column does not match the file`
  );

  // The json says which candidate parsed.
  assert.ok(data.sfcCandidate, `${testCase.name}: sfcCandidate missing from the json`);
  if (testCase.candidate) {
    const acceptable = Array.isArray(testCase.candidate)
      ? testCase.candidate
      : [testCase.candidate];
    assert.ok(
      acceptable.includes(data.sfcCandidate),
      `${testCase.name}: parsed with "${data.sfcCandidate}", expected one of ${acceptable.join(", ")}`
    );
  }

  // One template binding keeps its line and column against the file.
  const needleOffset = testCase.content.indexOf(testCase.needle);
  assert.notEqual(needleOffset, -1, `${testCase.name}: needle missing from fixture`);
  const bindingOffset = needleOffset + testCase.shift;
  const nodes = collectNodes(data.ast);
  // a node that shares its start Position object with its parent (a JSX
  // attribute name does) serializes with an empty loc, a long-standing quirk
  // of the circular replacer; any node at the offset that still carries a loc
  // proves the position, so prefer it
  const bindingMatches = nodes.filter(
    (node) =>
      node.start === bindingOffset &&
      (testCase.maskedName
        ? (node.type === "JSXIdentifier" && node.name === testCase.bindingText) ||
          (node.type === "JSXAttribute" && node.name?.name === testCase.bindingText)
        : testCase.content.slice(node.start, node.end) === testCase.bindingText)
  );
  const bindingNode =
    bindingMatches.find((node) => node.loc?.start) ?? bindingMatches[0];
  assert.ok(
    bindingNode,
    `${testCase.name}: no AST node for "${testCase.bindingText}" at offset ${bindingOffset}`
  );
  assert.equal(
    bindingNode.loc.start.line,
    lineOf(testCase.content, bindingOffset),
    `${testCase.name}: binding line ${bindingNode.loc.start.line}, file has it on ${lineOf(testCase.content, bindingOffset)}`
  );
  assert.equal(
    bindingNode.loc.start.column,
    columnOf(testCase.content, bindingOffset),
    `${testCase.name}: binding column does not match the file`
  );

  if (!testCase.maskedName) {
    assert.equal(
      testCase.content.slice(bindingNode.start, bindingNode.end),
      testCase.bindingText,
      `${testCase.name}: binding offsets do not address the file's text`
    );
  }

  // A good twin is untouched: its element is still in the AST, at its offset.
  if (testCase.keepElement) {
    const elementOffset = testCase.content.indexOf(`<${testCase.keepElement}`);
    const kept = nodes.some(
      (node) =>
        node.type === "JSXOpeningElement" &&
        node.name?.name === testCase.keepElement &&
        node.start === elementOffset
    );
    assert.ok(
      kept,
      `${testCase.name}: the <${testCase.keepElement}> element was masked away; a self-closed or explicitly closed tag must stay untouched`
    );
  }
}

// A generated template must never produce a candidate that moves text:
// the geometry helper is checked for every candidate of random combinations
// of void elements (unclosed, self-closed, explicitly closed), slot
// shorthands, quoted `>` values, `#` in values and interpolations.
function evaluateGeneratedGeometry() {
  const voidTags = fc.constantFrom(
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "param", "source", "track", "wbr"
  );
  const elementArb = fc.letrec((tie) => ({
    node: fc.oneof(
      voidTags.map((tag) => {
        const style = fc.constantFrom("open", "selfclosed", "spaced", "closed");
        // the tag spelling is drawn independently of the tag
        return style.map((form) =>
          form === "open"
            ? `<${tag} :disabled="a > b">`
            : form === "selfclosed"
              ? `<${tag} :disabled="a > b"/>`
              : form === "spaced"
                ? `<${tag} :disabled="a > b" />`
                : `<${tag} :disabled="a > b"></${tag}>`
        );
      }),
      fc.constantFrom(
        "<div #one>{{ a < b }}</div>",
        '<List><template #item="{ row }"><span>{{ row.k }}</span></template></List>',
        "<Suspense><template #fallback>...</template><template v-slot:footer>f</template></Suspense>",
        '<a href="#top" :title="t">{{ \'#x\' }}</a>',
        '<Input :label="l">child</Input>',
        "<template v-slot><p>p</p></template>"
      ),
      tie("wrap")
    ),
    wrap: fc
      .array(tie("node"), { minLength: 1, maxLength: 4 })
      .map((children) => `<section #[name] class="s">\n${children.join("\n")}\n</section>`)
  }));

  const templateArb = fc
    .array(elementArb.node, { minLength: 1, maxLength: 6 })
    .map((elements) => sfc(`${elements.join("\n")}\n`));

  fc.assert(
    fc.property(templateArb, (content) => {
      const candidates = buildVueParseCandidates(content);
      for (const candidate of candidates) {
        assert.ok(
          vueGeometryPreserved(content, candidate.code),
          `generated template: candidate "${candidate.name}" does not preserve geometry`
        );
      }
    }),
    { numRuns: 150 }
  );
}

// The helper itself must reject the old disease: a script moved to the top of
// the buffer (the removed `combined` and `script-only` forms), a dropped `\r`,
// and any length change.
function evaluateGeometryHelperRejectsRelocation() {
  const content = sfc(`  <form>\n    <input :disabled="isDisabled">\n  </form>\n`);
  const script = "import axios from 'axios'\n\nexport const send = () => axios.post('/y')\n";
  const maskedRest = content.replace(/[^\r\n]/g, " ");
  const relocated = `${script}\n${maskedRest}`;
  assert.equal(content.length === relocated.length, false);
  assert.equal(
    vueGeometryPreserved(content, relocated),
    false,
    "a script moved to the top of the buffer is not the file's geometry"
  );
  const crlfContent = content.replace(/\n/g, "\r\n");
  assert.equal(
    vueGeometryPreserved(crlfContent, content),
    false,
    "dropping every \\r changes the geometry"
  );
  assert.equal(
    vueGeometryPreserved(content, `${content} `),
    false,
    "a length change is not the file's geometry"
  );
  assert.equal(
    vueGeometryPreserved(crlfContent, crlfContent.replace("isDisabled", "xsDisabled")),
    true,
    "a same-length, same-newline rewrite preserves geometry"
  );
}

try {
  runAstgenOnce();
  for (const testCase of allCases) {
    evaluateCase(testCase);
  }
  evaluateGeneratedGeometry();
  evaluateGeometryHelperRejectsRelocation();
  console.log("astgen Vue positions regression tests passed");
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
