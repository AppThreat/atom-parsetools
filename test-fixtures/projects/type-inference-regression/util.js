/** @type {3} */
export const DEFAULT_COUNT = 3;

/**
 * @param {number} value
 * @returns {string}
 */
export function makeLabel(value) {
  return `count:${value}`;
}

/**
 * @template T
 * @param {T} value
 * @returns {{ value: T }}
 */
export function box(value) {
  return { value };
}
