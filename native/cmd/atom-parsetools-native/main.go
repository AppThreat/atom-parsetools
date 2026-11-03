// Command atom-parsetools-native is the native replacement for atom-parsetools'
// parsers. This tranche implements one subcommand:
//
//	atom-parsetools-native typemap -i SRC -o OUT [--workers N] [--report FILE]
//
// typemap writes OUT/<relative path>.typemap for every file astgen would type,
// using the flags and ASTGEN_* variables astgen reads. Later subcommands (astgen,
// phpastgen, rbastgen) are added to the switch in main.
package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/AppThreat/atom-parsetools/native/internal/typemap"
)

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "typemap":
		os.Exit(runTypemap(os.Args[2:]))
	case "--version", "version":
		fmt.Println(version + " (TypeScript " + typemap.TypeScriptPin() + ")")
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: atom-parsetools-native <subcommand> [options]

subcommands:
  typemap   write .typemap files, as astgen does with types on
            -i, --src DIR       source directory            [default: .]
            -o, --output DIR    output directory            [default: <src>/ast_out]
            -t, --type TYPE     project type; auto-detected when absent
            -r, --recurse       accepted for astgen compatibility
                --tsTypes       types on (default); --no-tsTypes does nothing
                --workers N     checkers; default ASTGEN_TYPE_WORKERS or the CPU count, at most 8
                --report FILE   write the run manifest (JSON) to FILE
                --file-ms N     wall time budget per file in milliseconds (default 60000)
                --file-work N   checker work budget per file (default 150000000; deterministic)
  version`)
}

type args struct {
	src, output, typ, report string
	workers                  int
	tsTypes                  bool
	fileMs                   int
	fileWork                 int
}

func parseArgs(in []string) (args, error) {
	a := args{src: ".", output: "ast_out", tsTypes: true}
	val := func(i *int, name string) (string, error) {
		if strings.Contains(in[*i], "=") {
			return in[*i][strings.Index(in[*i], "=")+1:], nil
		}
		if *i+1 >= len(in) {
			return "", fmt.Errorf("option %s needs a value", name)
		}
		*i++
		return in[*i], nil
	}
	for i := 0; i < len(in); i++ {
		name := in[i]
		if k := strings.Index(name, "="); k > 0 && strings.HasPrefix(name, "--") {
			name = name[:k]
		}
		var err error
		switch name {
		case "-i", "--src":
			a.src, err = val(&i, name)
		case "-o", "--output":
			a.output, err = val(&i, name)
		case "-t", "--type":
			a.typ, err = val(&i, name)
		case "--report":
			a.report, err = val(&i, name)
		case "--workers", "--file-ms", "--file-work":
			var s string
			if s, err = val(&i, name); err == nil {
				n, e := strconv.Atoi(s)
				if e != nil || n < 0 {
					return a, fmt.Errorf("option %s needs a non-negative integer", name)
				}
				switch name {
				case "--workers":
					a.workers = n
				case "--file-ms":
					a.fileMs = n
				default:
					a.fileWork = n
				}
			}
		case "-r", "--recurse", "--tsTypes":
		case "--no-tsTypes":
			a.tsTypes = false
		default:
			return a, fmt.Errorf("unknown option %s", in[i])
		}
		if err != nil {
			return a, err
		}
	}
	return a, nil
}

func runTypemap(in []string) int {
	a, err := parseArgs(in)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if a.output == "ast_out" {
		a.output = filepath.Join(a.src, a.output)
	}
	if st, err := os.Stat(a.src); err != nil || !st.IsDir() {
		fmt.Fprintln(os.Stderr, a.src, "is invalid")
		return 1
	}
	switch strings.ToLower(a.typ) {
	case "nodejs", "js", "javascript", "typescript", "ts", "flow":
	case "vue":
		return 0 // astgen -t vue writes ASTs only
	default:
		// createXAst: an unknown project type needs a package.json or rush.json.
		_, e1 := os.Stat(filepath.Join(a.src, "package.json"))
		_, e2 := os.Stat(filepath.Join(a.src, "rush.json"))
		if e1 != nil && e2 != nil {
			fmt.Fprintln(os.Stderr, a.src, "unknown project type")
			return 1
		}
	}
	if !a.tsTypes {
		return 0
	}
	budget := typemap.DefaultBudget()
	if a.fileMs > 0 {
		budget.FileWall = time.Duration(a.fileMs) * time.Millisecond
	}
	if a.fileWork > 0 {
		budget.FileWork = int64(a.fileWork)
	}
	if v := os.Getenv("TYPEMAP_RECYCLE_AFTER"); v != "" { // experiment, off by default
		budget.RecycleAfter, _ = strconv.Atoi(v)
	}
	budget.KeepPrinterCaches = os.Getenv("TYPEMAP_KEEP_PRINTER_CACHES") != "" // experiment, off by default
	opts := typemap.Options{Budget: budget,
		Src: a.src, Output: a.output, Workers: a.workers, Env: typemap.EnvFromProcess(), ReportPath: a.report,
		Log: func(f string, v ...any) { fmt.Fprintf(os.Stderr, f+"\n", v...) },
	}
	rep, err := typemap.Run(context.Background(), opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, "typemap failed:", err)
		return 1
	}
	for _, w := range rep.Warnings {
		fmt.Fprintln(os.Stderr, "warning:", w)
	}
	for _, d := range rep.Diagnostics {
		fmt.Fprintf(os.Stderr, "diagnostic: %s: %s %s\n", d.File, d.Reason, d.Detail)
	}
	fmt.Fprintf(os.Stderr, "typemap: %d files typed, %d keys, %d types given up, %d ms\n", rep.Typed, rep.Keys, rep.GaveUp, rep.Millis)
	return 0
}
