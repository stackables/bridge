---
"@stackables/bridge-core": minor
"@stackables/bridge-graphql": minor
"@stackables/bridge": minor
---

Engine hardening & resource exhaustion defenses

- **Tool timeout**: `callTool` now races tool invocations against a configurable `toolTimeoutMs` (default: 15 seconds). Hanging tools throw `BridgeTimeoutError`, freeing the engine thread.
- **Bounded tracing**: `TraceCollector` replaces `structuredClone` with a `boundedClone` utility that truncates arrays, strings, and deep objects to prevent OOM when tracing large payloads. Configurable via `maxArrayItems`, `maxStringLength`, and `cloneDepth`.
- **Abort discipline**: `resolveWiresAsync` and `createShadowArray` now check `signal.aborted` and throw `BridgeAbortError` to halt execution immediately when a client disconnects.
- **Strict constant parsing**: `coerceConstant` no longer uses `JSON.parse`. Strictly handles boolean, null, numeric, and quoted-string literals.
- **setNested guard**: Throws if asked to assign a nested path through a primitive (string, number, etc.).
- **Configurable limits**: `toolTimeoutMs` and `maxDepth` are now configurable via `ExecuteBridgeOptions` and `BridgeOptions`, with sensible defaults (15s timeout, depth 30).
