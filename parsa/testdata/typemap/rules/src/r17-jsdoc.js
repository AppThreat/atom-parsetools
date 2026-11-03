/** @type {import('./r04-property-declaration').Props} */
const props = null;
/** @type {Array<string>} */
const list = [];
/**
 * @param {string} name
 * @param {number} [count]
 * @returns {boolean}
 */
function check(name, count) { return name.length > (count || 0); }
const cast = /** @type {{ id: number }} */ (JSON.parse("{}"));
/** @typedef {{ a: string, b: number }} Pair */
/** @type {Pair} */
const pair = { a: "x", b: 1 };
module.exports = { props, list, check, cast, pair };
