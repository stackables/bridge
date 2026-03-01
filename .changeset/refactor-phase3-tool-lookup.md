---
"@stackables/bridge-core": patch
---

Refactor Phase 3: Extract tool lookup into `toolLookup.ts`

- Created `toolLookup.ts` (310 lines) with `ToolLookupContext` interface and free functions: `lookupToolFn`, `resolveToolDefByName`, `resolveToolWires`, `resolveToolSource`, `resolveToolDep`
- `ExecutionTree` delegates via one-line wrapper methods; `callTool` made public to satisfy the context interface
- Exposed `toolFns`, `toolDefCache`, `toolDepCache`, `context`, `parent`, and `instructions` getter for extracted modules
- ExecutionTree reduced from 1599 → 1448 lines

Zero behaviour change — all 621 unit tests and 35 e2e tests pass unchanged.
