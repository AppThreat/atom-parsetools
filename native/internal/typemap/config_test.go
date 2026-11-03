package typemap

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/microsoft/TypeScript/tsc/shim/core"
)

func runConfig(t *testing.T, name string) (map[string]map[int]string, *Report, string) {
	t.Helper()
	proj := filepath.Join("..", "..", "testdata", "typemap", "config", name)
	out := filepath.Join(t.TempDir(), "out")
	rep, err := Run(context.Background(), Options{Src: proj, Output: out, Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	return readMaps(t, out), rep, proj
}

func read(t *testing.T, proj, rel string) string {
	b, err := os.ReadFile(filepath.Join(proj, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestConfigDiscoveryFindsTsconfigAndJsconfig(t *testing.T) {
	for name, file := range map[string]string{"extends": "tsconfig.json", "jsconfig": "jsconfig.json"} {
		_, rep, proj := runConfig(t, name)
		want, _ := filepath.Abs(filepath.Join(proj, file))
		if rep.ConfigPath != want {
			t.Fatalf("%s: config found %q, want %q", name, rep.ConfigPath, want)
		}
	}
}

// strict comes from the extended file: with strictNullChecks `f()` is string | undefined.
func TestConfigExtendsIsFollowed(t *testing.T) {
	maps, _, proj := runConfig(t, "extends")
	src := read(t, proj, "src/a.ts")
	if got := typeAt(maps["src/a.ts"], src, "n ="); !strings.Contains(got, "undefined") {
		t.Fatalf("strictNullChecks from the extended config did not apply: n has type %q", got)
	}
}

// include/exclude of the tsconfig is not a filter: files discovery finds are typed, tsconfig files add to them.
func TestConfigIncludeExcludeDoesNotRemoveDiscoveredFiles(t *testing.T) {
	maps, _, _ := runConfig(t, "include-exclude")
	for _, f := range []string{"src/kept.ts", "src/skip/s.ts", "scripts/run.ts"} {
		if len(maps[f]) == 0 {
			t.Errorf("%s must be typed: discovery found it", f)
		}
	}
}

// Files discovery leaves out stay out of the program when the tsconfig has no include.
func TestConfigKeepsDiscoveryExclusionsOut(t *testing.T) {
	maps, _, _ := runConfig(t, "left-out")
	if len(maps["src/x.ts"]) == 0 {
		t.Fatal("src/x.ts must be typed")
	}
	for _, f := range []string{"docs/d.ts", ".hidden/h.ts", "src/three.js"} {
		if _, ok := maps[f]; ok {
			t.Errorf("%s was left out by discovery and must not be typed", f)
		}
	}
}

// allowJs/checkJs/noEmit/skipLibCheck/resolveJsonModule are forced on whatever the tsconfig says.
func TestConfigForcedOptions(t *testing.T) {
	maps, _, proj := runConfig(t, "forced-options")
	src := read(t, proj, "a.js")
	m := maps["a.js"]
	if len(m) == 0 {
		t.Fatal("a .js file must be typed although the tsconfig has allowJs false")
	}
	if got := typeAt(m, src, "answer ="); got != "number" {
		t.Fatalf("answer = %q", got)
	}
	// resolveJsonModule: the require of a .json file resolves to its structure
	found := false
	for _, v := range m {
		if strings.Contains(v, "k: Array<number>") {
			found = true
		}
	}
	if !found {
		t.Fatalf("require(\"./data.json\") must be typed through resolveJsonModule: %v", m)
	}
}

// Project references are not passed to the program (astgen passes none): both projects are typed from source.
func TestConfigProjectReferencesAreIgnored(t *testing.T) {
	maps, _, _ := runConfig(t, "references")
	if len(maps["app/main.ts"]) == 0 || len(maps["lib/index.ts"]) == 0 {
		t.Fatalf("both referenced projects' sources must be typed: %v", maps)
	}
}

// node_modules/@types is loaded without a `types` list.
func TestConfigAutomaticTypes(t *testing.T) {
	maps, _, proj := runConfig(t, "auto-types")
	src := read(t, proj, "src/g.ts")
	if got := typeAt(maps["src/g.ts"], src, "g ="); got != "number" {
		t.Fatalf("FAKE_GLOBAL from node_modules/@types/fake must resolve: g has type %q", got)
	}
}

// An unreadable extended config and options TypeScript 7 removed produce warnings and the run goes on.
func TestConfigRemovedAndBrokenOptionsWarnAndContinue(t *testing.T) {
	maps, rep, _ := runConfig(t, "removed-options")
	if len(maps["r.ts"]) == 0 {
		t.Fatal("the file must still be typed")
	}
	joined := strings.Join(rep.Warnings, "\n")
	if !strings.Contains(joined, "keyofStringsOnly") || !strings.Contains(joined, "Cannot_read_file") {
		t.Fatalf("expected warnings for the removed option and the missing extends, got %q", rep.Warnings)
	}
}

// package.json "type": "module" and .mts files switch to NodeNext resolution, as detectDefaultTscOptions does.
func TestConfigNodeNextDetection(t *testing.T) {
	maps, _, proj := runConfig(t, "nodenext")
	src := read(t, proj, "a.mts")
	if got := typeAt(maps["a.mts"], src, "m ="); !strings.Contains(got, "Map<string, number>") {
		t.Fatalf("m = %q", got)
	}
}

// TypeScript 7 no longer resolves modules through baseUrl; BuildSetup keeps TypeScript 6's meaning by
// resolving paths from baseUrl and adding a "*" entry. baseurl-paths has baseUrl at the tsconfig's
// directory, baseurl-src points it into src/, so a paths entry relative to the tsconfig would miss.
func TestConfigBaseUrlResolvesLikeTypeScript6(t *testing.T) {
	for _, name := range []string{"baseurl-paths", "baseurl-src"} {
		maps, _, proj := runConfig(t, name)
		src := read(t, proj, "src/use.ts")
		for _, marker := range []string{"a = make()", "b = bare()"} {
			if got := typeAt(maps["src/use.ts"], src, marker); !strings.Contains(got, "Item") {
				t.Errorf("%s: %s has type %q, want Item", name, marker, got)
			}
		}
	}
}

func setupFor(t *testing.T, name string) *Setup {
	t.Helper()
	proj, _ := filepath.Abs(filepath.Join("..", "..", "testdata", "typemap", "config", name))
	d := NewDiscovery(Env{})
	s, err := BuildSetup(proj, d.SourceFiles(proj), d, 1)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// The options the program is created with, rule by rule. Types alone cannot tell some of these apart
// (an extended strict flag only shows in a nullable result, NodeNext only in resolution), so the
// options are asserted directly.
func TestConfigOptionsPerRule(t *testing.T) {
	// extends: strict comes from base.json
	if o := setupFor(t, "extends").Options(); !o.Strict.IsTrue() {
		t.Errorf("extends: strict from the extended config must apply, got %v", o.Strict)
	}
	// forced options win over the tsconfig that turns them off
	o := setupFor(t, "forced-options").Options()
	for name, v := range map[string]core.Tristate{"allowJs": o.AllowJs, "checkJs": o.CheckJs, "noEmit": o.NoEmit, "skipLibCheck": o.SkipLibCheck, "resolveJsonModule": o.ResolveJsonModule} {
		if !v.IsTrue() {
			t.Errorf("forced-options: %s must be forced on, got %v", name, v)
		}
	}
	// astgen's defaults win over the tsconfig for the keys they set (TypeScript 6 behaviour, checked)
	o = setupFor(t, "removed-options").Options()
	if o.Target != core.ScriptTargetES2022 {
		t.Errorf("removed-options: the tsconfig asks for es5 and astgen's default target is ES2022, got %v", o.Target)
	}
	if o.Module != core.ModuleKindCommonJS {
		t.Errorf("default module must be CommonJS, got %v", o.Module)
	}
	// package.json type module, or .mts files, switch to NodeNext
	if o := setupFor(t, "nodenext").Options(); o.Module != core.ModuleKindNodeNext || o.ModuleResolution != core.ModuleResolutionKindNodeNext {
		t.Errorf("nodenext: module %v resolution %v", o.Module, o.ModuleResolution)
	}
	if o := setupFor(t, "extends").Options(); o.Module == core.ModuleKindNodeNext {
		t.Errorf("a project without type module or .mts files must not switch to NodeNext")
	}
	// automatic types
	if o := setupFor(t, "auto-types").Options(); len(o.Types) != 1 || o.Types[0] != "*" {
		t.Errorf("auto-types: types must be [*], got %v", o.Types)
	}
}

// The explicit module check reads tsconfigs the way TypeScript does: a byte order mark, comments, and a
// trailing comma followed by a comment are all accepted.
func TestExplicitCompilerOptionReadsLikeTypeScript(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{
		"bom":           "\xef\xbb\xbf{\"compilerOptions\":{\"module\":\"esnext\"}}",
		"comma-comment": "{\n  \"compilerOptions\": {\n    \"module\": \"esnext\", // esm\n  }\n}\n",
		"block-comment": "{ /* a */ \"compilerOptions\": { \"module\": \"esnext\" /* b */ , } }",
		"url-in-string": "{ \"compilerOptions\": { \"module\": \"esnext\", \"x\": \"http://a/*b*/\", } }",
	} {
		p := filepath.Join(dir, name+".json")
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if !hasExplicitCompilerOption(p, "module") {
			t.Errorf("%s: module is set explicitly", name)
		}
	}
}
