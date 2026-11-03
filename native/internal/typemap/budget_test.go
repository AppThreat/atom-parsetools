package typemap

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// evolvingArrayFile is testdata/repro/gen.py's output written in Go, so the tests do not need Python:
// n sequential blocks that reassign an untyped `let components = []` with concat, which makes checking
// exponential in the number of blocks.
func evolvingArrayFile(n int, typed bool) string {
	var b strings.Builder
	b.WriteString("// Generated: n sequential blocks that reassign an evolving array with concat.\n")
	b.WriteString("/** @param {string} kind */\nasync function make(kind) { return { bomJson: { components: [{ name: kind }] } }; }\n")
	b.WriteString("/** @param {{ types: string[] }} options */\nexport async function scan(options) {\n  let bomData;\n")
	if typed {
		b.WriteString("  /** @type {any[]} */ let components = [];\n")
	} else {
		b.WriteString("  let components = [];\n")
	}
	for i := 0; i < n; i++ {
		fmt.Fprintf(&b, "  if (options.types.includes('t%d')) {\n    bomData = await make('t%d');\n    if (bomData?.bomJson?.components?.length) {\n      components = components.concat(bomData.bomJson.components);\n    }\n  }\n", i, i)
	}
	b.WriteString("  return components;\n}\n")
	return b.String()
}

func TestGeneratorMatchesTheCheckedInPythonOne(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed, cannot compare with testdata/repro/gen.py")
	}
	for _, variant := range []string{"plain", "typed"} {
		out, err := exec.Command(py, filepath.Join("..", "..", "testdata", "repro", "gen.py"), "5", variant).Output()
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(string(out)) != strings.TrimSpace(evolvingArrayFile(5, variant == "typed")) {
			t.Fatalf("the Go generator differs from gen.py for the %s variant", variant)
		}
	}
}

// A small block count completes inside the budget and types everything.
func TestSmallEvolvingArrayIsTypedInFull(t *testing.T) {
	maps, rep := runProject(t, map[string]string{"scan.js": evolvingArrayFile(8, false)}, 1, Env{}, Budget{})
	if len(rep.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %+v", rep.Diagnostics)
	}
	if len(maps["scan.js"]) < 100 {
		t.Fatalf("expected a full map, got %d keys", len(maps["scan.js"]))
	}
}

// The work budget stops the exponential file at a point that does not depend on timing, keeps the
// entries before it, records a diagnostic, and the same file gives the same bytes at every worker count.
func TestWorkBudgetStopsARunawayFileDeterministically(t *testing.T) {
	src := evolvingArrayFile(20, false)
	budget := Budget{FileWork: 3_000_000}
	var first map[int]string
	for _, workers := range []int{1, 4, 8} {
		start := time.Now()
		maps, rep := runProject(t, map[string]string{"scan.js": src, "other.js": "export const ok = 1;\n"}, workers, Env{}, budget)
		if time.Since(start) > 30*time.Second {
			t.Fatalf("workers=%d took %v, the budget did not stop the file", workers, time.Since(start))
		}
		if len(rep.Diagnostics) != 1 || rep.Diagnostics[0].Reason != ReasonWork || rep.Diagnostics[0].File != "scan.js" {
			t.Fatalf("workers=%d: want one %s diagnostic for scan.js, got %+v", workers, ReasonWork, rep.Diagnostics)
		}
		if got := maps["other.js"]; len(got) == 0 {
			t.Fatalf("workers=%d: another file must still be typed", workers)
		}
		m := maps["scan.js"]
		if len(m) == 0 || len(m) >= 100 {
			t.Fatalf("workers=%d: the entries before the cut should be kept and the rest dropped, got %d keys", workers, len(m))
		}
		if first == nil {
			first = m
		} else if fmt.Sprint(first) != fmt.Sprint(m) {
			t.Fatalf("workers=%d: the cut moved: %d keys against %d", workers, len(m), len(first))
		}
	}
}

