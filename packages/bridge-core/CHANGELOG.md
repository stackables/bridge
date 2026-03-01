# @stackables/bridge-core

## 1.1.0

### Minor Changes

- 2831fba: Engine hardening & resource exhaustion defenses

  - **Tool timeout**: `callTool` now races tool invocations against a configurable `toolTimeoutMs` (default: 15 seconds). Hanging tools throw `BridgeTimeoutError`, freeing the engine thread.
  - **Bounded tracing**: `TraceCollector` replaces `structuredClone` with a `boundedClone` utility that truncates arrays, strings, and deep objects to prevent OOM when tracing large payloads. Configurable via `maxArrayItems`, `maxStringLength`, and `cloneDepth`.
  - **Abort discipline**: `resolveWiresAsync` and `createShadowArray` now check `signal.aborted` and throw `BridgeAbortError` to halt execution immediately when a client disconnects.
  - **Strict constant parsing**: `coerceConstant` no longer uses `JSON.parse`. Strictly handles boolean, null, numeric, and quoted-string literals.
  - **setNested guard**: Throws if asked to assign a nested path through a primitive (string, number, etc.).
  - **Configurable limits**: `toolTimeoutMs` and `maxDepth` are now configurable via `ExecuteBridgeOptions` and `BridgeOptions`, with sensible defaults (15s timeout, depth 30).

## 1.0.4

### Patch Changes

- ab248d7: Readability refactoring of the execution engine (no behaviour change):

  - Switched engine-internal caches on `NodeRef` and the pull-wire variant of `Wire` to symbol-keyed storage (for example, `TRUNK_KEY_CACHE` and `SIMPLE_PULL_CACHE`), eliminating `(as any)` casts that previously looked like unsafe mutations of AST nodes
  - Extracted `createShadowArray()` — removes 3 identical `BREAK_SYM`/`CONTINUE_SYM`/`shadow()` loops in `pullOutputField`, `response`, and the define-field path
  - Extracted `planShadowOutput()` — separates the wire-classification (planner) phase of `materializeShadows` from the execution loop, so each method has a single clear responsibility
  - Extracted `evaluateWireSource()` — moves the 80-line `cond`/`condAnd`/`condOr`/`from` dispatch block out of `resolveWiresAsync`; the main loop now reads as four sequential layers: evaluate → falsy gate → nullish gate → catch
  - Extracted `pullSafe()` — de-duplicates the safe-navigation `.catch()` guard shared by `condAnd` and `condOr` evaluation

- ab248d7: Refactor Phase 1: Extract utility helpers from ExecutionTree.ts into focused modules

  - `tree-types.ts` — Error classes, sentinels, type aliases (`MaybePromise`, `Trunk`, `Logger`, `Path`), and lightweight helpers (`isPromise`, `isFatalError`, `applyControlFlow`)
  - `tree-utils.ts` — Pure utility functions (`trunkKey`, `sameTrunk`, `pathEquals`, `coerceConstant`, `setNested`, `getSimplePullRef`, `roundMs`)
  - `tracing.ts` — OpenTelemetry instrumentation (`TraceCollector`, `ToolTrace`, `TraceLevel`, `otelTracer`, metric counters/histograms)

  ExecutionTree re-exports all symbols so the public API is unchanged.

- ab248d7: Refactor Phase 2: Define TreeContext interface and extract wire resolution

  - Added `TreeContext` interface to `tree-types.ts` — narrow contract for extracted modules
  - Created `resolveWires.ts` — wire resolution logic (`resolveWires`, `resolveWiresAsync`, `evaluateWireSource`, `pullSafe`) as free functions taking `TreeContext`
  - `ExecutionTree` now implements `TreeContext`; `pullSingle` is public to satisfy the interface

  Zero behaviour change — all unit and e2e tests pass unchanged.

- ab248d7: Refactor Phase 3: Extract tool lookup into `toolLookup.ts`

  - Created `toolLookup.ts` (310 lines) with `ToolLookupContext` interface and free functions: `lookupToolFn`, `resolveToolDefByName`, `resolveToolWires`, `resolveToolSource`, `resolveToolDep`
  - `ExecutionTree` delegates via one-line wrapper methods; `callTool` made public to satisfy the context interface
  - Exposed `toolFns`, `toolDefCache`, `toolDepCache`, `context`, `parent`, and `instructions` getter for extracted modules
  - ExecutionTree reduced from 1599 → 1448 lines

  Zero behaviour change — all 621 unit tests and 35 e2e tests pass unchanged.

