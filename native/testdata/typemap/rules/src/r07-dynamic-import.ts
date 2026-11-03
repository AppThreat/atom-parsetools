export const loaded = import("./r04-property-declaration");
export async function lazy() { const m = await import("./r04-property-declaration"); return m.Props; }
