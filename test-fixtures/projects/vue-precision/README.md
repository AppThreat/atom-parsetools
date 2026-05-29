# Vue Precision Fixtures

This fixture set is used by `test-fixtures/astgen-vue-regression.js` to validate Vue-focused type inference precision.

It intentionally mixes:

- Vue SFC `<script setup lang="ts">` patterns (`defineProps`, `defineEmits`, `withDefaults`)
- Composition macro patterns (`defineModel`, `defineSlots`)
- Top-level async setup flow (`await` in script setup)
- Provide/inject typing (`InjectionKey`)
- Plain TypeScript utility modules to verify non-SFC regressions

Run the dedicated regression:

```bash
npm run test:vue
```
