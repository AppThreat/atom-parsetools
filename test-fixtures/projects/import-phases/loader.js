import source wasmModule from "./math.wasm";
import defer * as reports from "./reports.js";

export async function instantiate(imports) {
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  return instance.exports;
}

export function sourceOf(path) {
  return import.source(path);
}

export function summary() {
  return reports.render();
}
