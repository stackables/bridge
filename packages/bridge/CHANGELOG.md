# @stackables/bridge

## 2.1.3

### Patch Changes

- Updated dependencies [[`837ec1c`](https://github.com/stackables/bridge/commit/837ec1cc74c0a76e205d818b94c33b4c28e3628d), [`cf5cd2e`](https://github.com/stackables/bridge/commit/cf5cd2e40e6339fb3e896e05dbdbe66b0b5d77a9)]:
  - @stackables/bridge-parser@1.1.1
  - @stackables/bridge-core@1.2.0
  - @stackables/bridge-graphql@1.1.2

## 2.1.2

### Patch Changes

- Updated dependencies [[`ce6cb8a`](https://github.com/stackables/bridge/commit/ce6cb8a8e6e8288e8ab73f7ce44d14b205c70c91)]:
  - @stackables/bridge-parser@1.1.0

## 2.1.1

### Patch Changes

- Updated dependencies [e953c93]
  - @stackables/bridge-core@1.1.1
  - @stackables/bridge-compiler@1.0.6
  - @stackables/bridge-graphql@1.1.1

## 2.1.0

### Minor Changes

- 2831fba: Engine hardening & resource exhaustion defenses

  - **Tool timeout**: `callTool` now races tool invocations against a configurable `toolTimeoutMs` (default: 15 seconds). Hanging tools throw `BridgeTimeoutError`, freeing the engine thread.
  - **Bounded tracing**: `TraceCollector` replaces `structuredClone` with a `boundedClone` utility that truncates arrays, strings, and deep objects to prevent OOM when tracing large payloads. Configurable via `maxArrayItems`, `maxStringLength`, and `cloneDepth`.
  - **Abort discipline**: `resolveWiresAsync` and `createShadowArray` now check `signal.aborted` and throw `BridgeAbortError` to halt execution immediately when a client disconnects.
  - **Strict constant parsing**: `coerceConstant` no longer uses `JSON.parse`. Strictly handles boolean, null, numeric, and quoted-string literals.
  - **setNested guard**: Throws if asked to assign a nested path through a primitive (string, number, etc.).
  - **Configurable limits**: `toolTimeoutMs` and `maxDepth` are now configurable via `ExecuteBridgeOptions` and `BridgeOptions`, with sensible defaults (15s timeout, depth 30).

### Patch Changes

- Updated dependencies [2831fba]
  - @stackables/bridge-core@1.1.0
  - @stackables/bridge-graphql@1.1.0
  - @stackables/bridge-compiler@1.0.5

## 2.0.4

### Patch Changes

- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
  - @stackables/bridge-core@1.0.4
  - @stackables/bridge-compiler@1.0.4
  - @stackables/bridge-graphql@1.0.4

## 2.0.3

### Patch Changes

- 8e4ce59: Unintended tsconfig change broke package exports.
- Updated dependencies [8e4ce59]
  - @stackables/bridge-compiler@1.0.3
  - @stackables/bridge-graphql@1.0.3
  - @stackables/bridge-stdlib@1.5.1
  - @stackables/bridge-core@1.0.3

## 2.0.2

### Patch Changes

- Updated dependencies [a92f7de]
- Updated dependencies [2023592]
  - @stackables/bridge-core@1.0.2
  - @stackables/bridge-graphql@1.0.2
  - @stackables/bridge-compiler@1.0.2

## 2.0.1

### Patch Changes

- 56d17e3: Fix `executeBridge` returning `undefined` for nested object fields defined via scope blocks (`o.field { .sub <- ... }`).

  Previously, `run()` only resolved top-level output fields with exact path matches. Wires produced by scope blocks (e.g. `o.why { .temperature <- api.deg }`) have paths like `["why", "temperature"]`, so `pullOutputField(["why"])` found nothing and returned `undefined`.

  The fix builds nested output objects recursively: when no exact wire matches a field path, it collects all deeper-path wires under that prefix and assembles the nested object, matching the behaviour already available in the GraphQL resolver path.

- Updated dependencies [56d17e3]
  - @stackables/bridge-core@1.0.1
  - @stackables/bridge-compiler@1.0.1
  - @stackables/bridge-graphql@1.0.1

## 2.0.0

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

- 5627153: Remove `std.assert` from the standard library. The tool is redundant with the `|| throw` and `?? throw` language syntax, which provides more expressive inline validation. Use `value <- source || throw "message"` instead.
- ca1c3e8: Add `@version` syntax to `with` statements for tool versioning. Bridge handles and tool dependencies can now include a version tag (e.g., `with geocoder@2.1 as geo`) that is stored as metadata on the binding and preserved through parse → serialize round-trips.

  The `version` header now accepts any minor version within the same major (e.g., `version 1.7` on a `1.x` parser). A `VersionDecl` instruction is emitted in the AST, and the engine validates at runtime that the installed standard library satisfies the bridge file's declared minimum version — producing a clear error message when a newer std is needed.

  **Versioned tool validation & injection:** Handles with `@version` tags are validated at startup. For `std.*` tools, the bundled std version is checked; for custom tools, user must provide a versioned tool key (e.g., `"myApi.getData@2.0": fn`). The engine prefers versioned tool functions when available, enabling side-by-side version coexistence. The language service emits warnings for `@version` tags exceeding the bundled std.

  **Versioned namespace keys:** Tools can be provided with versioned namespace keys (e.g., `"std@1.5": { str: {...} }` or `"std.arr@1.7": { toArray: fn }`) in the tools map. The engine resolves versioned handles through namespace traversal, trying successively broader namespace keys (e.g., `"std.str@999.1"` then `"std@999.1"`).

  **Cross-major version support:** The parser declares a supported version range (`PARSER_VERSION.minMajor` – `PARSER_VERSION.maxMajor`) instead of a single major. When the bundled std is incompatible with a bridge file's version, `resolveStd()` scans the tools map for a matching `"std@X.Y"` namespace key. Error messages guide users to provide a compatible std in the tools map.

### Patch Changes

- 597ed33: Add infinite loop protection to the execution engine:

  - **Depth ceiling**: Shadow tree nesting is capped at 30 levels. Exceeding this limit throws a `BridgePanicError`, preventing infinite recursion from circular array mappings or deeply nested tool chains.
  - **Cycle detection**: The pull chain now tracks which trunks are actively being resolved. If a trunk is encountered again in its own resolution path (e.g. Tool A → Tool B → Tool A), a `BridgePanicError` is thrown immediately instead of silently deadlocking.

- Updated dependencies [ca1c3e8]
- Updated dependencies [597ed33]
- Updated dependencies [021d52c]
- Updated dependencies [5627153]
- Updated dependencies [ca1c3e8]
  - @stackables/bridge-compiler@1.0.0
  - @stackables/bridge-core@1.0.0
  - @stackables/bridge-graphql@1.0.0
  - @stackables/bridge-stdlib@1.5.0

## 1.22.1

### Patch Changes

- Updated dependencies [cbe3564]
  - @stackables/bridge-compiler@0.0.1
  - @stackables/bridge-graphql@0.0.1
  - @stackables/bridge-stdlib@0.0.1
  - @stackables/bridge-core@0.0.1
