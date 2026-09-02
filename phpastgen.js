#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectPhp } from "@appthreat/atom-common";

let url = import.meta.url;
if (!url.startsWith("file://")) {
  url = new URL(`file://${import.meta.url}`).toString();
}
const dirName = import.meta ? dirname(fileURLToPath(url)) : __dirname;
export const PLUGINS_HOME = join(dirName, "plugins");
export const PARENT_NODE_PLUGINS_HOME = join(
  dirName,
  "..",
  "..",
  "node_modules",
  "@appthreat",
  "atom-parsetools",
  "plugins"
);
let PHP_PARSER_BIN =
  process.env.PHP_PARSER_BIN || join(PLUGINS_HOME, "bin", "php-parse");
if (
  !existsSync(PHP_PARSER_BIN) &&
  existsSync(join(PARENT_NODE_PLUGINS_HOME, "bin", "php-parse"))
) {
  PHP_PARSER_BIN = join(PARENT_NODE_PLUGINS_HOME, "bin", "php-parse");
}
// `timeout` must be a number: spawnSync throws ERR_INVALID_ARG_TYPE on the raw string an
// environment variable gives us. Unset or unparseable means no timeout.
function spawnTimeout() {
  const timeout = Number.parseInt(
    process.env.ATOM_TIMEOUT || process.env.ASTGEN_TIMEOUT,
    10
  );
  return Number.isNaN(timeout) ? undefined : timeout;
}
function main(argvs) {
  if (!detectPhp()) {
    console.warn("PHP is not installed!");
    return false;
  }
  const cwd = process.env.ATOM_CWD || process.cwd();
  // Insert the parser path, do not replace argv[0]: splice(0, 1, ...) dropped the caller's first
  // flag, which silently disabled `--with-recovery` for every file chen parses.
  argvs.splice(0, 0, PHP_PARSER_BIN);
  spawnSync(process.env.PHP_CMD || "php", argvs, {
    encoding: "utf-8",
    cwd,
    stdio: "inherit",
    stderr: "inherit",
    env: process.env,
    timeout: spawnTimeout()
  });
}
main(process.argv.slice(2));
