package typemap

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Env is the subset of the process environment that decides which files astgen
// looks at. It is a value so tests can set it without touching the process.
type Env struct {
	IgnoreDirs                string // ASTGEN_IGNORE_DIRS
	IgnoreFilePattern         string // ASTGEN_IGNORE_FILE_PATTERN
	IncludeTestFiles          bool   // ASTGEN_INCLUDE_TEST_FILES == "true"
	IncludeMinified           bool   // ASTGEN_INCLUDE_MINIFIED == "true"
	IncludeNodeModulesBundles bool   // ASTGEN_INCLUDE_NODE_MODULES_BUNDLES == "true"
}

// EnvFromProcess reads the variables astgen reads.
func EnvFromProcess() Env {
	return Env{
		IgnoreDirs:                os.Getenv("ASTGEN_IGNORE_DIRS"),
		IgnoreFilePattern:         os.Getenv("ASTGEN_IGNORE_FILE_PATTERN"),
		IncludeTestFiles:          os.Getenv("ASTGEN_INCLUDE_TEST_FILES") == "true",
		IncludeMinified:           os.Getenv("ASTGEN_INCLUDE_MINIFIED") == "true",
		IncludeNodeModulesBundles: os.Getenv("ASTGEN_INCLUDE_NODE_MODULES_BUNDLES") == "true",
	}
}

var defaultIgnoreDirs = []string{"venv", "docs", "e2e", "e2e-beta", "examples", "cypress", "jest-cache", "eslint-rules", "codemods", "flow-typed", "i18n"}

const defaultIgnoreFilePattern = `(three|\.d)\.(js|ts|jsx|tsx)$`

var (
	// astgen.js getAllSrcJSAndTSFiles: no "i" flag.
	sourceFilePattern  = regexp.MustCompile(`\.(js|jsx|cjs|mjs|ts|tsx|mts|cts|vue|svelte|astro|html|hbs|gjs|gts|xsjs|xsjslib|ejs)$`)
	bundledNMPattern   = regexp.MustCompile(`node_modules[\\/].*[\\/](?:.*\.)?(bundle|dist|index|min|app)\.(js|cjs|mjs)$`)
	testFilePattern    = regexp.MustCompile(`(?i)(?:\.(?:poku|test|spec|e2e|integration|it)\.(?:js|jsx|cjs|mjs|ts|tsx|mts|cts)$|[\\/]__(?:tests|mocks)__[\\/])`)
	minifiedPattern    = regexp.MustCompile(`(?i)[.-]min\.(js|cjs|mjs)$`)
	nodeModulesInPath  = regexp.MustCompile(`node_modules[\\/]`)
	declarationPattern = regexp.MustCompile(`(?i)\.d\.[cm]?ts$`)
)

// Discovery decides the file set the way astgen.js does.
type Discovery struct {
	env         Env
	ignoreDirs  []string
	ignoreFile  *regexp.Regexp
	Diagnostics []string
}

// NewDiscovery compiles the ignore pattern. A pattern Go's RE2 cannot compile
// (JavaScript-only syntax such as a lookahead) falls back to the default with
// a diagnostic.
func NewDiscovery(env Env) *Discovery {
	d := &Discovery{env: env}
	if env.IgnoreDirs != "" {
		d.ignoreDirs = strings.Split(env.IgnoreDirs, ",")
	} else {
		d.ignoreDirs = defaultIgnoreDirs
	}
	pat := defaultIgnoreFilePattern
	if env.IgnoreFilePattern != "" {
		pat = env.IgnoreFilePattern
	}
	re, err := regexp.Compile("(?i)" + pat)
	if err != nil {
		d.Diagnostics = append(d.Diagnostics, "ASTGEN_IGNORE_FILE_PATTERN is not a valid RE2 expression, using the default: "+err.Error())
		re = regexp.MustCompile("(?i)" + defaultIgnoreFilePattern)
	}
	d.ignoreFile = re
	return d
}

