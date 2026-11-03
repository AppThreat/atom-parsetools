One directory per tsconfig rule of createTscProgramConfig. `expected/` holds the native output; the same projects
typed by astgen 1.10.6 agree on every key except `baseurl-paths`, where `import ... from 'src/lib/item'` (a bare
specifier resolved through `baseUrl`) is typed by TypeScript 6 and not by TypeScript 7, which no longer treats
`baseUrl` as a module resolution root. `paths` aliases resolve in both.
