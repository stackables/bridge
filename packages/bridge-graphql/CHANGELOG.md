# @stackables/bridge-graphql

## 1.2.4

### Patch Changes

- Updated dependencies [[`848282b`](https://github.com/stackables/bridge/commit/848282b28f506a77128c4645c874f0099dfd7dac)]:
  - @stackables/bridge-core@1.7.0

## 1.2.3

### Patch Changes

- Updated dependencies [[`8da19e8`](https://github.com/stackables/bridge/commit/8da19e878fefa67860666bef8ee8f93375ee35d7)]:
  - @stackables/bridge-core@1.6.2

## 1.2.2

### Patch Changes

- Updated dependencies [[`d6907a2`](https://github.com/stackables/bridge/commit/d6907a2d263f9f23397e2073dc5f0a2bd7248062)]:
  - @stackables/bridge-core@1.6.1

## 1.2.1

### Patch Changes

- [#111](https://github.com/stackables/bridge/pull/111) [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942) Thanks [@aarne](https://github.com/aarne)! - Move Bridge source metadata onto BridgeDocument.

  Parsed documents now retain their original source text automatically, and can
  optionally carry a filename from parse time. Runtime execution, compiler
  fallbacks, GraphQL execution, and playground formatting now read that metadata
  from the document instead of requiring callers to thread source and filename
  through execute options.

- Updated dependencies [[`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942), [`375e2b0`](https://github.com/stackables/bridge/commit/375e2b08a16f670cded3aba7d6e2ee52254eab1c), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942), [`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942)]:
  - @stackables/bridge-core@1.6.0
  - @stackables/bridge-stdlib@1.5.3

## 1.2.0

### Minor Changes

- [#104](https://github.com/stackables/bridge/pull/104) [`b213e9f`](https://github.com/stackables/bridge/commit/b213e9f49ed5da80e7d9a1b9e161586e59b3719c) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Support optional lookahead resolver with compiler

### Patch Changes

- Updated dependencies [[`b213e9f`](https://github.com/stackables/bridge/commit/b213e9f49ed5da80e7d9a1b9e161586e59b3719c), [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60), [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60), [`2243c7e`](https://github.com/stackables/bridge/commit/2243c7e7fd23a37c30118e713ae348b833c523fe), [`8e5b2e2`](https://github.com/stackables/bridge/commit/8e5b2e21796cfd7e9a9345225d94ceb8bfc39bac)]:
  - @stackables/bridge-core@1.5.0
  - @stackables/bridge-stdlib@1.5.2

## 1.1.4

### Patch Changes

- Updated dependencies [[`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f)]:
  - @stackables/bridge-core@1.4.0

## 1.1.3

### Patch Changes

- Updated dependencies [[`fc3d8ed`](https://github.com/stackables/bridge/commit/fc3d8ed392c3dd8181c2eef124585a2e43ea0499)]:
  - @stackables/bridge-core@1.3.0

## 1.1.2

### Patch Changes

- Updated dependencies [[`cf5cd2e`](https://github.com/stackables/bridge/commit/cf5cd2e40e6339fb3e896e05dbdbe66b0b5d77a9)]:
  - @stackables/bridge-core@1.2.0

## 1.1.1

### Patch Changes

- Updated dependencies [e953c93]
  - @stackables/bridge-core@1.1.1

## 1.1.0

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

## 1.0.4

### Patch Changes

- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
- Updated dependencies [ab248d7]
  - @stackables/bridge-core@1.0.4

## 1.0.3

### Patch Changes

- 8e4ce59: Unintended tsconfig change broke package exports.
- Updated dependencies [8e4ce59]
  - @stackables/bridge-stdlib@1.5.1
  - @stackables/bridge-core@1.0.3

## 1.0.2

### Patch Changes

- a92f7de: Fix JSONObject/JSON scalar fields dumping the full ExecutionTree instead of the resolved output object
- Updated dependencies [a92f7de]
- Updated dependencies [2023592]
  - @stackables/bridge-core@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies [56d17e3]
  - @stackables/bridge-core@1.0.1

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

- Updated dependencies [ca1c3e8]
- Updated dependencies [597ed33]
- Updated dependencies [021d52c]
- Updated dependencies [5627153]
- Updated dependencies [ca1c3e8]
  - @stackables/bridge-core@1.0.0
  - @stackables/bridge-stdlib@1.5.0

## 0.0.1

### Patch Changes

- cbe3564: Split into targeted pacakges
- Updated dependencies [cbe3564]
  - @stackables/bridge-stdlib@0.0.1
  - @stackables/bridge-core@0.0.1
