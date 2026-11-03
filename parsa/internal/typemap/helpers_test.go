package typemap

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// runProject writes files (relative path to content) under a temp directory
// with a package.json, runs the type map with the given worker count and
// returns the parsed type maps by relative path (without the .typemap suffix).
func runProject(t *testing.T, files map[string]string, workers int, env Env, budget Budget) (map[string]map[int]string, *Report) {
	t.Helper()
	dir := t.TempDir()
	if _, ok := files["package.json"]; !ok {
		files["package.json"] = `{"name":"fixture"}`
	}
	for rel, body := range files {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return runDir(t, dir, workers, env, budget)
}

func runDir(t *testing.T, dir string, workers int, env Env, budget Budget) (map[string]map[int]string, *Report) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out")
	rep, err := Run(context.Background(), Options{Src: dir, Output: out, Workers: workers, Env: env, Budget: budget})
	if err != nil {
		t.Fatal(err)
	}
	return readMaps(t, out), rep
}

func readMaps(t *testing.T, out string) map[string]map[int]string {
	t.Helper()
	res := map[string]map[int]string{}
	_ = filepath.Walk(out, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || filepath.Ext(p) != ".typemap" {
			return nil
		}
		b, _ := os.ReadFile(p)
		var raw map[string]string
		if err := json.Unmarshal(b, &raw); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
		m := map[int]string{}
		for k, v := range raw {
			n, _ := strconv.Atoi(k)
			m[n] = v
		}
		rel, _ := filepath.Rel(out, p)
		res[filepath.ToSlash(rel[:len(rel)-len(".typemap")])] = m
		return nil
	})
	return res
}

// at returns the entry for the first occurrence of marker in src (a UTF-16 aware lookup is
// done by callers that need it; fixtures here use ASCII before the marker).
func typeAt(m map[int]string, src, marker string) string {
	for i := 0; i+len(marker) <= len(src); i++ {
		if src[i:i+len(marker)] == marker {
			return m[i]
		}
	}
	return "<marker not found>"
}
