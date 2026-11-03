// Public entry point for the vendored arborist.  Upstream's index.js uses
// module.exports = require(...) chains that have no mechanical CJS→ESM
// equivalent, so this file is generated from a fixed template by
// contrib/vendor-arborist.mjs.

import Arborist from "./arborist/index.js";
import Edge from "./edge.js";
import Link from "./link.js";
import Node from "./node.js";
import NpmExtension from "./npm-extension.js";
import PackageExtensions from "./package-extensions.js";
import Shrinkwrap from "./shrinkwrap.js";

Arborist.Arborist = Arborist;
Arborist.Node = Node;
Arborist.Link = Link;
Arborist.Edge = Edge;
Arborist.Shrinkwrap = Shrinkwrap;
Arborist.PackageExtensions = PackageExtensions;
Arborist.NpmExtension = NpmExtension;

export default Arborist;
