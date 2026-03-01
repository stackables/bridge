# ExecutionTree Refactoring Plan

> Track incremental extraction of `packages/bridge-core/src/ExecutionTree.ts` (~2000 lines)
> into focused modules with a thin coordinator class.

---

## Goal

Split the monolithic `ExecutionTree` class into **procedural modules + thin coordinator**.
Each module is a set of pure(ish) functions that receive a narrow context interface.
The class keeps one-line delegation methods so the public API is unchanged.

### Principles

- **Zero behaviour change** — every phase must pass `pnpm test && pnpm e2e`
- **No new allocations on hot paths** — extracted functions use the same patterns
- **Narrow dependency contracts** — modules depend on a `TreeContext` interface, not the full class
- **Incremental** — each phase is a standalone PR-sized change

---

## Current method inventory

| Concern                     | ~Lines | Methods                                                                                                                                                                                                   |
| --------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Top-level helpers           | ~300   | `trunkKey`, `sameTrunk`, `pathEquals`, `isFatalError`, `coerceConstant`, `setNested`, `getSimplePullRef`, `applyControlFlow`, `TraceCollector`, `roundMs`, `isPromise`, `MaybePromise`, sentinels, errors |
| Tool resolution             | ~200   | `lookupToolFn`, `resolveToolDefByName`, `resolveToolWires`, `resolveToolSource`, `resolveToolDep`                                                                                                         |
| Scheduling                  | ~200   | `schedule`, `scheduleFinish`, `scheduleToolDef`                                                                                                                                                           |
| Instrumented tool calling   | ~130   | `callTool`                                                                                                                                                                                                |
| Wire resolution             | ~250   | `resolveWires`, `resolveWiresAsync`, `evaluateWireSource`, `pullSingle`, `pullSafe`                                                                                                                       |
| Shadow trees / materializer | ~250   | `shadow`, `createShadowArray`, `planShadowOutput`, `materializeShadows`                                                                                                                                   |
| Output / response           | ~400   | `pullOutputField`, `collectOutput`, `run`, `response`, `findDefineFieldWires`, `applyPath`                                                                                                                |
| Lifecycle / state           | ~150   | constructor, `push`, `executeForced`, `resolvePreGrouped`, `getTraces`                                                                                                                                    |

---

## Target file structure

```
bridge-core/src/
  ExecutionTree.ts          ← thin coordinator (constructor, shadow, run, response, lifecycle)
  resolveWires.ts           ← wire resolution + modifier layers
  scheduleTools.ts          ← schedule, scheduleFinish, scheduleToolDef, callTool
  materializeShadows.ts     ← planShadowOutput + materializeShadows
  toolLookup.ts             ← lookupToolFn, resolveToolDefByName, resolveToolDep
  tracing.ts                ← TraceCollector, ToolTrace, TraceLevel, OTel helpers
  tree-types.ts             ← Trunk, MaybePromise, TreeContext interface, sentinels, errors
  tree-utils.ts             ← trunkKey, sameTrunk, pathEquals, isFatalError, coerceConstant, setNested, etc.
  types.ts                  ← existing (Wire, Bridge, NodeRef, …)
  utils.ts                  ← existing (parsePath)
  …
```

---

## Phases

### Phase 1 — Extract utility helpers ✅ <!-- mark when done -->

Move **zero-class-dependency** helpers out of `ExecutionTree.ts`:

**New file: `tree-types.ts`**

- `BridgePanicError`, `BridgeAbortError` (error classes)
- `CONTINUE_SYM`, `BREAK_SYM` (sentinels)
- `MAX_EXECUTION_DEPTH` constant
- `MaybePromise<T>` type alias
- `Trunk` type
- `Logger` interface
- `Path` interface (GraphQL path)
- `isPromise()` helper
- `isFatalError()` helper
- `applyControlFlow()` helper

**New file: `tree-utils.ts`**

- `trunkKey()`
- `sameTrunk()`
- `pathEquals()`
- `coerceConstant()` + `constantCache`
- `setNested()` + `UNSAFE_KEYS`
- `getSimplePullRef()`
- `roundMs()`

**New file: `tracing.ts`**

- `TraceCollector` class
- `ToolTrace` type
- `TraceLevel` type
- OTel meter/tracer setup (`otelTracer`, `otelMeter`, counters, histogram)
- `isOtelActive()` helper

`ExecutionTree.ts` re-imports everything and the public API (`index.ts`) stays unchanged.

**Status:** Done

---

### Phase 2 — Extract wire resolution

Move wire evaluation into `resolveWires.ts`:

- `resolveWires()` (fast path + delegation)
- `resolveWiresAsync()` (full loop with modifier layers)
- `evaluateWireSource()` (Layer 1)
- `pullSafe()` (safe-navigation wrapper)

Define a narrow `WireResolver` interface that these functions need:

```ts
interface WireResolverContext {
  pullSingle(ref: NodeRef, pullChain?: Set<string>): MaybePromise<any>;
}
```

`ExecutionTree` implements `WireResolverContext` and keeps a one-line:

```ts
private resolveWires(wires: Wire[], pullChain?: Set<string>): MaybePromise<any> {
  return resolveWires(this, wires, pullChain);
}
```

**Status:** Not started

---

### Phase 3 — Extract tool lookup

Move tool resolution into `toolLookup.ts`:

- `lookupToolFn()`
- `resolveToolDefByName()` + cache
- `resolveToolWires()`
- `resolveToolSource()`
- `resolveToolDep()`

**Status:** Not started

---

### Phase 4 — Extract materializer

Move shadow output assembly into `materializeShadows.ts`:

- `planShadowOutput()`
- `materializeShadows()`

**Status:** Not started

---

### Phase 5 — Extract scheduler + callTool

Move scheduling and tool invocation into `scheduleTools.ts`:

- `schedule()`
- `scheduleFinish()`
- `scheduleToolDef()`
- `callTool()`

**Status:** Not started

---

### Phase 6 — Define `TreeContext` interface

Once Phases 2–5 are done, formalise the narrow interface that extracted modules depend on.
This enables mock-based unit testing of individual modules.

**Status:** Not started

---

## Progress log

| Date       | Phase   | Notes                                                                                                                                  |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-01 | Phase 1 | Extracted tree-types.ts (101 L), tree-utils.ts (135 L), tracing.ts (130 L). ExecutionTree.ts 1997→1768 lines. 621 unit + all e2e pass. |
