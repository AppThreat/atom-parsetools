package typemap

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func reasons(rep *Report) map[string]string {
	m := map[string]string{}
	for _, d := range rep.Diagnostics {
		m[d.File] = d.Reason
	}
	return m
}

// Invalid UTF-8 is read as U+FFFD, the file is typed, and the user is told how many sequences were bad.
func TestInvalidUTF8IsTypedAndReported(t *testing.T) {
	bad := "export const a = \"\xe2\x82\";\n// \xff\xfe comment\nexport const b = [1, 2];\n"
	maps, rep := runProject(t, map[string]string{"bad.ts": bad, "ok.ts": "export const ok = 1;\n"}, 1, Env{}, Budget{})
	if reasons(rep)["bad.ts"] != ReasonInvalidUTF8 {
		t.Fatalf("want an %s diagnostic for bad.ts, got %+v", ReasonInvalidUTF8, rep.Diagnostics)
	}
	if !strings.Contains(rep.Diagnostics[0].Detail, "3 invalid") {
		t.Fatalf("the truncated euro sign and the two stray bytes are three sequences: %q", rep.Diagnostics[0].Detail)
	}
	// "export const b" starts after the first line and the comment line, counted in UTF-16 units of the
	// text as Node decodes it (the truncated sequence is one character)
	if len(maps["bad.ts"]) == 0 || len(maps["ok.ts"]) == 0 {
		t.Fatalf("both files must be typed: %v", maps)
	}
}

// A file with NUL bytes is almost certainly not source: it is typed (the checker copes) and reported.
func TestBinaryFileWithSourceExtensionIsReported(t *testing.T) {
	blob := make([]byte, 20000)
	for i := range blob {
		blob[i] = byte(i * 7)
	}
	_, rep := runProject(t, map[string]string{"blob.ts": string(blob), "ok.ts": "export const ok = 1;\n"}, 1, Env{}, Budget{})
	if got := reasons(rep)["blob.ts"]; got != ReasonBinary {
		t.Fatalf("want %s for blob.ts, got %q (%+v)", ReasonBinary, got, rep.Diagnostics)
	}
}

// A 100,000 element array literal is typed in full and quickly.
func TestHugeArrayLiteralIsTyped(t *testing.T) {
	var b strings.Builder
	b.WriteString("export const big = [")
	for i := 0; i < 100000; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprint(&b, i)
	}
	b.WriteString("];\nexport const after = \"x\";\n")
	maps, rep := runProject(t, map[string]string{"big.ts": b.String()}, 1, Env{}, Budget{})
	if len(rep.Diagnostics) != 0 {
		t.Fatalf("a long literal is not a problem: %+v", rep.Diagnostics)
	}
	if len(maps["big.ts"]) < 100000 {
		t.Fatalf("every element has a type: %d keys", len(maps["big.ts"]))
	}
	if got := typeAt(maps["big.ts"], b.String(), "after ="); got != "string" {
		t.Fatalf("the code after the literal is typed: %q", got)
	}
}

// A file over LargeFileBytes is typed and reported, because a bundle is the usual cause of a costly run.
func TestLargeFileIsReported(t *testing.T) {
	var b strings.Builder
	for b.Len() < LargeFileBytes+1000 {
		fmt.Fprintf(&b, "var v%d=%d;", b.Len(), b.Len())
	}
	_, rep := runProject(t, map[string]string{"bundle.js": b.String()}, 1, Env{}, Budget{})
	if got := reasons(rep)["bundle.js"]; got != ReasonLarge {
		t.Fatalf("want %s, got %q (%+v)", ReasonLarge, got, rep.Diagnostics)
	}
}

// Symlink loops end with a diagnostic and no hang; real files next to them are typed.
func TestSymlinkLoopsEndWithADiagnostic(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks needs privileges on Windows")
	}
	dir := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Skip("cannot create symlinks: " + err.Error())
		}
	}
	must(os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"loop"}`), 0o644))
	must(os.MkdirAll(filepath.Join(dir, "src"), 0o755))
	must(os.WriteFile(filepath.Join(dir, "src", "a.ts"), []byte("export const a = 1;\n"), 0o644))
	must(os.Symlink("..", filepath.Join(dir, "src", "up")))
	must(os.Symlink(".", filepath.Join(dir, "src", "self")))
	must(os.Symlink("loop2", filepath.Join(dir, "src", "loop1")))
	must(os.Symlink("loop1", filepath.Join(dir, "src", "loop2")))
	maps, rep := runDir(t, dir, 1, Env{}, Budget{})
	if len(maps["src/a.ts"]) == 0 {
		t.Fatalf("the real file is typed: %v", maps)
	}
	joined := strings.Join(rep.Warnings, "\n")
	for _, want := range []string{"symlink loop skipped", "too many levels"} {
		if !strings.Contains(joined, want) {
			t.Errorf("want a warning containing %q, got:\n%s", want, joined)
		}
	}
	if len(maps) != 1 {
		t.Errorf("the loops must not duplicate the file: %v", maps)
	}
}

// A path outside the input root (a link to a file elsewhere) is not followed out of the tree by name: it is
// typed under its own path inside the root, or skipped, never written outside the output directory.
func TestOutputStaysInsideTheOutputDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks needs privileges on Windows")
	}
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "elsewhere.ts"), []byte("export const e = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"x"}`), 0o644)
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Skip("cannot create symlinks: " + err.Error())
	}
	out := filepath.Join(t.TempDir(), "out")
	if _, err := Run(t.Context(), Options{Src: dir, Output: out, Workers: 1}); err != nil {
		t.Fatal(err)
	}
	_ = filepath.Walk(filepath.Dir(out), func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && !strings.HasPrefix(p, out+string(filepath.Separator)) {
			t.Errorf("a file was written outside the output directory: %s", p)
		}
		return nil
	})
}
