class Point { constructor(public x: number, public y: number) {} dist() { return Math.hypot(this.x, this.y); } }
function id<T>(v: T): T { return v; }
const p = new Point(1, 2);
const d = p.dist();
const s = id("lit");
const arr = new Array<string>(3);
const u = JSON.parse("{}");
const lenient = id(u);
export { p, d, s, arr, lenient };
