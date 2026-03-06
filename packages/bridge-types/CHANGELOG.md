# @stackables/bridge-types

## 1.1.0

### Minor Changes

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

## 1.0.1

### Patch Changes

- 8e4ce59: Unintended tsconfig change broke package exports.

## 1.0.0

### Major Changes

- 021d52c: Release split packages as 1.0

## 0.0.1

### Patch Changes

- cbe3564: Split into targeted pacakges
