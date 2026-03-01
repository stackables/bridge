# @stackables/bridge-core

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
