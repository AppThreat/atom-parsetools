package typemap

import (
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/microsoft/TypeScript/tsc/shim/ast"
	"github.com/microsoft/TypeScript/tsc/shim/checker"
	"github.com/microsoft/TypeScript/tsc/shim/scanner"
)

// fileStats counts what happened while one file was typed.
type fileStats struct {
	nodes, writes, gaveUp, recovered int
}

// unit is the state of typing one source file. It replaces the closure state
// of createTsc in astgen.js; everything that astgen resets per file
// (oversizedTypes, the result map) lives here.
type unit struct {
	c         *checker.Checker
	sf        *ast.SourceFile
	off       *Offsets
	seen      map[int]string
	oversized map[*checker.Type]uint8
	stats     fileStats
	over      func() string // returns a reason once a per-file budget is exceeded
	overWhy   string
	nodeCount int

	memoRet       map[*ast.Node]memoStr
	memoAsyncBody map[*ast.Node]memoStr
	memoAsyncSyn  map[*ast.Node]memoStr
	syntaxDepth   int
}

type memoStr struct {
	s  string
	ok bool
}

func newUnit(c *checker.Checker, sf *ast.SourceFile, off *Offsets) *unit {
	return &unit{
		c: c, sf: sf, off: off,
		seen:          map[int]string{},
		oversized:     map[*checker.Type]uint8{},
		memoRet:       map[*ast.Node]memoStr{},
		memoAsyncBody: map[*ast.Node]memoStr{},
		memoAsyncSyn:  map[*ast.Node]memoStr{},
	}
}

func (u *unit) noteRecovered(any) { u.stats.recovered++ }

// start is node.getStart(): the position of the first token, without leading
// trivia and without JSDoc, as a UTF-16 offset.
func (u *unit) start(n *ast.Node) int {
	return u.off.At(scanner.GetTokenPosOfNode(n, u.sf, false))
}

func (u *unit) text(n *ast.Node) string {
	return scanner.GetSourceTextOfNodeFromSourceFile(u.sf, n, false)
}

// isUnresolved is isUnresolvedTypeString.
func isUnresolved(s string) bool {
	switch s {
	case "any", "unknown", "any[]", "unknown[]", "error", "/*unresolved*/ any", "Promise<any>", "Promise<unknown>":
		return true
	}
	return false
}

// isIgnoredForKey is the list addTypeAtPosition and the final write test against.
func isIgnoredForKey(s string) bool {
	switch s {
	case "any", "unknown", "any[]", "unknown[]", "error", "/*unresolved*/ any":
		return true
	}
	return false
}

func scoreTypeString(v string) int {
	if v == "" || isUnresolved(v) {
		return 0
	}
	if strings.Contains(v, "=>") {
		return 3
	}
	if strings.Contains(v, "import(") || strings.Contains(v, "{") || strings.Contains(v, "|") {
		return 2
	}
	return 1
}

// addAt is addTypeAtPosition: of two candidate strings for one offset keep the
// one with the higher score, and on a tie the longer or equal one (later wins).
func (u *unit) addAt(pos int, typeStr string) {
	if pos < 0 || typeStr == "" || isIgnoredForKey(typeStr) {
		return
	}
	existing, ok := u.seen[pos]
	if !ok || existing == "" {
		u.seen[pos] = typeStr
		return
	}
	es, ns := scoreTypeString(existing), scoreTypeString(typeStr)
	if ns > es || (ns == es && JSLen(typeStr) >= JSLen(existing)) {
		u.seen[pos] = typeStr
	}
}

func isFnDecl(n *ast.Node) bool {
	switch n.Kind {
	case ast.KindFunctionDeclaration, ast.KindMethodDeclaration, ast.KindFunctionExpression, ast.KindArrowFunction:
		return true
	}
	return false
}

// declarationFor finds the first declaration of the callee's symbol that is a
// function, method, function expression or arrow function.
func (u *unit) declarationFor(callee *ast.Node) *ast.Node {
	sym := u.c.GetSymbolAtLocation(callee)
	if sym == nil {
		return nil
	}
	for _, d := range sym.Declarations() {
		if isFnDecl(d) {
			return d
		}
	}
	return nil
}

