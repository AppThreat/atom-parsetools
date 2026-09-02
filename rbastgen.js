#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectRuby } from "@appthreat/atom-common";

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
// Ruby versions needed
const RUBY_VERSIONS_NEEDED = ["3.4.x", "4.0.x"];

/**
 * The vendored bundle is a plain gem repository of pure-Ruby gems, exposed to the child through
 * GEM_PATH rather than through the standalone loader bundler generates. That loader resolves its
 * paths with Gem.ruby_api_version, which pinned the whole package to the one Ruby ABI it was built
 * with; GEM_PATH does not care, so a single build serves every supported Ruby. prism and racc are
 * deliberately not vendored: they carry C extensions and are default gems in all supported Rubies,
 * so the runtime's own copies are used, and the grammar level follows the runtime's prism.
 *
 * @returns {string | undefined} path of the bundle/ruby directory
 */
function bundleHome() {
  for (const home of [PLUGINS_HOME, PARENT_NODE_PLUGINS_HOME]) {
    const bundle = join(home, "rubyastgen", "bundle", "ruby");
    if (existsSync(bundle)) {
      return bundle;
    }
  }
  return undefined;
}

function subDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Gem repositories to add to GEM_PATH: one per ABI directory in the bundle, whatever it is called.
 *
 * @param {string | undefined} bundle path of the bundle/ruby directory
 * @returns {string[]}
 */
export function gemPaths(bundle) {
  return bundle ? subDirs(bundle) : [];
}

/**
 * ruby_ast_gen itself is installed as a git gem, which RubyGems cannot activate from GEM_PATH, so
 * its lib directory goes on the load path directly. `RUBY_ASTGEN_BIN` points the run at a working
 * copy instead, and then that checkout's lib is used.
 *
 * @param {string | undefined} bundle path of the bundle/ruby directory
 * @returns {{ script: string | undefined, loadPaths: string[] }}
 */
export function generatorScript(bundle) {
  if (process.env.RUBY_ASTGEN_BIN) {
    const script = process.env.RUBY_ASTGEN_BIN;
    return { script, loadPaths: [join(dirname(script), "..", "lib")] };
  }
  for (const abiDir of gemPaths(bundle)) {
    for (const gemDir of subDirs(join(abiDir, "bundler", "gems"))) {
      const script = join(gemDir, "exe", "ruby_ast_gen");
      if (existsSync(script)) {
        return { script, loadPaths: [join(gemDir, "lib")] };
      }
    }
  }
  return { script: undefined, loadPaths: [] };
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
  const cwd = process.env.ATOM_CWD || process.cwd();
  const bundle = bundleHome();
  const { script, loadPaths } = generatorScript(bundle);
  if (!script || !existsSync(script)) {
    console.warn(
      `ruby_ast_gen was not found under ${PLUGINS_HOME}. Reinstall @appthreat/atom-parsetools, or set RUBY_ASTGEN_BIN to the exe/ruby_ast_gen of a ruby_ast_gen checkout.`
    );
    return false;
  }
  // ruby -I<ruby_ast_gen lib> <generator> <caller's arguments>
  const rubyArgs = [];
  for (const loadPath of loadPaths) {
    rubyArgs.push("-I", loadPath);
  }
  rubyArgs.push(script, ...argvs);
  const env = {
    ...process.env
  };
  // Appending keeps the caller's repositories reachable, so a newer prism installed on the machine
  // still wins and raises the grammar level.
  const gemPath = gemPaths(bundle);
  if (process.env.GEM_PATH) {
    gemPath.push(process.env.GEM_PATH);
  }
  if (gemPath.length) {
    env.GEM_PATH = gemPath.join(delimiter);
  }
  let rubyCmd = process.env.RUBY_CMD || "ruby";
  if (
    process.env.ATOM_RUBY_HOME &&
    existsSync(join(process.env.ATOM_RUBY_HOME, "bin"))
  ) {
    const rubyBinDir = join(process.env.ATOM_RUBY_HOME, "bin");
    if (rubyCmd === "ruby") {
      rubyCmd = join(rubyBinDir, "ruby");
    }
    if (!env.PATH.includes(rubyBinDir)) {
      env.PATH = `${rubyBinDir}${delimiter}${env.PATH}`;
    }
  }
  let rubyFound = false;
  for (const rubyVersion of RUBY_VERSIONS_NEEDED) {
    if (rubyCmd === "ruby" && detectRuby(rubyVersion)) {
      rubyFound = true;
      break;
    }
  }
  if (!rubyFound) {
    console.warn(
      `Ruby is not installed! Set the environment variable "ATOM_RUBY_HOME" to the install directory. Supported versions: ${RUBY_VERSIONS_NEEDED}`
    );
    return false;
  }
  spawnSync(rubyCmd, rubyArgs, {
    encoding: "utf-8",
    cwd,
    stdio: "inherit",
    stderr: "inherit",
    env,
    timeout: spawnTimeout()
  });
}
main(process.argv.slice(2));
