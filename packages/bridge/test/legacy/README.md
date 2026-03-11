# Legacy Tests

These test files use the older `forEachEngine` dual-run pattern and need to be migrated to the stricter `regressionTest` harness.

## Already migrated (removed from legacy)

| File | How |
|------|-----|
| `tool-self-wires-runtime.test.ts` | Serializer fixed for expression/ternary/coalesce/interpolation in tool self-wires |
| `native-batching.test.ts` | Created `test.batch.multitool`; serializer fixed for element-scoped tool handles |
| `infinite-loop-protection.test.ts` | Split into regressionTest + standalone circular dependency + depth ceiling tests |

## Action items before migration

| File | Blockers | Suggested approach |
|------|----------|-------------------|
| `sync-tools.test.ts` | Custom sync tools with `.bridge = { sync: true }`; pipe syntax tests need transforming tools | Use `test.sync.multitool` for echo tests; per-scenario `tools` overrides for custom sync tools; `allowDowngrade` for compiler skips |
| `scheduling.test.ts` | Timing-based assertions (`performance.now()` deltas); call-order spy patterns | Convert timing assertions to `assertTraces` (count-based); convert spy patterns to `assertTraces` function that inspects trace order |
| `memoized-loop-tools.test.ts` | Call-count tracking for memoization deduplication; uses `executeCompiled` directly | Use `assertTraces` count to verify dedup (2 unique inputs = 2 traces); keep compiler test as standalone describe |
| `define-loop-tools.test.ts` | Call-count tracking for memoization across define boundaries | Use `assertTraces` count; keep parser error test as standalone `test()` |
| `traces-on-errors.test.ts` | Uses `executeFn` directly with `trace: "basic"`; inspects `BridgeRuntimeError.traces` and `.executionTraceId` | Use `assertError` + `assertTraces` function to inspect error traces |
| `loop-scoped-tools.test.ts` | Uses `executeCompiled` directly; tests compiler warning logs | Split: parser error tests as standalone; execution tests via regressionTest; compiler tests as standalone describe |
| `strict-scope-rules.test.ts` | Parser error tests (`parseBridge` throws); compiler skip for nested loop scope pull | Split: parser test as standalone; execution via regressionTest with `allowDowngrade` |
| `property-search.test.ts` | Reads `.bridge` file from disk; spy tools verify chained coordinates | Inline bridge text; convert spy to `assertTraces` function inspecting trace input |
| `scope-and-edges.test.ts` | Parser tests, spy tools (`capturedInput`), `parsePath` unit tests, compiler skips | Split: parser/parsePath as standalone; execution via regressionTest with `allowDowngrade` |
| `path-scoping.test.ts` | Heavy parser/serializer unit tests; spread syntax; many compiler skips | Split: parser/serializer tests as standalone describe; execution via regressionTest with `allowDowngrade` |
| `tool-features.test.ts` | Spy tools (`capturedInput`), httpCall cache call-count tracking, context pull, pipe tests | Split: spy tests → `assertTraces` function; context/pipe → regressionTest; call-count → `assertTraces` count |
| `control-flow.test.ts` | `break`/`continue` with multilevel; many compiler skips; parser/serializer tests | Split: parser/serializer as standalone; execution via regressionTest with `allowDowngrade` |
| `resilience.test.ts` | Parser tests, `serializeBridge` round-trips, error boundary tests | Split: parser/roundtrip as standalone; error tests via regressionTest with `assertError` |
| `tool-error-location.test.ts` | Inspects `BridgeRuntimeError.bridgeLoc.startLine`; custom `failingSyncTool`; `toolTimeoutMs` | Use `assertError` function to inspect error properties |
| `execute-bridge.test.ts` | Direct `executeBridge` calls, version checking, document merging, language service tests | Keep as standalone — tests API surface, not execution behavior |
| `runtime-error-format.test.ts` | Inspects `BridgeRuntimeError` properties (`.bridgeLoc`, `.path`, `.tool`) | Use `assertError` function to inspect error properties |
| `shared-parity.test.ts` | Already data-driven with its own parity runner; large test matrix | Gradually adopt regressionTest for individual cases |
| `expressions.test.ts` | Short-circuit side-effect tests (tracking `rightEvaluated` flag) | Keep as legacy — side-effect tracking requires imperative test style |
| `force-wire.test.ts` | Timing-based parallel assertion; `force catch null` runtime-skip test | Convert timing to `assertTraces`; `force catch null` via regressionTest with `allowDowngrade` |

## Common patterns for migration

1. **Compiler skips** (`skip: engine === "compiled"`) → Use `allowDowngrade: true` in scenario
2. **Call-count tracking** → Use `assertTraces: expectedCount` (batched = 1 trace per flush, memoized = deduplicated count)
3. **Spy tools** (`capturedInput`) → Use `assertTraces` function: `(traces) => { assert.equal(traces[0].input.x, "expected") }`
4. **Custom tool metadata** → Use per-scenario `tools` override or `test.sync.multitool`/`test.batch.multitool`
5. **Parser error tests** → Keep as standalone `test()` / `describe()` blocks (not execution tests)
6. **Timing assertions** → Replace with `assertTraces` count or trace order inspection
7. **`BridgeRuntimeError` inspection** → Use `assertError` function: `(err) => { assert.equal(err.bridgeLoc.startLine, 5) }`