func nameOr(n *ast.Node) *ast.Node {
	if name := n.Name(); name != nil {
		return name
	}
	return n
}

// paramsOf is node.parameters. ok is false for kinds that have no parameter list
// (undefined in astgen), which is different from an empty list.
func paramsOf(n *ast.Node) (ps []*ast.Node, ok bool) {
	defer func() {
		if recover() != nil {
			ps, ok = nil, false
		}
	}()
	list := n.ParameterList()
	if list == nil {
		return nil, false
	}
	return list.Nodes, true
}

// annotation is node.type: the written annotation. TypeScript 7 also hangs a
// type it builds from a JSDoc @type tag on the declaration; TypeScript 6 did not
// (those are found through the checker), so those do not count here.
func annotation(n *ast.Node) *ast.Node {
	t := n.Type()
	if t == nil || t.Flags&ast.NodeFlagsReparsed != 0 {
		return nil
	}
	return t
}

func (u *unit) isAsync(n *ast.Node) bool {
	return ast.GetCombinedModifierFlags(n)&ast.ModifierFlagsAsync != 0
}

// ---- syntax based fallbacks (inferExpressionTypeFromSyntax and friends) ----

const maxSyntaxDepth = 64 // astgen recurses without a limit and relies on a caught stack overflow

func (u *unit) inferExpressionTypeFromSyntax(e *ast.Node) string {
	if e == nil || u.syntaxDepth > maxSyntaxDepth {
		return ""
	}
	u.syntaxDepth++
	defer func() { u.syntaxDepth-- }()
	if e.Kind == ast.KindCallExpression && e.Expression().Kind == ast.KindImportKeyword {
		args := e.Arguments()
		if len(args) > 0 && ast.IsStringLiteralLike(args[0]) {
			return `Promise<typeof import("` + normalizeImportedTypeSpecifier(args[0].Text(), string(u.sf.FileName())) + `")>`
		}
	}
	if e.Kind == ast.KindAwaitExpression {
		awaited := u.inferExpressionTypeFromSyntax(e.Expression())
		if strings.HasPrefix(awaited, "Promise<") && len(awaited) >= 9 {
			return awaited[8 : len(awaited)-1]
		}
		return awaited
	}
	if e.Kind == ast.KindIdentifier {
		if sym := u.c.GetSymbolAtLocation(e); sym != nil {
			if d := sym.ValueDeclaration(); d != nil && d.Kind == ast.KindVariableDeclaration && d.Initializer() != nil {
				return u.inferExpressionTypeFromSyntax(d.Initializer())
			}
		}
	}
	if e.Kind == ast.KindPropertyAccessExpression {
		if base := u.inferExpressionTypeFromSyntax(e.Expression()); base != "" {
			return base + "." + u.text(e.Name())
		}
	}
	return ""
}

func isNestedFunction(n *ast.Node) bool {
	switch n.Kind {
	case ast.KindFunctionDeclaration, ast.KindFunctionExpression, ast.KindArrowFunction, ast.KindMethodDeclaration:
		return true
	}
	return false
}

// jsSortedUnion is [...set].sort().join(" | ") with Promise wrapping.
func promiseOfUnion(set []string) string {
	sorted := append([]string(nil), set...)
	sort.Slice(sorted, func(i, j int) bool { return compareUTF16(sorted[i], sorted[j]) < 0 })
	union := strings.Join(sorted, " | ")
	if strings.HasPrefix(union, "Promise<") {
		return union
	}
	return "Promise<" + union + ">"
}

// compareUTF16 orders strings by UTF-16 code unit, as Array.prototype.sort does.
func compareUTF16(a, b string) int {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1
			}
			return 1
		}
	}
	return len(x) - len(y)
}

type strSet struct {
	list []string
	has  map[string]bool
}

func (s *strSet) add(v string) {
	if s.has == nil {
		s.has = map[string]bool{}
	}
	if !s.has[v] {
		s.has[v] = true
		s.list = append(s.list, v)
	}
}

