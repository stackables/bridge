---
"@stackables/bridge-core": patch
---

Refactor Phase 4: Extract materializer into `materializeShadows.ts`

- Created `materializeShadows.ts` (247 lines) with `MaterializerHost` and `MaterializableShadow` interfaces plus free functions: `planShadowOutput`, `materializeShadows`
- `ExecutionTree` delegates via a single one-line `materializeShadows` wrapper
- ExecutionTree reduced from 1446 → 1265 lines

Zero behaviour change — all 621 unit tests and 35 e2e tests pass unchanged.
