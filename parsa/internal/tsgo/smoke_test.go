package tsgo_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/microsoft/TypeScript/tsc/shim/ast"
	"github.com/microsoft/TypeScript/tsc/shim/bundled"
	"github.com/microsoft/TypeScript/tsc/shim/checker"
	"github.com/microsoft/TypeScript/tsc/shim/compiler"
	"github.com/microsoft/TypeScript/tsc/shim/core"
	"github.com/microsoft/TypeScript/tsc/shim/tsoptions"
	"github.com/microsoft/TypeScript/tsc/shim/tspath"
	"github.com/microsoft/TypeScript/tsc/shim/vfs/cachedvfs"
	"github.com/microsoft/TypeScript/tsc/shim/vfs/osvfs"
)

// A three-file project is loaded through the pinned tsc/ source and the type of
// a call expression is printed.
func TestSmokeThreeFileProject(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	write("a.ts", "export interface User { id: number; name: string }\n")
	write("b.ts", "import { User } from './a';\nexport function load(): User { return { id: 1, name: 'x' }; }\n")
	main := write("c.ts", "import { load } from './b';\nexport const u = load();\n")

	fs := bundled.WrapFS(cachedvfs.From(osvfs.FS()))
	host := compiler.NewCompilerHost(fs, bundled.LibPath(), nil, nil, nil)
	root := tspath.RootedPathFromAbsolute(dir)
	opts := &core.CompilerOptions{Module: core.ModuleKindESNext, Target: core.ScriptTargetESNext,
		ModuleResolution: core.ModuleResolutionKindBundler, NoEmit: core.TSTrue, SkipLibCheck: core.TSTrue}
	var files []tspath.RootedFilePath
	for _, n := range []string{"a.ts", "b.ts", "c.ts"} {
		files = append(files, tspath.RootedFilePath(tspath.RootedPathFromAbsolute(filepath.Join(dir, n))))
	}
	cfg := tsoptions.NewParsedCommandLine(opts, files, nil, tspath.RootedDirectoryPath(root), fs.CaseSensitivity())
	program := compiler.NewProgram(compiler.ProgramOptions{
		ProgramConfig: compiler.ProgramConfig{Config: cfg, SingleThreaded: core.TSTrue},
		ProgramHosts:  compiler.ProgramHosts{Host: host},
	})
	program.BindSourceFiles()
	sf := program.GetSourceFile(tspath.RootedFilePath(tspath.RootedPathFromAbsolute(main)))
	if sf == nil {
		t.Fatal("c.ts not in program")
	}
	c, done := program.GetTypeCheckerForFileExclusive(context.Background(), sf)
	defer done()
	var got string
	var visit func(n *ast.Node) bool
	visit = func(n *ast.Node) bool {
		if n.Kind == ast.KindCallExpression && got == "" {
			sig := c.GetResolvedSignature(n)
			got = c.TypeToString(c.GetReturnTypeOfSignature(sig))
		}
		return n.ForEachChild(visit)
	}
	sf.AsNode().ForEachChild(visit)
	if got != "User" {
		t.Fatalf("type of load() = %q, want User", got)
	}
	_ = checker.TypeFlagsAny
}