// collectReturnExpressionTypes is collectReturnExpressionTypes in astgen.js, including
// its quirk: the callback it hands to forEachChild returns the (truthy) result set, which
// makes forEachChild stop after the first child. A return statement is therefore only
// found when it is reached through first children (a function body that starts with
// it). Kept for rule-for-rule parity; the type map tests pin it.
func (u *unit) collectReturnExpressionTypes(n *ast.Node, set *strSet) {
	if n == nil {
		return
	}
	if n.Kind == ast.KindReturnStatement && n.Expression() != nil {
		e := n.Expression()
		rt := u.typeStr(u.c.GetTypeAtLocation(e), e)
		if rt != "" && !isUnresolved(rt) {
			set.add(rt)
		} else if inferred := u.inferExpressionTypeFromSyntax(e); inferred != "" && !isUnresolved(inferred) {
			set.add(inferred)
		}
		return
	}
	if !isNestedFunction(n) {
		n.ForEachChild(func(ch *ast.Node) bool { u.collectReturnExpressionTypes(ch, set); return true })
	}
}

func (u *unit) inferAsyncReturnTypeFromBody(n *ast.Node) (string, bool) {
	if m, ok := u.memoAsyncBody[n]; ok {
		return m.s, m.ok
	}
	s, ok := u.inferAsyncReturnTypeFromBodyImpl(n)
	u.memoAsyncBody[n] = memoStr{s, ok}
	return s, ok
}

func (u *unit) inferAsyncReturnTypeFromBodyImpl(n *ast.Node) (string, bool) {
	body := n.Body()
	if body == nil {
		return "", false
	}
	if body.Kind != ast.KindBlock {
		bt := u.typeStr(u.c.GetTypeAtLocation(body), body)
		if bt != "" && !strings.HasPrefix(bt, "Promise<") {
			return "Promise<" + bt + ">", true
		}
		return bt, bt != ""
	}
	var set strSet
	u.collectReturnExpressionTypes(body, &set)
	if len(set.list) == 0 {
		return "", false
	}
	return promiseOfUnion(set.list), true
}

func (u *unit) inferAsyncReturnTypeFromSyntaxBody(n *ast.Node) (string, bool) {
	if m, ok := u.memoAsyncSyn[n]; ok {
		return m.s, m.ok
	}
	s, ok := u.inferAsyncReturnTypeFromSyntaxBodyImpl(n)
	u.memoAsyncSyn[n] = memoStr{s, ok}
	return s, ok
}

func (u *unit) inferAsyncReturnTypeFromSyntaxBodyImpl(n *ast.Node) (string, bool) {
	body := n.Body()
	if body == nil {
		return "", false
	}
	var set strSet
	var visit func(c *ast.Node)
	visit = func(c *ast.Node) {
		if c == nil {
			return
		}
		if c.Kind == ast.KindReturnStatement && c.Expression() != nil {
			if t := u.inferExpressionTypeFromSyntax(c.Expression()); t != "" {
				set.add(t)
			}
			return
		}
		if !isNestedFunction(c) {
			c.ForEachChild(func(ch *ast.Node) bool { visit(ch); return false })
		}
	}
	if body.Kind == ast.KindBlock {
		visit(body)
	} else if t := u.inferExpressionTypeFromSyntax(body); t != "" {
		set.add(t)
	}
	if len(set.list) == 0 {
		return "", false
	}
	return promiseOfUnion(set.list), true
}

func (u *unit) inferFunctionDeclarationReturnType(decl *ast.Node) (string, bool) {
	if m, ok := u.memoRet[decl]; ok {
		return m.s, m.ok
	}
	s, ok := u.inferFunctionDeclarationReturnTypeImpl(decl)
	u.memoRet[decl] = memoStr{s, ok}
	return s, ok
}

func (u *unit) inferFunctionDeclarationReturnTypeImpl(decl *ast.Node) (string, bool) {
	sig := u.c.GetSignatureFromDeclaration(decl)
	if sig == nil {
		return "", false
	}
	inferred := u.typeStr(u.c.GetReturnTypeOfSignature(sig), nameOr(decl))
	if isUnresolved(inferred) && u.isAsync(decl) {
		if s, ok := u.inferAsyncReturnTypeFromSyntaxBody(decl); ok && s != "" {
			return s, true
		}
		if s, ok := u.inferAsyncReturnTypeFromBody(decl); ok && s != "" {
			return s, true
		}
	}
	return inferred, true
}

