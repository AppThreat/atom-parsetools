package typemap

import "time"

// Budget limits what one file may cost. Zero values mean no limit.
type Budget struct {
	FileWall time.Duration
	FileMB   int
}

// newGate returns the check typeFile polls while walking a file.
func (b Budget) newGate(start time.Time) func() string {
	if b.FileWall <= 0 && b.FileMB <= 0 {
		return nil
	}
	return func() string {
		if b.FileWall > 0 && time.Since(start) > b.FileWall {
			return "file-wall-time"
		}
		return ""
	}
}
