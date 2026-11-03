package typemap

import (
	_ "embed"
	"strings"
)

//go:embed pin.txt
var pinText string

// TypeScriptPin is the microsoft/TypeScript commit the binary was built against.
func TypeScriptPin() string { return strings.TrimSpace(pinText) }