- ab248d7: Refactor Phase 4: Extract materializer into `materializeShadows.ts`

  - Created `materializeShadows.ts` (247 lines) with `MaterializerHost` and `MaterializableShadow` interfaces plus free functions: `planShadowOutput`, `materializeShadows`
  - `ExecutionTree` delegates via a single one-line `materializeShadows` wrapper
  - ExecutionTree reduced from 1446 → 1265 lines

  Zero behaviour change — all 621 unit tests and 35 e2e tests pass unchanged.

- ab248d7: Refactor Phase 5: Extract scheduler into `scheduleTools.ts`

  - Created `scheduleTools.ts` (324 lines) with `SchedulerContext` interface plus free functions: `schedule`, `scheduleFinish`, `scheduleToolDef`
  - `ExecutionTree` delegates via a single one-line `schedule` wrapper
  - Removed 5 private delegation methods (`getToolName`, `lookupToolFn`, `resolveToolDefByName`, `resolveToolWires`, `resolveToolSource`) — scheduler calls `toolLookup.ts` functions directly
  - Made `pipeHandleMap`, `handleVersionMap`, `resolveWires` public to satisfy `SchedulerContext`
  - ExecutionTree reduced from 1265 → 1018 lines

  Zero behaviour change — all 621 unit tests and 35 e2e tests pass unchanged.

## 1.0.3

### Patch Changes

- 8e4ce59: Unintended tsconfig change broke package exports.
- Updated dependencies [8e4ce59]
  - @stackables/bridge-stdlib@1.5.1
  - @stackables/bridge-types@1.0.1

## 1.0.2

### Patch Changes

- a92f7de: Fix JSONObject/JSON scalar fields dumping the full ExecutionTree instead of the resolved output object
- 2023592: Performance: execution engine optimisations (up to +1055% on arrays, +48–57% on tool chains, +35% passthrough)

  - Lightweight shadow tree construction — bypass constructor for per-element shadow trees, copying pre-computed fields from parent instead of re-deriving them (+5–7% on array benchmarks)
  - Skip OpenTelemetry span overhead when no tracer is configured — lazy-probe once on first tool call, take a direct fast path when OTel is no-op (+7–9% on tool-heavy benchmarks)
  - Pre-group element wires once per `materializeShadows` call instead of re-filtering per element per field
  - Flatten nested `Promise.all(N × Promise.all(F))` to a single flat `Promise.all(N×F)` for direct-field arrays, eliminating microtask scheduling overhead (+44–130% on flat arrays, +14–43% on nested arrays)
  - Maybe-Async sync fast path — `pullSingle` returns synchronously when value is already in state, `resolveWires` detects single no-modifier wires and skips async entirely, `materializeShadows` avoids `Promise.all` when all values are synchronous; eliminates 6000–7000 microtask queue entries per 1000-element array (+42–114% on array benchmarks, +8–19% across all benchmarks)
  - Pre-compute keys and cache wire tags — cache `trunkKey` on NodeRef objects via `??=`, hoist pathKey computation out of N×F loop, cache simple-pull-wire detection on wire objects, cap `constantCache` at 10K entries (+60–129% on arrays, +4–16% across all benchmarks)
  - De-async `schedule()` and `callTool()` — `schedule` returns `MaybePromise` for targets without a ToolDef, `callTool` drops the `async` keyword so sync internal tools return synchronously; eliminates 2 microtask hops per tool call (+11–18% on tool-calling benchmarks, +15% on simple chain)
  - Cache element trunk key — pre-compute `trunkKey({ ...trunk, element: true })` once per tree instead of per call
  - Cache `coerceConstant()` results — module-level Map avoids redundant JSON.parse across shadow trees
  - Replace `pathEquals` `.every()` with a manual for-loop

## 1.0.1

### Patch Changes

