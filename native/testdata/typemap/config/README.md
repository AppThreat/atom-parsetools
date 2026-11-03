One directory per tsconfig rule of createTscProgramConfig. `expected/` holds the native output; the same projects
typed by astgen 1.10.6 agree on every key. `baseurl-paths` and `baseurl-src` resolve a bare specifier through
`baseUrl` (TypeScript 7 no longer does, the binary adds the `"*"` paths entry) and a `paths` alias relative to
`baseUrl`.
