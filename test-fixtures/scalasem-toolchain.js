// The compiler toolchain resolution against synthetic cache layouts: the runtime classpath of
// the helper comes from the compiler's own POM in the local caches, so the assembler and the
// other runtime artifacts of every release shape are found without a network and without a
// JDK. Runs against a temporary cache, so the machine caches cannot answer for the layout a
// release brings.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { resolveToolchain } from "../lib/scalasem/compiler.js";

const cache = mkdtempSync(join(tmpdir(), "scalasem-toolchain-"));
const previousCache = process.env.COURSIER_CACHE;
process.env.COURSIER_CACHE = cache;

/**
 * Place an artifact in the temporary cache, with the POM the resolution reads when one is
 * given. The jar content is never opened here; only the layouts are read.
 */
function writeArtifact(relPath, version, { pom, jarBytes = 4096 } = {}) {
  const dir = join(
    cache,
    "https",
    "repo1.maven.org",
    "maven2",
    ...relPath.split("/"),
    version
  );
  mkdirSync(dir, { recursive: true });
  const artifact = relPath.split("/").pop();
  writeFileSync(
    join(dir, `${artifact}-${version}.jar`),
    Buffer.alloc(jarBytes)
  );
  if (pom) {
    writeFileSync(join(dir, `${artifact}-${version}.pom`), pom);
  }
}

const compilerPom = (version, dependencyEntries, extra = "") => `<project>
  <groupId>org.scala-lang</groupId>
  <artifactId>scala3-compiler_3</artifactId>
  <version>${version}</version>
${extra ? `${extra}\n` : ""}  <dependencies>
${dependencyEntries.join("\n")}
  </dependencies>
</project>
`;

const dependency = (group, artifact, version, extra = "") =>
  `    <dependency>
      <groupId>${group}</groupId>
      <artifactId>${artifact}</artifactId>
      ${version ? `<version>${version}</version>` : ""}
${extra ? `${extra}\n` : ""}    </dependency>`;

// The newer shape: the assembler comes from upstream ASM, the directive parser is a test
// dependency, and the ASM versions come from the POM properties.
const newVersion = "3.90.0";
writeArtifact("org/scala-lang/scala3-compiler_3", newVersion, {
  pom: compilerPom(
    newVersion,
    [
      dependency("org.scala-lang", "scala3-interfaces", newVersion),
      dependency("org.scala-lang", "tasty-core_3", newVersion),
      dependency("org.scala-lang", "scala3-library_3", newVersion),
      dependency(
        "org.scala-lang",
        "scala3-directives-parser_3",
        newVersion,
        "      <scope>test</scope>"
      ),
      dependency("org.ow2.asm", "asm-util", "${asm.version}"),
      dependency(
        "org.ow2.asm",
        "asm-commons",
        "${asm.version}",
        `      <exclusions>
        <exclusion>
          <groupId>org.ow2.asm</groupId>
          <artifactId>asm-analysis</artifactId>
        </exclusion>
      </exclusions>`
      ),
      dependency("org.scala-sbt", "compiler-interface", "1.12.0")
    ],
    "  <properties><asm.version>9.20.0</asm.version></properties>"
  )
});
writeArtifact("org/scala-lang/scala3-interfaces", newVersion);
writeArtifact("org/scala-lang/tasty-core_3", newVersion);
// The congruent library switch: an empty redirect jar, and the classes in the library of the
// same version.
writeArtifact("org/scala-lang/scala3-library_3", newVersion, { jarBytes: 200 });
writeArtifact("org/scala-lang/scala-library", newVersion);
writeArtifact("org/scala-lang/scala3-tasty-inspector_3", newVersion);
writeArtifact("org/scala-lang/scala3-directives-parser_3", newVersion);
const asmPom = (dependencies) => compilerPom("9.20.0", dependencies);
writeArtifact("org/ow2/asm/asm-util", "9.20.0", {
  pom: asmPom([
    dependency("org.ow2.asm", "asm", "9.20.0"),
    dependency("org.ow2.asm", "asm-tree", "9.20.0")
  ])
});
writeArtifact("org/ow2/asm/asm-commons", "9.20.0", {
  pom: asmPom([
    dependency("org.ow2.asm", "asm", "9.20.0"),
    dependency("org.ow2.asm", "asm-tree", "9.20.0"),
    dependency("org.ow2.asm", "asm-analysis", "9.20.0")
  ])
});
writeArtifact("org/ow2/asm/asm", "9.20.0");
writeArtifact("org/ow2/asm/asm-tree", "9.20.0");
// Only the compiler POM's exclusion of it, on the asm-commons edge, keeps this jar out.
writeArtifact("org/ow2/asm/asm-analysis", "9.20.0");
writeArtifact("org/scala-sbt/compiler-interface", "1.12.0");
writeArtifact("org/scala-sbt/util-interface", "1.11.5");

