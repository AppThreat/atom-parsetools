// Dependency-free reimplementation of validate-npm-package-name 8.x, used by
// package-extensions.js to reject malformed packageExtensions selectors.
//
// The rules and the result shape match the published package: `errors` are
// conditions npm has never allowed, `warnings` are conditions that were once
// legal and now only disqualify a name from being newly published. Both keys
// are omitted when empty.
import { builtinModules } from "node:module";

const scopedPackagePattern = /^(?:@([^/]+?)\/)?([^/]+?)$/;
const exclusionList = new Set(["node_modules", "favicon.ico"]);
const builtins = new Set(builtinModules.map((m) => m.toLowerCase()));

function done(warnings, errors) {
  const result = {
    validForNewPackages: errors.length === 0 && warnings.length === 0,
    validForOldPackages: errors.length === 0,
    warnings,
    errors,
  };
  if (!result.warnings.length) {
    delete result.warnings;
  }
  if (!result.errors.length) {
    delete result.errors;
  }
  return result;
}

/**
 * Validate a package name.
 *
 * @param {*} name Candidate package name
 * @returns {{validForNewPackages: boolean, validForOldPackages: boolean, warnings?: string[], errors?: string[]}}
 */
export default function validate(name) {
  const warnings = [];
  const errors = [];

  if (name === null) {
    errors.push("name cannot be null");
    return done(warnings, errors);
  }
  if (name === undefined) {
    errors.push("name cannot be undefined");
    return done(warnings, errors);
  }
  if (typeof name !== "string") {
    errors.push("name must be a string");
    return done(warnings, errors);
  }

  if (!name.length) {
    errors.push("name length must be greater than zero");
  }
  if (name.startsWith(".")) {
    errors.push("name cannot start with a period");
  }
  if (name.startsWith("-")) {
    errors.push("name cannot start with a hyphen");
  }
  if (name.startsWith("_")) {
    errors.push("name cannot start with an underscore");
  }
  if (name.trim() !== name) {
    errors.push("name cannot contain leading or trailing spaces");
  }
  for (const excludedName of exclusionList) {
    if (name.toLowerCase() === excludedName) {
      errors.push(`${excludedName} is not a valid package name`);
    }
  }

  if (builtins.has(name.toLowerCase())) {
    warnings.push(`${name} is a core module name`);
  }
  if (name.length > 214) {
    warnings.push("name can no longer contain more than 214 characters");
  }
  if (name.toLowerCase() !== name) {
    warnings.push("name can no longer contain capital letters");
  }
  if (/[~'!()*]/.test(name.split("/").slice(-1)[0])) {
    warnings.push('name can no longer contain special characters ("~\'!()*")');
  }

  if (encodeURIComponent(name) !== name) {
    // A scope and a bare name are each URL-encoded separately, so the slash
    // between them is legal even though it does not survive encodeURIComponent.
    const nameMatch = name.match(scopedPackagePattern);
    if (nameMatch) {
      const [, user, pkg] = nameMatch;
      if (pkg.startsWith(".")) {
        errors.push("name cannot start with a period");
      }
      if (
        encodeURIComponent(user) === user &&
        encodeURIComponent(pkg) === pkg
      ) {
        return done(warnings, errors);
      }
    }
    errors.push("name can only contain URL-friendly characters");
  }

  return done(warnings, errors);
}
