namespace NS { export interface Inner { v: number } }
interface Gen<T> { item: T }
export const a: Promise<string> = Promise.resolve("x");
export const b: NS.Inner = { v: 1 };
export const c: Gen<number[]> = { item: [1] };
export const d: HTMLDivElement | null = null;
export function f(p: Map<string, Gen<boolean>>): Array<NS.Inner> { return []; }
export class Impl implements Gen<string> { item = "s"; }
export type Alias = Gen<Date>;
export const q: typeof a = a;
