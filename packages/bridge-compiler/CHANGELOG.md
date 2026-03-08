# @stackables/bridge-compiler

## 2.4.1

### Patch Changes

- [#108](https://github.com/stackables/bridge/pull/108) [`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339) Thanks [@aarne](https://github.com/aarne)! - Add memoized tool handles with compiler support.

  Bridge `with` declarations now support `memoize` for tool handles, including
  loop-scoped tool handles inside array mappings. Memoized handles reuse the same
  result for repeated calls with identical inputs, and each declared handle keeps
  its own cache.

  The AOT compiler now compiles memoized tool handles too, including loop-scoped
  tool handles inside array mappings. Compiled execution preserves request-scoped
  caching semantics and reuses results for repeated calls with identical inputs.

- [#108](https://github.com/stackables/bridge/pull/108) [`de20ece`](https://github.com/stackables/bridge/commit/de20ece3ca9c42d0def90f512f90900962670339) Thanks [@aarne](https://github.com/aarne)! - Compile shadowed loop-scoped tool handles in the AOT compiler.

  Bridges can now redeclare the same tool alias in nested array scopes without
  triggering `BridgeCompilerIncompatibleError` or falling back to the interpreter.
  The compiler now assigns distinct tool instances to repeated handle bindings so
  each nested scope emits and reads from the correct tool call.

- [#111](https://github.com/stackables/bridge/pull/111) [`fc836e4`](https://github.com/stackables/bridge/commit/fc836e4ff33f00a078246094b8b12b77ee844942) Thanks [@aarne](https://github.com/aarne)! - Move Bridge source metadata onto BridgeDocument.

  Parsed documents now retain their original source text automatically, and can
  optionally carry a filename from parse time. Runtime execution, compiler
  fallbacks, GraphQL execution, and playground formatting now read that metadata
  from the document instead of requiring callers to thread source and filename
  through execute options.

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
  - @stackables/bridge-stdlib@1.5.3

## 2.4.0

### Minor Changes

- [#104](https://github.com/stackables/bridge/pull/104) [`b213e9f`](https://github.com/stackables/bridge/commit/b213e9f49ed5da80e7d9a1b9e161586e59b3719c) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Multi-Level Control Flow (break N, continue N)

  When working with deeply nested arrays (e.g., mapping categories that contain lists of products), you may want an error deep inside the inner array to skip the outer array element.

  You can append a number to break or continue to specify how many loop levels the signal should pierce.

- [#102](https://github.com/stackables/bridge/pull/102) [`2243c7e`](https://github.com/stackables/bridge/commit/2243c7e7fd23a37c30118e713ae348b833c523fe) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Sync tool optimisation — honour the `sync` flag in ToolMetadata

  When a tool declares `{ sync: true }` in its `.bridge` metadata the engine
  now enforces and optimises it:

  1. **Enforcement** — if a sync-declared tool returns a Promise, both the
     runtime and compiled engines throw immediately.
  2. **Core optimisation** — `callTool()` skips timeout racing, the OTel span
     wrapper, and all promise handling for sync tools.
  3. **Compiler optimisation** — generated code uses a dedicated `__callSync()`
     helper at every call-site, avoiding `await` overhead entirely.
  4. **Array-map fast path** — when all per-element tools in an array map are
     sync, the compiled engine generates a dual-path: a synchronous `.map()`
     branch (no microtask ticks) with a runtime fallback to `for…of + await`
     for async tools.

  Benchmarks show up to ~50 % latency reduction for compiled array maps
  with sync tools (100 elements).

### Patch Changes

- [#103](https://github.com/stackables/bridge/pull/103) [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60) Thanks [@aarne](https://github.com/aarne)! - Fix AOT compiler to throw `BridgeTimeoutError` on tool timeout

  AOT-compiled bridges now throw `BridgeTimeoutError` (with the same name and
  message format as the runtime) when a tool exceeds `toolTimeoutMs`. Previously
  the generated code constructed a generic `Error`, causing a class mismatch when
  callers caught and inspected the error type.

- [#103](https://github.com/stackables/bridge/pull/103) [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60) Thanks [@aarne](https://github.com/aarne)! - Fix AOT/runtime parity for null element traversal, catch-null recovery, and non-array source handling

- Updated dependencies [[`b213e9f`](https://github.com/stackables/bridge/commit/b213e9f49ed5da80e7d9a1b9e161586e59b3719c), [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60), [`fc6c619`](https://github.com/stackables/bridge/commit/fc6c6195dec524c880ac20f3057e776f76583f60), [`2243c7e`](https://github.com/stackables/bridge/commit/2243c7e7fd23a37c30118e713ae348b833c523fe), [`8e5b2e2`](https://github.com/stackables/bridge/commit/8e5b2e21796cfd7e9a9345225d94ceb8bfc39bac)]:
  - @stackables/bridge-core@1.5.0
  - @stackables/bridge-stdlib@1.5.2

## 2.3.0

### Minor Changes

- [#96](https://github.com/stackables/bridge/pull/96) [`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f) Thanks [@aarne](https://github.com/aarne)! - Migrate wire shape from separate `falsyFallback*`/`nullishFallback*` properties to a unified `fallbacks: WireFallback[]` array, enabling mixed `||` and `??` chains in any order (e.g. `A ?? B || C ?? D`).

### Patch Changes

- Updated dependencies [[`7384d3f`](https://github.com/stackables/bridge/commit/7384d3f404197babbd5771ab7cd84f14d0cd392f)]:
  - @stackables/bridge-core@1.4.0

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
