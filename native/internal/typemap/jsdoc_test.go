package typemap

import (
	"strings"
	"testing"
)

// Nodes that TypeScript 7 builds from JSDoc tags lie inside the comment. Only the root of such a subtree
// carries the reparsed flag, so every node parsed inside JSDoc is left out, while the real expression
// inside a JSDoc cast is still typed.
func TestNothingInsideJSDocIsTyped(t *testing.T) {
	src := "/** @import { Foo } from \"./foo\" */\n" +
		"/** @template T @param {T} x @returns {T} */\n" +
		"function id(x) { return x; }\n" +
		"const n = /** @type {number} */ (id(1));\n"
	foo := "export class Foo {}\n"
	maps, _ := runProject(t, map[string]string{"a.js": src, "foo.js": foo}, 1, Env{}, Budget{})
	m := maps["a.js"]
	inComment := func(pos int) bool {
		for i := 0; i < len(src); {
			s := strings.Index(src[i:], "/**")
			if s < 0 {
				return false
			}
			e := strings.Index(src[i+s:], "*/")
			if pos >= i+s && pos < i+s+e+2 {
				return true
			}
			i += s + e + 2
		}
		return false
	}
	for pos, typ := range m {
		if inComment(pos) {
			t.Errorf("key %d (%q) lies inside a JSDoc comment", pos, typ)
		}
	}
	if got := typeAt(m, src, "id(1)"); got == "" {
		t.Errorf("the call inside the cast must be typed")
	}
}
