package typemap

import (
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"
)

// Budget limits what typing one file, and the whole run, may cost. Zero means no limit for that field.
type Budget struct {
	// FileWall is the wall time one file may take, from the moment its checker is taken. The checker
	// only looks at it where it polls (checking expressions, flow analysis, printing), so it is a
	// backstop for FileWork, not a hard limit.
	FileWall time.Duration
	// FileWork bounds the checker work for one file (see Checker.SetWorkLimit). It is deterministic: a file
	// that exceeds it stops at the same node on every run and at every worker count.
	FileWork int64
	// MemoryCapMB is a ceiling for the heap of the whole run. Memory is shared by all checkers and
	// cannot be charged to one file, so past the cap every file being typed is stopped, the files not
	// yet started are left out, and each is reported. Which files were done by then depends on timing;
	// the cap is a backstop for runs too large for the machine, not part of normal output.
	MemoryCapMB int
	// KeepPrinterCaches turns the per-file release of the printer's caches off. Only tests set it, to
	// measure the release: the node builder caches every type node it serializes per enclosing
	// declaration, and releasing them after each file took outline from 1,641 to 892 MB.
	KeepPrinterCaches bool
	// BuilderCalls bounds the node builder work of one type write (astgen's MAX_TYPE_BUILDER_CALLS).
	BuilderCalls int
	// Poll is how often the watcher samples; default 50 ms.
	Poll time.Duration
}

// DefaultBudget is the budget of a normal run. FileWork is the one that decides in practice; the wall
// time and memory cap are backstops for what it does not count. A type needs at most a few hundred
// builder calls (astgen measured 305 across 37 projects).
func DefaultBudget() Budget {
	return Budget{FileWork: 150_000_000, FileWall: 60 * time.Second, MemoryCapMB: 6144, BuilderCalls: 16384, Poll: 50 * time.Millisecond}
}

// Reasons recorded in the manifest.
const (
	ReasonWork = "file-work-limit"
	ReasonWall = "file-wall-time"
	ReasonCap  = "memory-cap"
)

// Watch tracks the files being typed and interrupts one that goes over a budget.
type Watch struct {
	b      Budget
	mu     sync.Mutex
	active map[*Slot]struct{}
	capped atomic.Bool
	stop   chan struct{}
	done   chan struct{}
}

// Slot is the registration of one file being typed.
type Slot struct {
	Start  time.Time
	flag   atomic.Bool
	reason atomic.Value // string
}

// Interrupt returns the flag a checker polls.
func (s *Slot) Interrupt() *atomic.Bool { return &s.flag }

// Reason returns why the slot was interrupted, or "".
func (s *Slot) Reason() string {
	if r, ok := s.reason.Load().(string); ok {
		return r
	}
	return ""
}

func heapBytes() uint64 {
	sample := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(sample)
	if sample[0].Value.Kind() == metrics.KindUint64 {
		return sample[0].Value.Uint64()
	}
	return 0
}

// NewWatch starts the watcher. Close it when the run is over.
func NewWatch(b Budget) *Watch {
	if b.Poll <= 0 {
		b.Poll = 50 * time.Millisecond
	}
	w := &Watch{b: b, active: map[*Slot]struct{}{}, stop: make(chan struct{}), done: make(chan struct{})}
	go w.loop()
	return w
}

// Begin registers a file; End must be called when it is done.
func (w *Watch) Begin() *Slot {
	s := &Slot{Start: time.Now()}
	w.mu.Lock()
	w.active[s] = struct{}{}
	w.mu.Unlock()
	return s
}

// End unregisters the slot.
func (w *Watch) End(s *Slot) {
	w.mu.Lock()
	delete(w.active, s)
	w.mu.Unlock()
}

// Close stops the watcher.
func (w *Watch) Close() {
	close(w.stop)
	<-w.done
}

// Capped reports whether the run went over its memory cap. It also looks at the heap itself, so that
// a file is not started between two polls of the watcher once the cap is passed.
func (w *Watch) Capped() bool {
	if !w.capped.Load() && w.b.MemoryCapMB > 0 && heapBytes() > uint64(w.b.MemoryCapMB)<<20 {
		w.capped.Store(true)
	}
	return w.capped.Load()
}

// trip interrupts a slot. Only the watcher goroutine calls it, and the reason is stored before the
// flag, so a checker that sees the flag also sees why.
func (w *Watch) trip(s *Slot, reason string) {
	if s.flag.Load() {
		return
	}
	s.reason.Store(reason)
	s.flag.Store(true)
}

func (w *Watch) loop() {
	defer close(w.done)
	t := time.NewTicker(w.b.Poll)
	defer t.Stop()
	for {
		select {
		case <-w.stop:
			return
		case <-t.C:
		}
		now := time.Now()
		capped := w.Capped()
		w.mu.Lock()
		for s := range w.active {
			switch {
			case capped:
				w.trip(s, ReasonCap)
			case w.b.FileWall > 0 && now.Sub(s.Start) > w.b.FileWall:
				w.trip(s, ReasonWall)
			}
		}
		w.mu.Unlock()
	}
}
