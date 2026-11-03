// import() of a module that does not resolve: the checker has no type, the syntax fallback names it.
export async function viaImport() { return import("./does-not-exist"); }
export async function viaAwait() { return await import("./does-not-exist"); }
export const viaArrow = async () => import("./does-not-exist");
declare function opaque(): any;
export async function bodyUnion(flag: boolean) { if (flag) { return opaque(); } return "s"; }
