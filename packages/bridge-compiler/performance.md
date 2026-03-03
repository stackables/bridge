# Performance Optimisations

Tracks engine performance work: what was tried, what failed, and what's planned.

## Summary

| #   | Optimisation          | Date | Result |
| --- | --------------------- | ---- | ------ |
| 1   | Future work goes here |      |        |

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

### 1. Future work goes here
