declare const n: number; declare const s: string; declare const o: { a?: number };
export const bin = n * 2 + 1;
export const cmp = n > 3 && s.length > 1;
export const logic = s || "default";
export const nullish = o.a ?? 0;
export const cond = n > 1 ? s : n;
export const tpl = `v=${n}`;
export const tplPlain = `plain`;
function tag(strings: TemplateStringsArray, ...v: unknown[]) { return strings.length + v.length; }
export const tagged = tag`a${n}b`;
export function* gen() { const got = yield 1; return got; }
export const spread = [...[1, 2], ...s];
export const del = delete o.a;
export const typeofExpr = typeof n;
export const voided = void 0;
