// The pure parts of the accuracy check, over bytes and objects built here: the constant pool
// reader against hand laid out class files, the zip central directory reader against a hand
// packed jar, and the library scoring and the baseline difference over small inputs.
import { strict as assert } from "node:assert";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

import {
  baselineDiff,
  constantPoolClasses,
  dottedClassName,
  scalasemVersion,
  scoreLibraries,
  zipEntryNames
} from "./scalasem-accuracy-lib.js";

// The class file format counts big endian, the zip format little endian.
const be16 = (value) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
};
const u16 = be16;
const le16 = (value) => {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
};
const u32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
};

// A class file holds only what the reader reads: the magic, the versions and the constant
// pool it names the size of. The pool is one based; an entry that takes two slots, a long or
// a double here, shifts every slot after it.
function classBytes(entries) {
  const slots = entries.reduce(
    (total, entry) => total + (entry.tag === 5 || entry.tag === 6 ? 2 : 1),
    0
  );
  const parts = [
    Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
    u16(0),
    u16(61),
    u16(slots + 1)
  ];
  for (const entry of entries) {
    if (entry.tag === 1) {
      const text = Buffer.from(entry.text, "utf-8");
      parts.push(Buffer.from([1]), u16(text.length), text);
    } else if (entry.tag === 7) {
      parts.push(Buffer.from([7]), u16(entry.index));
    } else if (entry.tag === 5 || entry.tag === 6) {
      parts.push(Buffer.from([entry.tag]), Buffer.alloc(8));
    } else if (entry.tag === 10) {
      parts.push(
        Buffer.from([10]),
        u16(entry.classIndex),
        u16(entry.nameAndTypeIndex)
      );
    } else if (entry.tag === 12) {
      parts.push(
        Buffer.from([12]),
        u16(entry.nameIndex),
        u16(entry.descriptorIndex)
      );
    } else {
      throw new Error(`the fixture does not lay out tag ${entry.tag}`);
    }
  }
  return Buffer.concat(parts);
}

// Slot 1: the name of the class itself, slot 2: the class entry that carries it. Slot 3 and
// 4: an array type and its class entry. Slots 5 and 6: a long. Slots 7 and 8: the name and
// the class entry of a library the method reference in slot 11 calls through the name and
// type of slots 9 and 10.
const pool = [
  { tag: 1, text: "org/example/Thing" },
  { tag: 7, index: 1 },
  { tag: 1, text: "[Ljava/util/List;" },
  { tag: 7, index: 3 },
  { tag: 5 },
  { tag: 1, text: "lib/Other" },
  { tag: 7, index: 7 },
  { tag: 1, text: "run" },
  { tag: 1, text: "()V" },
  { tag: 12, nameIndex: 8, descriptorIndex: 9 },
  { tag: 10, classIndex: 6, nameAndTypeIndex: 10 }
];
assert.deepStrictEqual(
  constantPoolClasses(classBytes(pool)),
  ["org.example.Thing", "java.util.List", "lib.Other"],
  "the constant pool names every class it carries, arrays unwrapped and two slot entries skipped"
);
assert.deepStrictEqual(
  constantPoolClasses(Buffer.from("not a class file")),
  [],
  "bytes that open no class file name no class"
);

function zipBytes(names) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf-8");
    // Local file header: signature, versions, flags, method, time, date, crc, sizes,
    // name length, extra length, then the name.
    locals.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        le16(20),
        le16(0),
        le16(0),
        le16(0),
        le16(0),
        u32(0),
        u32(0),
        u32(0),
        le16(nameBytes.length),
        le16(0),
        nameBytes
      ])
    );
    // Central directory entry: signature, versions, flags, method, time, date, crc, sizes,
    // name length, extra length, comment length, disk, attributes, header offset, then the
    // name.
    central.push(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        le16(20),
        le16(20),
        le16(0),
        le16(0),
        le16(0),
        le16(0),
        u32(0),
        u32(0),
        u32(0),
        le16(nameBytes.length),
        le16(0),
        le16(0),
        le16(0),
        le16(0),
        u32(0),
        u32(offset),
        nameBytes
      ])
    );
    offset += 30 + nameBytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    le16(0),
    le16(0),
    le16(names.length),
    le16(names.length),
    u32(directory.length),
    u32(offset),
    le16(0)
  ]);
  return Buffer.concat([...locals, directory, end]);
}
assert.deepStrictEqual(
  zipEntryNames(
    zipBytes([
      "org/example/Thing.class",
      "META-INF/MANIFEST.MF",
      "lib/Other.class"
    ])
  ),
  ["org/example/Thing.class", "META-INF/MANIFEST.MF", "lib/Other.class"],
  "the central directory names every entry of the jar"
);
assert.deepStrictEqual(
  zipEntryNames(Buffer.alloc(64)),
  [],
  "bytes that hold no zip end record name no entry"
);
assert.strictEqual(
  dottedClassName("org/example/Thing.class"),
  "org.example.Thing"
);
assert.strictEqual(dottedClassName("META-INF/MANIFEST.MF"), undefined);

