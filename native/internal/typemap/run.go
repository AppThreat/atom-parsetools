package typemap

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/microsoft/TypeScript/tsc/shim/ast"
	"github.com/microsoft/TypeScript/tsc/shim/checker"
)

// Options configures one type map run.
type Options struct {
	Src        string
	Output     string
	Workers    int // 0 = default from the CPU count, capped at 8
	Env        Env
	ReportPath string
	Budget     Budget
	Log        func(format string, args ...any)
}

// FileReport records a file that hit a budget or failed.
type FileReport struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
	Detail string `json:"detail,omitempty"`
	Keys   int    `json:"keys"`
	Ms     int64  `json:"ms"`
}

// Report is the run manifest written with --report.
type Report struct {
	Tool        string       `json:"tool"`
	TypeScript  string       `json:"typescript"`
	Workers     int          `json:"workers"`
	Files       int          `json:"files"`
	Typed       int          `json:"typed"`
	Keys        int          `json:"keys"`
	GaveUp      int          `json:"gaveUpTypes"`
	Recovered   int          `json:"recoveredPanics"`
	ConfigPath  string       `json:"config,omitempty"`
	Warnings    []string     `json:"warnings,omitempty"`
	Diagnostics []FileReport `json:"diagnostics,omitempty"`
	Millis      int64        `json:"ms"`
}

// DefaultWorkers is the checker count when nothing asks for one: the CPU
// count, at most 8.
func DefaultWorkers() int {
	n := runtime.NumCPU()
	if n > 8 {
		n = 8
	}
	if n < 1 {
		n = 1
	}
	return n
}

var typedExtRe = regexp.MustCompile(`\.(?:js|jsx|cjs|mjs|ts|tsx|mts|cts)$`)

// ResolveWorkers applies ASTGEN_TYPE_WORKERS: unset or empty gives the default
// ("auto" is the same), a number is capped at the file count and at 8.
func ResolveWorkers(env string, files int) int {
	n := DefaultWorkers()
	if env != "" && !strings.EqualFold(env, "auto") {
		var v int
		if _, err := fmt.Sscanf(env, "%d", &v); err == nil && v >= 1 {
			n = v
		} else {
			n = 1
		}
	}
	if n > 8 {
		n = 8
	}
	if n > files {
		n = files
	}
	if n < 1 {
		n = 1
	}
	return n
}

