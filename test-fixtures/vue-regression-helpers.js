// The Vue and Svelte regression tests share the same runner/loader/assertion
// helpers; the implementations live in ast-regression-helpers.js and are
// re-exported here for the existing Vue test imports.

export {
  createOutputRoot,
  runAstgen,
  readJson,
  countUnresolved,
  expectType,
  loadFixtureSet
} from "./ast-regression-helpers.js";