// buildFunctionSignatureType renders `(a: T, b: U) => R` from a declaration.
func (u *unit) buildFunctionSignatureType(n *ast.Node, returnType string) string {
	params, ok := paramsOf(n)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(params))
	for _, p := range params {
		name := "arg"
		if pn := p.Name(); pn != nil {
			if t := u.text(pn); t != "" {
				name = t
			}
		}
		target := p
		if pn := p.Name(); pn != nil {
			target = pn
		}
		parts = append(parts, name+": "+u.typeStr(u.c.GetTypeAtLocation(target), target))
	}
	return "(" + strings.Join(parts, ", ") + ") => " + returnType
}

// ---- the node walk ----

func isStructural(k ast.Kind) bool {
	switch k {
	case ast.KindSourceFile, ast.KindBlock, ast.KindImportDeclaration, ast.KindImportClause, ast.KindNamedImports,
		ast.KindNamespaceImport, ast.KindExportDeclaration, ast.KindNamedExports, ast.KindTypeAliasDeclaration,
		ast.KindInterfaceDeclaration, ast.KindModuleDeclaration:
		return true
	}
	return false
}

func (u *unit) recurse(n *ast.Node) {
	n.ForEachChild(func(ch *ast.Node) bool { u.addType(ch); return false })
}

// addType is addType in astgen.js.
func (u *unit) addType(n *ast.Node) {
	if u.overWhy != "" {
		return
	}
	u.stats.nodes++
	if u.over != nil && u.stats.nodes&0x3f == 0 {
		if why := u.over(); why != "" {
			u.overWhy = why
			return
		}
	}
	if isStructural(n.Kind) {
		u.recurse(n)
		return
	}
	// A node TypeScript 7 builds from a JSDoc tag has no counterpart in TypeScript 6's
	// walk; its real children (a cast's operand) are still visited.
	if n.Flags&ast.NodeFlagsReparsed == 0 {
		u.visit(n)
	}
	u.recurse(n)
}

func (u *unit) visit(n *ast.Node) {
	isDirectCallee := n.Kind == ast.KindIdentifier && n.Parent != nil &&
		n.Parent.Kind == ast.KindCallExpression && n.Parent.Expression() == n
	defer func() {
		if r := recover(); r != nil {
			u.noteRecovered(r) // astgen: "silently fail on type resolution errors"
		}
	}()
	typeStr := u.typeForNode(n)
	if !isDirectCallee && typeStr != "" && !isIgnoredForKey(typeStr) {
		u.addAt(u.start(n), typeStr)
	}
}