- 56d17e3: Fix `executeBridge` returning `undefined` for nested object fields defined via scope blocks (`o.field { .sub <- ... }`).

  Previously, `run()` only resolved top-level output fields with exact path matches. Wires produced by scope blocks (e.g. `o.why { .temperature <- api.deg }`) have paths like `["why", "temperature"]`, so `pullOutputField(["why"])` found nothing and returned `undefined`.

  The fix builds nested output objects recursively: when no exact wire matches a field path, it collects all deeper-path wires under that prefix and assembles the nested object, matching the behaviour already available in the GraphQL resolver path.

## 1.0.0

### Major Changes

- 021d52c: Release split packages as 1.0

### Minor Changes

- ca1c3e8: Wrap compiler output in a `BridgeDocument` type (`{ version?: string; instructions: Instruction[] }`) instead of returning a bare `Instruction[]`. This lifts the version declaration to a document-level field and removes `VersionDecl` from the `Instruction` union.

  **Breaking changes:**

  - `parseBridge()` and `parseBridgeDiagnostics()` now return `BridgeDocument` (an object) instead of `Instruction[]`
  - `executeBridge()` accepts `{ document }` instead of `{ instructions }`
  - `bridgeTransform()` accepts `DocumentSource` (renamed from `InstructionSource`)
  - `VersionDecl` is no longer part of the `Instruction` discriminated union

  **Migration:** Replace `parseBridge(src)` array usage with `parseBridge(src).instructions`. Update `executeBridge({ instructions })` calls to `executeBridge({ document })`. Rename `InstructionSource` imports to `DocumentSource`. Use `mergeBridgeDocuments()` instead of manual instruction array spreading when composing multiple bridge files.

- ca1c3e8: Add `@version` syntax to `with` statements for tool versioning. Bridge handles and tool dependencies can now include a version tag (e.g., `with geocoder@2.1 as geo`) that is stored as metadata on the binding and preserved through parse → serialize round-trips.

  The `version` header now accepts any minor version within the same major (e.g., `version 1.7` on a `1.x` parser). A `VersionDecl` instruction is emitted in the AST, and the engine validates at runtime that the installed standard library satisfies the bridge file's declared minimum version — producing a clear error message when a newer std is needed.

  **Versioned tool validation & injection:** Handles with `@version` tags are validated at startup. For `std.*` tools, the bundled std version is checked; for custom tools, user must provide a versioned tool key (e.g., `"myApi.getData@2.0": fn`). The engine prefers versioned tool functions when available, enabling side-by-side version coexistence. The language service emits warnings for `@version` tags exceeding the bundled std.

  **Versioned namespace keys:** Tools can be provided with versioned namespace keys (e.g., `"std@1.5": { str: {...} }` or `"std.arr@1.7": { toArray: fn }`) in the tools map. The engine resolves versioned handles through namespace traversal, trying successively broader namespace keys (e.g., `"std.str@999.1"` then `"std@999.1"`).

  **Cross-major version support:** The parser declares a supported version range (`PARSER_VERSION.minMajor` – `PARSER_VERSION.maxMajor`) instead of a single major. When the bundled std is incompatible with a bridge file's version, `resolveStd()` scans the tools map for a matching `"std@X.Y"` namespace key. Error messages guide users to provide a compatible std in the tools map.

### Patch Changes

- 597ed33: Add infinite loop protection to the execution engine:

  - **Depth ceiling**: Shadow tree nesting is capped at 30 levels. Exceeding this limit throws a `BridgePanicError`, preventing infinite recursion from circular array mappings or deeply nested tool chains.
  - **Cycle detection**: The pull chain now tracks which trunks are actively being resolved. If a trunk is encountered again in its own resolution path (e.g. Tool A → Tool B → Tool A), a `BridgePanicError` is thrown immediately instead of silently deadlocking.

- Updated dependencies [021d52c]
- Updated dependencies [5627153]
- Updated dependencies [ca1c3e8]
  - @stackables/bridge-types@1.0.0
  - @stackables/bridge-stdlib@1.5.0

## 0.0.1

### Patch Changes

- cbe3564: Split into targeted pacakges
- Updated dependencies [cbe3564]
  - @stackables/bridge-stdlib@0.0.1
  - @stackables/bridge-types@0.0.1
