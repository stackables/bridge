# @stackables/bridge

## 2.3.0

### Minor Changes

- [#112](https://github.com/stackables/bridge/pull/112) [`375e2b0`](https://github.com/stackables/bridge/commit/375e2b08a16f670cded3aba7d6e2ee52254eab1c) Thanks [@aarne](https://github.com/aarne)! - Improve native batched tool authoring by documenting the feature, exporting dedicated batch tool types, and simplifying the batch contract to plain input arrays.

  Batch tools now receive `Input[]` and must return `Output[]` in matching order. Batched tool tracing and logging are also emitted once per flushed batch call instead of once per queued item.

  Native batching now works in compiled execution as well as the runtime interpreter. Batch tools can also signal partial failures by returning an `Error` at a specific result index, which rejects only that item and allows normal wire-level `catch` fallbacks to handle it.

### Patch Changes

- [#108](https://github.com/stackables/bridge/pull/108) [`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339) Thanks [@aarne](https://github.com/aarne)! - Add memoized tool handles with compiler support.

  Bridge `with` declarations now support `memoize` for tool handles, including
  loop-scoped tool handles inside array mappings. Memoized handles reuse the same
  result for repeated calls with identical inputs, and each declared handle keeps
  its own cache.

  The AOT compiler now compiles memoized tool handles too, including loop-scoped
  tool handles inside array mappings. Compiled execution preserves request-scoped
  caching semantics and reuses results for repeated calls with identical inputs.

- [#111](https://github.com/stackables/bridge/pull/111) [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942) Thanks [@aarne](https://github.com/aarne)! - Move Bridge source metadata onto BridgeDocument.

  Parsed documents now retain their original source text automatically, and can
  optionally carry a filename from parse time. Runtime execution, compiler
  fallbacks, GraphQL execution, and playground formatting now read that metadata
  from the document instead of requiring callers to thread source and filename
  through execute options.

- [#111](https://github.com/stackables/bridge/pull/111) [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942) Thanks [@aarne](https://github.com/aarne)! - Improve formatted runtime errors for missing tools and source underlines.

  `No tool found for "..."` and missing registered tool-function errors now carry
  Bridge source locations when they originate from authored bridge wires, so
  formatted errors include the filename, line, and highlighted source span.
  Control-flow throw fallbacks now preserve their own source span, so
  `?? throw "..."` highlights only the throw clause instead of the whole wire.
  Caret underlines now render the full inclusive source span instead of stopping
  one character short.

- [#111](https://github.com/stackables/bridge/pull/111) [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942) Thanks [@aarne](https://github.com/aarne)! - Fix segment-local `?.` traversal so later strict path segments still fail after a guarded null hop, and preserve source formatting for `panic` control-flow errors.

- [#108](https://github.com/stackables/bridge/pull/108) [`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339) Thanks [@aarne](https://github.com/aarne)! - Fix strict nested scope resolution for array mappings.

  Nested scopes can now read iterator aliases from visible parent scopes while
  still resolving overlapping names to the nearest inner scope. This also keeps
  invalid nested tool input wiring rejected during parsing.

- [#111](https://github.com/stackables/bridge/pull/111) [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942) Thanks [@aarne](https://github.com/aarne)! - Improve runtime error source mapping for ternary conditions and strict path traversal.

  Runtime and compiled execution now preserve clause-level source spans for ternary conditions and branches, so formatted errors can highlight only the failing condition or selected branch instead of the whole wire.
  Strict path traversal also now fails consistently on primitive property access in both runtime and AOT execution, keeping error messages and behavior aligned.

- Updated dependencies [[`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942), [`375e2b0`](https://github.com/stackables/bridge/commit/375e2b08a16f670cded3aba7d6e2ee52254eab1c), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942), [`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339), [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942)]:
  - @stackables/bridge-core@1.6.0
  - @stackables/bridge-parser@1.4.1
  - @stackables/bridge-graphql@1.2.1
  - @stackables/bridge-stdlib@1.5.3

## 2.2.1

### Patch Changes

- Updated dependencies [[`b213e9f`](https://github.com/stackables/bridge/commit/b213e9f49ed5da80e7d9a1b9e161586e59b3719c), [`b213e9f`](https://github.com/stackables/bridge/commit/b213e9f49ed5da80e7d9a1b9e161586e59b3719c), [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60), [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60), [`2243c7e`](https://github.com/stackables/bridge/commit/2243c7e7fd23a37c30118e713ae348b833c523fe), [`8e5b2e2`](https://github.com/stackables/bridge/commit/8e5b2e21796cfd7e9a9345225d94ceb8bfc39bac)]:
  - @stackables/bridge-parser@1.4.0
  - @stackables/bridge-core@1.5.0
  - @stackables/bridge-graphql@1.2.0
  - @stackables/bridge-stdlib@1.5.2

## 2.2.0

### Minor Changes

- [#96](https://github.com/stackables/bridge/pull/96) [`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f) Thanks [@aarne](https://github.com/aarne)! - Migrate wire shape from separate `falsyFallback*`/`nullishFallback*` properties to a unified `fallbacks: WireFallback[]` array, enabling mixed `||` and `??` chains in any order (e.g. `A ?? B || C ?? D`).

### Patch Changes

- [#94](https://github.com/stackables/bridge/pull/94) [`93bbb94`](https://github.com/stackables/bridge/commit/93bbb9453d4f8babbcdeed352a37a92d8ef8aa7e) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Fix chained `||` literal fallback parsing so authored left-to-right short-circuiting is preserved after safe pulls (`?.`), and add regression coverage for mixed `||` + `??` chains.

- Updated dependencies [[`93bbb94`](https://github.com/stackables/bridge/commit/93bbb9453d4f8babbcdeed352a37a92d8ef8aa7e), [`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f)]:
  - @stackables/bridge-parser@1.3.0
  - @stackables/bridge-core@1.4.0
  - @stackables/bridge-graphql@1.1.4

## 2.1.4

### Patch Changes

- Updated dependencies [[`fc3d8ed`](https://github.com/stackables/bridge/commit/fc3d8ed392c3dd8181c2eef124585a2e43ea0499)]:
  - @stackables/bridge-parser@1.2.0
  - @stackables/bridge-core@1.3.0
  - @stackables/bridge-graphql@1.1.3

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
