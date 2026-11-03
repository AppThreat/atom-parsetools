package typemap

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestVirtualSourceKeepsOffsetsAndMasksTheTemplate(t *testing.T) {
	code := "<template>\r\n  <p>é😀</p>\r\n</template>\r\n<script setup>\r\nconst a = 1;\r\n</script>\r\n<style>x{}</style>"
	got, has := VirtualSource(code)
	if !has {
		t.Fatal("the script has content")
	}
	orig, virt := utf16.Encode([]rune(code)), utf16.Encode([]rune(got))
	if len(orig) != len(virt) {
		t.Fatalf("length in UTF-16 units changed: %d -> %d", len(orig), len(virt))
	}
	start := strings.Index(code, "const a")
	pos := len(utf16.Encode([]rune(code[:start])))
	if string(utf16.Decode(virt[pos:pos+11])) != "const a = 1" {
		t.Fatalf("script text moved: %q", string(utf16.Decode(virt[pos:pos+11])))
	}
	for i, u := range orig {
		if (u == '\r' || u == '\n') && virt[i] != u {
			t.Fatalf("line break at %d was changed", i)
		}
	}
	if strings.Contains(got, "template") || strings.Contains(got, "style") {
		t.Fatalf("template and style must be masked: %q", got)
	}
}

func TestVirtualSourceWithoutScript(t *testing.T) {
	if _, has := VirtualSource("<template><p/></template>"); has {
		t.Fatal("no script content")
	}
	if _, has := VirtualSource("<script>   \n</script>"); has {
		t.Fatal("a blank script has no content")
	}
}

// The shims are byte for byte the constants in astgen.js.
func TestShimsMatchAstgen(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "astgen.js"))
	if err != nil {
		t.Skip("astgen.js not found: " + err.Error())
	}
	for name, want := range map[string]string{"VUE_COMPILER_MACRO_SHIMS": vueShims, "SVELTE_RUNE_SHIMS": svelteShims} {
		m := regexp.MustCompile("const " + name + " = `([\\s\\S]*?)`;").FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s not found in astgen.js", name)
		}
		// The constants are template literals; the only escapes they use are backslash-quote and \\.
		js := strings.ReplaceAll(strings.ReplaceAll(string(m[1]), `\\`, "\x00"), `\"`, `"`)
		js = strings.ReplaceAll(js, "\x00", `\`)
		if js != want {
			t.Errorf("%s differs from astgen.js; regenerate parsa/internal/typemap/shims", name)
		}
	}
}

func sfcMaps(t *testing.T) (map[string]map[int]string, string) {
	t.Helper()
	proj := filepath.Join("..", "..", "testdata", "typemap", "sfc")
	out := filepath.Join(t.TempDir(), "out")
	if _, err := Run(context.Background(), Options{Src: proj, Output: out, Workers: 1}); err != nil {
		t.Fatal(err)
	}
	return readMaps(t, out), proj
}

func TestSFCScriptTypesAreKeyedByOffsetInTheOriginalFile(t *testing.T) {
	maps, proj := sfcMaps(t)
	vue, _ := os.ReadFile(filepath.Join(proj, "src", "Counter.vue"))
	m := maps["src/Counter.vue"]
	if len(m) == 0 {
		t.Fatal("Counter.vue must be typed")
	}
	// The shim declares Ref<T> as { value: T }; astgen 1.10.6 prints the same.
	if got := typeAt(m, string(vue), "count = ref(props.start)"); got != "{ value: number; }" {
		t.Fatalf("count = %q (script setup with defineProps)", got)
	}
	if got := typeAt(m, string(vue), "label = computed"); got != "{ readonly value: string; }" {
		t.Fatalf("label = %q", got)
	}
	// nothing in the template (it is masked)
	tpl := strings.Index(string(vue), "{{ count }}")
	for k := range m {
		if k < strings.Index(string(vue), "<script") && k >= 0 && k < tpl+10 {
			t.Fatalf("template offset %d has an entry: %q", k, m[k])
		}
	}
}

func TestSFCSvelteRunes(t *testing.T) {
	maps, proj := sfcMaps(t)
	src, _ := os.ReadFile(filepath.Join(proj, "src", "Todo.svelte"))
	if got := typeAt(maps["src/Todo.svelte"], string(src), "remaining ="); got != "number" {
		t.Fatalf("remaining = %q ($derived with the rune shims)", got)
	}
}

func TestSFCWithoutScriptHasNoTypeMap(t *testing.T) {
	maps, _ := sfcMaps(t)
	if _, ok := maps["src/NoScript.vue"]; ok {
		t.Fatal("a component without script content must not get a type map")
	}
}

// A byte order mark, CRLF and an astral character in front of a script: keys are UTF-16 offsets in
// the file as Babel reads it (the mark is a character).
func TestSFCOffsetsWithBOMCRLFAndAstral(t *testing.T) {
	maps, proj := sfcMaps(t)
	data, _ := os.ReadFile(filepath.Join(proj, "src", "Unicode.vue"))
	pos := utf16Index(data, "after =")
	if got := maps["src/Unicode.vue"][pos]; got != "Array<number>" {
		t.Fatalf("type at UTF-16 offset %d = %q; keys: %v", pos, got, maps["src/Unicode.vue"])
	}
	pos = utf16Index(data, "smile =")
	if got := maps["src/Unicode.vue"][pos]; got != "string" {
		t.Fatalf("type at UTF-16 offset %d = %q", pos, got)
	}
}
