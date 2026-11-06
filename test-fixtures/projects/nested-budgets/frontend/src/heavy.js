function scan(opts) {
  let components = [];
  if (opts.t0) { components = components.concat(load0(opts)); }
  if (opts.t1) { components = components.concat(load1(opts)); }
  if (opts.t2) { components = components.concat(load2(opts)); }
  if (opts.t3) { components = components.concat(load3(opts)); }
  if (opts.t4) { components = components.concat(load4(opts)); }
  if (opts.t5) { components = components.concat(load5(opts)); }
  if (opts.t6) { components = components.concat(load6(opts)); }
  if (opts.t7) { components = components.concat(load7(opts)); }
  if (opts.t8) { components = components.concat(load8(opts)); }
  if (opts.t9) { components = components.concat(load9(opts)); }
  if (opts.t10) { components = components.concat(load10(opts)); }
  if (opts.t11) { components = components.concat(load11(opts)); }
  if (opts.t12) { components = components.concat(load12(opts)); }
  if (opts.t13) { components = components.concat(load13(opts)); }
  if (opts.t14) { components = components.concat(load14(opts)); }
  if (opts.t15) { components = components.concat(load15(opts)); }
  if (opts.t16) { components = components.concat(load16(opts)); }
  if (opts.t17) { components = components.concat(load17(opts)); }
  if (opts.t18) { components = components.concat(load18(opts)); }
  if (opts.t19) { components = components.concat(load19(opts)); }
  return components;
}
function load0(o) { return [{ name: "c0", o }]; }
function load1(o) { return [{ name: "c1", o }]; }
function load2(o) { return [{ name: "c2", o }]; }
function load3(o) { return [{ name: "c3", o }]; }
function load4(o) { return [{ name: "c4", o }]; }
function load5(o) { return [{ name: "c5", o }]; }
function load6(o) { return [{ name: "c6", o }]; }
function load7(o) { return [{ name: "c7", o }]; }
function load8(o) { return [{ name: "c8", o }]; }
function load9(o) { return [{ name: "c9", o }]; }
function load10(o) { return [{ name: "c10", o }]; }
function load11(o) { return [{ name: "c11", o }]; }
function load12(o) { return [{ name: "c12", o }]; }
function load13(o) { return [{ name: "c13", o }]; }
function load14(o) { return [{ name: "c14", o }]; }
function load15(o) { return [{ name: "c15", o }]; }
function load16(o) { return [{ name: "c16", o }]; }
function load17(o) { return [{ name: "c17", o }]; }
function load18(o) { return [{ name: "c18", o }]; }
function load19(o) { return [{ name: "c19", o }]; }
module.exports = { scan };
