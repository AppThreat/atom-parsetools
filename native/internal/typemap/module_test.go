package typemap

import "testing"

// A required CommonJS module is named `typeof import("<file>")`, as TypeScript 6 did and as chen needs
// to link a call on it to that module. Inside the exporting file the structure is kept.
func TestCommonJSModuleIsNamedByImport(t *testing.T) {
	app := "const m = require('./lib/m');\nm.f();\nmodule.exports = m;\n"
	lib := "function f() {}\nmodule.exports = { f };\n"
	maps, _ := runProject(t, map[string]string{"app.js": app, "lib/m.js": lib}, 1, Env{}, Budget{})
	for _, marker := range []string{"m = require", "m;"} {
		if got := typeAt(maps["app.js"], app, marker); got != `typeof import("./lib/m")` {
			t.Errorf("app.js %q: got %q", marker, got)
		}
	}
	if got := typeAt(maps["app.js"], app, "m.f()"); got != "() => void" {
		t.Errorf("app.js m.f(): got %q", got)
	}
	if got := typeAt(maps["lib/m.js"], lib, "exports = {"); got != "{ f: () => void; }" {
		t.Errorf("lib/m.js exports: got %q", got)
	}
}
