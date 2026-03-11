# Legacy Tests

These test files use the older `forEachEngine` dual-run pattern and need to be migrated to the stricter `regressionTest` harness.

## Action items before migration

| File | Blockers |
|------|----------|
| `tool-self-wires-runtime.test.ts` | Serializer does not round-trip expression self-wires in tool blocks (e.g. `const.one + 1`, ternary, coalesce, string interpolation) |
| `traces-on-errors.test.ts` | Uses `executeFn` directly with `trace: "basic"` option; inspects `BridgeRuntimeError.traces` and `.executionTraceId` |
| `tool-error-location.test.ts` | Inspects `BridgeRuntimeError.bridgeLoc.startLine`; uses custom `failingSyncTool` with `.bridge = { sync: true }` metadata; uses `slowTool` with `toolTimeoutMs` |
| `sync-tools.test.ts` | Uses custom tool functions with `.bridge = { sync: true }` metadata that `test.multitool` cannot replace |
| `scheduling.test.ts` | Timing-based assertions (parallel execution, `performance.now()` deltas); spy patterns tracking call order |
| `native-batching.test.ts` | Custom batch tool functions with `.bridge = { batch: true }` metadata |
| `memoized-loop-tools.test.ts` | Call-count tracking to verify memoization deduplication |
| `loop-scoped-tools.test.ts` | Uses `executeCompiled` directly; tests compiler warning logs |
| `define-loop-tools.test.ts` | Call-count tracking for memoization across define block boundaries |
| `property-search.test.ts` | Reads `.bridge` file from disk; uses spy tools to verify chained coordinates |
| `strict-scope-rules.test.ts` | Parser error tests (`parseBridge` throws); compiler skip (`engine === "compiled"`) for nested loop scope pull |
| `scope-and-edges.test.ts` | Parser tests, spy tools (`capturedInput`), `parsePath` unit tests, compiler skips |
| `path-scoping.test.ts` | Heavy parser/serializer unit tests; spread syntax; many compiler skips |
| `tool-features.test.ts` | Spy tools (`capturedInput`), httpCall cache call-count tracking, context pull, pipe operator tests |
| `control-flow.test.ts` | `break`/`continue` with multilevel; many compiler skips; parser/serializer tests |
| `resilience.test.ts` | Parser tests, `serializeBridge` round-trips, error boundary tests |
| `execute-bridge.test.ts` | Direct `executeBridge` calls, version checking, document merging, language service tests |
| `runtime-error-format.test.ts` | Inspects `BridgeRuntimeError` properties (`.bridgeLoc`, `.path`, `.tool`); uses `parseBridge` directly |
| `shared-parity.test.ts` | Already data-driven with its own parity runner; large test matrix |
| `infinite-loop-protection.test.ts` | Uses `ExecutionTree` and `BridgePanicError` directly; `MAX_EXECUTION_DEPTH` ceiling test |
| `expressions.test.ts` | Short-circuit side-effect tests (tracking `rightEvaluated` flag) |
| `force-wire.test.ts` | Timing-based parallel assertion; `force catch null` runtime-skip test |

## Common blockers

1. **Serializer bugs**: Round-trip (`parse → serialize → parse`) fails for expression self-wires, template strings in `||`/ternary, and alias references in fallback chains
2. **Compiler incompatibility**: Many tests skip the compiled engine (`skip: engine === "compiled"`) for features like `and`/`or`/`not` expressions, `?.` safe navigation, parenthesized booleans
3. **Side-effect inspection**: Tests that spy on tool inputs, track call counts, or measure timing cannot use the data-driven `regressionTest` pattern
4. **Direct API usage**: Tests using `ExecutionTree`, `BridgeRuntimeError`, `parseBridge`, or `executeFn` directly need the flexible `forEachEngine` runner
5. **Custom tool metadata**: Tests using `.bridge = { sync: true }` or `.bridge = { batch: true }` cannot use `test.multitool`
