# @stackables/bridge-stdlib

## 1.5.2

### Patch Changes

- [#103](https://github.com/stackables/bridge/pull/103) [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60) Thanks [@aarne](https://github.com/aarne)! - Fix `filter`, `find`, `toLowerCase`, `toUpperCase`, `trim`, and `length` crashing on unexpected input types

- [#100](https://github.com/stackables/bridge/pull/100) [`8e5b2e2`](https://github.com/stackables/bridge/commit/8e5b2e21796cfd7e9a9345225d94ceb8bfc39bac) Thanks [@aarne](https://github.com/aarne)! - Add `ToolMetadata` — per-tool observability controls

  Tools can now attach a `.bridge` property to declare how the engine should
  instrument them, imported as `ToolMetadata` from `@stackables/bridge`.

  ```ts
  import type { ToolMetadata } from "@stackables/bridge";

  myTool.bridge = {
    trace: false, // skip OTel span for this tool
    log: {
      execution: "info", // log successful calls at info level
      errors: "error", // log failures at error level (default)
    },
  } satisfies ToolMetadata;
  ```

- Updated dependencies [[`8e5b2e2`](https://github.com/stackables/bridge/commit/8e5b2e21796cfd7e9a9345225d94ceb8bfc39bac)]:
  - @stackables/bridge-types@1.1.0

## 1.5.1

### Patch Changes

- 8e4ce59: Unintended tsconfig change broke package exports.
- Updated dependencies [8e4ce59]
  - @stackables/bridge-types@1.0.1

## 1.5.0

### Minor Changes

- 5627153: Remove `std.assert` from the standard library. The tool is redundant with the `|| throw` and `?? throw` language syntax, which provides more expressive inline validation. Use `value <- source || throw "message"` instead.
- ca1c3e8: Add `@version` syntax to `with` statements for tool versioning. Bridge handles and tool dependencies can now include a version tag (e.g., `with geocoder@2.1 as geo`) that is stored as metadata on the binding and preserved through parse → serialize round-trips.

  The `version` header now accepts any minor version within the same major (e.g., `version 1.7` on a `1.x` parser). A `VersionDecl` instruction is emitted in the AST, and the engine validates at runtime that the installed standard library satisfies the bridge file's declared minimum version — producing a clear error message when a newer std is needed.

  **Versioned tool validation & injection:** Handles with `@version` tags are validated at startup. For `std.*` tools, the bundled std version is checked; for custom tools, user must provide a versioned tool key (e.g., `"myApi.getData@2.0": fn`). The engine prefers versioned tool functions when available, enabling side-by-side version coexistence. The language service emits warnings for `@version` tags exceeding the bundled std.

  **Versioned namespace keys:** Tools can be provided with versioned namespace keys (e.g., `"std@1.5": { str: {...} }` or `"std.arr@1.7": { toArray: fn }`) in the tools map. The engine resolves versioned handles through namespace traversal, trying successively broader namespace keys (e.g., `"std.str@999.1"` then `"std@999.1"`).

  **Cross-major version support:** The parser declares a supported version range (`PARSER_VERSION.minMajor` – `PARSER_VERSION.maxMajor`) instead of a single major. When the bundled std is incompatible with a bridge file's version, `resolveStd()` scans the tools map for a matching `"std@X.Y"` namespace key. Error messages guide users to provide a compatible std in the tools map.

### Patch Changes

- 021d52c: Release split packages as 1.0
- Updated dependencies [021d52c]
  - @stackables/bridge-types@1.0.0

## 0.0.1

### Patch Changes

- cbe3564: Split into targeted pacakges
- Updated dependencies [cbe3564]
  - @stackables/bridge-types@0.0.1
