// Normalizations for comparing type strings written by TypeScript 6 and TypeScript 7.
//
// Each normalization has an id, a justification and examples, and the test suite
// (test-fixtures/typemap-diff-regression.js) checks that it equates the positive
// examples and keeps the negative ones apart. A normalization may only equate
// strings that name the same type. Anything that cannot be shown to be the same
// stays a difference and is reported.

export const NORMALIZATIONS = [
  {
    id: "union-order",
    description: "Members of a union are compared as a set, at any nesting depth.",
    justification:
      "TypeScript 7 orders union members by a stable key and TypeScript 6 by type id, so the same union prints in two orders. The members, and their count, are unchanged.",
    equal: [
      ['"ADMIN" | "USER"', '"USER" | "ADMIN"'],
      ["Promise<string | number>", "Promise<number | string>"],
      ["(z: boolean) => 1 | \"no\"", "(z: boolean) => \"no\" | 1"],
      ["Array<A | B>", "Array<B | A>"]
    ],
    different: [
      ['"ADMIN" | "USER"', '"ADMIN" | "OTHER"'],
      ["string | number", "string | number | boolean"],
      ["(a: string) => number", "(a: number) => string"]
    ]
  },
  {
    id: "object-member-order",
    description: "Property members of an object type are compared as a set. Call and construct signatures keep their order.",
    justification:
      "TypeScript 7 sorts property members of printed object types by a stable key. Overload order is meaningful in both versions, so signatures are not reordered.",
    equal: [
      ["{ b: number; a: string; }", "{ a: string; b: number; }"],
      ["Promise<{ y: 1; x: 2; }>", "Promise<{ x: 2; y: 1; }>"]
    ],
    different: [
      ["{ a: string; }", "{ a: number; }"],
      ["{ (a: string): void; (a: number): void; }", "{ (a: number): void; (a: string): void; }"],
      ["{ a: string; }", "{ a: string; b: number; }"]
    ]
  },
  {
    id: "quote-style",
    description: "String literal types are compared by value, not by the quote character.",
    justification:
      "TypeScript 6 printed literal types with double quotes; TypeScript 7 keeps the quote style of the source text. The value is the same.",
    equal: [
      ["'a' | 'b'", '"a" | "b"'],
      ["{ k: 'v'; }", '{ k: "v"; }'],
      ["'it\\'s'", '"it\'s"']
    ],
    different: [
      ["'a'", '"b"'],
      ["'a'", "string"]
    ]
  },
  {
    id: "typeof-vs-signature",
    description: "`typeof name` in the baseline matches a function type in the candidate.",
    justification:
      "TypeScript 6 printed a JavaScript function as `typeof name`; TypeScript 7 prints its signature. Only a plain `typeof` of a name against a function type is equated, never against any other type, and when sources are available the name must occur in the source text of the node.",
    equal: [
      ["typeof setFromEuler", "(x: number) => void"],
      ["typeof a.b.c", "() => string"]
    ],
    different: [
      ["typeof setFromEuler", "string"],
      ["typeof setFromEuler", "{ a: 1; }"],
      ["typeof import(\"x\")", "(x: number) => void"]
    ]
  },
  {
    id: "bom-shift",
    description: "In a file that starts with a byte order mark the candidate offset is the baseline offset plus one.",
    justification:
      "astgen 1.10.6 wrote type map keys without the byte order mark while Babel's node offsets count it, so keys and AST nodes do not join in such files. The native binary counts it. Applied by shifting candidate keys, only for files whose source starts with U+FEFF.",
    equal: [],
    different: []
  }
];

const OPEN = { "(": ")", "<": ">", "[": "]", "{": "}" };

// ---- tokenizer ----

function tokenize(s) {
  const toks = [];
  let i = 0;
  const n = s.length;
  let word = "";
  const flush = () => {
    const w = word.trim();
    if (w) toks.push({ t: "w", v: w });
    word = "";
  };
  while (i < n) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      flush();
      let j = i + 1;
      while (j < n && s[j] !== c) {
        if (s[j] === "\\") j++;
        j++;
      }
      toks.push({ t: c === "`" ? "w" : "s", v: s.slice(i, j + 1), q: c });
      i = j + 1;
      continue;
    }
    if (c === "=" && s[i + 1] === ">") {
      flush();
      toks.push({ t: "arrow" });
      i += 2;
      continue;
    }
    if (c in OPEN) {
      flush();
      toks.push({ t: "open", v: c });
    } else if (c === ")" || c === ">" || c === "]" || c === "}") {
      flush();
      toks.push({ t: "close", v: c });
    } else if (c === "|" || c === "&" || c === "," || c === ";") {
      flush();
      toks.push({ t: "sep", v: c });
    } else {
      word += c;
    }
    i++;
  }
  flush();
  return toks;
}

function unquote(tok) {
  // value of a '...' or "..." literal
  const body = tok.v.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) {
      out += body[++i];
    } else {
      out += body[i];
    }
  }
  return out;
}

// ---- tree ----