// Run types every file astgen would type and writes <output>/<relative>.typemap.
func Run(ctx context.Context, o Options) (*Report, error) {
	t0 := time.Now()
	logf := o.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}
	src, err := filepath.Abs(o.Src)
	if err != nil {
		return nil, err
	}
	outDir, err := filepath.Abs(o.Output)
	if err != nil {
		return nil, err
	}
	disc := NewDiscovery(o.Env)
	discovered := disc.SourceFiles(src)
	projectFiles := discovered
	if !disc.includeNMBundles() {
		projectFiles = projectFiles[:0:0]
		for _, f := range discovered {
			if !strings.Contains(f, "node_modules") {
				projectFiles = append(projectFiles, f)
			}
		}
	}
	rep := &Report{Tool: "atom-parsetools-native typemap", TypeScript: TypeScriptPin(), Files: len(discovered)}
	rep.Warnings = append(rep.Warnings, disc.Diagnostics...)

	workers := o.Workers
	if workers <= 0 {
		workers = ResolveWorkers(os.Getenv("ASTGEN_TYPE_WORKERS"), len(discovered))
	}
	rep.Workers = workers
	setup, err := BuildSetup(src, projectFiles, disc, workers)
	if err != nil {
		return rep, err
	}
	rep.ConfigPath = setup.ConfigPath
	rep.Warnings = append(rep.Warnings, setup.Warnings...)

	// expandSrcFilesWithRootNames: the typed set also holds tsconfig files under the source root.
	have := map[string]bool{}
	for _, f := range discovered {
		have[filepath.ToSlash(f)] = true
	}
	files := append([]string(nil), discovered...)
	for _, r := range setup.RootNames {
		rf := filepath.FromSlash(r)
		if IsUnderRoot(rf, src) && typedExtRe.MatchString(rf) && !disc.IsExcludedTestFile(rf) &&
			!disc.IsExcludedMinifiedFile(rf) && !have[r] {
			have[r] = true
			files = append(files, filepath.Join(src, mustRel(src, rf)))
		}
	}
	sort.Strings(files)

	var targets []*ast.SourceFile
	var rels []string
	for _, f := range files {
		if sf := setup.Program.GetSourceFile(rootedFile(filepath.ToSlash(f))); sf != nil {
			targets = append(targets, sf)
			rels = append(rels, mustRel(src, f))
		}
	}
	logf("program ready: %d root files, %d to type, %d checkers, %d ms", len(setup.RootNames), len(targets), workers, time.Since(t0).Milliseconds())

	type result struct {
		keys, gaveUp, recovered int
		diag                    *FileReport
	}
	results := make([]result, len(targets))

	// Deterministic schedule. The pool ties every file to one checker, so the files are grouped by
	// that checker first (taking and releasing the checker at once), and each checker then types
	// its files one after the other in sorted order. A checker's answers can depend on what it
	// resolved before (a circular reference is cut at a different place), so the order of the files
	// on a checker must not depend on timing. Handing files to whichever goroutine is free, as a
	// work queue does, changes that order from run to run.
	groups := map[*checker.Checker][]int{}
	var order []*checker.Checker
	for i, sf := range targets {
		c, done := setup.Program.GetTypeCheckerForFileExclusive(ctx, sf)
		done()
		if _, ok := groups[c]; !ok {
			order = append(order, c)
		}
		groups[c] = append(groups[c], i)
	}
	var wg sync.WaitGroup
	for _, c := range order {
		list := groups[c]
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, i := range list {
				k, st, d := typeFile(ctx, setup, targets[i], filepath.FromSlash(rels[i]), outDir, o.Budget, rels[i])
				results[i] = result{k, st.gaveUp, st.recovered, d}
			}
		}()
	}
	wg.Wait()

	rep.Typed = len(targets)
	for _, r := range results {
		rep.Keys += r.keys
		rep.GaveUp += r.gaveUp
		rep.Recovered += r.recovered
		if r.diag != nil {
			rep.Diagnostics = append(rep.Diagnostics, *r.diag)
		}
	}
	rep.Millis = time.Since(t0).Milliseconds()
	if o.ReportPath != "" {
		b, _ := json.MarshalIndent(rep, "", "  ")
		if err := os.WriteFile(o.ReportPath, append(b, '\n'), 0o644); err != nil {
			return rep, err
		}
	}
	return rep, nil
}

func mustRel(base, target string) string {
	r, err := filepath.Rel(base, target)
	if err != nil {
		return target
	}
	return r
}

// typeFile types one file with its own exclusive checker and writes its map.
func typeFile(ctx context.Context, s *Setup, sf *ast.SourceFile, rel, outDir string, b Budget, relSlash string) (keys int, st fileStats, diag *FileReport) {
	start := time.Now()
	defer func() {
		if r := recover(); r != nil {
			diag = &FileReport{File: relSlash, Reason: "panic", Detail: fmt.Sprint(r), Ms: time.Since(start).Milliseconds()}
		}
	}()
	c, done := s.Program.GetTypeCheckerForFileExclusive(ctx, sf)
	defer done()
	bom := hasUTF8BOM(string(sf.FileName()))
	u := newUnit(c, sf, NewOffsets(sf.Text(), bom))
	u.over = b.newGate(start)
	sf.AsNode().ForEachChild(func(ch *ast.Node) bool { u.addType(ch); return false })
	st = u.stats
	if len(u.seen) > 0 {
		out := filepath.Join(outDir, rel+".typemap")
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return 0, st, &FileReport{File: relSlash, Reason: "write", Detail: err.Error()}
		}
		if err := os.WriteFile(out, EncodeTypeMap(u.seen), 0o644); err != nil {
			return 0, st, &FileReport{File: relSlash, Reason: "write", Detail: err.Error()}
		}
	}
	if u.overWhy != "" {
		diag = &FileReport{File: relSlash, Reason: u.overWhy, Keys: len(u.seen), Ms: time.Since(start).Milliseconds()}
	}
	return len(u.seen), st, diag
}

// hasUTF8BOM reports whether the file on disk starts with a UTF-8 byte order mark.
func hasUTF8BOM(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var b [3]byte
	n, _ := f.Read(b[:])
	return n == 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF
}
