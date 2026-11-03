import sys
n=int(sys.argv[1]); variant=sys.argv[2] if len(sys.argv)>2 else "plain"
out=["// Generated: n sequential blocks that reassign an evolving array with concat.",
     "/** @param {string} kind */",
     "async function make(kind) { return { bomJson: { components: [{ name: kind }] } }; }",
     "/** @param {{ types: string[] }} options */",
     "export async function scan(options) {",
     "  let bomData;",
     "  " + ("/** @type {any[]} */ " if variant=="typed" else "") + "let components = [];"]
for i in range(n):
    out += [f"  if (options.types.includes('t{i}')) {{",
            f"    bomData = await make('t{i}');",
            "    if (bomData?.bomJson?.components?.length) {",
            "      components = components.concat(bomData.bomJson.components);",
            "    }",
            "  }"]
out += ["  return components;", "}"]
print("\n".join(out))