// A file that tripped the budget taints its checker; files typed after it on the same checker must come out
// as if the interrupted file had never been there. Which files share a checker is up to the pool, so this test
// puts every file on one (FixedCheckers = 1) and compares each file with itself typed in a project without the
// runaway file.
func TestFilesAfterAnInterruptedFileAreUnaffected(t *testing.T) {
	saved := FixedCheckers
	FixedCheckers = 1
	defer func() { FixedCheckers = saved }()
	good := func(i int) string {
		return fmt.Sprintf("export const a%d = [1, 2, 3].map((n) => n + %d);\nexport function f%d(x) { return { x, k: %d }; }\n", i, i, i, i)
	}
	files := map[string]string{"a-first.js": good(0), "b-runaway.js": evolvingArrayFile(20, false)}
	clean := map[string]string{"a-first.js": good(0)}
	for i := 1; i <= 6; i++ {
		name := fmt.Sprintf("c%02d.js", i)
		files[name] = good(i)
		clean[name] = good(i)
	}
	cleanMaps, _ := runProject(t, clean, 1, Env{}, Budget{})
	maps, rep := runProject(t, files, 1, Env{}, Budget{FileWork: 3_000_000})
	if len(rep.Diagnostics) != 1 || rep.Diagnostics[0].File != "b-runaway.js" {
		t.Fatalf("exactly the runaway file must be reported: %+v", rep.Diagnostics)
	}
	if rep.Rebuilds != 1 {
		t.Fatalf("a checker that was interrupted must be replaced when files remain on it: %+v", rep)
	}
	for name := range clean {
		if fmt.Sprint(maps[name]) != fmt.Sprint(cleanMaps[name]) {
			t.Fatalf("%s differs from the same file typed without the interrupted one\nwith:    %v\nwithout: %v", name, maps[name], cleanMaps[name])
		}
	}
}

// Using an expensive function costs the files that use it too: the budget is per file, the work is per symbol.
// A file that imports the runaway module pays for it and is reported on its own.
func TestFilesThatUseARunawayFunctionAreBudgetedToo(t *testing.T) {
	files := map[string]string{
		"b-runaway.js": evolvingArrayFile(20, false),
		"user.js":      "import { scan } from './b-runaway.js';\nexport const s = scan({ types: [] });\n",
	}
	_, rep := runProject(t, files, 1, Env{}, Budget{FileWork: 3_000_000})
	reported := map[string]bool{}
	for _, d := range rep.Diagnostics {
		reported[d.File] = true
	}
	if !reported["b-runaway.js"] || !reported["user.js"] {
		t.Fatalf("both the function's file and the file that calls it hit the budget: %+v", rep.Diagnostics)
	}
}

// With the JSDoc annotation the reproducer is cheap: the budget is for inputs without it.
func TestAnnotatedEvolvingArrayIsCheap(t *testing.T) {
	_, rep := runProject(t, map[string]string{"scan.js": evolvingArrayFile(25, true)}, 1, Env{}, Budget{FileWork: 3_000_000})
	if len(rep.Diagnostics) != 0 {
		t.Fatalf("the annotated file must not hit the budget: %+v", rep.Diagnostics)
	}
}

// A type longer than 4096 characters is retried by name and then given up, and the count is reported.
// The type is an object with many properties: literal types would be widened by the default rule and
// never print in full.
func TestOversizedTypeIsGivenUpAndCounted(t *testing.T) {
	var props []string
	for i := 0; i < 300; i++ {
		props = append(props, fmt.Sprintf("  property_with_a_long_name_%04d_padding_padding: { nested_%04d: string; other: number[] };", i, i))
	}
	src := "export interface Wide {\n" + strings.Join(props, "\n") + "\n}\n" +
		"declare const w: { [K in keyof Wide]: Wide[K] };\nexport const copy = w;\nexport const small = 1;\n"
	maps, rep := runProject(t, map[string]string{"wide.ts": src}, 1, Env{}, Budget{})
	if rep.GaveUp == 0 {
		t.Fatalf("a type over the limit must be counted as given up: %+v", rep)
	}
	for k, v := range maps["wide.ts"] {
		if JSLen(v) >= MaxTypeStringLength {
			t.Fatalf("a type string of %d characters was written at %d", JSLen(v), k)
		}
	}
	if typeAt(maps["wide.ts"], src, "small") != "number" {
		t.Fatalf("the rest of the file must be typed: %v", maps["wide.ts"])
	}
}

// The node builder budget ends one type's printing without touching the rest of the file.
func TestBuilderBudgetGivesUpOneTypeOnly(t *testing.T) {
	var props []string
	for i := 0; i < 40; i++ {
		props = append(props, fmt.Sprintf("p%d: { a: 'x', b: { c: 1, d: [true] } }", i))
	}
	// An object literal value: its type is inferred, so the printer builds every nested type node
	// (a written annotation would be reused as it stands).
	src := "const wide = {" + strings.Join(props, ", ") + "};\nexport const viaWide = wide;\nexport const num = 1;\n"
	files := map[string]string{"wide.ts": src}
	_, base := runProject(t, files, 1, Env{}, Budget{FileWork: 1_000_000_000})
	maps, rep := runProject(t, files, 1, Env{}, Budget{BuilderCalls: 10, FileWork: 1_000_000_000})
	if base.GaveUp != 0 {
		t.Fatalf("without a builder budget the type prints: %+v", base)
	}
	if rep.GaveUp == 0 {
		t.Fatalf("a builder budget of 10 must make the printer give up on the wide type: %+v", rep)
	}
	if len(rep.Diagnostics) != 0 {
		t.Fatalf("a builder budget is per type, not per file: %+v", rep.Diagnostics)
	}
	if typeAt(maps["wide.ts"], src, "num") != "number" {
		t.Fatalf("the rest of the file must be typed after a type was given up: %v", maps["wide.ts"])
	}
}

