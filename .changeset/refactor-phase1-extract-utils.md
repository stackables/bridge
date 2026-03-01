---
"@stackables/bridge-core": patch
---

Refactor Phase 1: Extract utility helpers from ExecutionTree.ts into focused modules

- `tree-types.ts` — Error classes, sentinels, type aliases (`MaybePromise`, `Trunk`, `Logger`, `Path`), and lightweight helpers (`isPromise`, `isFatalError`, `applyControlFlow`)
- `tree-utils.ts` — Pure utility functions (`trunkKey`, `sameTrunk`, `pathEquals`, `coerceConstant`, `setNested`, `getSimplePullRef`, `roundMs`)
- `tracing.ts` — OpenTelemetry instrumentation (`TraceCollector`, `ToolTrace`, `TraceLevel`, `otelTracer`, metric counters/histograms)

ExecutionTree re-exports all symbols so the public API is unchanged.
