---
"@stackables/bridge-core": minor
"@stackables/bridge-graphql": minor
"@stackables/bridge": minor
---

Engine hardening & resource exhaustion defences

- **Tool-call timeouts**: New `toolTimeoutMs` option on `ExecutionTree`, `BridgeOptions`, and `ExecuteBridgeOptions`. When set, tool calls that exceed the limit throw `BridgeTimeoutError` (catchable via the `catch` gate). Exported constant `DEFAULT_TOOL_TIMEOUT_MS = 15_000`.

- **Bounded trace cloning**: `TraceCollector` no longer uses `structuredClone` for full-level traces. A new `boundedClone` helper (exported from `@stackables/bridge-core`) truncates arrays, strings, and object depth to prevent OOM on large payloads. Limits are configurable via new `TraceCollector` constructor parameters (`maxArrayItems`, `maxStringLength`, `cloneDepth`).

- **Abort-signal discipline**: `AbortSignal` is now checked at the top of the hot wire-resolution loop (`resolveWiresAsync`) and inside the array-element iteration loop (`createShadowArray`). Client disconnects now halt execution mid-wire without waiting for a tool to settle.

- **Strict constant parsing**: `coerceConstant` no longer uses `JSON.parse`. Primitives (`true`/`false`/`null`/numbers) and JSON-encoded strings are decoded with a strict custom parser, eliminating any hypothetical AST-injection gadget chain.

- **`setNested` type-safety guard**: If a path segment traverses through a primitive (string, number, etc.) a descriptive `Error` is thrown instead of silently failing.

- **Configurable engine limits**: New `maxDepth` option (default: `MAX_EXECUTION_DEPTH = 30`) is exposed on `BridgeOptions`, `ExecuteBridgeOptions`, and `ExecutionTree` directly — shadow trees inherit the value automatically.
