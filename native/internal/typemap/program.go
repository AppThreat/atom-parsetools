package typemap

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/microsoft/TypeScript/tsc/shim/ast"
	"github.com/microsoft/TypeScript/tsc/shim/bundled"
	"github.com/microsoft/TypeScript/tsc/shim/compiler"
	"github.com/microsoft/TypeScript/tsc/shim/core"
	"github.com/microsoft/TypeScript/tsc/shim/tsoptions"
	"github.com/microsoft/TypeScript/tsc/shim/tspath"
	"github.com/microsoft/TypeScript/tsc/shim/vfs"
	"github.com/microsoft/TypeScript/tsc/shim/vfs/cachedvfs"
	"github.com/microsoft/TypeScript/tsc/shim/vfs/osvfs"
)

// Setup is the checker's view of a project: the program, the file names it
// was rooted at (astgen's tscConfig.rootNames) and what had to be worked
// around on the way.
type Setup struct {
	Program    *compiler.Program
	RootNames  []string // sorted, absolute, slash separated
	ConfigPath string   // the tsconfig/jsconfig that was used, or ""
	Warnings   []string
	FS         vfs.FS
	host       compiler.CompilerHost
}

// baseOptions is DEFAULT_TSC_OPTIONS from astgen.js, without noStrictGenericChecks,
// which TypeScript 7 removed. astgen does not set
// `strict`, so a project without a tsconfig is checked without strictNullChecks.
func baseOptions() *core.CompilerOptions {
	return &core.CompilerOptions{
		Target:                             core.ScriptTargetES2022,
		Module:                             core.ModuleKindCommonJS,
		ModuleResolution:                   core.ModuleResolutionKindNode10, // TypeScript 7 maps this to bundler for CommonJS
		AllowImportingTsExtensions:         core.TSFalse,
		AllowArbitraryExtensions:           core.TSFalse,
		AllowSyntheticDefaultImports:       core.TSTrue,
		AllowUmdGlobalAccess:               core.TSTrue,
		AllowJs:                            core.TSTrue,
		CheckJs:                            core.TSTrue,
		AllowUnreachableCode:               core.TSTrue,
		AllowUnusedLabels:                  core.TSTrue,
		AlwaysStrict:                       core.TSFalse,
		EmitDecoratorMetadata:              core.TSTrue,
		ExactOptionalPropertyTypes:         core.TSTrue,
		ExperimentalDecorators:             core.TSTrue,
		NoUncheckedIndexedAccess:           core.TSFalse,
		NoPropertyAccessFromIndexSignature: core.TSFalse,
		NoEmit:                             core.TSTrue,
		SkipLibCheck:                       core.TSTrue,
		ResolveJsonModule:                  core.TSTrue,
		Jsx:                                core.JsxEmitPreserve,
		Lib:                                []string{"lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"},
	}
}

// overlayNodeNext applies detectDefaultTscOptions' extra settings.
func overlayNodeNext(o *core.CompilerOptions) {
	o.Module = core.ModuleKindNodeNext
	o.ModuleResolution = core.ModuleResolutionKindNodeNext
	o.ResolvePackageJsonExports = core.TSTrue
	o.ResolvePackageJsonImports = core.TSTrue
	o.AllowImportingTsExtensions = core.TSTrue
	o.VerbatimModuleSyntax = core.TSTrue
}

// overlayDefaults copies every option astgen's defaults set onto o. In
// TypeScript 6 these are `existingOptions` to parseJsonConfigFileContent, which
// win over the tsconfig for the keys they set (checked against TypeScript 6.0:
// a tsconfig with target es5 and jsx react still gave ES2022 and preserve).
func overlayDefaults(o *core.CompilerOptions, d *core.CompilerOptions, nodeNext bool) {
	o.Target, o.Module, o.ModuleResolution = d.Target, d.Module, d.ModuleResolution
	o.AllowImportingTsExtensions, o.AllowArbitraryExtensions = d.AllowImportingTsExtensions, d.AllowArbitraryExtensions
	o.AllowSyntheticDefaultImports, o.AllowUmdGlobalAccess = d.AllowSyntheticDefaultImports, d.AllowUmdGlobalAccess
	o.AllowJs, o.CheckJs = d.AllowJs, d.CheckJs
	o.AllowUnreachableCode, o.AllowUnusedLabels, o.AlwaysStrict = d.AllowUnreachableCode, d.AllowUnusedLabels, d.AlwaysStrict
	o.EmitDecoratorMetadata, o.ExactOptionalPropertyTypes, o.ExperimentalDecorators = d.EmitDecoratorMetadata, d.ExactOptionalPropertyTypes, d.ExperimentalDecorators
	o.NoUncheckedIndexedAccess, o.NoPropertyAccessFromIndexSignature = d.NoUncheckedIndexedAccess, d.NoPropertyAccessFromIndexSignature
	o.NoEmit, o.SkipLibCheck, o.ResolveJsonModule = d.NoEmit, d.SkipLibCheck, d.ResolveJsonModule
	o.Jsx, o.Lib = d.Jsx, d.Lib
	if nodeNext {
		overlayNodeNext(o)
	}
}

