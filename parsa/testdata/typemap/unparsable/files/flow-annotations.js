// @flow
// Flow annotations: tsgo recovers from this syntax instead of failing, Babel parses it with the
// flow plugin. The type map of a recovered tree must still land on nodes Babel has.
export function concat(a: string, b: ?string): string {
  return a + (b ?? "");
}

export const maybe: Array<number> = [1, 2, 3];

export function first<T: string | number>(xs: Array<T>): ?T {
  return xs[0];
}

const predicate = (x: mixed): %checks => typeof x === "number";

export default ({ flowAnnotated: true }: Object);
