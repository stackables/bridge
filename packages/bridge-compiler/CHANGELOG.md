# @stackables/bridge-compiler

## 2.2.0

### Minor Changes

- [#86](https://github.com/stackables/bridge/pull/86) [`fc3d8ed`](https://github.com/stackables/bridge/commit/fc3d8ed392c3dd8181c2eef124585a2e43ea0499) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Support object spread in path-scoped scope blocks

### Patch Changes

- Updated dependencies [[`fc3d8ed`](https://github.com/stackables/bridge/commit/fc3d8ed392c3dd8181c2eef124585a2e43ea0499)]:
  - @stackables/bridge-core@1.3.0

## 2.1.0

### Minor Changes

- [#82](https://github.com/stackables/bridge/pull/82) [`cf5cd2e`](https://github.com/stackables/bridge/commit/cf5cd2e40e6339fb3e896e05dbdbe66b0b5d77a9) Thanks [@aarne](https://github.com/aarne)! - Add `requestedFields` option to `executeBridge()` for sparse fieldset filtering.

  When provided, only the listed output fields (and their transitive tool dependencies) are resolved.
  Tools that feed exclusively into unrequested fields are never called, reducing latency and upstream
  bandwidth.

  Supports dot-separated paths and a trailing wildcard (`["id", "price", "legs.*"]`).

### Patch Changes

- [`badbb78`](https://github.com/stackables/bridge/commit/badbb7859e270ea6c82ca8c4a5132f254fca9978) Thanks [@aarne](https://github.com/aarne)! - Fix three code generation bugs that caused `SyntaxError: await is only valid in async functions` when array mappings combined `catch` fallbacks or element-scoped tools with control flow.

  - **Bug 1 – catch inside array `.map()`:** `needsAsync` only checked for element-scoped tool calls. Wires with `catch` fallbacks or `catch` control flow that fall back to an async IIFE now also trigger the async `for...of` loop path.

  - **Bug 2 – element-scoped tool inside `.flatMap()`:** When a `?? continue` (or similar) control flow was detected first, the compiler unconditionally emitted `.flatMap()`. If the same loop also contained an element-scoped tool (`alias tool:iter`), the `await __call(...)` was placed inside a synchronous `.flatMap()` callback. `needsAsync` is now evaluated before the control-flow check, and when true, a `for...of` loop with a native `continue` statement is emitted instead.

  - **Bug 3 – nested sub-array async blindspot:** The inner sub-array handler in `buildElementBody` never calculated `needsAsync`, always falling back to a synchronous `.map()`. It now uses the same async `for...of` IIFE pattern when inner wires contain element-scoped tools or catch expressions.

- [#84](https://github.com/stackables/bridge/pull/84) [`837ec1c`](https://github.com/stackables/bridge/commit/837ec1cc74c0a76e205d818b94c33b4c28e3628d) Thanks [@aarne](https://github.com/aarne)! - Fix several AOT compiler/runtime parity bugs discovered via fuzzing:

  - Fix `condAnd` and `condOr` code generation to match runtime boolean semantics.
  - Fix nullish fallback chaining so `??` handling matches runtime overdefinition boundaries.
  - Fix overdefinition precedence so the first constant wire remains terminal, matching runtime behavior.
  - Fix `serializeBridge` quoting for empty-string and slash-only string constants so parse/serialize/parse round-trips remain valid.
  - Add deterministic regression coverage for these parity cases to prevent regressions.

- Updated dependencies [[`cf5cd2e`](https://github.com/stackables/bridge/commit/cf5cd2e40e6339fb3e896e05dbdbe66b0b5d77a9)]:
  - @stackables/bridge-core@1.2.0

## 2.0.0

### Major Changes

- [#78](https://github.com/stackables/bridge/pull/78) [`ce6cb8a`](https://github.com/stackables/bridge/commit/ce6cb8a8e6e8288e8ab73f7ce44d14b205c70c91) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Rename `@stackables/bridge-compiler` to `@stackables/bridge-parser` (parser, serializer, language service). The new `@stackables/bridge-compiler` package compiles BridgeDocument into optimized JavaScript code with abort signal support, tool timeout, and full language feature parity.

  bridge-parser first release will continue from current bridge-compiler version 1.0.6. New version of bridge-compiler will jump to 2.0.0 to mark a breaking change in the package purpose
