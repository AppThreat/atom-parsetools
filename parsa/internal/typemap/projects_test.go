package typemap

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureProject(t *testing.T, name string) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "..", "test-fixtures", "projects", name))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Skipf("fixture %s is not there: %v", name, err)
	}
	return p
}

func relLabels(src string, tp TypeProjects) []string {
	var out []string
	for _, p := range tp.Projects {
		rel, _ := filepath.Rel(src, p.ConfigPath)
		out = append(out, p.Label+"="+filepath.ToSlash(rel))
	}
	return out
}

func TestFindTypeProjectsNestedConfigs(t *testing.T) {
	src := fixtureProject(t, "nested-configs")
	d := NewDiscovery(Env{})
	files := d.SourceFiles(src)
	tp := FindTypeProjects(files, src)
	got := strings.Join(relLabels(src, tp), " ")
	// frontend/tsconfig.json is solution-style and references src/tsconfig.app.json, which owns
	// frontend/src; packages/shared is a workspace package; examples/ is left out by discovery, so
	// its tsconfig.json types nothing
	want := "frontend=frontend/tsconfig.json frontend/src=frontend/src/tsconfig.app.json packages/shared=packages/shared/tsconfig.json"
	if got != want {
		t.Fatalf("projects:\n got %s\nwant %s", got, want)
	}
	if tp.RootConfigPath != "" {
		t.Fatalf("the root tsconfig.json lists files, so it keeps the root: %s", tp.RootConfigPath)
	}

	groups := PartitionTypeGroups(files, files, tp, src)
	owner := map[string]string{}
	for _, g := range groups {
		for _, f := range g.Files {
			rel, _ := filepath.Rel(src, f)
			owner[filepath.ToSlash(rel)] = g.Program.Label
		}
	}
	for file, label := range map[string]string{
		"frontend/src/widget.ts":   "frontend/src",
		"frontend/src/ui/badge.ts": "frontend/src",
		"packages/shared/flags.ts": "packages/shared",
		"src/app.js":               ".",
		"config/settings.ts":       ".",
	} {
		if owner[file] != label {
			t.Errorf("%s: typed by %q, want %q", file, owner[file], label)
		}
	}
	if groups[0].Program.Label != "." {
		t.Errorf("the root program comes first, got %q", groups[0].Program.Label)
	}

	root := groups[0].Program
	if !root.isOtherProjectsFile(filepath.Join(src, "frontend", "src", "widget.ts")) {
		t.Error("the root program must leave a nested project's file to that project")
	}
	if root.isOtherProjectsFile(filepath.Join(src, "src", "app.js")) {
		t.Error("the root's own file is the root's")
	}
	if root.isOtherProjectsFile(filepath.Join(filepath.Dir(src), "elsewhere.ts")) {
		t.Error("a file outside the run is no project's, so it stays in")
	}
	var nilSpec *ProgramSpec
	if nilSpec.isOtherProjectsFile(filepath.Join(src, "frontend", "src", "widget.ts")) {
		t.Error("a run without nested projects leaves nothing out")
	}
}

func TestFindTypeProjectsSolutionRoot(t *testing.T) {
	src := fixtureProject(t, "solution-root")
	d := NewDiscovery(Env{})
	files := d.SourceFiles(src)
	tp := FindTypeProjects(files, src)
	if len(tp.Projects) != 0 {
		t.Fatalf("no nested projects, got %v", relLabels(src, tp))
	}
	if filepath.Base(tp.RootConfigPath) != "tsconfig.app.json" {
		t.Fatalf("a solution-style root hands the root to tsconfig.app.json, got %q", tp.RootConfigPath)
	}
	groups := PartitionTypeGroups(files, files, tp, src)
	if len(groups) != 1 || groups[0].Program == nil || groups[0].Program.ConfigPath != tp.RootConfigPath {
		t.Fatalf("one group with the root's chosen configuration, got %+v", groups)
	}
}

func TestPartitionWithoutProjectsIsOneGroup(t *testing.T) {
	files := []string{"/r/a.ts", "/r/b/c.ts"}
	groups := PartitionTypeGroups(files, files, TypeProjects{}, "/r")
	if len(groups) != 1 || groups[0].Program != nil || len(groups[0].Files) != 2 {
		t.Fatalf("a run without nested projects is the one program it always was, got %+v", groups)
	}
}

func TestTypeConfigRank(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return p
	}
	solution, _ := readTypeConfig(write("tsconfig.json", `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }], }`))
	app, _ := readTypeConfig(write("tsconfig.app.json", `// comment
{ "include": ["src"] }`))
	js, _ := readTypeConfig(write("jsconfig.json", `{}`))
	if !solution.isSolutionStyle() || app.isSolutionStyle() || js.isSolutionStyle() {
		t.Fatal("only the configuration with no files of its own and references is solution-style")
	}
	if !(app.rank() < solution.rank()) {
		t.Error("a configuration that lists files wins over a solution-style one")
	}
	if !(js.rank() < app.rank()) {
		t.Error("jsconfig.json wins over another name when neither is solution-style")
	}
	if got := resolveProjectReferencePath(filepath.Join(dir, "sub")); got != filepath.Join(dir, "sub", "tsconfig.json") {
		t.Errorf("a reference to a directory means its tsconfig.json, got %s", got)
	}
}

// A specifier through a paths alias that covers node_modules names the package path, as astgen's
// normalizeImportedTypeSpecifier does; a relative or absolute project file keeps its rule.
func TestNormalizeSpecifierThroughNodeModules(t *testing.T) {
	cur := "/p/src/settings.ts"
	for in, want := range map[string]string{
		"@app/node_modules/tiny-config/types/inner": "tiny-config/types/inner",
		"/p/node_modules/@scope/pkg/index.d.ts":     "@scope/pkg/index",
		"/p/a/node_modules/x/node_modules/y/lib":    "y/lib",
		"/p/src/model.ts":                           "./model",
		"rxjs":                                      "rxjs",
	} {
		if got := normalizeImportedTypeSpecifier(in, cur); got != want {
			t.Errorf("%s: got %s, want %s", in, got, want)
		}
	}
}