func (u *unit) typeForNode(n *ast.Node) string {
	c := u.c
	switch {
	// WRAPPER NODES
	case n.Kind == ast.KindSatisfiesExpression || n.Kind == ast.KindAsExpression ||
		n.Kind == ast.KindTypeAssertionExpression || n.Kind == ast.KindNonNullExpression:
		return u.typeStr(c.GetTypeAtLocation(n), n)

	// FUNCTION/METHOD SIGNATURES: return type and parameter types
	case ast.IsFunctionLike(n):
		return u.functionLike(n)

	// CLASS PROPERTIES
	case n.Kind == ast.KindPropertyDeclaration:
		if t := annotation(n); t != nil {
			return u.typeStr(c.GetTypeFromTypeNode(t), t)
		}
		if init := n.Initializer(); init != nil {
			return u.typeStr(c.GetTypeAtLocation(init), init)
		}
		return ""

	// VARIABLE DECLARATIONS
	case n.Kind == ast.KindVariableDeclaration && n.Name() != nil:
		return u.variableDeclaration(n)

	// BINDING ELEMENTS
	case n.Kind == ast.KindBindingElement && n.Name() != nil:
		return u.typeStr(c.GetTypeAtLocation(n.Name()), n.Name())

	// PARAMETERS
	case n.Kind == ast.KindParameter && n.Name() != nil:
		return u.typeStr(c.GetTypeAtLocation(n.Name()), n.Name())

	// OBJECT LITERAL PROPERTIES
	case n.Kind == ast.KindPropertyAssignment && n.Initializer() != nil:
		return u.typeStr(c.GetTypeAtLocation(n.Initializer()), n.Initializer())

	// SHORTHAND OBJECT PROPERTIES
	case n.Kind == ast.KindShorthandPropertyAssignment:
		return u.typeStr(c.GetTypeAtLocation(n.Name()), n.Name())

	// IMPORT CALLS
	case n.Kind == ast.KindCallExpression && n.Expression() != nil && n.Expression().Kind == ast.KindImportKeyword:
		return u.typeStr(c.GetTypeAtLocation(n), n)

	// CALL EXPRESSIONS
	case n.Kind == ast.KindCallExpression:
		sig := c.GetResolvedSignature(n)
		if sig == nil {
			return ""
		}
		ts := u.typeStr(c.GetReturnTypeOfSignature(sig), n)
		if isUnresolved(ts) && n.Expression().Kind == ast.KindIdentifier {
			if d := u.declarationFor(n.Expression()); d != nil {
				if s, ok := u.inferFunctionDeclarationReturnType(d); ok && s != "" {
					ts = s
				}
			}
		}
		return ts

	// NEW EXPRESSIONS
	case n.Kind == ast.KindNewExpression:
		sig := c.GetResolvedSignature(n)
		if sig == nil {
			return ""
		}
		return u.typeStr(c.GetReturnTypeOfSignature(sig), n)

	// PROPERTY ACCESS
	case n.Kind == ast.KindPropertyAccessExpression || n.Kind == ast.KindElementAccessExpression:
		ts := u.typeStr(c.GetTypeAtLocation(n), n)
		if n.Kind == ast.KindPropertyAccessExpression {
			u.addAt(u.start(n.Name()), ts)
		} else if arg := n.AsElementAccessExpression().ArgumentExpression; arg != nil {
			u.addAt(u.start(arg), ts)
		}
		return ts

	// BINARY, CONDITIONAL. The Logical rule and the ArrowFunction rule of astgen.js never run:
	// SyntaxKind.LogicalExpression does not exist, and isFunctionLike catches arrow functions above.
	case n.Kind == ast.KindBinaryExpression, n.Kind == ast.KindConditionalExpression:
		return u.typeStr(c.GetTypeAtLocation(n), n)

	// CLASS DECLARATIONS: the construct signature of the class type
	case n.Kind == ast.KindClassDeclaration || n.Kind == ast.KindClassExpression:
		classType := c.GetTypeAtLocation(n)
		if classType == nil {
			return ""
		}
		sigs := c.GetSignaturesOfType(classType, checker.SignatureKindConstruct)
		if len(sigs) > 0 {
			return u.typeStr(c.GetReturnTypeOfSignature(sigs[0]), n)
		}
		return ""

	case n.Kind == ast.KindEnumMember,
		n.Kind == ast.KindTemplateExpression, n.Kind == ast.KindNoSubstitutionTemplateLiteral,
		n.Kind == ast.KindTaggedTemplateExpression, n.Kind == ast.KindYieldExpression,
		n.Kind == ast.KindDeleteExpression, n.Kind == ast.KindTypeOfExpression, n.Kind == ast.KindVoidExpression:
		return u.typeStr(c.GetTypeAtLocation(n), n)

	case n.Kind == ast.KindSpreadElement:
		return u.typeStr(c.GetTypeAtLocation(n.Expression()), n.Expression())

	// STANDARD EXPRESSIONS, IDENTIFIERS AND TYPE NODES: literal types are widened
	default:
		t := u.typeAtLocationForDefault(n)
		if t == nil {
			return ""
		}
		if t.Flags()&checker.TypeFlagsLiteral != 0 {
			if base := c.GetBaseTypeOfLiteralType(t); base != nil {
				t = base
			}
		}
		return u.typeStr(t, n)
	}
}

