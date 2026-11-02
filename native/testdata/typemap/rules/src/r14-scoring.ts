// A method without modifiers starts at its name: the return type and the signature compete for one offset.
export class Scoring {
  m(a: number) { return a; }
  static s() { return { x: 1 }; }
}
export function onlyName(a: string) { return a; }
export const arrowVar = (a: string) => ({ a });
