// Ember (Glimmer) template regression tests for astgen.
//
// astgen rewrites an `.hbs` file, and the `<template>` blocks of a `.gjs`/`.gts`
// file, into TSX and parses that (see emberAst.js). The contract these tests pin:
//
//   1. Every newline stays where it was: the rewritten text has the file's line
//      count, and a template line's code is on its own line.
//   2. The rewritten text parses as JSX/TSX.
//   3. The shapes downstream relies on: `{{{x}}}` is `<ember-raw innerHTML={x} />`,
//      `@name` is `this.args.name`, a component's `@arg={{v}}` the attribute
//      `arg={v}`, an element modifier a spread of the modifier's call with
//      `(undefined, [positional], {named})`, a class body's template the method
//      `__glimmer_template`, any other one a function of that name, helpers
//      calls, blocks conditionals and callbacks.
//   4. astgen writes the rewritten text beside the AST as `source`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { lowerEmberFile } from "../emberAst.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const parses = (code, ts) =>
  parse(code, {
    sourceType: "module",
    plugins: [
      "jsx",
      ["decorators", { decoratorsBeforeExport: true }],
      ...(ts ? ["typescript"] : [])
    ]
  });

const lines = (text) => text.split("\n").length;

// a route template
const hbs = `{{! the controller is \`this\` }}
<h2>Search</h2>
<p>You searched for {{this.q}}</p> <!-- escaped -->
<p>{{{this.q}}}</p>
<SearchSummary @term={{this.q}} class="x {{if @wide 'wide'}}" />
{{#each @model as |hit index|}}
  <li {{on "click" (fn this.open hit)}}>{{format-date hit.at "short"}}</li>
{{else}}
  <p>None</p>
{{/each}}
{{#if this.loading}}
  <Spinner />
{{else if this.failed}}
  <p>Failed</p>
{{else}}
  {{outlet}}
{{/if}}
<input disabled value={{this.q}}>
`;
const lhbs = lowerEmberFile("app/templates/search.hbs", hbs);
assert.equal(lines(lhbs), lines(hbs), "an .hbs file keeps its line count");
parses(lhbs);
const hbsLine = (n) => lhbs.split("\n")[n - 1];
assert.match(
  hbsLine(1),
  /^export default function __glimmer_template\(\) \{ return <>/
);
assert.match(
  hbsLine(3),
  /\{this\.q\}/,
  "an escaped mustache is an expression container"
);
assert.match(
  hbsLine(4),
  /<ember-raw innerHTML=\{this\.q\} \/>/,
  "a triple-stash is the raw element"
);
assert.match(
  hbsLine(5),
  /<SearchSummary term=\{this\.q\}/,
  "a component argument is an attribute"
);
assert.match(
  hbsLine(5),
  /class=\{`x \$\{\(this\.args\.wide \? 'wide' : undefined\)\}`\}/
);
assert.match(
  hbsLine(6),
  /\{\(this\.args\.model\)\.map\(\(hit, index\) => <>/,
  "each is a map"
);
assert.match(
  hbsLine(7),
  /\{\.\.\.on\(undefined, \["click", \(fn\(this\.open, hit\)\)\], \{\}\)\}/
);
assert.match(
  hbsLine(7),
  /format_date\(hit\.at, "short"\)/,
  "a helper is a call"
);
assert.match(hbsLine(11), /\{\(this\.loading\) \? <>/, "if is a conditional");
assert.match(
  hbsLine(13),
  /<\/> : \(this\.failed\) \? <>/,
  "else if chains the conditional"
);
assert.match(
  hbsLine(18),
  /<input disabled value=\{this\.q\} \/>/,
  "a void element closes itself"
);

// components: a class with a template, a template-only component, a modifier
const gjs = `import Component from '@glimmer/component';
import innerHtml from 'docs-app/modifiers/inner-html';
const Badge = <template><b>{{@label}}</b></template>;

export default class Summary extends Component {
  get term() { return this.args.term ?? ''; }

  <template>
    <p>{{this.term}}</p>
    <div {{innerHtml this.term mode="raw"}}></div>
    <Badge @label={{this.term}} />
  </template>
}
`;
const lgjs = lowerEmberFile("app/components/summary.gjs", gjs);
assert.equal(lines(lgjs), lines(gjs), "a .gjs file keeps its line count");
parses(lgjs);
const gjsLine = (n) => lgjs.split("\n")[n - 1];
assert.match(
  gjsLine(3),
  /const Badge = \(function __glimmer_template\(\) \{ return <><b>\{this\.args\.label\}<\/b><\/>; \}\);/
);
assert.match(
  gjsLine(8),
  /^  __glimmer_template\(\) \{ return <>$/,
  "a class's template is a method"
);
assert.match(
  gjsLine(10),
  /\{\.\.\.innerHtml\(undefined, \[this\.term\], \{"mode": "raw"\}\)\}/
);
assert.match(gjsLine(11), /<Badge label=\{this\.term\}/);

// a template-only file and a .gts class
const only = `<template>
  {{{@body}}}
</template>
`;
const lonly = lowerEmberFile("app/components/body.gjs", only);
assert.equal(lines(lonly), lines(only));
parses(lonly);
assert.match(
  lonly,
  /^;\(function __glimmer_template\(\) \{ return <>/,
  "a statement of its own"
);
assert.match(
  lonly.split("\n")[1],
  /<ember-raw innerHTML=\{this\.args\.body\} \/>/
);

const gts = `import Component from '@glimmer/component';
interface Signature { Args: { html: string } }
export default class Raw extends Component<Signature> {
  <template>{{{@html}}}</template>
}
`;
const lgts = lowerEmberFile("app/components/raw.gts", gts);
assert.equal(lines(lgts), lines(gts));
parses(lgts, true);

assert.equal(
  lowerEmberFile("app/app.js", "x"),
  undefined,
  "other files are not rewritten"
);

// end to end: astgen emits the rewritten text as `source`
const work = mkdtempSync(join(tmpdir(), "astgen-ember-"));
try {
  const src = join(work, "src");
  const out = join(work, "out");
  mkdirSync(join(src, "app", "templates"), { recursive: true });
  writeFileSync(join(src, "app", "templates", "search.hbs"), hbs);
  execFileSync(
    process.execPath,
    [join(__dirname, "..", "astgen.js"), "-i", src, "-o", out, "-t", "js"],
    {
      stdio: "pipe"
    }
  );
  const data = JSON.parse(
    readFileSync(join(out, "app", "templates", "search.hbs.json"), "utf-8")
  );
  assert.equal(
    data.source,
    lhbs,
    "the AST comes with the text its offsets index"
  );
  assert.equal(
    data.ast.loweredSource,
    undefined,
    "the AST itself does not carry it"
  );
  assert.equal(data.ast.program.body[0].type, "ExportDefaultDeclaration");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log("astgen ember regression: ok");