// Releasing the printer's caches after each file keeps the heap lower than keeping them. The inputs are
// 16 files that each print large inferred types; the heap is read with the checker still alive.
func TestPrinterCachesAreReleasedPerFile(t *testing.T) {
	files := map[string]string{}
	var shared strings.Builder
	for i := 0; i < 3; i++ {
		var props []string
		for j := 0; j < 20; j++ {
			props = append(props, fmt.Sprintf("f%d: { a: 'x', b: [{ c: %d, d: true }], e: () => ({ z: %d }) }", j, j, j))
		}
		fmt.Fprintf(&shared, "export const shared%d = { %s };\n", i, strings.Join(props, ", "))
	}
	files["shared.ts"] = shared.String()
	for n := 0; n < 16; n++ {
		var b strings.Builder
		b.WriteString("import { shared0, shared1, shared2 } from './shared';\n")
		for k := 0; k < 6; k++ {
			fmt.Fprintf(&b, "export const v%d = shared%d;\nexport function fn%d(x: typeof shared%d) { const y = x; return { y, again: x }; }\n", k, k%3, k, k%3)
		}
		files[fmt.Sprintf("f%03d.ts", n)] = b.String()
	}
	heap := func(keep bool) uint64 {
		dir := t.TempDir()
		files["package.json"] = `{"name":"mem"}`
		for rel, body := range files {
			if err := os.WriteFile(filepath.Join(dir, rel), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		b := DefaultBudget()
		b.KeepPrinterCaches = keep
		var peak uint64
		_, err := Run(context.Background(), Options{Src: dir, Output: filepath.Join(t.TempDir(), "o"), Workers: 1, Budget: b, HeapProbe: func(live uint64) {
			if live > peak {
				peak = live
			}
		}})
		if err != nil {
			t.Fatal(err)
		}
		return peak
	}
	kept, released := heap(true), heap(false)
	t.Logf("peak live heap while typing: keep=%d MB, release=%d MB", kept>>20, released>>20)
	if released >= kept*9/10 {
		t.Fatalf("releasing the printer caches must lower the heap by at least 10%%: keep=%d MB release=%d MB", kept>>20, released>>20)
	}
}

// The output must not depend on the number of workers. A checker's answers can depend on what it resolved
// before, so the files are tied to a fixed number of checkers. The vendored arborist code (see
// testdata/typemap/arborist/README.md) is an input on which the output differed between one and eight
// workers when the number of checkers followed the number of workers.
func TestOutputDoesNotDependOnTheNumberOfWorkers(t *testing.T) {
	proj := filepath.Join("..", "..", "testdata", "typemap", "arborist")
	var first map[string]map[int]string
	for _, workers := range []int{1, 2, 4, 8} {
		maps, rep := runDir(t, proj, workers, Env{}, Budget{})
		if len(rep.Diagnostics) != 0 {
			t.Fatalf("workers=%d: %+v", workers, rep.Diagnostics)
		}
		if first == nil {
			first = maps
			if len(first) < 20 {
				t.Fatalf("expected at least 20 type maps, got %d", len(first))
			}
			continue
		}
		for f, m := range first {
			if fmt.Sprint(m) != fmt.Sprint(maps[f]) {
				t.Fatalf("workers=%d: the type map of %s differs from the one with 1 worker", workers, f)
			}
		}
	}
}

// The program is built with FixedCheckers, whatever the number of workers (read from the program, not
// from what was asked for).
func TestProgramUsesAFixedNumberOfCheckers(t *testing.T) {
	for _, workers := range []int{1, 3, 8} {
		_, rep := runProject(t, map[string]string{"a.js": "export const a = 1;\n"}, workers, Env{}, Budget{})
		if rep.Checkers != FixedCheckers {
			t.Fatalf("workers=%d: the program has %d checkers, want %d", workers, rep.Checkers, FixedCheckers)
		}
	}
}
