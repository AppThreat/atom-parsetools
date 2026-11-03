package typemap

import (
	"net/url"
	"path"
	"regexp"
	"strings"

	"github.com/microsoft/TypeScript/tsc/shim/ast"
	"github.com/microsoft/TypeScript/tsc/shim/checker"
)

// Never add TypeFormatFlagsNoTruncation: it replaces MaxTruncationLength with a
// limit of one million characters and an unbounded type exhausted memory on
// cdxgen.
const flagsFull = checker.TypeFormatFlagsInTypeAlias |
	checker.TypeFormatFlagsWriteArrayAsGenericType |
	checker.TypeFormatFlagsGenerateNamesForShadowedTypeParams |
	checker.TypeFormatFlagsWriteTypeArgumentsOfSignature |
	checker.TypeFormatFlagsUseFullyQualifiedType |
	checker.TypeFormatFlagsNoTypeReduction

// The same flags with type aliases written by name, for a type too long to
// write out.
const flagsByName = flagsFull &^ checker.TypeFormatFlagsInTypeAlias

// MaxTypeStringLength is the longest type string written (astgen's MAX_TYPE_STRING_LENGTH).
const MaxTypeStringLength = 4096

const (
	typeWritable = iota
	typeByName
	typeUnwritable
)

var importSpecifierRe = regexp.MustCompile(`import\("([^"]+)"(?:,\s*\{\s*with:\s*\{\s*"resolution-mode":\s*"import"\s*\}\s*\})?\)`)
var typeFileExtRe = regexp.MustCompile(`(\.d)?\.(tsx?|jsx?|mts|cts|mjs|cjs)$`)

// posixRelative is path.relative for two absolute slash separated paths.
func posixRelative(from, to string) string {
	f := strings.Split(strings.Trim(path.Clean(from), "/"), "/")
	t := strings.Split(strings.Trim(path.Clean(to), "/"), "/")
	if len(f) == 1 && f[0] == "" {
		f = nil
	}
	if len(t) == 1 && t[0] == "" {
		t = nil
	}
	i := 0
	for i < len(f) && i < len(t) && f[i] == t[i] {
		i++
	}
	parts := make([]string, 0, len(f)-i+len(t)-i)
	for k := i; k < len(f); k++ {
		parts = append(parts, "..")
	}
	parts = append(parts, t[i:]...)
	return strings.Join(parts, "/")
}

func isDriveAbsolute(s string) bool {
	return len(s) > 2 && s[1] == ':' && s[2] == '/' && (s[0]|0x20) >= 'a' && (s[0]|0x20) <= 'z'
}

// normalizeImportedTypeSpecifier is the function of the same name in astgen.js.
// A drive-letter path is made relative like a rooted one; astgen leaves it
// absolute, which makes Windows output differ from POSIX output.
func normalizeImportedTypeSpecifier(specifier, currentFile string) string {
	s := strings.ReplaceAll(specifier, "\\", "/")
	cur := strings.ReplaceAll(currentFile, "\\", "/")
	if strings.HasPrefix(s, "file://") {
		if u, err := url.Parse(s); err == nil {
			p := u.Path
			if len(p) > 2 && p[0] == '/' && p[2] == ':' {
				p = p[1:]
			}
			s = strings.ReplaceAll(p, "\\", "/")
		}
	}
	if cur != "" && (strings.HasPrefix(s, "/") || isDriveAbsolute(s)) {
		rel := posixRelative(path.Dir(cur), s)
		if strings.HasPrefix(rel, ".") {
			s = rel
		} else {
			s = "./" + rel
		}
	}
	return typeFileExtRe.ReplaceAllString(s, "")
}

func normalizeTypeString(s, currentFile string) string {
	if s == "" || !strings.Contains(s, "import(") {
		return s
	}
	return importSpecifierRe.ReplaceAllStringFunc(s, func(m string) string {
		sub := importSpecifierRe.FindStringSubmatch(m)
		return `import("` + normalizeImportedTypeSpecifier(sub[1], currentFile) + `")`
	})
}

