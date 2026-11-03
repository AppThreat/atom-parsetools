const o = { list: [1, 2, 3], map: { k: "v" } as Record<string, string> };
export const e = o.list[1];
export const f = o.map["k"];
export const g = o.list.length;
export const h = o?.map.k;
