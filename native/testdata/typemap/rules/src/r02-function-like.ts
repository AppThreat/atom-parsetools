export function plain(x: number, y = "s") { return x + y.length; }
export const arrow = (n: string) => n.length > 2;
export const expr = function named(z: boolean) { return z ? 1 : "no"; };
export class Shape {
  private w = 1;
  constructor(public name: string) {}
  area(scale: number): number { return this.w * scale; }
  get label() { return this.name + "!"; }
  set label(v: string) { this.name = v; }
}
export interface Api {
  (x: number): string;
  new (x: string): Api;
  call(a: boolean): void;
}