// writeType prints t once with the given flags and reports whether the result
// is complete: the checker did not cut it short, it is under the limit and the
// node builder stayed within its call budget. Like astgen's cancelled write, a
// write over the call budget is incomplete, so the caller can still try the
// shorter form with aliases by name.
func (u *unit) writeType(t *checker.Type, enclosing *ast.Node, flags checker.TypeFormatFlags) (s string, ok bool) {
	defer func() {
		if r := recover(); r != nil {
			if _, over := r.(checker.BuilderBudgetExceeded); !over {
				panic(r)
			}
			s, ok = "", false
		}
	}()
	vc := &checker.VerbosityContext{MaxTruncationLength: MaxTypeStringLength, MaxBuilderCalls: u.builderCalls}
	u.stats.writes++
	s = u.c.TypeToStringEx(t, enclosing, flags, vc)
	if vc.Truncated {
		return s, false
	}
	if len(s) >= MaxTypeStringLength && JSLen(s) >= MaxTypeStringLength {
		return s, false
	}
	return s, true
}

// typeToBounded is typeToBoundedString: full, then aliases by name, then "any".
// The state of a type that did not fit is remembered for the rest of the file,
// because the checker keeps a cut-short type cached for its enclosing node.
func (u *unit) typeToBounded(t *checker.Type, enclosing *ast.Node) string {
	st := u.oversized[t]
	if st == typeWritable {
		if s, ok := u.writeType(t, enclosing, flagsFull); ok {
			return s
		}
		u.oversized[t] = typeByName
		st = typeByName
	}
	if st == typeByName {
		u.stats.retriedByName++
		if s, ok := u.writeType(t, enclosing, flagsByName); ok {
			return s
		}
		u.oversized[t] = typeUnwritable
		u.stats.gaveUp++
	}
	return "any"
}

// typeStr is safeTypeToString and safeTypeWithContextToString (they differ
// only in argument names in astgen.js).
func (u *unit) typeStr(t *checker.Type, enclosing *ast.Node) (res string) {
	if t == nil {
		return "any"
	}
	defer func() {
		if r := recover(); r != nil {
			if _, ok := r.(checker.Interrupted); ok {
				panic(r) // not a failure of this type: the whole file is out of budget
			}
			u.noteRecovered(r)
			res = "any"
		}
	}()
	if m := u.moduleTypeName(t); m != "" {
		return normalizeTypeString(m, string(u.sf.FileName()))
	}
	return normalizeTypeString(u.typeToBounded(t, enclosing), string(u.sf.FileName()))
}

// moduleTypeName names the type a CommonJS module exports (`module.exports = {...}`)
// as `typeof import("<file>")`, which is what TypeScript 6 wrote for most uses of a
// required module and what chen turns into a link to that module. TypeScript 7
// prints the exported object's structure instead, which loses the module. Inside
// the exporting file TypeScript 6 printed the structure too, and so does this.
func (u *unit) moduleTypeName(t *checker.Type) string {
	if t.Flags()&checker.TypeFlagsObject == 0 {
		return ""
	}
	sym := t.Symbol()
	if sym == nil || sym.ValueDeclaration() == nil {
		return ""
	}
	sf := ast.GetSourceFileOfNode(sym.ValueDeclaration())
	if sf == nil || sf == u.sf || !ast.IsExternalOrCommonJSModule(sf) {
		return ""
	}
	name := string(sf.FileName())
	if cached, ok := u.moduleTypes[name]; ok {
		if cached == t {
			return `typeof import("` + name + `")`
		}
		return ""
	}
	var exported *checker.Type
	if fileSym := sf.AsNode().Symbol(); fileSym != nil {
		if ms := u.c.ResolveExternalModuleSymbol(fileSym); ms != nil && ms != fileSym {
			exported = u.c.GetTypeOfSymbol(ms)
		}
	}
	u.moduleTypes[name] = exported
	if exported == t {
		return `typeof import("` + name + `")`
	}
	return ""
}
