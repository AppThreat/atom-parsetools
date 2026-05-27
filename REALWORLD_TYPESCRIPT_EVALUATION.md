# Real-World TypeScript Evaluation

Date: 2026-05-27

## Repositories Evaluated

1. `nestjs/typescript-starter` @ `c4d9330`
2. `sindresorhus/ky` @ `61d6d66`

## Commands Used

```bash
node astgen.js -i /tmp/astgen-realworld/nestjs-typescript-starter -o /tmp/astgen-realworld-output/nestjs -t ts
node astgen.js -i /tmp/astgen-realworld/ky -o /tmp/astgen-realworld-output/ky -t ts
```

## Repo-Level Summary

| Repo | Typemap files | Typemap entries | Unresolved entries | Unique type strings |
|------|---------------|-----------------|--------------------|---------------------|
| `nestjs-typescript-starter` | 7 | 106 | 8 | 35 |
| `ky` | 52 | 25,639 | 1,722 | 1,801 |

## Manual Type Tracing

### 1. `nestjs-typescript-starter`

#### File: `src/app.service.ts`
Source:
- `class AppService`
- `getHello(): string`

Observed typemap evidence:
- `AppService` → `AppService`
- `getHello` → `() => string`
- method return position also resolves to `string`

Assessment:
- Internal class and method return types are traced correctly.
- This is a strong basic signal that class/method inference remains intact on a standard NestJS project.

#### File: `src/app.controller.ts`
Source:
- constructor parameter `appService: AppService`
- method `getHello(): string { return this.appService.getHello(); }`

Observed typemap evidence:
- `AppController` → `AppController`
- `appService` → `AppService`
- `getHello(): string` → `() => string`
- `this.appService` yields receiver/property chain evidence:
  - `this` → `this`
  - property access on `appService` → `AppService`
  - `getHello` call site → `() => string`

Assessment:
- Internal import resolution (`./app.service`) works correctly.
- Property access and method-call typing are usable for manual tracing.
- External NestJS decorators/imports are not the interesting type signal here; the internal app types are the main success case.

### 2. `ky`

#### File: `source/index.ts`
Source:
- `const createInstance = (defaults?: Partial<Options>): KyInstance => { ... }`
- `const ky: Partial<Mutable<KyInstance>> = ...`
- `ky.create = ...`
- `ky.extend = ...`
- `validateAndMerge(defaults, options)`

Observed typemap evidence:
- `createInstance` → `(defaults?: Partial<Options>) => KyInstance`
- `defaults?: Partial<Options>` → `Partial<Options> | undefined`
- `ky: Partial<Mutable<KyInstance>>` → expanded mapped/object type for partial mutable Ky instance
- `ky.create` → `(defaultOptions?: Options) => KyInstance`
- `ky.extend` → `(defaultOptions: Options | ((parentOptions: Options) => Options)) => KyInstance`
- `validateAndMerge(defaults, options)` → `(...sources: Array<Partial<Options> | undefined>) => Partial<Options>`

Assessment:
- Internal multi-file module resolution works well on a real ESM TypeScript library with `.js` import specifiers.
- Generic and mapped types are preserved, though often verbose.
- Output is accurate but sometimes too expanded for human readability.

#### File: `source/core/Ky.ts`
Source:
- `const createTextDecoder = (contentType: string): TextDecoder => ...`
- `const cloneRetryOptions = (retry: RetryOptions | number): RetryOptions | number => ...`
- `function cloneInitHookOptions(options: Options): Options`
- `static create(input: Input, options: Options): ResponsePromise`

Observed typemap evidence:
- `createTextDecoder` → `(contentType: string) => TextDecoder`
- `cloneRetryOptions` → `(retry: RetryOptions | number) => RetryOptions | number`
- `retry: RetryOptions | number` → `number | RetryOptions`
- `cloneInitHookOptions` → `(options: Options) => Options`
- `static create(...)` shows:
  - function type `(input: Input, options: Options) => ResponsePromise`
  - parameter types like `Input` resolving to `string | URL | Request`
  - `Options` preserved through parameter/return flows
- `response = beforeRequestResponse ?? await ky.#retry(...)` → `void | Response`

Assessment:
- This is a strong real-world signal for advanced TypeScript: unions, generics, class statics, async/await, and private-field-heavy code all produce meaningful typemap output.
- The awaited union `void | Response` at a real async control-flow site is especially useful.

## What Looks Good

- Internal TypeScript module resolution is materially better after the latest `astgen.js` changes.
- Path/tsconfig-aware type resolution works in fixtures and internal real-world imports.
- ESM `.js` import specifiers in TypeScript sources are handled successfully in `ky`.
- Async control flow, generic callbacks, mapped types, and union return types are present in typemap output.
- Declaration-file parsing is now exercised in fixtures and no longer blocked.

## Gaps Exposed by Real-World Tracing

1. **Verbose imported type strings**
   - `ky` emits many `import("/abs/path", { with: { "resolution-mode": "import" } }).Type` strings.
   - These are semantically useful but not ergonomic for downstream diffing or analyst review.

2. **Property-chain precision is uneven**
   - Some declarations are best traced at receiver or call offsets rather than the obvious variable/property token.
   - Example: `aliasDepartment` in the local fixture did not always land directly on the declaration identifier offset.

3. **Dynamic import typing still degrades in some cases**
   - The local alias fixture currently shows `Promise<any>` for one dynamic-import path.
   - This needs a dedicated follow-up improvement batch.

4. **External dependency types without install step**
   - Repos with no installed dependencies still produce useful internal types, but unresolved counts remain non-trivial.
   - This is expected for public quick-clone evaluation, but it should be distinguished from internal resolution failures.

## Recommended Next Real-World Batch

1. Normalize imported type strings so absolute-path import types become shorter, stable module-like names where possible.
2. Improve property-access offset mapping so declaration identifiers and property chains are both easier to trace.
3. Investigate dynamic `import()` return typing and eliminate avoidable `Promise<any>` fallbacks.
4. Add a real-world evaluator script that records:
   - typemap file count
   - entries
   - unresolved count
   - selected manual trace exemplars
   - repo commit hash

## Conclusion

`astgen` is now in a materially better position for TypeScript projects than before this round of work. The real-world runs show that:
- small app-style TypeScript projects already produce credible manual traces,
- complex library-style TypeScript projects produce high-value type data,
- the biggest remaining issues are readability/stability of imported type strings and a few precision gaps around property/dynamic-import tracing.
