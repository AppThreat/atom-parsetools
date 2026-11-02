package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"testing"
	"time"
)

// The test binary doubles as the helper process.
func TestMain(m *testing.M) {
	switch os.Getenv("WD_HELPER") {
	case "alloc": // allocate and touch N MB, then sleep
		n, _ := strconv.Atoi(os.Getenv("WD_MB"))
		b := make([]byte, n<<20)
		for i := 0; i < len(b); i += 4096 {
			b[i] = 1
		}
		time.Sleep(60 * time.Second)
		os.Exit(0)
	case "spawn": // run the allocating helper as a child of a child
		c := exec.Command(os.Args[0])
		c.Env = append(os.Environ(), "WD_HELPER=alloc")
		_ = c.Start()
		_ = c.Wait()
		os.Exit(0)
	case "spawn2": // grandchild of the watchdog's child
		c := exec.Command(os.Args[0])
		c.Env = append(os.Environ(), "WD_HELPER=spawn")
		_ = c.Start()
		_ = c.Wait()
		os.Exit(0)
	case "sleep":
		time.Sleep(60 * time.Second)
		os.Exit(0)
	case "exit":
		n, _ := strconv.Atoi(os.Getenv("WD_RC"))
		os.Exit(n)
	}
	os.Exit(m.Run())
}

func runWD(t *testing.T, secs, mb string, env ...string) (Result, int, time.Duration) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the watchdog uses process groups and ps; not supported on Windows")
	}
	if _, err := exec.LookPath("ps"); err != nil {
		t.Skip("ps not found")
	}
	exe, _ := os.Executable()
	// The watchdog is this same binary running main(): build the real one.
	bin := filepath.Join(t.TempDir(), "wd")
	if out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	res := filepath.Join(t.TempDir(), "r.json")
	cmd := exec.Command(bin, "-t", secs, "-m", mb, "-q", "100", "-o", res, "--", exe)
	cmd.Env = append(os.Environ(), env...)
	start := time.Now()
	err := cmd.Run()
	took := time.Since(start)
	rc := 0
	if ee, ok := err.(*exec.ExitError); ok {
		rc = ee.ExitCode()
	}
	b, rerr := os.ReadFile(res)
	if rerr != nil {
		t.Fatalf("no result file: %v", rerr)
	}
	var r Result
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatalf("bad json %q: %v", b, err)
	}
	return r, rc, took
}

func TestGrandchildAllocationKilled(t *testing.T) {
	r, rc, took := runWD(t, "30", "300", "WD_HELPER=spawn2", "WD_MB=800")
	if !r.Killed || r.Reason != "rss" || rc != 124 {
		t.Fatalf("want killed by rss, rc 124; got %+v rc=%d", r, rc)
	}
	if r.PeakRSSMB < 300 {
		t.Fatalf("peak too low: %+v", r)
	}
	if took > 20*time.Second {
		t.Fatalf("took %v", took)
	}
}

func TestDirectChildAllocationKilled(t *testing.T) {
	r, _, _ := runWD(t, "30", "300", "WD_HELPER=alloc", "WD_MB=800")
	if !r.Killed || r.Reason != "rss" {
		t.Fatalf("got %+v", r)
	}
}

func TestSleeperKilledOnTime(t *testing.T) {
	r, rc, took := runWD(t, "2", "1000", "WD_HELPER=sleep")
	if !r.Killed || r.Reason != "time" || rc != 124 {
		t.Fatalf("got %+v rc=%d", r, rc)
	}
	if took < 2*time.Second || took > 8*time.Second {
		t.Fatalf("killed at %v, want about 2s", took)
	}
}

func TestNormalExitCode(t *testing.T) {
	r, rc, _ := runWD(t, "30", "1000", "WD_HELPER=exit", "WD_RC=7")
	if r.Killed || r.RC != 7 || rc != 7 {
		t.Fatalf("got %+v rc=%d", r, rc)
	}
}

func TestZeroExit(t *testing.T) {
	r, rc, _ := runWD(t, "30", "1000", "WD_HELPER=exit", "WD_RC=0")
	if r.Killed || r.RC != 0 || rc != 0 || r.Reason != "" {
		t.Fatalf("got %+v rc=%d", r, rc)
	}
}
