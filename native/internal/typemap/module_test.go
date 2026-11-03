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

// `this` at the top level of a CommonJS module is its exports: TypeScript 6 wrote the module's type,
// and chen links the helpers compiled code reads through it. Inside a function it stays as it is.
func TestCommonJSTopLevelThisIsTheModule(t *testing.T) {
	src := "var helper = (this && this.helper) || function (m) { return m; };\nfunction f() { return this; }\nexports.x = 1;\n"
	esm := "export const y = this;\n"
	maps, _ := runProject(t, map[string]string{"build/app.js": src, "esm.mjs": esm}, 1, Env{}, Budget{})
	if got := typeAt(maps["build/app.js"], src, "this && "); got != `typeof import("./app")` {
		t.Errorf("top-level this: got %q", got)
	}
	if got := typeAt(maps["build/app.js"], src, "this; }"); got == `typeof import("./app")` {
		t.Errorf("this inside a function is not the module: got %q", got)
	}
	if got := typeAt(maps["esm.mjs"], esm, "this;"); got == `typeof import("./esm")` {
		t.Errorf("this in an ES module is not the module: got %q", got)
	}
}