// IsUnderRoot mirrors isUnderRoot.
func IsUnderRoot(file, root string) bool {
	rel, err := filepath.Rel(root, file)
	if err != nil || rel == "" || rel == "." || filepath.IsAbs(rel) {
		return false
	}
	return strings.Split(filepath.ToSlash(rel), "/")[0] != ".."
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

func readJSONIfExists(path string) map[string]any {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

func findNearestPackageJSON(src string) string {
	dir := src
	for {
		p := filepath.Join(dir, "package.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// usesNodeNext mirrors detectDefaultTscOptions' decision.
func usesNodeNext(files []string, src string) bool {
	if pj := findNearestPackageJSON(src); pj != "" {
		if m := readJSONIfExists(pj); m != nil {
			if m["type"] == "module" || truthy(m["exports"]) || truthy(m["imports"]) {
				return true
			}
		}
	}
	for _, f := range files {
		if strings.HasSuffix(f, ".mts") || strings.HasSuffix(f, ".cts") {
			return true
		}
	}
	return false
}

func findConfigFile(src string) string {
	for _, name := range []string{"tsconfig.json", "jsconfig.json"} {
		dir := src
		for {
			p := filepath.Join(dir, name)
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func findTypeRoots(dir string) []string {
	var roots []string
	for {
		p := filepath.Join(dir, "node_modules", "@types")
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			roots = append(roots, p)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return roots
		}
		dir = parent
	}
}

// withAutomaticTypes mirrors the function of the same name in astgen.js:
// TypeScript 6 and 7 leave every @types package out unless `types` names it.
func withAutomaticTypes(o *core.CompilerOptions, src string, hasConfig bool) {
	if o.Types != nil {
		return
	}
	if hasConfig {
		o.Types = []string{"*"}
		return
	}
	roots := findTypeRoots(src)
	if o.TypeRoots != nil {
		return
	}
	if len(roots) > 0 {
		o.Types = []string{"*"}
		for _, r := range roots {
			o.TypeRoots = append(o.TypeRoots, tspath.RootedDirectoryPath(tspath.RootedPathFromAbsolute(r)))
		}
	}
}

// stripJSONC removes comments and trailing commas so encoding/json can read a tsconfig.
func stripJSONC(in []byte) []byte {
	var out []byte
	inStr := false
	for i := 0; i < len(in); i++ {
		c := in[i]
		if inStr {
			out = append(out, c)
			if c == '\\' && i+1 < len(in) {
				i++
				out = append(out, in[i])
			} else if c == '"' {
				inStr = false
			}
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out = append(out, c)
		case c == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
			out = append(out, '\n')
		case c == '/' && i+1 < len(in) && in[i+1] == '*':
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i++
		case c == ',':
			j := i + 1
			for j < len(in) && (in[j] == ' ' || in[j] == '\n' || in[j] == '\r' || in[j] == '\t') {
				j++
			}
			if j < len(in) && (in[j] == '}' || in[j] == ']') {
				continue
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}

func hasExplicitCompilerOption(configPath string, names ...string) bool {
	b, err := os.ReadFile(configPath)
	if err != nil {
		return false
	}
	var m struct {
		CompilerOptions map[string]any `json:"compilerOptions"`
	}
	if json.Unmarshal(stripJSONC(b), &m) != nil {
		return false
	}
	for _, n := range names {
		if _, ok := m.CompilerOptions[n]; ok {
			return true
		}
	}
	return false
}

func rootedFile(p string) tspath.RootedFilePath {
	return tspath.RootedFilePath(tspath.RootedPathFromAbsolute(p))
}

func diagText(d *ast.Diagnostic) string {
	if t := d.MessageText(); t != "" {
		return t
	}
	return fmt.Sprintf("%s %v", d.MessageKey(), d.MessageArgs())
}

var supportedRootExt = []string{".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}

func isSupportedRoot(f string) bool {
	if strings.HasSuffix(f, ".d.ts") || strings.HasSuffix(f, ".d.mts") || strings.HasSuffix(f, ".d.cts") {
		return true
	}
	for _, e := range supportedRootExt {
		if strings.HasSuffix(f, e) {
			return true
		}
	}
	return false
}

// BuildSetup is createTscProgramConfig followed by createProgram. projectFiles
// are the discovered files (without node_modules); checkers is the number of
// type checkers the program may use.
func BuildSetup(src string, projectFiles []string, disc *Discovery, checkers int) (*Setup, error) {
	s := &Setup{}
	fs := bundled.WrapFS(cachedvfs.From(osvfs.FS()))
	s.FS = fs
	host := compiler.NewCompilerHost(fs, bundled.LibPath(), nil, nil, nil)
	s.host = host

	nodeNext := usesNodeNext(projectFiles, src)
	opts := baseOptions()
	rootSet := map[string]bool{}
	for _, f := range projectFiles {
		if isSupportedRoot(f) {
			rootSet[filepath.ToSlash(f)] = true
		}
	}
	var parsed *tsoptions.ParsedCommandLine

	if cfgPath := findConfigFile(src); cfgPath != "" {
		respect := hasExplicitCompilerOption(cfgPath, "module", "moduleResolution")
		p, diags := tsoptions.GetParsedCommandLineOfConfigFile(rootedFile(cfgPath), &core.CompilerOptions{}, nil, tsoptions.NewDefaultParseConfigHost(fs), nil)
		if p == nil {
			for _, d := range diags {
				s.Warnings = append(s.Warnings, "tsconfig "+cfgPath+" is unreadable, using the defaults: "+diagText(d))
			}
		} else {
			parsed = p
			s.ConfigPath = cfgPath
			for _, d := range p.Errors {
				if strings.HasPrefix(diagText(d), "No inputs were found") {
					continue
				}
				s.Warnings = append(s.Warnings, "tsconfig "+cfgPath+": "+diagText(d))
			}
			o := p.CompilerOptions()
			if o == nil {
				o = &core.CompilerOptions{}
			}
			overlayDefaults(o, baseOptions(), nodeNext && !respect)
			opts = o
			for _, f := range p.FileNames() {
				ff := string(f)
				if IsUnderRoot(filepath.FromSlash(ff), src) && disc.IsLeftOutByDiscovery(filepath.FromSlash(ff), src) {
					continue
				}
				rootSet[ff] = true
			}
		}
	}
	if parsed == nil && nodeNext {
		overlayNodeNext(opts)
	}
	opts.AllowJs, opts.CheckJs, opts.NoEmit, opts.SkipLibCheck, opts.ResolveJsonModule = core.TSTrue, core.TSTrue, core.TSTrue, core.TSTrue, core.TSTrue
	withAutomaticTypes(opts, src, parsed != nil)
	if checkers > 1 {
		n := checkers
		opts.Checkers = &n
	} else {
		opts.Checkers = nil
	}

	roots := make([]string, 0, len(rootSet))
	for f := range rootSet {
		roots = append(roots, f)
	}
	sort.Strings(roots)
	s.RootNames = roots
	rooted := make([]tspath.RootedFilePath, len(roots))
	for i, r := range roots {
		rooted[i] = rootedFile(r)
	}
	base := tspath.RootedDirectoryPath(tspath.RootedPathFromAbsolute(src))
	var cfg *tsoptions.ParsedCommandLine
	if parsed != nil {
		parsed.SetCompilerOptions(opts)
		cfg = parsed.WithFileNames(rooted)
	} else {
		cfg = tsoptions.NewParsedCommandLine(opts, rooted, nil, base, fs.CaseSensitivity())
	}
	s.Program = compiler.NewProgram(compiler.ProgramOptions{
		ProgramConfig: compiler.ProgramConfig{Config: cfg, SingleThreaded: core.BoolToTristate(checkers <= 1)},
		ProgramHosts:  compiler.ProgramHosts{Host: host},
	})
	if s.Program == nil {
		return nil, fmt.Errorf("the TypeScript program could not be created")
	}
	s.Program.BindSourceFiles()
	return s, nil
}
