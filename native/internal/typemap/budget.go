package typemap

import (
	"runtime/metrics"
	"sync"
	"sync/atomic"
	"time"
)

// Budget limits what typing one file may cost. Zero means no limit for that field.
type Budget struct {
	// FileWall is the wall time one file may take, from the moment its checker is taken.
	FileWall time.Duration
	// HeapGrowthMB is how far the process heap may grow while one file is typed. The heap is shared by
	// all checkers, so with several workers the file that has grown it most since it started is
	// the one that is interrupted.
	HeapGrowthMB int
	// HeapCapMB is an absolute ceiling for the heap; past it the file that has grown it most is interrupted.
	HeapCapMB int
	// FileWork bounds the checker work for one file (see Checker.SetWorkLimit). It is deterministic: a file
	// that exceeds it stops at the same node on every run and at every worker count.
	FileWork int64
	// KeepPrinterCaches turns the per-file release of the printer's caches off (for measuring). The
	// node builder caches every type node it serializes per enclosing declaration; releasing them after
	// each file took outline from 1,641 to 892 MB and angular-realworld from 2,737 to 1,580 MB.
	KeepPrinterCaches bool
	// RecycleAfter replaces the program (and with it every checker's accumulated type objects) after
	// this many files have been typed on a checker. 0 = never. Measured and not worth it: with the caches
	// released, recycling every 300 files made outline slower (7.5 s against 5.7 s) and no smaller.
	RecycleAfter int
	// BuilderCalls bounds the node builder work of one type write (astgen's MAX_TYPE_BUILDER_CALLS).
	BuilderCalls int
	// Poll is how often the watcher samples; default 50 ms.
	Poll time.Duration
}

// DefaultBudget is the budget of a normal run. FileWork is the one that decides in practice; the wall
// time and heap limits are a backstop for what it does not count. A type needs at most a few hundred
// builder calls (astgen measured 305 across 37 projects).
func DefaultBudget() Budget {
	return Budget{FileWork: 150_000_000, FileWall: 60 * time.Second, HeapGrowthMB: 3072, HeapCapMB: 6144, BuilderCalls: 16384, Poll: 50 * time.Millisecond}
}

// Reasons recorded in the manifest.
const (
	ReasonWork = "file-work-limit"
	ReasonWall = "file-wall-time"
	ReasonHeap = "file-heap-growth"
	ReasonCap  = "heap-cap"
)

// Watch tracks the files being typed and interrupts one that goes over a budget.
type Watch struct {
	b      Budget
	mu     sync.Mutex
	active map[*Slot]struct{}
	stop   chan struct{}
	done   chan struct{}
}

// Slot is the registration of one file being typed.
type Slot struct {
	Start     time.Time
	startHeap uint64
	flag      atomic.Bool
	reason    atomic.Value // string
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
	s := &Slot{Start: time.Now(), startHeap: heapBytes()}
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

func (w *Watch) trip(s *Slot, reason string) {
	if s.flag.CompareAndSwap(false, true) {
		s.reason.Store(reason)
	}
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
		heap := heapBytes()
		w.mu.Lock()
		var worst *Slot
		var worstGrowth uint64
		for s := range w.active {
			if s.flag.Load() {
				continue
			}
			if w.b.FileWall > 0 && now.Sub(s.Start) > w.b.FileWall {
				w.trip(s, ReasonWall)
				continue
			}
			var g uint64
			if heap > s.startHeap {
				g = heap - s.startHeap
			}
			if g >= worstGrowth {
				worst, worstGrowth = s, g
			}
		}
		if worst != nil {
			switch {
			case w.b.HeapGrowthMB > 0 && worstGrowth > uint64(w.b.HeapGrowthMB)<<20:
				w.trip(worst, ReasonHeap)
			case w.b.HeapCapMB > 0 && heap > uint64(w.b.HeapCapMB)<<20:
				w.trip(worst, ReasonCap)
			}
		}
		w.mu.Unlock()
	}
}