const toolchain = resolveToolchain(
  { scalaVersion: newVersion, buildTool: "test" },
  { installDeps: false }
);
assert.ok(
  toolchain,
  `${newVersion}: toolchain resolved from the synthetic cache`
);
const jarNames = (jars) => jars.map((j) => j.split("/").pop()).sort();
assert.ok(
  jarNames(toolchain.compilerJars).includes("asm-util-9.20.0.jar"),
  `${newVersion}: the upstream assembler is on the compiler classpath`
);
assert.ok(
  jarNames(toolchain.compilerJars).includes("asm-tree-9.20.0.jar"),
  `${newVersion}: transitive dependencies of a POM dependency are resolved`
);
assert.ok(
  jarNames(toolchain.compilerJars).includes("compiler-interface-1.12.0.jar"),
  `${newVersion}: the compiler's own runtime dependencies stay on the classpath`
);
assert.ok(
  !jarNames(toolchain.compilerJars).includes("asm-analysis-9.20.0.jar"),
  `${newVersion}: an exclusion holds along the path it is declared on`
);
assert.ok(
  !jarNames(toolchain.compilerJars).some((n) =>
    n.startsWith("scala3-directives-parser")
  ),
  `${newVersion}: test dependencies stay off the classpath`
);
assert.ok(
  !jarNames(toolchain.compilerJars).some((n) => n.startsWith("scala-asm")),
  `${newVersion}: the shaded assembler of the older shape is not guessed`
);
assert.deepStrictEqual(
  jarNames(toolchain.libraryJars),
  [`scala-library-${newVersion}.jar`],
  `${newVersion}: the classes live in the congruent library`
);

// A dependency whose jar the cache does not hold leaves the POM unsatisfied: the jars it did
// find stay on the classpath, and the shared artifacts cover the coordinates they always
// have, so the release resolves with whatever the caches really hold. The dependency versions
// stay out of the reach of the layouts above.
const incompleteVersion = "3.91.0";
writeArtifact("org/scala-lang/scala3-compiler_3", incompleteVersion, {
  pom: compilerPom(incompleteVersion, [
    dependency("org.scala-lang", "scala3-interfaces", incompleteVersion),
    dependency("org.scala-lang", "tasty-core_3", incompleteVersion),
    dependency("org.scala-lang", "scala3-library_3", incompleteVersion),
    dependency("org.ow2.asm", "asm-util", "9.30.0"),
    dependency("org.ow2.asm", "asm-tree", "9.30.0")
  ])
});
writeArtifact("org/scala-lang/scala3-interfaces", incompleteVersion);
writeArtifact("org/scala-lang/tasty-core_3", incompleteVersion);
writeArtifact("org/scala-lang/scala3-library_3", incompleteVersion, {
  jarBytes: 200
});
writeArtifact("org/scala-lang/scala-library", incompleteVersion);
writeArtifact("org/scala-lang/scala3-tasty-inspector_3", incompleteVersion);
writeArtifact("org/ow2/asm/asm-util", "9.30.0");
// asm-tree has no jar in the cache.
const incomplete = resolveToolchain(
  { scalaVersion: incompleteVersion, buildTool: "test" },
  { installDeps: false }
);
assert.ok(incomplete, `${incompleteVersion}: the compiler itself resolves`);
assert.ok(
  jarNames(incomplete.compilerJars).includes("asm-util-9.30.0.jar"),
  `${incompleteVersion}: the POM artifacts the caches hold stay on the classpath`
);
assert.ok(
  !jarNames(incomplete.compilerJars).includes("asm-tree-9.30.0.jar"),
  `${incompleteVersion}: nothing is invented for the jar the cache does not hold`
);

