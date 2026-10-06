// Configuration parsing: Play routes files, including `->` mounted sub-routers resolved to
// their own file, and HOCON keys that carry service endpoints.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { sanitizeUrl } from "./util.js";

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS"
]);

/**
 * Parse the routes and configuration files of a project.
 *
 * @param {string} projectDir Absolute project directory
 * @returns {{ routes: Object[], values: Object[] }}
 */
export function parseProjectConfig(projectDir) {
  const routesFiles = findRoutesFiles(projectDir);
  const routes = [];
  const mounted = new Set();
  for (const file of routesFiles) {
    for (const sub of mountsOf(projectDir, file, routesFiles)) {
      mounted.add(sub.file);
    }
  }
  for (const file of routesFiles) {
    if (mounted.has(file)) {
      // A mounted sub-router is reported through its mount point, with the prefix applied.
      continue;
    }
    parseRoutesFile(projectDir, file, "", routesFiles, routes);
  }
  const values = parseHoconValues(projectDir);
  return { routes, values };
}

function findRoutesFiles(projectDir) {
  const files = [];
  // A route table lives in the `conf` directory of the project or of a sample or
  // subproject below it.
  const confDirs = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "conf") {
        confDirs.push(join(dir, entry.name));
      } else if (
        depth > 0 &&
        !["target", "node_modules", "project"].includes(entry.name)
      ) {
        visit(join(dir, entry.name), depth - 1);
      }
    }
  };
  visit(projectDir, 2);
  for (const confDir of confDirs) {
    for (const entry of readdirSync(confDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".routes")) {
        files.push(join(confDir, entry.name));
      }
    }
    if (existsSync(join(confDir, "routes"))) {
      files.push(join(confDir, "routes"));
    }
  }
  return [...new Set(files)].sort();
}

/** The `-> /mount router.Routes` lines of one file, resolved to a sibling routes file. */
function mountsOf(projectDir, file, allRoutesFiles) {
  const mounts = [];
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (_err) {
    return mounts;
  }
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts[0] !== "->" || parts.length < 3) {
      continue;
    }
    const sub = resolveSubRouter(projectDir, file, parts[2], allRoutesFiles);
    if (sub) {
      mounts.push({ prefix: parts[1], file: sub });
    }
  }
  return mounts;
}

function parseRoutesFile(projectDir, file, prefix, allRoutesFiles, routes) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (_err) {
    return;
  }
  const rel = relative(projectDir, file).split("\\").join("/");
  let lineNo = 0;
  const mounts = [];
  for (const raw of text.split("\n")) {
    lineNo += 1;
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("+")) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts[0] === "->" && parts.length >= 3) {
      const sub = resolveSubRouter(projectDir, file, parts[2], allRoutesFiles);
      if (sub) {
        mounts.push({
          prefix: joinPatterns(prefix, parts[1]),
          file: sub,
          line: lineNo
        });
      }
      continue;
    }
    if (!HTTP_METHODS.has((parts[0] || "").toUpperCase()) || parts.length < 3) {
      continue;
    }
    if (parts[1] === "/webjars" || parts[2].startsWith("webjars.")) {
      continue;
    }
    const controllerMethod = parts[2].includes("(")
      ? parts[2].split("(")[0]
      : parts[2];
    routes.push({
      method: parts[0].toUpperCase(),
      pattern: joinPatterns(prefix, parts[1]),
      declaredPattern: parts[1],
      controllerMethod,
      file: rel,
      line: lineNo
    });
  }
  for (const mount of mounts) {
    const before = routes.length;
    parseRoutesFile(
      projectDir,
      mount.file,
      mount.prefix,
      allRoutesFiles,
      routes
    );
    // A mounted sub-router's routes are reachable through their mount point.
    for (const route of routes.slice(before)) {
      route.router = relative(projectDir, mount.file).split("\\").join("/");
      route.mountFile = relative(projectDir, file).split("\\").join("/");
      route.mountLine = mount.line;
    }
  }
}

