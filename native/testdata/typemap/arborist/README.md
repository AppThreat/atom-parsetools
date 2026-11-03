# arborist fixture

`lib/` is `lib/third-party/arborist/lib` from cdxgen at 90baa955934985ea4a18630e8e382c96bc18a0bd, which vendors it from
npm's `@npmcli/arborist` (ISC License, Copyright npm, Inc., see LICENSE.md). It is used unmodified.

Why it is here: typed with checkers that share state differently, one file of it, `lib/printable.js`, got other answers
(`[any, any]` against `Array<any>`, one class against a union of two): a checker's answer can depend on what it
resolved earlier. With the number of checkers tied to the number of workers, the output of this directory differed
between one and eight workers; with a fixed number of checkers it does not. A synthetic project did not show the
effect (several were tried), this one does, so `budget_test.go` uses it.
