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
  const confDir = join(projectDir, "conf");
  if (existsSync(confDir)) {
    for (const entry of readdirSync(confDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".routes")) {
        files.push(join(confDir, entry.name));
      }
    }
    if (existsSync(join(confDir, "routes"))) {
      files.push(join(confDir, "routes"));
    }
  }
  return files.sort();
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
        mounts.push({ prefix: joinPatterns(prefix, parts[1]), file: sub });
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
      controllerMethod,
      file: rel,
      line: lineNo
    });
  }
  for (const mount of mounts) {
    parseRoutesFile(
      projectDir,
      mount.file,
      mount.prefix,
      allRoutesFiles,
      routes
    );
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

/**
 * HOCON keys whose value names an endpoint: URLs, JDBC URLs and host with port. Values are
 * sanitized the same way the report writer treats URLs.
 */
function parseHoconValues(projectDir) {
  const values = [];
  const confDir = join(projectDir, "conf");
  if (!existsSync(confDir)) {
    return values;
  }
  for (const entry of readdirSync(confDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(conf|properties)$/.test(entry.name)) {
      continue;
    }
    const file = join(confDir, entry.name);
    let text;
    try {
      text = readFileSync(file, "utf-8");
    } catch (_err) {
      continue;
    }
    const rel = relative(projectDir, file).split("\\").join("/");
    let lineNo = 0;
    for (const raw of text.split("\n")) {
      lineNo += 1;
      const line = raw.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const assignment = /^"?([A-Za-z0-9_.-]+)"?\s*[=:]\s*(.+)$/.exec(line);
      if (!assignment) {
        continue;
      }
      const key = assignment[1];
      const value = assignment[2].replace(/^["']|["'],?$/g, "").trim();
      if (
        !/(url|uri|host|endpoint|jdbc|topic|bootstrap|server|address)/i.test(
          key
        )
      ) {
        continue;
      }
      if (!/^(https?|jdbc):|^[a-z0-9.-]+:\d+/.test(value)) {
        continue;
      }
      values.push({ key, value: sanitizeUrl(value), file: rel, line: lineNo });
    }
  }
  return values;
}
