import { DEFAULT_COUNT, box, makeLabel } from "./util.js";

const primitiveNumber = 42;
const primitiveString = "hello";
const numericList = [1, 2, 3];
const mixedRecord = { name: "Ada", score: 99, active: true };
const spreadRecord = { ...mixedRecord, role: "admin" };
const optionalScore = mixedRecord?.score;
const countLabel = makeLabel(DEFAULT_COUNT);
const boxedLabel = box(countLabel);
const destructuredValue = boxedLabel.value;
const tupleLike = /** @type {[number, string]} */ ([1, "one"]);
const [tupleNumber, tupleString] = tupleLike;
const expressionResult = Math.max(primitiveNumber, optionalScore ?? 0);
const ternaryResult = expressionResult > 40 ? "large" : "small";

/**
 * @param {number} left
 * @param {number} right
 * @returns {number}
 */
export function typedAdd(left, right) {
  return left + right;
}

export class Counter {
  /** @type {number} */
  value = 0;

  /** @param {number} step */
  increment(step) {
    this.value += step;
    return this.value;
  }
}

const counter = new Counter();
const nextValue = counter.increment(2);
