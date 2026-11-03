package typemap

import (
	"strings"
	"testing"
)

// utf16At computes the expected offset by decoding the whole prefix, the slow
// way, so the table is checked against an independent computation.
func utf16At(text string, b int) int {
	n := 0
	for i := 0; i < b; {
		bytes, units := decodeStep(text[i:])
		if i+bytes > b {
			break
		}
		i += bytes
		n += units
	}
	return n
}

func TestOffsetsWidths(t *testing.T) {
	// ASCII, 2-byte (é), 3-byte (€), 4-byte (U+1F600, a surrogate pair), then ASCII.
	text := "a" + "é" + "€" + "\U0001F600" + "z"
	o := NewOffsets(text, false)
	want := map[string]int{"a": 0, "é": 1, "€": 2, "\U0001F600": 3, "z": 5}
	for ch, w := range want {
		b := strings.Index(text, ch)
		if got := o.At(b); got != w {
			t.Errorf("offset of %q (byte %d) = %d, want %d", ch, b, got, w)
		}
	}
	if got := o.At(len(text)); got != 6 {
		t.Errorf("end offset = %d, want 6", got)
	}
}

func TestOffsetsCRLFDoNotMatter(t *testing.T) {
	a := NewOffsets("x\r\ny\r\nz", false)
	if a.At(strings.Index("x\r\ny\r\nz", "z")) != 6 {
		t.Fatal("CRLF must count as two code units")
	}
	b := NewOffsets("x\ny\nz", false)
	if b.At(strings.Index("x\ny\nz", "z")) != 4 {
		t.Fatal("LF must count as one code unit")
	}
}

func TestOffsetsBOMShift(t *testing.T) {
	o := NewOffsets("const a", true)
	if o.At(0) != 1 || o.At(6) != 7 {
		t.Fatalf("BOM must shift every offset by one: %d %d", o.At(0), o.At(6))
	}
}

func TestOffsetsInvalidUTF8(t *testing.T) {
	// E2 82 is a truncated euro sign: the WHATWG decoder gives one U+FFFD for the pair.
	text := "a\xe2\x82b\xffc"
	o := NewOffsets(text, false)
	if got := o.At(strings.Index(text, "b")); got != 2 {
		t.Errorf("b at %d, want 2", got)
	}
	if got := o.At(strings.Index(text, "c")); got != 4 {
		t.Errorf("c at %d, want 4", got)
	}
	if JSLen(text) != 5 {
		t.Errorf("JSLen = %d, want 5", JSLen(text))
	}
}

func TestOffsetsMatchSlowComputation(t *testing.T) {
	text := "é€😀 x\r\n\xff y😀€é"
	o := NewOffsets(text, false)
	for i := 0; i <= len(text); i++ {
		if got, want := o.At(i), utf16At(text, i); got != want {
			t.Fatalf("byte %d: table %d, slow %d", i, got, want)
		}
	}
}

func TestEncodeTypeMapEscapesLikeJSON(t *testing.T) {
	got := string(EncodeTypeMap(map[int]string{
		10: `Promise<{ a: "x" }>`, 2: "a\\b\n\t\x01<>&\u2028", 100: "ok",
	}))
	want := `{"2":"a\\b\n\t\u0001<>&` + "\u2028" + `","10":"Promise<{ a: \"x\" }>","100":"ok"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}
