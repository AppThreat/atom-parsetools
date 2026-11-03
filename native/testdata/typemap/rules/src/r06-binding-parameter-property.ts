declare const pair: [string, { n: number }];
const [first, { n }] = pair;
const { port, ...rest } = { port: 80, host: "h", tls: true };
export function params(a: string, { b, c }: { b: number; c: boolean[] }, ...more: number[]) { return a + b + c + more; }
const shorthand = { first, n };
const props = { count: 1, label: "x", nested: { ok: true }, fn() { return 1; } };
export { port, rest, shorthand, props };