// The older shape: the assembler is shaded into org.scala-lang.modules, and the library is a
// real jar of the release.
const shadedVersion = "3.89.0";
writeArtifact("org/scala-lang/scala3-compiler_3", shadedVersion, {
  pom: compilerPom(shadedVersion, [
    dependency("org.scala-lang", "scala3-interfaces", shadedVersion),
    dependency("org.scala-lang", "tasty-core_3", shadedVersion),
    dependency("org.scala-lang", "scala3-library_3", shadedVersion),
    dependency("org.scala-lang.modules", "scala-asm", "9.9.0-scala-1"),
    dependency("org.scala-sbt", "compiler-interface", "1.12.0")
  ])
});
writeArtifact("org/scala-lang/scala3-interfaces", shadedVersion);
writeArtifact("org/scala-lang/tasty-core_3", shadedVersion);
writeArtifact("org/scala-lang/scala3-library_3", shadedVersion);
writeArtifact("org/scala-lang/modules/scala-asm", "9.9.0-scala-1");
writeArtifact("org/scala-lang/scala3-tasty-inspector_3", shadedVersion);
const shaded = resolveToolchain(
  { scalaVersion: shadedVersion, buildTool: "test" },
  { installDeps: false }
);
assert.ok(shaded, `${shadedVersion}: toolchain resolved`);
assert.ok(
  jarNames(shaded.compilerJars).includes("scala-asm-9.9.0-scala-1.jar"),
  `${shadedVersion}: the shaded assembler is on the compiler classpath`
);
assert.ok(
  !jarNames(shaded.compilerJars).some((n) => n.startsWith("asm-util")),
  `${shadedVersion}: the upstream assembler is not guessed`
);
assert.ok(
  jarNames(shaded.libraryJars).includes(
    `scala3-library_3-${shadedVersion}.jar`
  ),
  `${shadedVersion}: the library is the release's own jar`
);
assert.ok(
  !jarNames(shaded.libraryJars).includes(`scala-library-${shadedVersion}.jar`),
  `${shadedVersion}: the congruent library is not guessed`
);

// A version the POM manages instead of the dependency writing one.
const managedVersion = "3.92.0";
writeArtifact("org/scala-lang/scala3-compiler_3", managedVersion, {
  pom: `<project>
  <groupId>org.scala-lang</groupId>
  <artifactId>scala3-compiler_3</artifactId>
  <version>${managedVersion}</version>
  <dependencyManagement>
    <dependencies>
${dependency("org.ow2.asm", "asm-util", "9.21.0")}
    </dependencies>
  </dependencyManagement>
  <dependencies>
${dependency("org.scala-lang", "scala3-interfaces", managedVersion)}
${dependency("org.scala-lang", "scala3-library_3", managedVersion)}
${dependency("org.ow2.asm", "asm-util")}
  </dependencies>
</project>
`
});
writeArtifact("org/scala-lang/scala3-interfaces", managedVersion);
writeArtifact("org/scala-lang/scala3-library_3", managedVersion);
writeArtifact("org/scala-lang/scala-library", managedVersion);
writeArtifact("org/scala-lang/scala3-tasty-inspector_3", managedVersion);
writeArtifact("org/ow2/asm/asm-util", "9.21.0");
const managed = resolveToolchain(
  { scalaVersion: managedVersion, buildTool: "test" },
  { installDeps: false }
);
assert.ok(
  jarNames(managed.compilerJars).includes("asm-util-9.21.0.jar"),
  `${managedVersion}: a managed version answers a dependency without one`
);

// A release the machine caches hold for real keeps its full shape: the compiler of the newest
// line carries the upstream assembler when everything is cached, and is skipped cleanly when
// it is not.
const real = resolveToolchain(
  { scalaVersion: "3.10.0", buildTool: "test" },
  { installDeps: false }
);
if (real?.inspectorJar) {
  assert.ok(
    jarNames(real.compilerJars).some((n) => n.startsWith("asm-util")),
    "3.10.0: the cached release resolves with the upstream assembler"
  );
  assert.ok(
    jarNames(real.libraryJars).some((n) => n.startsWith("scala-library")),
    "3.10.0: the congruent library is resolved"
  );
} else {
  console.log(
    "scalasem-toolchain: the 3.10.0 release is not cached complete, skipped"
  );
}

process.env.COURSIER_CACHE = previousCache;
rmSync(cache, { recursive: true, force: true });
console.log(
  "scalasem-toolchain: the new, the shaded and the incomplete cache layouts resolve as their POMs say"
);
