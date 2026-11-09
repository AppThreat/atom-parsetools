package typemap

import (
	"bytes"
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

// underlayDefaults gives o astgen's default for every option the configuration, with its extends
// chain, left unset: astgen merges `{...DEFAULT_TSC_OPTIONS, ...detected, ...parsed options,
// ...FORCED_TSC_OPTIONS}`, so a project's own target, module, moduleResolution, lib, jsx and
// exactOptionalPropertyTypes are the ones its program uses. d carries the detected NodeNext
// settings when the configuration sets neither module nor moduleResolution itself. A target or
// module resolution TypeScript 7 removed (ES5, classic) counts as unset.
func underlayDefaults(o *core.CompilerOptions, d *core.CompilerOptions) {
	tri := func(v *core.Tristate, def core.Tristate) {
		if *v == core.TSUnknown {
			*v = def
		}
	}
	if o.Target == core.ScriptTargetNone || o.Target < core.ScriptTargetES2015 {
		o.Target = d.Target
	}
	if o.Module == core.ModuleKindNone {
		o.Module = d.Module
	}
	if o.ModuleResolution == core.ModuleResolutionKindUnknown || o.ModuleResolution == core.ModuleResolutionKindClassic {
		o.ModuleResolution = d.ModuleResolution
	}
	tri(&o.AllowImportingTsExtensions, d.AllowImportingTsExtensions)
	tri(&o.AllowArbitraryExtensions, d.AllowArbitraryExtensions)
	tri(&o.AllowSyntheticDefaultImports, d.AllowSyntheticDefaultImports)
	tri(&o.AllowUmdGlobalAccess, d.AllowUmdGlobalAccess)
	tri(&o.AllowUnreachableCode, d.AllowUnreachableCode)
	tri(&o.AllowUnusedLabels, d.AllowUnusedLabels)
	tri(&o.AlwaysStrict, d.AlwaysStrict)
	tri(&o.EmitDecoratorMetadata, d.EmitDecoratorMetadata)
	tri(&o.ExactOptionalPropertyTypes, d.ExactOptionalPropertyTypes)
	tri(&o.ExperimentalDecorators, d.ExperimentalDecorators)
	tri(&o.NoUncheckedIndexedAccess, d.NoUncheckedIndexedAccess)
	tri(&o.NoPropertyAccessFromIndexSignature, d.NoPropertyAccessFromIndexSignature)
	tri(&o.ResolvePackageJsonExports, d.ResolvePackageJsonExports)
	tri(&o.ResolvePackageJsonImports, d.ResolvePackageJsonImports)
	tri(&o.VerbatimModuleSyntax, d.VerbatimModuleSyntax)
	if o.Jsx == core.JsxEmitNone {
		o.Jsx = d.Jsx
	}
	if o.Lib == nil {
		o.Lib = d.Lib
	}
}

// forcedOptions are astgen's FORCED_TSC_OPTIONS: every program types JavaScript too and never
// emits. They go to the configuration parser as existing options (allowJs also decides whether
// `include` lists JavaScript files) and win over the configuration.
func forcedOptions() *core.CompilerOptions {
	return &core.CompilerOptions{AllowJs: core.TSTrue, CheckJs: core.TSTrue, NoEmit: core.TSTrue, SkipLibCheck: core.TSTrue, ResolveJsonModule: core.TSTrue}
}

// emulateBaseURL keeps TypeScript 6's meaning of `baseUrl` for `paths`: their entries are relative to
// it, where TypeScript 7 takes them relative to the tsconfig. A bare specifier resolved through
// `baseUrl` alone (`import "src/lib/x"`) is not emulated: the `"*"` entry that would do it also makes
// the printer write package types through it (`import("node_modules/rxjs/dist/types")` instead of
// `import("rxjs")`), which changes the type names chen derives.
func emulateBaseURL(o *core.CompilerOptions) {
	if o.BaseUrl == "" || o.Paths == nil || o.Paths.Size() == 0 {
		return
	}
	o.PathsBasePath = o.BaseUrl
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

// stripJSONC removes a byte order mark, comments and trailing commas so encoding/json can read a
// tsconfig, as TypeScript's own reader accepts them. Comments go first, so that a comma followed by a
// comment and then a closing bracket is seen as trailing.
func stripJSONC(in []byte) []byte {
	in = bytes.TrimPrefix(in, []byte("\xef\xbb\xbf"))
	return dropTrailingCommas(dropComments(in))
}

// skipString copies the string literal that starts at in[i] to out and returns the index after it.
func skipString(in []byte, i int, out []byte) (int, []byte) {
	out = append(out, in[i])
	for i++; i < len(in); i++ {
		out = append(out, in[i])
		if in[i] == '\\' && i+1 < len(in) {
			i++
			out = append(out, in[i])
		} else if in[i] == '"' {
			return i + 1, out
		}
	}
	return i, out
}

func dropComments(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); {
		switch {
		case in[i] == '"':
			i, out = skipString(in, i, out)
		case in[i] == '/' && i+1 < len(in) && in[i+1] == '/':
			for i < len(in) && in[i] != '\n' {
				i++
			}
		case in[i] == '/' && i+1 < len(in) && in[i+1] == '*':
			i += 2
			for i+1 < len(in) && !(in[i] == '*' && in[i+1] == '/') {
				i++
			}
			i += 2
			out = append(out, ' ')
		default:
			out = append(out, in[i])
			i++
		}
	}
	return out
}

func dropTrailingCommas(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); {
		switch {
		case in[i] == '"':
			i, out = skipString(in, i, out)
		case in[i] == ',':
			j := i + 1
			for j < len(in) && (in[j] == ' ' || in[j] == '\n' || in[j] == '\r' || in[j] == '\t') {
				j++
			}
			if j < len(in) && (in[j] == '}' || in[j] == ']') {
				i++
				continue
			}
			out = append(out, in[i])
			i++
		default:
			out = append(out, in[i])
			i++
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

// CheckerCount is the number of checkers the program's pool has.
func (s *Setup) CheckerCount() int {
	if n := s.Program.Options().Checkers; n != nil {
		return *n
	}
	return 1
}

// Options returns the compiler options the program was created with.
func (s *Setup) Options() *core.CompilerOptions { return s.Program.Options() }

// BuildSetup is createTscProgramConfig followed by createProgram. projectFiles
// are the discovered files (without node_modules); checkers is the number of
// type checkers the program may use.
// BuildSetup builds the program for projectFiles under src. spec, when the run has nested projects
// or a solution-style root, names the configuration to read instead of searching from src, and a
// file that configuration lists but another project of the run owns is left to that project.
func BuildSetup(src string, projectFiles []string, disc *Discovery, checkers int, spec *ProgramSpec) (*Setup, error) {
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

	cfgPath := findConfigFile(src)
	if spec != nil && spec.ConfigPath != "" {
		cfgPath = spec.ConfigPath
	}
	if cfgPath != "" {
		respect := hasExplicitCompilerOption(cfgPath, "module", "moduleResolution")
		p, diags := tsoptions.GetParsedCommandLineOfConfigFile(rootedFile(cfgPath), forcedOptions(), nil, tsoptions.NewDefaultParseConfigHost(fs), nil)
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
			defaults := baseOptions()
			if nodeNext && !respect {
				overlayNodeNext(defaults)
			}
			underlayDefaults(o, defaults)
			emulateBaseURL(o)
			opts = o
			for _, f := range p.FileNames() {
				ff := string(f)
				if IsUnderRoot(filepath.FromSlash(ff), src) && disc.IsLeftOutByDiscovery(filepath.FromSlash(ff), src) {
					continue
				}
				if spec.isOtherProjectsFile(filepath.FromSlash(ff)) {
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
		// astgen passes no project references to createProgram. With them tsgo would redirect each
		// root file to the referenced project's output and load none of the sources itself.
		parsed.ParsedConfig.ProjectReferences = nil
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

// configRootNames is the file list of the configuration a program for projectFiles under src
// would read (configPath, or the one found from src), with what discovery leaves out removed, as
// BuildSetup lists them, plus the project files themselves: astgen's tscConfig.rootNames, computed
// without building a program.
func configRootNames(src string, projectFiles []string, disc *Discovery, configPath string) []string {
	set := map[string]bool{}
	for _, f := range projectFiles {
		if isSupportedRoot(f) {
			set[filepath.ToSlash(f)] = true
		}
	}
	if configPath == "" {
		configPath = findConfigFile(src)
	}
	if configPath != "" {
		fs := bundled.WrapFS(cachedvfs.From(osvfs.FS()))
		if p, _ := tsoptions.GetParsedCommandLineOfConfigFile(rootedFile(configPath), forcedOptions(), nil, tsoptions.NewDefaultParseConfigHost(fs), nil); p != nil {
			for _, f := range p.FileNames() {
				ff := string(f)
				if IsUnderRoot(filepath.FromSlash(ff), src) && disc.IsLeftOutByDiscovery(filepath.FromSlash(ff), src) {
					continue
				}
				set[ff] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for f := range set {
		out = append(out, f)
	}
	sort.Strings(out)
	return out
}
