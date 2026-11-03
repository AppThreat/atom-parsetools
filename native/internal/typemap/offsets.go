package typemap

import "unicode/utf8"

// Offsets converts UTF-8 byte offsets in a source text to UTF-16 code unit
// offsets, the unit Babel and chen use. The table is built once per file.
//
// Invalid UTF-8 is counted the way the WHATWG decoder (and so Node's
// readFileSync(file, "utf-8")) counts it: each maximal invalid subpart is one
// U+FFFD, which is one UTF-16 code unit.
type Offsets struct {
	table []int32 // nil when the text is ASCII
	shift int     // added to every result (1 for a UTF-8 byte order mark that the checker's text lacks)
}

// NewOffsets builds the table for text. bom reports that the file on disk
// started with a UTF-8 byte order mark that text no longer contains: Babel
// counts the mark as a character, so every offset moves by one.
func NewOffsets(text string, bom bool) *Offsets {
	o := &Offsets{}
	if bom {
		o.shift = 1
	}
	ascii := true
	for i := 0; i < len(text); i++ {
		if text[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return o
	}
	t := make([]int32, len(text)+1)
	u := int32(0)
	for i := 0; i < len(text); {
		n, units := decodeStep(text[i:])
		for k := 0; k < n; k++ {
			t[i+k] = u
		}
		u += int32(units)
		i += n
	}
	t[len(text)] = u
	o.table = t
	return o
}

// At returns the UTF-16 offset of byte offset b. Offsets inside a multi-byte
// sequence map to the start of that character.
func (o *Offsets) At(b int) int {
	if o.table == nil {
		return b + o.shift
	}
	if b < 0 {
		b = 0
	}
	if b >= len(o.table) {
		b = len(o.table) - 1
	}
	return int(o.table[b]) + o.shift
}

// decodeStep returns how many bytes of s form the next character (or maximal
// invalid subpart) and how many UTF-16 code units that is.
func decodeStep(s string) (bytes, units int) {
	c := s[0]
	if c < 0x80 {
		return 1, 1
	}
	r, size := utf8.DecodeRuneInString(s)
	if r != utf8.RuneError || size > 1 {
		if r >= 0x10000 {
			return size, 2
		}
		return size, 1
	}
	// Invalid: find the maximal subpart (WHATWG Encoding, UTF-8 decoder).
	lo, hi, need := byte(0x80), byte(0xBF), 0
	switch {
	case c >= 0xC2 && c <= 0xDF:
		need = 1
	case c == 0xE0:
		need, lo = 2, 0xA0
	case c >= 0xE1 && c <= 0xEC, c == 0xEE, c == 0xEF:
		need = 2
	case c == 0xED:
		need, hi = 2, 0x9F
	case c == 0xF0:
		need, lo = 3, 0x90
	case c >= 0xF1 && c <= 0xF3:
		need = 3
	case c == 0xF4:
		need, hi = 3, 0x8F
	default:
		return 1, 1
	}
	n := 1
	for k := 0; k < need && n < len(s); k++ {
		b := s[n]
		if b < lo || b > hi {
			break
		}
		lo, hi = 0x80, 0xBF
		n++
	}
	return n, 1
}

// JSLen returns the length of s as JavaScript's String.length reports it.
func JSLen(s string) int {
	n := 0
	for i := 0; i < len(s); {
		b, u := decodeStep(s[i:])
		i += b
		n += u
	}
	return n
}
