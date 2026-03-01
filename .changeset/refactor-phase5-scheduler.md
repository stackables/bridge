---
"@stackables/bridge-core": patch
---

Refactor Phase 5: Extract scheduler into `scheduleTools.ts`

- Created `scheduleTools.ts` (324 lines) with `SchedulerContext` interface plus free functions: `schedule`, `scheduleFinish`, `scheduleToolDef`
- `ExecutionTree` delegates via a single one-line `schedule` wrapper
- Removed 5 private delegation methods (`getToolName`, `lookupToolFn`, `resolveToolDefByName`, `resolveToolWires`, `resolveToolSource`) — scheduler calls `toolLookup.ts` functions directly
- Made `pipeHandleMap`, `handleVersionMap`, `resolveWires` public to satisfy `SchedulerContext`
- ExecutionTree reduced from 1265 → 1018 lines

Zero behaviour change — all 621 unit tests and 35 e2e tests pass unchanged.