/** `admin.Routes` in a mounted routes file refers to `conf/admin.routes`. */
function resolveSubRouter(projectDir, mountingFile, reference, allRoutesFiles) {
  const simple = reference.split(".").slice(0, -1).join(".");
  const candidates = [
    join(dirname(mountingFile), `${simple}.routes`),
    join(projectDir, "conf", `${simple}.routes`)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return allRoutesFiles.find(
    (f) =>
      f
        .split(/[\\/]/)
        .pop()
        .replace(/\.routes$/, "") === simple
  );
}

function joinPatterns(prefix, pattern) {
  const left = prefix && prefix !== "/" ? prefix.replace(/\/$/, "") : "";
  const right = pattern && pattern !== "/" ? pattern : "";
  if (!left) {
    return right || "/";
  }
  if (!right) {
    return left;
  }
  return `${left}/${right.replace(/^\//, "")}`;
}

// Keys whose value may name an endpoint, and the values that do.
const ENDPOINT_KEY =
  /(url|uri|host|endpoint|jdbc|dsn|topic|bootstrap|servers?|address|connection)/i;
const ENDPOINT_VALUE =
  /^(https?|wss?|jdbc|mongodb(\+srv)?|rediss?|amqps?|postgres(ql)?|mysql|nats|grpcs?):|^[A-Za-z0-9.-]+:\d{2,5}(,[A-Za-z0-9.-]+:\d{2,5})*$/i;

/**
 * Configuration keys whose value names an endpoint: URLs, JDBC URLs and host with port, and
 * `${?NAME}` overrides as `env:NAME`. HOCON and properties files of every `conf/` directory
 * and of the main resources of every module are read. Values are sanitized the same way the
 * report writer treats URLs.
 */
function parseHoconValues(projectDir) {
  const values = [];
  for (const file of configFiles(projectDir)) {
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch (_err) {
      continue;
    }
    const rel = relative(projectDir, file).split("\\").join("/");
    for (const { key, value, line } of hoconAssignments(text)) {
      if (!ENDPOINT_KEY.test(key.split(".").pop())) {
        continue;
      }
      const env = /^\$\{\??([A-Z][A-Z0-9_]*)\}$/.exec(value);
      if (env) {
        values.push({ key, value: `env:${env[1]}`, file: rel, line });
      } else if (ENDPOINT_VALUE.test(value) && !value.includes("${")) {
        values.push({ key, value: sanitizeUrl(value), file: rel, line });
      }
    }
  }
  return values;
}

/** The `.conf` and `.properties` files of `conf/` and `src/main/resources/` directories. */
function configFiles(projectDir) {
  const files = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry.name);
      const rel = relative(projectDir, full).split("\\").join("/");
      if (entry.name === "conf" || rel.endsWith("src/main/resources")) {
        for (const file of readdirSync(full, { withFileTypes: true })) {
          if (file.isFile() && /\.(conf|properties)$/.test(file.name)) {
            files.push(join(full, file.name));
          }
        }
      } else if (
        depth > 0 &&
        !["target", "out", "node_modules", "project", "test"].includes(
          entry.name
        )
      ) {
        visit(full, depth - 1);
      }
    }
  };
  visit(projectDir, 4);
  return [...new Set(files)].sort();
}

/**
 * The assignments of a HOCON or properties text with their full key: `db { default { url =
 * x } }` assigns `db.default.url`. Comments outside quotes are dropped. Includes, arrays and
 * value concatenation are not followed.
 */
export function hoconAssignments(text) {
  const assignments = [];
  const scope = [];
  let lineNo = 0;
  for (const raw of text.split("\n")) {
    lineNo += 1;
    let line = stripComment(raw).trim();
    while (line.startsWith("}")) {
      scope.pop();
      line = line.slice(1).trim();
    }
    if (!line) {
      continue;
    }
    const block = /^"?([A-Za-z0-9_.-]+)"?\s*[=:]?\s*\{\s*(\}?)$/.exec(line);
    if (block) {
      if (!block[2]) {
        scope.push(block[1]);
      }
      continue;
    }
    // A block on one line: `kafka { bootstrap.servers = "k:9092" }`.
    const inline = /^"?([A-Za-z0-9_.-]+)"?\s*[=:]?\s*\{(.*)\}$/.exec(line);
    if (inline) {
      for (const inner of hoconAssignments(splitOutsideQuotes(inline[2]))) {
        assignments.push({
          key: [...scope, inline[1], inner.key].join("."),
          value: inner.value,
          line: lineNo
        });
      }
      continue;
    }
    const assignment = /^"?([A-Za-z0-9_.-]+)"?\s*(?:=|:|\+=)\s*(.+?),?$/.exec(
      line
    );
    if (!assignment) {
      continue;
    }
    let value = assignment[2].trim();
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
    if (quoted) {
      value = quoted[1].replace(/\\(.)/g, "$1");
    }
    assignments.push({
      key: [...scope, assignment[1]].join("."),
      value,
      line: lineNo
    });
  }
  return assignments;
}

/** The fields of a one line block, one per line: commas inside quotes stay. */
function splitOutsideQuotes(text) {
  let quoted = false;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") {
      quoted = !quoted;
    }
    out += ch === "," && !quoted ? "\n" : ch;
  }
  return out;
}

/** A line without its `#` or `//` comment, ignoring the ones inside quotes. */
function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") {
      quoted = !quoted;
    } else if (!quoted && (ch === "#" || (ch === "/" && line[i + 1] === "/"))) {
      // `//` inside a URL is part of the value only when it is quoted; an unquoted URL
      // keeps its `scheme://`.
      if (ch === "/" && line[i - 1] === ":") {
        continue;
      }
      return line.slice(0, i);
    }
  }
  return line;
}
