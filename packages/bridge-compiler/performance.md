# Performance Optimisations

Tracks engine performance work: what was tried, what failed, and what's planned.

## Summary

| #   | Optimisation                         | Date       | Result                                                                    |
| --- | ------------------------------------ | ---------- | ------------------------------------------------------------------------- |
| 1   | Strict-path parity via `__path`      | March 2026 | ✅ Done (correctness first, measurable slowdown)                          |
| 2   | Single-segment fast path via `__get` | March 2026 | ✅ Done (partial recovery on compiled hot paths)                          |
| 3   | Array loop IIFE elimination          | June 2026  | ✅ Done (array benchmarks within 3–7 % of baseline)                       |
| 4   | Batch-level loc annotation           | June 2026  | ✅ Done (tool-input/output IIFEs replaced with statement-level try/catch) |

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
| compiled: passthrough (no tools)       | ~649K   | 0.002    |
| compiled: short-circuit                | ~622K   | 0.002    |
| compiled: simple chain (1 tool)        | ~551K   | 0.002    |
| compiled: chained 3-tool fan-out       | ~343K   | 0.003    |
| compiled: flat array 10                | ~424K   | 0.002    |
| compiled: flat array 100               | ~176K   | 0.006    |
| compiled: flat array 1000              | ~26.4K  | 0.038    |
| compiled: nested array 5×5             | ~220K   | 0.005    |
| compiled: nested array 10×10           | ~101K   | 0.010    |
| compiled: nested array 20×10           | ~53.6K  | 0.019    |
| compiled: array + tool-per-element 10  | ~278K   | 0.004    |
| compiled: array + tool-per-element 100 | ~49.1K  | 0.036    |

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

### 3. Array loop IIFE elimination

**Date:** March 2026
**Status:** ✅ Done

**Problem:**

Array loop bodies were emitting a per-field IIFE with try/catch for `bridgeLoc`
error annotation:

```js
__el_0.id = await (async () => { try { return __el_0.id; } catch (__e) { ... wrapErr(bridgeLoc({...})) ... } })();
```

Three separate sources of overhead in the hot loop:

1. **Per-field IIFE closure** — one closure allocation + call per field per
   element.
2. **`Object.values().find()` sentinel check** — ran every iteration even when
   no `break`/`continue` was possible.
3. **Per-iteration loc object allocation** — `bridgeLoc({startLine:7,...})`
   allocated a fresh object per field per element.

**What changed:**

- **Static analysis:** Added `bodyHasControlFlow(body)` /
  `exprHasControlFlow(expr)` helpers that recursively scan array body AST for
  `break`/`continue` expressions. When absent, the sentinel check
  (`Object.values().find(v => v === SENTINEL_BREAK)`) is elided entirely.

- **Consolidated try/catch with `loopLocInfo`:** Instead of per-field IIFEs,
  a single try/catch is hoisted **outside** the for-loop. Each field expression
  becomes a comma expression that sets an integer index before evaluating:
  `(__li_0 = 2, __el_0.id)`. In the catch handler, the actual loc is looked up
  from a precomputed array: `[loc0, loc1, loc2][__li_0]`.

- **Hoisted try/catch:** The try block wraps the entire for-loop rather than
  each iteration, removing per-iteration overhead.

**Result:**

| Benchmark                     | Before | After | Change |
| ----------------------------- | ------ | ----- | ------ |
| compiled: flat array 10       | ~283K  | ~424K | +50%   |
| compiled: flat array 100      | ~61K   | ~176K | +189%  |
| compiled: flat array 1000     | ~7K    | ~22K  | +216%  |
| compiled: nested array 5×5    | ~80K   | ~220K | +175%  |
| compiled: nested array 10×10  | ~46K   | ~92K  | +100%  |
| compiled: nested array 20×10  | ~24K   | ~49K  | +104%  |
| compiled: tool-per-element 10 | ~217K  | ~278K | +28%   |

Array benchmarks went from 50–75 % below baseline to within 3–7 %.

### 4. Batch-level loc annotation

**Date:** March 2026
**Status:** ✅ Done

**Problem:**

Outside of array loops, every output wire and tool-input field was still wrapped
in an async IIFE for `bridgeLoc` annotation:

```js
__result.foo = await (async () => { try { return expr; } catch (__e) { ... } })();
```

For wires going into `emitParallelAssignments` (Promise.all batches), this
per-expression IIFE was unnecessary — error annotation could happen at the batch
level instead.

**What changed:**

- **`compileBody` pending wires:** For single-source expressions without
  `wireCatch`, uses `compileSourceChain` (raw expression, no IIFE) and captures
  `locExpr` separately. Falls back to `compileSourceChainWithLoc` for
  multi-source or wireCatch cases.

- **Tool input field wires:** Same pattern — single-source without wireCatch
  uses `compileSourceChain` + `locExpr`.

- **`emitParallelAssignments`:** Accepts `locExpr?: string` per item. For sync
  items with a loc, wraps the assignment in a statement-level try/catch. For
  async batches, builds a `__locs` array and annotates errors in the existing
  rethrow loop. Single async items with a loc get a try/catch around the
  assignment.

**Result:**

| Benchmark                        | Before | After | Change |
| -------------------------------- | ------ | ----- | ------ |
| compiled: simple chain (1 tool)  | ~536K  | ~551K | +3%    |
| compiled: chained 3-tool fan-out | ~329K  | ~343K | +4%    |

Modest gains because most expressions were already single-segment. The remaining
gap on chained 3-tool (~343K vs ~523K baseline, −34 %) comes from feature
additions in tool getter bodies that the baseline did not have: sync tool
detection, timeout handling, `__checkAbort()` calls, and conditional await.
These are correctness requirements and are not optimisable without removing
features.
