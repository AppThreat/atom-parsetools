declare const cfg: { port: number; hosts: string[] };
const explicit: Array<string> = [];
const fromProp = cfg.port;
const fromElem = cfg.hosts[0];
const fromCall = Math.max(1, 2);
function make() { return { id: 1, tags: ["a"] }; }
const made = make();
for (const ch of "abc") { console.log(ch); }
for (const k in cfg) { console.log(k); }
let later;
later = 3;
export { explicit, fromProp, fromElem, fromCall, made, later };
