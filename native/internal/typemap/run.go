package typemap

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/pprof"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
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
	Budget     Budget // zero value: DefaultBudget()
	// HeapProbe, when set, is called with the live heap (bytes) after each file; tests use it.
	HeapProbe func(liveBytes uint64)
	Log       func(format string, args ...any)
}

// FileReport records a file that hit a budget or failed.
type FileReport struct {
	File   string `json:"file"`
	Reason string `json:"reason"`
	Detail string `json:"detail,omitempty"`
	Keys   int    `json:"keys"`
	Ms     int64  `json:"ms"`
}

// FileWork is a file and the checker work it took.
type FileWork struct {
	File string `json:"file"`
	Work int64  `json:"work"`
	Ms   int64  `json:"ms"`
}

// Report is the run manifest written with --report.
type Report struct {
	Tool          string       `json:"tool"`
	TypeScript    string       `json:"typescript"`
	Workers       int          `json:"workers"`
	Files         int          `json:"files"`
	Typed         int          `json:"typed"`
	Keys          int          `json:"keys"`
	GaveUp        int          `json:"gaveUpTypes"`
	Recovered     int          `json:"recoveredPanics"`
	ConfigPath    string       `json:"config,omitempty"`
	Warnings      []string     `json:"warnings,omitempty"`
	Diagnostics   []FileReport `json:"diagnostics,omitempty"`
	Rebuilds      int          `json:"programRebuilds,omitempty"`
	HeapMB        uint64       `json:"heapMBAfter"`
	PeakHeapMB    uint64       `json:"peakHeapMB"`
	MaxWork       int64        `json:"maxFileWork"`
	HeaviestFiles []FileWork   `json:"heaviestFiles,omitempty"`
	Millis        int64        `json:"ms"`
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
	if o.Budget == (Budget{}) {
		o.Budget = DefaultBudget()
	}
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
		work, ms                int64
		diag                    *FileReport
	}
	results := make([]result, len(targets))
	watch := NewWatch(o.Budget)
	defer watch.Close()

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
	var rebuilds atomic.Int64
	for _, c := range order {
		list := groups[c]
		wg.Add(1)
		go func() {
			defer wg.Done()
			cur := setup
			for n, i := range list {
				sf := targets[i]
				if cur != setup {
					sf = cur.Program.GetSourceFile(rootedFile(filepath.ToSlash(string(targets[i].FileName()))))
					if sf == nil {
						results[i] = result{diag: &FileReport{File: rels[i], Reason: "missing", Detail: "the file is not in the rebuilt program"}}
						continue
					}
				}
				k, st, d, tainted := typeFile(ctx, cur, watch, o.Budget, probeOnce(o.HeapProbe, &probeMu), sf, filepath.FromSlash(rels[i]), outDir, rels[i])
				results[i] = result{k, st.gaveUp, st.recovered, st.work, st.ms, d}
				recycle := o.Budget.RecycleAfter > 0 && (n+1)%o.Budget.RecycleAfter == 0
				if (tainted || recycle) && n+1 < len(list) {
					// Either the checker was stopped inside a query and may hold half built state, or
					// RecycleAfter files have gone through it and its type cache is dropped to bound memory.
					// The rest of its files go to a fresh single checker program.
					next, err := BuildSetup(src, projectFiles, disc, 1)
					if err != nil {
						for _, j := range list[n+1:] {
							results[j] = result{diag: &FileReport{File: rels[j], Reason: "rebuild-failed", Detail: err.Error()}}
						}
						return
					}
					rebuilds.Add(1)
					cur = next
				}
			}
		}()
	}
	wg.Wait()
	rep.Rebuilds = int(rebuilds.Load())

	rep.Typed = len(targets)
	if path := os.Getenv("TYPEMAP_HEAP_PROFILE"); path != "" { // diagnostic: heap profile while the program is still alive
		runtime.GC()
		if f, e := os.Create(path); e == nil {
			_ = pprof.Lookup("heap").WriteTo(f, 0)
			f.Close()
		}
		runtime.KeepAlive(setup)
	}
	var heavy []FileWork
	for i, r := range results {
		heavy = append(heavy, FileWork{rels[i], r.work, r.ms})
		rep.Keys += r.keys
		rep.GaveUp += r.gaveUp
		rep.Recovered += r.recovered
		if r.work > rep.MaxWork {
			rep.MaxWork = r.work
		}
		if r.diag != nil {
			rep.Diagnostics = append(rep.Diagnostics, *r.diag)
		}
	}
	sort.Slice(heavy, func(i, j int) bool { return heavy[i].Work > heavy[j].Work })
	if len(heavy) > 5 {
		heavy = heavy[:5]
	}
	rep.HeaviestFiles = heavy
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	rep.PeakHeapMB = ms.HeapSys >> 20
	runtime.GC()
	runtime.ReadMemStats(&ms)
	rep.HeapMB = ms.HeapAlloc >> 20
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

var probeMu sync.Mutex

// probeOnce serializes calls to a test probe that several workers share.
func probeOnce(f func(uint64), mu *sync.Mutex) func(uint64) {
	if f == nil {
		return nil
	}
	return func(v uint64) {
		mu.Lock()
		defer mu.Unlock()
		f(v)
	}
}

// typeFile types one file with its own exclusive checker and writes its map. An interrupt (a time
// or memory budget) ends the file: what was collected before it is kept, the diagnostic says why,
// and the checker, which may have been left half way through a query, is reported as tainted.
func typeFile(ctx context.Context, s *Setup, w *Watch, b Budget, probe func(uint64), sf *ast.SourceFile, rel, outDir, relSlash string) (keys int, st fileStats, diag *FileReport, tainted bool) {
	start := time.Now()
	defer func() {
		if r := recover(); r != nil {
			diag = &FileReport{File: relSlash, Reason: "panic", Detail: fmt.Sprint(r), Ms: time.Since(start).Milliseconds()}
		}
	}()
	c, done := s.Program.GetTypeCheckerForFileExclusive(ctx, sf)
	defer done()
	slot := w.Begin()
	defer w.End(slot)
	c.SetInterrupt(slot.Interrupt())
	c.SetWorkLimit(b.FileWork)
	defer c.SetWorkLimit(0)
	defer c.SetInterrupt(nil)
	if !b.KeepPrinterCaches {
		defer c.ReleasePrinterCaches() // see budget.go: this halves the heap on outline and angular-realworld
	}
	bom := hasUTF8BOM(string(sf.FileName()))
	u := newUnit(c, sf, NewOffsets(sf.Text(), bom))
	u.builderCalls = b.BuilderCalls
	u.slot = slot
	sf.AsNode().ForEachChild(func(ch *ast.Node) bool { u.addType(ch); return false })
	st = u.stats
	st.work = c.Work()
	if probe != nil {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		probe(m.HeapAlloc)
	}
	st.ms = time.Since(start).Milliseconds()
	if len(u.seen) > 0 {
		out := filepath.Join(outDir, rel+".typemap")
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return 0, st, &FileReport{File: relSlash, Reason: "write", Detail: err.Error()}, u.tainted
		}
		if err := os.WriteFile(out, EncodeTypeMap(u.seen), 0o644); err != nil {
			return 0, st, &FileReport{File: relSlash, Reason: "write", Detail: err.Error()}, u.tainted
		}
	}
	if u.overWhy != "" {
		diag = &FileReport{File: relSlash, Reason: u.overWhy, Detail: "no further entries were written for this file", Keys: len(u.seen), Ms: time.Since(start).Milliseconds()}
	}
	return len(u.seen), st, diag, u.tainted
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