// IncludeNodeModulesBundles mirrors shouldIncludeNodeModulesBundles.
func (d *Discovery) includeNMBundles() bool {
	if d.env.IncludeNodeModulesBundles {
		return true
	}
	return d.env.IgnoreDirs != "" && !strings.Contains(strings.ToLower(d.env.IgnoreDirs), "node_modules")
}

// IsExcludedTestFile mirrors isExcludedTestFile.
func (d *Discovery) IsExcludedTestFile(file string) bool {
	return !d.env.IncludeTestFiles && testFilePattern.MatchString(file)
}

// IsExcludedMinifiedFile mirrors isExcludedMinifiedFile.
func (d *Discovery) IsExcludedMinifiedFile(file string) bool {
	return !d.env.IncludeMinified && !nodeModulesInPath.MatchString(file) && minifiedPattern.MatchString(file)
}

// IsLeftOutByDiscovery mirrors isLeftOutByDiscovery for a file under srcRoot.
func (d *Discovery) IsLeftOutByDiscovery(file, srcRoot string) bool {
	rel, err := filepath.Rel(srcRoot, file)
	if err != nil {
		return false
	}
	names := strings.Split(filepath.ToSlash(rel), "/")
	fileName := names[len(names)-1]
	names = names[:len(names)-1]
	for _, n := range names {
		if strings.HasPrefix(n, ".") || strings.EqualFold(n, "node_modules") ||
			containsString(d.ignoreDirs, strings.ToLower(n)) || d.ignoreFile.MatchString(n) {
			return true
		}
	}
	return strings.HasPrefix(fileName, ".") || (d.ignoreFile.MatchString(fileName) && !declarationPattern.MatchString(fileName))
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// SourceFiles returns the sorted list of files astgen would process.
func (d *Discovery) SourceFiles(src string) []string {
	set := map[string]bool{}
	d.walk(src, true, sourceFilePattern, set, nil)
	if d.includeNMBundles() {
		d.walk(src, false, bundledNMPattern, set, nil)
	}
	var out []string
	for f := range set {
		if !d.IsExcludedTestFile(f) && !d.IsExcludedMinifiedFile(f) {
			out = append(out, f)
		}
	}
	sort.Strings(out)
	return out
}

// walk is getAllFiles. ancestors holds the real paths of the directories
// above dir, so that a symlink back into one of them ends the descent (astgen
// descends until the operating system reports ELOOP and lists the files many
// times over).
func (d *Discovery) walk(dir string, ignoreNM bool, re *regexp.Regexp, out map[string]bool, ancestors []string) {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		d.Diagnostics = append(d.Diagnostics, "cannot resolve directory "+dir+": "+err.Error())
		return
	}
	for _, a := range ancestors {
		if a == real {
			d.Diagnostics = append(d.Diagnostics, "symlink loop skipped: "+dir+" -> "+real)
			return
		}
	}
	ancestors = append(append([]string(nil), ancestors...), real)
	entries, err := os.ReadDir(dir)
	if err != nil {
		d.Diagnostics = append(d.Diagnostics, "cannot read directory "+dir+": "+err.Error())
		return
	}
	for _, e := range entries {
		name := e.Name()
		if (ignoreNM && strings.HasPrefix(name, ".")) || d.ignoreFile.MatchString(name) {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := os.Stat(path) // follows symlinks, as statSync does
		if err != nil {
			d.Diagnostics = append(d.Diagnostics, "cannot stat "+path+": "+err.Error())
			continue
		}
		if info.IsDir() {
			lower := strings.ToLower(name)
			if (ignoreNM && strings.HasPrefix(name, ".")) || containsString(d.ignoreDirs, lower) || (ignoreNM && lower == "node_modules") {
				continue
			}
			d.walk(path, ignoreNM, re, out, ancestors)
			continue
		}
		if re.MatchString(path) {
			out[path] = true
		}
	}
}
