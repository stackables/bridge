# Performance Optimisations

Tracks engine performance work: what was tried, what failed, and what's planned.

## Summary

| #   | Optimisation                         | Date       | Result                                           |
| --- | ------------------------------------ | ---------- | ------------------------------------------------ |
| 1   | Strict-path parity via `__path`      | March 2026 | ✅ Done (correctness first, measurable slowdown) |
| 2   | Single-segment fast path via `__get` | March 2026 | ✅ Done (partial recovery on compiled hot paths) |

## Baseline (main, March 2026)

Benchmarks live in `packages/bridge/bench/engine.bench.ts` (tinybench) under the
`compiled:` suite. Historical tracking via
[Bencher](https://bencher.dev/console/projects/the-bridge/perf) — look for
benchmark names prefixed `compiled:`.

Run locally: `pnpm bench`

**Hardware:** MacBook Air M4 (4th gen, 15″). All numbers in this
document are from this machine — compare only against the same hardware.

| Benchmark                              | ops/sec | avg (ms) |
| -------------------------------------- | ------- | -------- |
| compiled: passthrough (no tools)       | ~644K   | 0.002    |
| compiled: short-circuit                | ~640K   | 0.002    |
| compiled: simple chain (1 tool)        | ~612K   | 0.002    |
| compiled: chained 3-tool fan-out       | ~523K   | 0.002    |
| compiled: flat array 10                | ~454K   | 0.002    |
| compiled: flat array 100               | ~185K   | 0.006    |
| compiled: flat array 1000              | ~27.9K  | 0.036    |
| compiled: nested array 5×5             | ~231K   | 0.004    |
| compiled: nested array 10×10           | ~103K   | 0.010    |
| compiled: nested array 20×10           | ~55.0K  | 0.019    |
| compiled: array + tool-per-element 10  | ~293K   | 0.003    |
| compiled: array + tool-per-element 100 | ~58.7K  | 0.017    |

This table is the current perf level. It is updated after a successful optimisation is committed.

---

## Optimisations

### 1. Strict-path parity via `__path`

**Date:** March 2026
**Status:** ✅ Done

**Why:**

Runtime source-mapping work tightened strict path traversal semantics so
primitive property access throws at the failing segment instead of silently
flowing through as `undefined`. Compiled execution still had some strict paths
emitted as raw bracket access, which caused AOT/runtime divergence in parity
fuzzing.

**What changed:**

`appendPathExpr(...)` was switched to route compiled path traversal through the
generated `__path(...)` helper so compiled execution matched runtime semantics.

**Result:**

Correctness and parity were restored, but this imposed a noticeable cost on the
compiled hot path because even one-segment accesses paid the generic loop-based
helper.

Observed branch-level compiled numbers before the follow-up optimisation:

| Benchmark                              | Baseline | With `__path` everywhere | Change |
| -------------------------------------- | -------- | ------------------------ | ------ |
| compiled: passthrough (no tools)       | ~644K    | ~561K                    | -13%   |
| compiled: simple chain (1 tool)        | ~612K    | ~536K                    | -12%   |
| compiled: flat array 1000              | ~27.9K   | ~14.1K                   | -49%   |
| compiled: array + tool-per-element 100 | ~58.7K   | ~45.2K                   | -23%   |

### 2. Single-segment fast path via `__get`

**Date:** March 2026
**Status:** ✅ Done

**Hypothesis:**

The vast majority of compiled property reads in the benchmark suite are short,
especially one-segment accesses. Running every one of them through the generic
`__path(base, path, safe, allowMissingBase)` loop was overpaying for the common
case.

**What changed:**

- Added a generated `__get(base, segment, accessSafe, allowMissingBase)` helper
  for the one-segment case.
- Kept the strict primitive-property failure semantics from `__path(...)`.
- Left multi-segment accesses on `__path(...)` so correctness stays uniform.

**Result:**

This recovered a meaningful portion of the compiled regression while preserving
the stricter source-mapping semantics.

| Benchmark                              | Before `__get` | After `__get` | Change |
| -------------------------------------- | -------------- | ------------- | ------ |
| compiled: passthrough (no tools)       | ~561K          | ~639K         | +14%   |
| compiled: simple chain (1 tool)        | ~536K          | ~583K         | +9%    |
| compiled: flat array 1000              | ~14.1K         | ~15.7K        | +11%   |
| compiled: nested array 20×10           | ~36.0K         | ~39.1K        | +9%    |
| compiled: array + tool-per-element 100 | ~45.2K         | ~50.0K        | +11%   |

**What remains:**

Compiled performance is much closer to baseline now, but still below the March
2026 table on some heavy array benchmarks. The obvious next step, if needed, is
specialising short strict paths of length 2–3 rather than routing every
multi-segment path through the generic loop helper.
