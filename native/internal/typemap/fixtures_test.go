package typemap

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode/utf16"
)

// Each file under testdata/typemap/<set>/src is one fixture; its expected type
// map is testdata/typemap/<set>/expected/<name>.typemap, written in TypeScript 7's
// member order and quote style. Set UPDATE_TYPEMAP_FIXTURES=1 to rewrite them after
// reviewing a change (compare with TypeScript 6 astgen before accepting it).

func fixtureSets(t *testing.T) []string {
	t.Helper()
	dirs, _ := filepath.Glob(filepath.Join("..", "..", "testdata", "typemap", "*"))
	var sets []string
	for _, d := range dirs {
		if st, err := os.Stat(filepath.Join(d, "src")); err == nil && st.IsDir() {
			sets = append(sets, d)
		}
	}
	sort.Strings(sets)
	return sets
}

func TestFixtures(t *testing.T) {
	for _, set := range fixtureSets(t) {
		set := set
		t.Run(filepath.Base(set), func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "out")
			if _, err := Run(context.Background(), Options{Src: set, Output: out, Workers: 1}); err != nil {
				t.Fatal(err)
			}
			srcs, _ := filepath.Glob(filepath.Join(set, "src", "*"))
			for _, src := range srcs {
				name := filepath.Base(src)
				t.Run(strings.TrimSuffix(name, filepath.Ext(name)), func(t *testing.T) {
					got, _ := os.ReadFile(filepath.Join(out, "src", name+".typemap"))
					want := filepath.Join(set, "expected", name+".typemap")
					if os.Getenv("UPDATE_TYPEMAP_FIXTURES") == "1" {
						_ = os.MkdirAll(filepath.Dir(want), 0o755)
						if err := os.WriteFile(want, got, 0o644); err != nil {
							t.Fatal(err)
						}
						return
					}
					exp, err := os.ReadFile(want)
					if err != nil {
						t.Fatalf("no expected file %s: %v", want, err)
					}
					if !bytes.Equal(exp, got) {
						t.Fatalf("type map differs from %s\nexpected: %s\ngot:      %s", want, exp, got)
					}
				})
			}
		})
	}
}

// utf16Index is the UTF-16 offset of the first occurrence of marker in the file
// text as Babel sees it: decoded from UTF-8, with a byte order mark counted.
func utf16Index(data []byte, marker string) int {
	text := []rune(string(data))
	m := []rune(marker)
	for i := 0; i+len(m) <= len(text); i++ {
		if string(text[i:i+len(m)]) == marker {
			return len(utf16.Encode(text[:i]))
		}
	}
	return -1
}

func TestOffsetsAreUTF16UnitsOfTheFileOnDisk(t *testing.T) {
	set := filepath.Join("..", "..", "testdata", "typemap", "offsets")
	out := filepath.Join(t.TempDir(), "out")
	if _, err := Run(context.Background(), Options{Src: set, Output: out, Workers: 1}); err != nil {
		t.Fatal(err)
	}
	maps := readMaps(t, out)
	cases := []struct{ file, marker, want string }{
		{"crlf.ts", "second", "string"}, {"crlf.ts", "third", "Array<number>"},
		{"bom.ts", "afterBom", "number"}, {"bom.ts", "second", "string"},
		{"two-byte.ts", "after", "number"}, {"two-byte.ts", "caf\u00e9", "string"},
		{"three-byte.ts", "after", "boolean"},
		{"four-byte.ts", "after", "Array<number>"},
		{"mixed.ts", "b = 2", "number"}, {"mixed.ts", "c =", "string"},
		{"no-final-newline.ts", "end", "string"},
	}
	for _, c := range cases {
		data, _ := os.ReadFile(filepath.Join(set, "src", c.file))
		pos := utf16Index(data, c.marker)
		if pos < 0 {
			t.Fatalf("%s: marker %q not found", c.file, c.marker)
		}
		got := maps["src/"+c.file][pos]
		if got != c.want {
			t.Errorf("%s: type at UTF-16 offset %d (%q) = %q, want %q; keys: %v", c.file, pos, c.marker, got, c.want, maps["src/"+c.file])
		}
	}
}
