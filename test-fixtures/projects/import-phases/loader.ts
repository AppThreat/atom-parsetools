import source wasmModule from "./math.wasm";
import defer * as reports from "./reports.js";

export async function instantiate(imports: WebAssembly.Imports) {
  const instance = await WebAssembly.instantiate(wasmModule, imports);
  return instance.exports;
}

export function deferredReports() {
  return import.defer("./reports.js");
}

export function summary(): string {
  return reports.render();
}
