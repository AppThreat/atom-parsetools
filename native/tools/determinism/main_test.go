package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestDiff(t *testing.T) {
	a := Tree{"x": "1", "y": "2", "z": "3"}
	b := Tree{"x": "1", "y": "9", "w": "4"}
	got := strings.Join(Diff(a, b), ",") // sorted: "changed:" < "only-a:" < "only-b:"
	if got != "changed:y,only-a:z,only-b:w" {
		t.Fatalf("got %s", got)
	}
}

func TestHashTreeDetectsOneByte(t *testing.T) {
	d := t.TempDir()
	_ = os.MkdirAll(filepath.Join(d, "s"), 0o755)
	_ = os.WriteFile(filepath.Join(d, "s", "a"), []byte("hello"), 0o644)
	t1, _ := HashTree(d)
	_ = os.WriteFile(filepath.Join(d, "s", "a"), []byte("hellO"), 0o644)
	t2, _ := HashTree(d)
	if len(Diff(t1, t2)) != 1 {
		t.Fatalf("a one byte change must show up: %v", Diff(t1, t2))
	}
}

// build compiles the watchdog and the determinism tool, then runs the tool on a shell command.
func runTool(t *testing.T, script string, extra ...string) (string, error) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the test commands use /bin/sh")
	}
	dir := t.TempDir()
	wd := filepath.Join(dir, "wd")
	if out, err := exec.Command("go", "build", "-o", wd, "../watchdog").CombinedOutput(); err != nil {
		t.Skipf("cannot build the watchdog: %v\n%s", err, out)
	}
	tool := filepath.Join(dir, "det")
	if out, err := exec.Command("go", "build", "-o", tool, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	args := append([]string{"-watchdog", wd, "-t", "20", "-m", "1000"}, extra...)
	args = append(args, "--", "/bin/sh", "-c", script, "sh", "{out}", "{workers}")
	out, err := exec.Command(tool, args...).Output()
	return string(out), err
}

func TestStableCommandIsIdentical(t *testing.T) {
	out, err := runTool(t, `mkdir -p "$1/d" && echo fixed > "$1/d/f"`, "-repeat", "2")
	if err != nil || !strings.Contains(out, `"identical":true`) {
		t.Fatalf("err=%v out=%s", err, out)
	}
}

func TestCommandThatDependsOnWorkersIsCaught(t *testing.T) {
	out, err := runTool(t, `echo "$2" > "$1/f"`, "-workers", "1,4,8")
	if err == nil || !strings.Contains(out, `"identical":false`) || !strings.Contains(out, "changed:f") {
		t.Fatalf("a worker dependent output must fail: err=%v out=%s", err, out)
	}
}

func TestNondeterministicRunIsCaught(t *testing.T) {
	out, err := runTool(t, `echo $$ > "$1/f"`, "-repeat", "2")
	if err == nil || !strings.Contains(out, `"identical":false`) {
		t.Fatalf("a changing output must fail: err=%v out=%s", err, out)
	}
}

func TestEmptyOutputIsNotIdentical(t *testing.T) {
	out, err := runTool(t, `true`, "-repeat", "2")
	if err == nil || !strings.Contains(out, "wrote no files") {
		t.Fatalf("no output must fail: err=%v out=%s", err, out)
	}
}
