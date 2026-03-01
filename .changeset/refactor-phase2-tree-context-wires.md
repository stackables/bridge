---
"@stackables/bridge-core": patch
---

Refactor Phase 2: Define TreeContext interface and extract wire resolution

- Added `TreeContext` interface to `tree-types.ts` — narrow contract for extracted modules
- Created `resolveWires.ts` — wire resolution logic (`resolveWires`, `resolveWiresAsync`, `evaluateWireSource`, `pullSafe`) as free functions taking `TreeContext`
- `ExecutionTree` now implements `TreeContext`; `pullSingle` is public to satisfy the interface

Zero behaviour change — all unit and e2e tests pass unchanged.
