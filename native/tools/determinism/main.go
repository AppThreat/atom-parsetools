// Command determinism runs a command several times under the watchdog and
// compares the output trees it writes, byte for byte.
//
//	determinism [-watchdog BIN] [-t secs] [-m mb] [-repeat 2] [-workers 1,4,8] [-work DIR] -- cmd args...
//
// In cmd and args, {out} is replaced by the output directory of the run and
// {workers} by the worker count. With -workers, every count is run once and the
// first count is run a second time; without it the command is run -repeat times.
// The result is one line of JSON; the exit status is 0 when all trees are identical.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Tree maps a slash separated relative path to the SHA-256 of the file.
type Tree map[string]string

// HashTree hashes every regular file under root.
func HashTree(root string) (Tree, error) {
	t := Tree{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		t[filepath.ToSlash(rel)] = hex.EncodeToString(h.Sum(nil))
		return nil
	})
	return t, err
}

// Diff lists the paths that differ between two trees: "only-a:", "only-b:" or "changed:".
func Diff(a, b Tree) []string {
	var d []string
	for p, h := range a {
		if bh, ok := b[p]; !ok {
			d = append(d, "only-a:"+p)
		} else if bh != h {
			d = append(d, "changed:"+p)
		}
	}
	for p := range b {
		if _, ok := a[p]; !ok {
			d = append(d, "only-b:"+p)
		}
	}
	sort.Strings(d)
	return d
}

// Result is the JSON line.
type Result struct {
	Identical bool     `json:"identical"`
	Runs      []string `json:"runs"`
	Files     int      `json:"files"`
	Diffs     []string `json:"diffs,omitempty"`
	Error     string   `json:"error,omitempty"`
}

func main() {
	wd := flag.String("watchdog", "", "path of the watchdog binary (required)")
	secs := flag.Float64("t", 600, "wall time cap per run, seconds")
	mb := flag.Int64("m", 8192, "memory cap per run, MB")
	repeat := flag.Int("repeat", 2, "runs when -workers is not given")
	workers := flag.String("workers", "", "comma separated worker counts, e.g. 1,4,8")
	work := flag.String("work", "", "directory for the output trees (default: a temporary directory, removed afterwards)")
	flag.Parse()
	cmdArgs := flag.Args()
	if *wd == "" || len(cmdArgs) == 0 {
		fmt.Fprintln(os.Stderr, "usage: determinism -watchdog BIN [-t secs] [-m mb] [-repeat N] [-workers 1,4,8] [-work DIR] -- cmd args...")
		os.Exit(2)
	}
	res := Result{}
	fail := func(err error) {
		res.Error = err.Error()
		b, _ := json.Marshal(res)
		fmt.Println(string(b))
		os.Exit(1)
	}
	root := *work
	if root == "" {
		var err error
		if root, err = os.MkdirTemp("", "determinism-"); err != nil {
			fail(err)
		}
		defer os.RemoveAll(root)
	}
	var variants []string
	if *workers != "" {
		variants = strings.Split(*workers, ",")
		variants = append(variants, variants[0])
	} else {
		for i := 0; i < *repeat; i++ {
			variants = append(variants, "")
		}
	}
	var trees []Tree
	for i, w := range variants {
		out := filepath.Join(root, fmt.Sprintf("run%d", i))
		if err := os.RemoveAll(out); err != nil {
			fail(err)
		}
		if err := os.MkdirAll(out, 0o755); err != nil {
			fail(err)
		}
		args := []string{"-t", strconv.FormatFloat(*secs, 'f', -1, 64), "-m", strconv.FormatInt(*mb, 10), "--"}
		for _, a := range cmdArgs {
			a = strings.ReplaceAll(a, "{out}", out)
			a = strings.ReplaceAll(a, "{workers}", w)
			args = append(args, a)
		}
		c := exec.Command(*wd, args...)
		c.Stdout, c.Stderr = os.Stderr, os.Stderr
		if err := c.Run(); err != nil {
			fail(fmt.Errorf("run %d (workers=%q) failed: %w", i, w, err))
		}
		t, err := HashTree(out)
		if err != nil {
			fail(err)
		}
		trees = append(trees, t)
		name := "run" + strconv.Itoa(i)
		if w != "" {
			name += "/workers=" + w
		}
		res.Runs = append(res.Runs, name)
		res.Files = len(t)
		if i > 0 {
			for _, d := range Diff(trees[0], t) {
				res.Diffs = append(res.Diffs, name+" "+d)
			}
		}
	}
	res.Identical = len(res.Diffs) == 0 && res.Files > 0
	if res.Files == 0 {
		res.Error = "the command wrote no files"
	}
	b, _ := json.Marshal(res)
	fmt.Println(string(b))
	if !res.Identical {
		os.Exit(1)
	}
}
