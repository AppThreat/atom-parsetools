import { readFileSync } from "node:fs";

export const lines = readFileSync("notes.txt", "utf8").split("\n");
export const firstLine = lines[0];