func (u *unit) functionLike(n *ast.Node) string {
	c := u.c
	sig := c.GetSignatureFromDeclaration(n)
	if sig == nil {
		ft := c.GetTypeAtLocation(n)
		if ft == nil {
			return ""
		}
		if sigs := c.GetSignaturesOfType(ft, checker.SignatureKindCall); len(sigs) > 0 {
			return u.typeStr(c.GetReturnTypeOfSignature(sigs[0]), nameOr(n))
		}
		return ""
	}
	ts := u.typeStr(c.GetReturnTypeOfSignature(sig), nameOr(n))
	if isUnresolved(ts) && u.isAsync(n) {
		if s, ok := u.inferAsyncReturnTypeFromSyntaxBody(n); ok && s != "" {
			ts = s
		} else if s, ok := u.inferAsyncReturnTypeFromBody(n); ok && s != "" {
			ts = s
		}
	}
	params, _ := paramsOf(n)
	for _, p := range params {
		func() {
			defer func() {
				if r := recover(); r != nil {
					u.noteRecovered(r)
				}
			}()
			ps := u.typeStr(c.GetTypeAtLocation(p), nameOr(p))
			if ps != "" && ps != "any" {
				u.seen[u.start(p)] = ps // set directly: no scoring, as in astgen
			}
		}()
	}
	if name := n.Name(); name != nil {
		u.addAt(u.start(name), u.buildFunctionSignatureType(n, ts))
	}
	return ts
}

func (u *unit) variableDeclaration(n *ast.Node) string {
	c := u.c
	explicit := ""
	if t := annotation(n); t != nil {
		explicit = u.typeStr(c.GetTypeFromTypeNode(t), t)
	}
	varType := c.GetTypeAtLocation(n.Name())
	var ts string
	if explicit != "" && !isUnresolved(explicit) {
		ts = explicit
	} else {
		ts = u.typeStr(varType, n.Name())
	}
	if init := n.Initializer(); init != nil && explicit == "" {
		target := init
		if init.Kind == ast.KindPropertyAccessExpression {
			target = init.Name()
		} else if init.Kind == ast.KindElementAccessExpression && init.AsElementAccessExpression().ArgumentExpression != nil {
			target = init.AsElementAccessExpression().ArgumentExpression
		}
		it := u.typeStr(c.GetTypeAtLocation(target), target)
		if !isUnresolved(it) && (isUnresolved(ts) || JSLen(it) > JSLen(ts)) {
			ts = it
		}
		if isUnresolved(ts) && init.Kind == ast.KindCallExpression && init.Expression().Kind == ast.KindIdentifier {
			if d := u.declarationFor(init.Expression()); d != nil {
				if s, ok := u.inferFunctionDeclarationReturnType(d); ok && s != "" {
					ts = s
				}
			}
		}
	}
	u.addAt(u.start(n.Name()), ts)
	return ts
}

// typeAtLocationForDefault is getTypeAtLocation with the typescript-go gap
// closed: it returns no type for the identifiers of a type reference, so the
// type is taken from the enclosing reference with getTypeFromTypeNode.
func (u *unit) typeAtLocationForDefault(n *ast.Node) *checker.Type {
	if n.Kind == ast.KindIdentifier || n.Kind == ast.KindQualifiedName {
		if ref := typeReferenceOf(n); ref != nil {
			return u.c.GetTypeFromTypeNode(ref)
		}
	}
	return u.c.GetTypeAtLocation(n)
}

// typeReferenceOf returns the TypeReference whose name ends in n (the name
// itself, or the right-hand part of a qualified name), or nil. The left-hand
// parts of a qualified name are namespaces and have no type.
func typeReferenceOf(n *ast.Node) *ast.Node {
	cur := n
	for cur.Parent != nil && cur.Parent.Kind == ast.KindQualifiedName {
		if cur.Parent.AsQualifiedName().Right != cur {
			return nil
		}
		cur = cur.Parent
	}
	if p := cur.Parent; p != nil && p.Kind == ast.KindTypeReference && p.AsTypeReferenceNode().TypeName == cur {
		return p
	}
	return nil
}
