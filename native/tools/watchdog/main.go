// Command watchdog runs a command under a wall time cap and a memory cap.
//
// It samples the resident set size of the whole process tree (the child and
// every descendant, found through the parent pid table) several times a
// second, kills the tree when a cap is exceeded, and prints one JSON line:
//
//	{"rc":0,"killed":false,"reason":"","elapsed_s":1.2,"peak_rss_mb":35}
//
// Usage: watchdog [-t secs] [-m mb] [-o result.json] [-q ms] -- cmd args...
//
// The child also gets GOMAXPROCS (at most 8) and GOMEMLIMIT (half of the RSS
// cap) unless the caller already set lower values. Exit status is the
// child's, or 124 when the watchdog killed it.
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Result is the one-line JSON record.
type Result struct {
	RC        int     `json:"rc"`
	Killed    bool    `json:"killed"`
	Reason    string  `json:"reason"`
	ElapsedS  float64 `json:"elapsed_s"`
	PeakRSSMB int64   `json:"peak_rss_mb"`
}

type proc struct{ pid, ppid, rssKB int64 }

// snapshot lists all processes. `ps -axo pid=,ppid=,rss=` behaves the same on
// macOS and Linux.
func snapshot() []proc {
	out, err := exec.Command("ps", "-axo", "pid=,ppid=,rss=").Output()
	if err != nil {
		return nil
	}
	var ps []proc
	for _, line := range bytes.Split(out, []byte("\n")) {
		f := strings.Fields(string(line))
		if len(f) != 3 {
			continue
		}
		a, e1 := strconv.ParseInt(f[0], 10, 64)
		b, e2 := strconv.ParseInt(f[1], 10, 64)
		c, e3 := strconv.ParseInt(f[2], 10, 64)
		if e1 != nil || e2 != nil || e3 != nil {
			continue
		}
		ps = append(ps, proc{a, b, c})
	}
	return ps
}

// tree returns the root and all its descendants, with their summed RSS in KB.
func tree(ps []proc, root int64) ([]int64, int64) {
	kids := map[int64][]proc{}
	byPid := map[int64]proc{}
	for _, p := range ps {
		kids[p.ppid] = append(kids[p.ppid], p)
		byPid[p.pid] = p
	}
	var pids []int64
	var sum int64
	seen := map[int64]bool{}
	stack := []int64{root}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[n] {
			continue
		}
		seen[n] = true
		if p, ok := byPid[n]; ok {
			pids = append(pids, n)
			sum += p.rssKB
		}
		for _, k := range kids[n] {
			stack = append(stack, k.pid)
		}
	}
	return pids, sum
}

func killAll(root int64, pids []int64) {
	// Freeze first so that a fork bomb or a respawning parent cannot outrun us.
	for _, p := range pids {
		_ = syscall.Kill(int(p), syscall.SIGSTOP)
	}
	_ = syscall.Kill(-int(root), syscall.SIGKILL)
	for _, p := range pids {
		_ = syscall.Kill(int(p), syscall.SIGKILL)
	}
}

func envWith(env []string, key, val string, keep func(old string) bool) []string {
	for i, e := range env {
		if strings.HasPrefix(e, key+"=") {
			if keep(e[len(key)+1:]) {
				return env
			}
			env[i] = key + "=" + val
			return env
		}
	}
	return append(env, key+"="+val)
}

func main() {
	secs := flag.Float64("t", 120, "wall time cap in seconds")
	mb := flag.Int64("m", 2048, "tree RSS cap in MB")
	out := flag.String("o", "", "also write the result line to this file")
	every := flag.Int("q", 250, "sampling interval in milliseconds")
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: watchdog [-t secs] [-m mb] [-o file] -- cmd args...")
		os.Exit(2)
	}
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	env := os.Environ()
	env = envWith(env, "GOMAXPROCS", "8", func(old string) bool {
		n, err := strconv.Atoi(old)
		return err == nil && n >= 1 && n <= 8
	})
	limit := *mb / 2 * 1024 * 1024
	env = envWith(env, "GOMEMLIMIT", strconv.FormatInt(limit, 10), func(old string) bool {
		n, err := strconv.ParseInt(strings.TrimSuffix(old, "B"), 10, 64)
		return err == nil && n > 0 && n <= limit
	})
	cmd.Env = env

	start := time.Now()
	res := Result{}
	if err := cmd.Start(); err != nil {
		res.RC, res.Reason = 127, "start: "+err.Error()
		emit(res, *out)
		os.Exit(127)
	}
	root := int64(cmd.Process.Pid)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	tick := time.NewTicker(time.Duration(*every) * time.Millisecond)
	defer tick.Stop()
	var waitErr error
loop:
	for {
		select {
		case waitErr = <-done:
			break loop
		case <-sig:
			pids, _ := tree(snapshot(), root)
			killAll(root, pids)
			res.Killed, res.Reason = true, "signal"
		case <-tick.C:
			pids, kb := tree(snapshot(), root)
			if m := kb / 1024; m > res.PeakRSSMB {
				res.PeakRSSMB = m
			}
			el := time.Since(start).Seconds()
			switch {
			case kb/1024 > *mb:
				res.Killed, res.Reason = true, "rss"
			case el > *secs:
				res.Killed, res.Reason = true, "time"
			}
			if res.Killed {
				killAll(root, pids)
			}
		}
		if res.Killed {
			waitErr = <-done
			break loop
		}
	}
	res.ElapsedS = float64(int(time.Since(start).Seconds()*100)) / 100
	rc := 0
	if ee, ok := waitErr.(*exec.ExitError); ok {
		rc = ee.ExitCode()
		if rc < 0 {
			rc = 128 + int(ee.Sys().(syscall.WaitStatus).Signal())
		}
	}
	res.RC = rc
	if res.Killed {
		emit(res, *out)
		os.Exit(124)
	}
	emit(res, *out)
	os.Exit(rc)
}

func emit(r Result, file string) {
	b, _ := json.Marshal(r)
	fmt.Fprintln(os.Stderr, string(b))
	if file != "" {
		_ = os.WriteFile(file, append(b, '\n'), 0o644)
	}
}
