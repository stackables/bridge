# @stackables/bridge-parser

## 1.3.0

### Minor Changes

- [#96](https://github.com/stackables/bridge/pull/96) [`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f) Thanks [@aarne](https://github.com/aarne)! - Migrate wire shape from separate `falsyFallback*`/`nullishFallback*` properties to a unified `fallbacks: WireFallback[]` array, enabling mixed `||` and `??` chains in any order (e.g. `A ?? B || C ?? D`).

### Patch Changes

- [#94](https://github.com/stackables/bridge/pull/94) [`93bbb94`](https://github.com/stackables/bridge/commit/93bbb9453d4f8babbcdeed352a37a92d8ef8aa7e) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Fix chained `||` literal fallback parsing so authored left-to-right short-circuiting is preserved after safe pulls (`?.`), and add regression coverage for mixed `||` + `??` chains.

- Updated dependencies [[`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f)]:
  - @stackables/bridge-core@1.4.0

## 1.2.0

### Minor Changes

- [#86](https://github.com/stackables/bridge/pull/86) [`fc3d8ed`](https://github.com/stackables/bridge/commit/fc3d8ed392c3dd8181c2eef124585a2e43ea0499) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Support object spread in path-scoped scope blocks

### Patch Changes

- Updated dependencies [[`fc3d8ed`](https://github.com/stackables/bridge/commit/fc3d8ed392c3dd8181c2eef124585a2e43ea0499)]:
  - @stackables/bridge-core@1.3.0

## 1.1.1

### Patch Changes

- [#84](https://github.com/stackables/bridge/pull/84) [`837ec1c`](https://github.com/stackables/bridge/commit/837ec1cc74c0a76e205d818b94c33b4c28e3628d) Thanks [@aarne](https://github.com/aarne)! - Fix several AOT compiler/runtime parity bugs discovered via fuzzing:

  - Fix `condAnd` and `condOr` code generation to match runtime boolean semantics.
  - Fix nullish fallback chaining so `??` handling matches runtime overdefinition boundaries.
  - Fix overdefinition precedence so the first constant wire remains terminal, matching runtime behavior.
  - Fix `serializeBridge` quoting for empty-string and slash-only string constants so parse/serialize/parse round-trips remain valid.
  - Add deterministic regression coverage for these parity cases to prevent regressions.

- Updated dependencies [[`cf5cd2e`](https://github.com/stackables/bridge/commit/cf5cd2e40e6339fb3e896e05dbdbe66b0b5d77a9)]:
  - @stackables/bridge-core@1.2.0

## 1.1.0

### Minor Changes

- [#78](https://github.com/stackables/bridge/pull/78) [`ce6cb8a`](https://github.com/stackables/bridge/commit/ce6cb8a8e6e8288e8ab73f7ce44d14b205c70c91) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Rename `@stackables/bridge-compiler` to `@stackables/bridge-parser` (parser, serializer, language service). The new `@stackables/bridge-compiler` package compiles BridgeDocument into optimized JavaScript code with abort signal support, tool timeout, and full language feature parity.

  bridge-parser first release will continue from current bridge-compiler version 1.0.6. New version of bridge-compiler will jump to 2.0.0 to mark a breaking change in the package purpose

## 1.0.6

### Patch Changes

- Updated dependencies [e953c93]
  - @stackables/bridge-core@1.1.1

## 1.0.5

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
