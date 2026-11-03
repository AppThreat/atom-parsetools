package typemap

import (
	"bytes"
	"sort"
	"strconv"
	"unicode/utf8"
)

// Entry is one type map record.
type Entry struct {
	Pos  int
	Type string
}

// EncodeTypeMap writes entries as the object JSON.stringify(Object.fromEntries(map))
// produces in Node: keys are integer strings in ascending order and strings are
// escaped as JSON.stringify escapes them (no \u003c for "<", no escaping of
// U+2028). Invalid UTF-8 in a value becomes U+FFFD.
func EncodeTypeMap(seen map[int]string) []byte {
	keys := make([]int, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		b.WriteString(strconv.Itoa(k))
		b.WriteString(`":`)
		writeJSString(&b, seen[k])
	}
	b.WriteByte('}')
	return b.Bytes()
}

const hexDigits = "0123456789abcdef"

func writeJSString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"':
				b.WriteString(`\"`)
			case c == '\\':
				b.WriteString(`\\`)
			case c == '\b':
				b.WriteString(`\b`)
			case c == '\f':
				b.WriteString(`\f`)
			case c == '\n':
				b.WriteString(`\n`)
			case c == '\r':
				b.WriteString(`\r`)
			case c == '\t':
				b.WriteString(`\t`)
			case c < 0x20:
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[c>>4])
				b.WriteByte(hexDigits[c&0xF])
			default:
				b.WriteByte(c)
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			n, _ := decodeStep(s[i:])
			b.WriteString("\uFFFD")
			i += n
			continue
		}
		b.WriteString(s[i : i+size])
		i += size
	}
	b.WriteByte('"')
}

// EncodeSpans writes the span map as one JSON object keyed "start:end", ordered by start and then end.
func EncodeSpans(spans map[Span]string) []byte {
	keys := make([]Span, 0, len(spans))
	for k := range spans {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Start != keys[j].Start {
			return keys[i].Start < keys[j].Start
		}
		return keys[i].End < keys[j].End
	})
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		b.WriteString(strconv.Itoa(k.Start))
		b.WriteByte(':')
		b.WriteString(strconv.Itoa(k.End))
		b.WriteString(`":`)
		writeJSString(&b, spans[k])
	}
	b.WriteByte('}')
	return b.Bytes()
}