const jars = [
  {
    group: "org.example",
    artifact: "used-and-named",
    version: "1.0",
    entries: ["org/example/Codec.class"]
  },
  {
    group: "org.example",
    artifact: "used-only",
    version: "2.0",
    entries: ["org/example/Hidden.class"]
  },
  {
    group: "org.example",
    artifact: "object-named",
    version: "2.5",
    entries: ["org/example/CipherBox.class", "org/example/CipherBox$.class"]
  },
  {
    group: "org.example",
    artifact: "named-only",
    version: "3.0",
    entries: ["org/example/OnlyNamed.class"]
  },
  {
    group: "io.appthreat",
    artifact: "upstream-module",
    version: "4.0",
    entries: ["io/appthreat/upstream/Part.class"]
  },
  {
    group: "org.example",
    artifact: "unused",
    version: "5.0",
    entries: ["org/example/Unused.class"]
  }
];
// The report names the object spelling of the box without its `$`, the class files reference
// the implementation class with it.
const scored = scoreLibraries(
  jars,
  ["org.example.Codec", "org.example.Hidden", "org.example.CipherBox$"],
  ["org.example.Codec", "org.example.OnlyNamed", "org.example.CipherBox"],
  "io.appthreat"
);
assert.deepStrictEqual(
  scored,
  {
    used: [
      { group: "org.example", artifact: "used-and-named", version: "1.0" },
      { group: "org.example", artifact: "used-only", version: "2.0" },
      { group: "org.example", artifact: "object-named", version: "2.5" }
    ],
    misses: [{ group: "org.example", artifact: "used-only", version: "2.0" }],
    suspects: [{ group: "org.example", artifact: "named-only", version: "3.0" }]
  },
  "a library the class files use and the report names is neither a miss nor a suspect"
);
assert.ok(
  !scored.used.some((c) => c.group === "io.appthreat"),
  "the project's own upstream modules stay out of the library scoring"
);
assert.strictEqual(
  scalasemVersion(),
  require("../package.json").version,
  "the version is the one of this checkout"
);

const current = {
  coverage: {
    overall: { files: 500, withFacts: 490, share: 0.98 },
    modules: [
      { id: "core", share: 1 },
      { id: "front", share: 0.95 }
    ]
  },
  counts: { calls: 1000, definitions: 500 },
  callSites: { namedShare: 0.97 },
  diagnostics: { "unresolved-symbols": 4 },
  failures: []
};
const baseline = {
  coverage: {
    overall: { files: 500, withFacts: 480, share: 0.96 },
    modules: [
      { id: "core", share: 1 },
      { id: "front", share: 0.99 }
    ]
  },
  counts: { calls: 1100, definitions: 500 },
  callSites: { namedShare: 0.98 },
  diagnostics: {},
  failures: []
};
const diff = baselineDiff(current, baseline);
assert.ok(
  diff.fields.some((f) => f.key === "coverage.withFacts" && f.delta === 10),
  "the coverage difference is counted"
);
assert.ok(
  diff.regressions.some((r) => r.startsWith("coverage.front:")) &&
    diff.regressions.some((r) => r.startsWith("calls:")) &&
    diff.regressions.some((r) =>
      r.startsWith("diagnostics.unresolved-symbols:")
    ),
  "a module covered less, fewer calls and a diagnostic that appears regress"
);
assert.ok(
  !diff.regressions.some((r) => r.startsWith("coverage.core:")),
  "a module whose share holds does not regress"
);
assert.ok(
  !baselineDiff(current, current).regressions.length,
  "the same numbers do not regress against themselves"
);

console.log(
  "scalasem-accuracy-units: the constant pool reader, the jar reader, the scoring and the baseline difference behave"
);