// A group is { open, items: [token|group...], close }.
function buildTree(toks) {
  const root = { open: "", items: [], close: "" };
  const stack = [root];
  for (const tk of toks) {
    const top = stack[stack.length - 1];
    if (tk.t === "open") {
      const g = { open: tk.v, items: [], close: OPEN[tk.v] };
      top.items.push(g);
      stack.push(g);
    } else if (tk.t === "close") {
      // An unmatched closer (the `>` of an arrow type was consumed as `=>`; others are real).
      if (stack.length > 1 && OPEN[stack[stack.length - 1].open] === tk.v) {
        stack.pop();
      } else {
        top.items.push({ t: "w", v: tk.v });
      }
    } else {
      top.items.push(tk);
    }
  }
  return root;
}

// ---- printing with options ----

function printItems(items, opts, isObject) {
  // split at top-level arrow: left side params, right side return type (extends to the end)
  const arrow = items.findIndex((x) => x.t === "arrow");
  if (arrow >= 0) {
    return `${printItems(items.slice(0, arrow), opts, false)} => ${printItems(items.slice(arrow + 1), opts, false)}`;
  }
  if (isObject) {
    // members are separated by ; or ,
    const members = splitOn(items, (x) => x.t === "sep" && (x.v === ";" || x.v === ","));
    const printed = members.filter((m) => m.length).map((m) => printUnionAware(m, opts));
    if (!opts.objectOrder) return printed.join("; ");
    const isSig = (p) => /^(\(|<|new\s*[(<])/.test(p);
    const sigs = printed.filter(isSig);
    const props = printed.filter((p) => !isSig(p)).sort();
    return [...sigs, ...props].join("; ");
  }
  return printUnionAware(items, opts);
}

function splitOn(items, pred) {
  const parts = [[]];
  for (const it of items) {
    if (pred(it)) parts.push([]);
    else parts[parts.length - 1].push(it);
  }
  return parts;
}

function printUnionAware(items, opts) {
  const terms = splitOn(items, (x) => x.t === "sep" && x.v === "|");
  const printed = terms.map((t) => printTerm(t, opts));
  if (terms.length > 1 && opts.unionOrder) printed.sort();
  return printed.join(" | ");
}

function printTerm(items, opts) {
  // intersections keep their order
  const parts = splitOn(items, (x) => x.t === "sep" && x.v === "&");
  return parts.map((p) => printAtoms(p, opts)).join(" & ");
}

function printAtoms(items, opts) {
  const out = [];
  for (const it of items) {
    if (it.open !== undefined) {
      out.push(printGroup(it, opts));
    } else if (it.t === "s") {
      out.push(opts.quotes ? JSON.stringify(unquote(it)) : it.v);
    } else if (it.t === "sep") {
      out.push(it.v === "," ? "," : ` ${it.v} `);
    } else if (it.t === "arrow") {
      out.push(" => ");
    } else {
      out.push(it.v);
    }
  }
  return out.join(" ").replace(/ ,/g, ",").replace(/\s+/g, " ").replace(/ ?=> ?/g, " => ").trim();
}

function printGroup(g, opts) {
  if (g.open === "{") {
    const body = printItems(g.items, opts, true);
    return body ? `{ ${body}; }` : "{}";
  }
  const parts = splitOn(g.items, (x) => x.t === "sep" && x.v === ",").map((p) => printItems(p, opts, false));
  return `${g.open}${parts.join(", ")}${g.close}`;
}

// canon returns the canonical form of a type string with the given normalizations on.
export function canon(s, ids) {
  const opts = {
    unionOrder: ids.includes("union-order"),
    objectOrder: ids.includes("object-member-order"),
    quotes: ids.includes("quote-style")
  };
  const tree = buildTree(tokenize(s));
  return printItems(tree.items, opts, false);
}

const TYPEOF_NAME = /^typeof [A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

function isFunctionType(s) {
  const toks = tokenize(s);
  const tree = buildTree(toks);
  // a function type has a top-level arrow after a parenthesized or generic parameter list
  const items = tree.items;
  const arrow = items.findIndex((x) => x.t === "arrow");
  if (arrow < 1) return false;
  const first = items[0];
  const startsNew = first.t === "w" && /^(new|abstract new)$/.test(first.v);
  const left = items[startsNew ? 1 : 0];
  const isParams = left && left.open === "(";
  const isGeneric = left && left.open === "<" && items[(startsNew ? 1 : 0) + 1]?.open === "(";
  return Boolean(isParams || isGeneric) && splitOn(items, (x) => x.t === "sep" && x.v === "|").length === 1;
}

// Returns the list of normalization ids needed to make baseline and candidate equal,
// [] when they are already identical, or undefined when they differ.
export function equalAfterNormalization(baseline, candidate, ctx = {}) {
  if (baseline === candidate) return [];
  const sets = [
    [],
    ["quote-style"],
    ["union-order"],
    ["object-member-order"],
    ["union-order", "object-member-order"],
    ["quote-style", "union-order"],
    ["quote-style", "object-member-order"],
    ["quote-style", "union-order", "object-member-order"]
  ];
  // the smallest set that makes them equal is the one reported
  for (const ids of sets) {
    if (ids.length && canon(baseline, ids) === canon(candidate, ids)) return ids;
  }
  if (TYPEOF_NAME.test(baseline) && isFunctionType(candidate)) {
    const last = baseline.split(".").pop().replace("typeof ", "");
    if (ctx.nodeText === undefined || ctx.nodeText.includes(last)) return ["typeof-vs-signature"];
  }
  return undefined;
}
