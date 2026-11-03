One directory per tsconfig rule of createTscProgramConfig. `expected/` holds the native output; the same projects
typed by astgen 1.10.6 agree on every key except the bare specifiers in `baseurl-paths` and `baseurl-src`
(`import ... from 'src/lib/item'`, resolved through `baseUrl` alone), which TypeScript 6 types and TypeScript 7
does not, because it no longer treats `baseUrl` as a module resolution root. `paths` aliases resolve in both, and
in `baseurl-src` they are relative to `baseUrl`, as TypeScript 6 read them.
