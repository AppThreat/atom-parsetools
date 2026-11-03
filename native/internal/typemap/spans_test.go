package typemap

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// runSpans runs the type map for one file and returns the type the span file has for the text between
// the first occurrence of from and the end of that text's first occurrence of upTo, counted from from.
func runSpans(t *testing.T, src string) (map[string]string, map[int]string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"fixture"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.ts"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "out")
	if _, err := Run(context.Background(), Options{Src: dir, Output: out, Workers: 1}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(out, "a.ts.typespans"))
	if err != nil {
		t.Fatalf("no span file written: %v", err)
	}
	spans := map[string]string{}
	if err := json.Unmarshal(b, &spans); err != nil {
		t.Fatal(err)
	}
	return spans, readMaps(t, out)["a.ts"]
}

func spanOf(t *testing.T, spans map[string]string, src, text string) string {
	t.Helper()
	i := strings.Index(src, text)
	if i < 0 {
		t.Fatalf("%q not in the source", text)
	}
	// ASCII source: UTF-16 offsets are byte offsets
	return spans[strconv.Itoa(i)+":"+strconv.Itoa(i+len(text))]
}

// The position keyed map has one type for `svc`, `svc.load` and `svc.load(user)`, which all start at
// one offset; the span file has the type of each of them.
func TestSpansTellApartNodesThatStartAtOneOffset(t *testing.T) {
	src := "interface User { id: number }\nclass Svc { load(u: User) { return u; } }\ndeclare const svc: Svc;\ndeclare const user: User;\nexport const out = svc.load(user);\n"
	spans, tm := runSpans(t, src)
	for text, want := range map[string]string{
		"svc.load(user)": "User",
		"svc.load":       "(u: User) => User",
	} {
		if got := spanOf(t, spans, src, text); got != want {
			t.Errorf("%q: got %q, want %q", text, got, want)
		}
	}
	// the last occurrence of `svc` is the receiver of the call
	last := strings.LastIndex(src, "svc.load(user)")
	if got := spans[strconv.Itoa(last)+":"+strconv.Itoa(last+3)]; got != "Svc" {
		t.Errorf("receiver svc: got %q, want Svc", got)
	}
	if got := tm[last]; got == "Svc" {
		t.Errorf("the type map was expected to hold one type for the three nodes at %d, got %q", last, got)
	}
}

// A function declaration's span without the leading `export default` is also written, as Babel starts a
// function after those keywords and TypeScript before them.
func TestSpansOfExportedFunctionWithoutKeywords(t *testing.T) {
	src := "export async function run() { return 1; }\n"
	spans, _ := runSpans(t, src)
	i := strings.Index(src, "async function")
	if got := spans[strconv.Itoa(i)+":"+strconv.Itoa(len(src)-1)]; got != "Promise<number>" {
		t.Errorf("function without export: got %q (%v)", got, spans)
	}
}

// `any` is not written: a node without a span entry is one the checker could not type.
func TestSpansLeaveOutAny(t *testing.T) {
	src := "declare const x: any;\nexport const y = x;\nexport const z = 1;\n"
	spans, _ := runSpans(t, src)
	for k, v := range spans {
		if v == "any" || v == "unknown" {
			t.Errorf("span %s has %q", k, v)
		}
	}
}
