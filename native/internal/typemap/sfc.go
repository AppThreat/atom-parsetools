package typemap

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/microsoft/TypeScript/tsc/shim/ast"
)

//go:embed shims/vue-shims.d.ts
var vueShims string

//go:embed shims/svelte-shims.d.ts
var svelteShims string

// scriptTagRe is vueScriptTagRegex in astgen.js.
var scriptTagRe = regexp.MustCompile(`(?i)<script\b[^>]*>([\s\S]*?)</script>`)

// decodeUTF16 decodes UTF-8 text into UTF-16 code units the way Node's utf-8 decoder does: each maximal
// invalid subpart becomes one U+FFFD, so every index into the result is an offset Babel and chen use.
func decodeUTF16(s string) []uint16 {
	out := make([]uint16, 0, len(s))
	for i := 0; i < len(s); {
		n, _ := decodeStep(s[i:])
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size <= 1 {
			out = append(out, 0xFFFD)
		} else if r >= 0x10000 {
			r1, r2 := utf16.EncodeRune(r)
			out = append(out, uint16(r1), uint16(r2))
		} else {
			out = append(out, uint16(r))
		}
		i += n
	}
	return out
}

// VirtualSource is createVirtualTypeSource: the file with every character but line breaks replaced by
// a space, and the contents of each <script> element put back where they were. Offsets in the result
// are offsets in the file, so the type map keys of the virtual file are keys of the original.
func VirtualSource(code string) (source string, hasScript bool) {
	units := decodeUTF16(code)
	out := make([]uint16, len(units))
	for i, u := range units {
		if u == '\r' || u == '\n' {
			out[i] = u
		} else {
			out[i] = ' '
		}
	}
	// Match positions are byte offsets in code; convert each to a UTF-16 offset.
	off := NewOffsets(code, false)
	for _, m := range scriptTagRe.FindAllStringSubmatchIndex(code, -1) {
		full := code[m[0]:m[1]]
		content := code[m[2]:m[3]]
		if strings.TrimSpace(content) != "" {
			hasScript = true
		}
		// contentStart = match.index + fullMatch.indexOf(scriptContent): the first occurrence of the
		// content inside the match, which for a script whose text also appears in its own tag is the tag.
		contentStart := off.At(m[0]) + JSLen(full[:strings.Index(full, content)])
		for i, u := range decodeUTF16(content) {
			if contentStart+i < len(out) {
				out[contentStart+i] = u
			}
		}
	}
	return string(utf16.Decode(out)), hasScript
}

// typeSFC is collectSfcSeenTypes for a file that is not in the project program (a .vue or .svelte
// path never is): type the virtual source with a throwaway program next to the framework's shim
// declarations, both in a temporary directory, as astgen does. It returns the type map, nil when
// the file has no script content.
func typeSFC(ctx context.Context, file string, b Budget, w *Watch) (seen map[int]string, spans map[Span]string, st fileStats, diag string, err error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, nil, st, "", err
	}
	virtual, has := VirtualSource(string(data))
	if !has {
		return nil, nil, st, "", nil
	}
	shimName, shimSrc := "vue-shims.d.ts", vueShims
	if strings.HasSuffix(file, ".svelte") {
		shimName, shimSrc = "svelte-shims.d.ts", svelteShims
	}
	dir, err := os.MkdirTemp("", "atom-parsetools-sfc-")
	if err != nil {
		return nil, nil, st, "", err
	}
	defer os.RemoveAll(dir)
	vfile := filepath.Join(dir, filepath.Base(file)+".ts")
	sfile := filepath.Join(dir, shimName)
	if err := os.WriteFile(vfile, []byte(virtual), 0o644); err != nil {
		return nil, nil, st, "", err
	}
	if err := os.WriteFile(sfile, []byte(shimSrc), 0o644); err != nil {
		return nil, nil, st, "", err
	}
	// The throwaway directory is resolved the way astgen resolves it: createTsc([virtual, shim], dir).
	real, _ := filepath.EvalSymlinks(dir)
	if real == "" {
		real = dir
	}
	vfile, sfile = filepath.Join(real, filepath.Base(vfile)), filepath.Join(real, shimName)
	disc := NewDiscovery(Env{})
	setup, err := safeBuildSetup(real, []string{vfile, sfile}, disc, 1)
	if err != nil {
		return nil, nil, st, "", err
	}
	sf := setup.Program.GetSourceFile(rootedFile(filepath.ToSlash(vfile)))
	if sf == nil {
		return nil, nil, st, "", fmt.Errorf("the virtual source is not in its program")
	}
	start := time.Now()
	c, done := setup.Program.GetTypeCheckerForFileExclusive(ctx, sf)
	defer done()
	slot := w.Begin()
	defer w.End(slot)
	c.SetInterrupt(slot.Interrupt())
	c.SetWorkLimit(b.FileWork)
	u := newUnit(c, sf, NewOffsets(sf.Text(), false)) // a byte order mark is a space in the virtual source
	u.builderCalls = b.BuilderCalls
	u.slot = slot
	sf.AsNode().ForEachChild(func(ch *ast.Node) bool { u.addType(ch); return false })
	st = u.stats
	st.work = c.Work()
	st.ms = time.Since(start).Milliseconds()
	return u.seen, u.spans, st, u.overWhy, nil
}
