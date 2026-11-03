// Local stub for npm-extension.  Upstream discovers a root
// .npm-extension.{mjs,cjs} file and imports it, then calls its
// transformManifest export against every installed package's manifest.  That
// is arbitrary project-local code execution during what is, for cdxgen, a
// read-only scan, so this stub reports that no extension file is present.
//
// The only part of the contract loadActual depends on is `present`:
// #applyNpmExtension() returns early when it is false, before load() or
// apply() can be reached.  Those two methods therefore throw rather than
// return a plausible-looking result, so that an upstream change which reaches
// them fails loudly instead of silently producing a tree that differs from
// npm's.
//
// Consequence: on loadActual, a project carrying a .npm-extension file gets a
// tree without the dependency repairs npm would apply.  loadVirtual is
// unaffected — npm bakes the repaired edges into the lockfile, so reading the
// lockfile already reflects them.

const REFUSED = "cdxgen does not execute .npm-extension code";

class NpmExtension {
  constructor() {
    this.present = false;
    this.root = null;
    this.path = null;
    this.format = null;
    this.hash = null;
  }

  async load() {
    throw new Error(REFUSED);
  }

  apply() {
    throw new Error(REFUSED);
  }
}

const hasExtensionFile = () => false;

NpmExtension.NpmExtension = NpmExtension;
NpmExtension.hasExtensionFile = hasExtensionFile;

export default NpmExtension;
export { hasExtensionFile, NpmExtension };
