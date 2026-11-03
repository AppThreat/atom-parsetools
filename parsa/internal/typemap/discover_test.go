package typemap

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func touch(t *testing.T, root string, rels ...string) {
	t.Helper()
	for _, r := range rels {
		p := filepath.Join(root, filepath.FromSlash(r))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func rels(root string, files []string) []string {
	var out []string
	for _, f := range files {
		r, _ := filepath.Rel(root, f)
		out = append(out, filepath.ToSlash(r))
	}
	return out
}

func TestDiscoveryRules(t *testing.T) {
	root := t.TempDir()
	touch(t, root,
		"a.ts", "b.js", "c.tsx", "d.d.ts", "three.js", "e.test.ts", "f.spec.js", "lib/x.min.js", "lib/y-min.js",
		"__tests__/z.ts", "docs/g.ts", "i18n/h.ts", "node_modules/m/index.js", ".hidden/i.ts", ".dot.ts",
		"src/ok.mts", "src/page.vue", "src/page.svelte", "src/readme.md", "Upper/J.TS")
	got := rels(root, NewDiscovery(Env{}).SourceFiles(root))
	want := []string{"a.ts", "b.js", "c.tsx", "src/ok.mts", "src/page.svelte", "src/page.vue"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("got  %v\nwant %v", got, want)
	}
}

func TestDiscoveryEnvSwitches(t *testing.T) {
	root := t.TempDir()
	touch(t, root, "a.ts", "a.test.ts", "lib/x.min.js", "docs/g.ts", "node_modules/m/dist/app.js", "node_modules/m/lib/other.js")
	got := rels(root, NewDiscovery(Env{IncludeTestFiles: true, IncludeMinified: true}).SourceFiles(root))
	if strings.Join(got, ",") != "a.test.ts,a.ts,lib/x.min.js" {
		t.Fatalf("include switches: %v", got)
	}
	// A non-empty ASTGEN_IGNORE_DIRS without node_modules turns node_modules bundles on and
	// replaces the default list (so docs is no longer ignored).
	got = rels(root, NewDiscovery(Env{IgnoreDirs: "build"}).SourceFiles(root))
	if strings.Join(got, ",") != "a.ts,docs/g.ts,node_modules/m/dist/app.js" {
		t.Fatalf("ignore dirs: %v", got)
	}
}

func TestDiscoverySymlinkLoopEndsWithDiagnostic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks needs privileges on Windows")
	}
	root := t.TempDir()
	touch(t, root, "a/one.ts")
	if err := os.Symlink(root, filepath.Join(root, "a", "loop")); err != nil {
		t.Skip("cannot create symlink: " + err.Error())
	}
	d := NewDiscovery(Env{})
	got := rels(root, d.SourceFiles(root))
	if strings.Join(got, ",") != "a/one.ts" {
		t.Fatalf("files: %v", got)
	}
	if len(d.Diagnostics) == 0 || !strings.Contains(d.Diagnostics[0], "symlink loop") {
		t.Fatalf("want a symlink loop diagnostic, got %v", d.Diagnostics)
	}
}

func TestLeftOutByDiscovery(t *testing.T) {
	d := NewDiscovery(Env{})
	root := filepath.FromSlash("/p")
	cases := map[string]bool{
		"/p/src/a.ts": false, "/p/docs/a.ts": true, "/p/.x/a.ts": true, "/p/src/three.js": true,
		"/p/src/types.d.ts": false, "/p/node_modules/q/a.ts": true, "/p/src/.a.ts": true,
	}
	for f, want := range cases {
		if got := d.IsLeftOutByDiscovery(filepath.FromSlash(f), root); got != want {
			t.Errorf("%s: got %v want %v", f, got, want)
		}
	}
}
