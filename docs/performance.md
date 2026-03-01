# Performance Optimisations

Tracks engine performance work: what was tried, what failed, and what's planned.

## Summary

| #   | Optimisation                    | Date       | Result                       |
| --- | ------------------------------- | ---------- | ---------------------------- |
| 1   | WeakMap-cached DocumentIndex    | March 2026 | ✗ Failed (–4–11%)            |
| 2   | Lightweight shadow construction | March 2026 | ✅ Done (+5–7%)              |
| 3   | Wire index by trunk key         | March 2026 | ✗ Failed (–10–23%)           |
| 4   | Cached element trunk key        | March 2026 | ✅ Done (~0%, code cleanup)  |
| 5   | Skip OTel when idle             | March 2026 | ✅ Done (+7–9% tool-heavy)   |
| 6   | Constant cache                  | March 2026 | ✅ Done (~0%, no regression) |
| 7   | pathEquals loop                 | March 2026 | ✅ Done (~0%, code cleanup)  |

## Baseline (main, March 2026)

Benchmarks live in `packages/bridge/bench/engine.bench.ts` (tinybench).
Historical tracking via [Bencher](https://bencher.dev) (project: `the-bridge`).

Run locally: `pnpm bench`

**Hardware:** MacBook Air M4 (4th gen, 15″). All numbers in this
document are from this machine — compare only against the same hardware.

| Benchmark                          | ops/sec | avg (ms) |
| ---------------------------------- | ------- | -------- |
| parse: simple bridge               | ~43K    | 0.023    |
| parse: large bridge (20×5)         | ~2.5K   | 0.40     |
| exec: passthrough (no tools)       | ~610K   | 0.002    |
| exec: short-circuit                | ~751K   | 0.001    |
| exec: simple chain (1 tool)        | ~417K   | 0.002    |
| exec: chained 3-tool fan-out       | ~152K   | 0.007    |
| exec: flat array 10                | ~48K    | 0.021    |
| exec: flat array 100               | ~5.1K   | 0.196    |
| exec: flat array 1000              | ~270    | 3.70     |
| exec: nested array 5×5             | ~15.8K  | 0.063    |
| exec: nested array 10×10           | ~4.3K   | 0.233    |
| exec: nested array 20×10           | ~2.1K   | 0.476    |
| exec: array + tool-per-element 10  | ~22K    | 0.045    |
| exec: array + tool-per-element 100 | ~2.2K   | 0.455    |

---

## Optimisations

### 1. WeakMap-cached DocumentIndex

**Date:** March 2026
**Branch:** `perf1`
**Result:** ✗ 4–11% _slower_ across every benchmark. Reverted.

Introduced a `DocumentIndex` class that pre-indexed:

- Wires by target trunk key (`Map<string, Wire[]>`)
- Bridge lookups by `type:field` key
- Tool definitions by name

Cached in a `WeakMap<Instruction[], DocumentIndex>` keyed by the document's
instruction array, so the index was built once and reused across
`ExecutionTree` instances sharing the same document.

Shadow trees looked up the index via `WeakMap.get(this.document.instructions)`
in the constructor.

**Why it failed:**

1. **`wireTargetKey()` string allocation.** The new index function
   `wireTargetKey(w)` built a string key for every wire lookup
   (`${module}:${type}:${field}:${instance ?? ""}`). This _replaced_
   `sameTrunk()` which does zero-allocation 4-field equality comparison.
   The Map lookup saved O(n) filtering but the per-call string allocation
   was more expensive than scanning a small array (~5–20 wires per bridge).

2. **WeakMap.get() on every shadow tree.** Each `new ExecutionTree()`
   called `WeakMap.get(instructions)` in the constructor to retrieve the
   cached index. `WeakMap.get()` costs ~50–100ns per call (hash + GC
   barrier), far more than the ~5ns property access it was replacing.
   For 1000 shadow trees this added ~50–100µs of pure overhead.

3. **Extra indirection layers.** The `DocumentIndex` class added a method
   call + property access on every wire lookup that wasn't there before.

**Lesson learned:**

- For small arrays (≤20 elements), linear scan with zero-allocation
  comparison (`sameTrunk`) beats Map lookup with string-key construction.
- `WeakMap` is not free — avoid it on the per-shadow-tree hot path.
- Measure _before_ assuming a theoretical complexity improvement translates
  to real-world speed. N is usually small in bridge wire arrays.

### 2. Lightweight shadow tree construction

**Date:** March 2026
**Result:** ✅ +5–7% on array benchmarks, +2–4% elsewhere.

| Benchmark                          | Before | After | Change  |
| ---------------------------------- | ------ | ----- | ------- |
| exec: passthrough                  | 613K   | 625K  | +2%     |
| exec: short-circuit                | 754K   | 759K  | +1%     |
| exec: simple chain                 | 378K   | 391K  | +3%     |
| exec: chained 3-tool fan-out       | 138K   | 143K  | +4%     |
| exec: flat array 10                | 43K    | 46K   | **+6%** |
| exec: flat array 100               | 4.7K   | 5.0K  | **+6%** |
| exec: flat array 1000              | 258    | 270   | **+5%** |
| exec: nested array 5×5             | 14.6K  | 15.5K | **+6%** |
| exec: nested array 10×10           | 4.0K   | 4.3K  | **+7%** |
| exec: nested array 20×10           | 2.0K   | 2.1K  | **+6%** |
| exec: array + tool-per-element 10  | 20K    | 21K   | **+6%** |
| exec: array + tool-per-element 100 | 2.1K   | 2.2K  | **+5%** |

Every `shadow()` call ran the full `ExecutionTree` constructor, which
redundantly re-derived data identical to the parent:

- `instructions.find()` — O(I) scan to locate the bridge (same result)
- `pipeHandleMap` — rebuilt from `bridge.pipeHandles` (identical)
- `handleVersionMap` — rebuilt by iterating all handles (identical)
- `constObj` — rebuilt by iterating all instructions (identical constants)
- `{ internal, ...(toolFns ?? {}) }` — new object spread (same tools)

Refactored `shadow()` to bypass the constructor and copy pre-computed
fields from the parent via `Object.create(ExecutionTree.prototype)`.

```ts
shadow(): ExecutionTree {
  const child = Object.create(ExecutionTree.prototype) as ExecutionTree;
  child.trunk = this.trunk;
  child.document = this.document;
  child.parent = this;
  child.depth = this.depth + 1;
  child.state = {};
  child.toolDepCache = new Map();
  child.toolDefCache = this.toolDefCache;
  child.bridge = this.bridge;
  child.pipeHandleMap = this.pipeHandleMap;
  child.handleVersionMap = this.handleVersionMap;
  child.toolFns = this.toolFns;
  child.tracer = this.tracer;
  child.logger = this.logger;
  child.signal = this.signal;
  return child;
}
```

**Key constraint:** Shadow trees must not mutate shared maps
(`pipeHandleMap`, `handleVersionMap`, `toolDefCache`) — they are
populated in the constructor and only read thereafter.

### 3. Wire index by target trunk key

**Date:** March 2026
**Result:** ✗ 10–23% _slower_ across every benchmark. Reverted.

Added a `wiresByTrunk: Map<string, Wire[]>` field to `ExecutionTree`,
built once in the root constructor by iterating all wires and keying them
with a new `wireTrunkKey()` function (ignoring element flag).
A `getWiresForTrunk(target)` helper replaced all 11 occurrences of
`bridge.wires.filter(w => sameTrunk(w.to, target))`.

Shared the pre-built index to shadow trees via #2.

| Benchmark             | With #2 only | With #2 + #3 | Change   |
| --------------------- | ------------ | ------------ | -------- |
| exec: passthrough     | 625K         | 506K         | **-19%** |
| exec: short-circuit   | 759K         | 587K         | **-23%** |
| exec: simple chain    | 391K         | 327K         | **-16%** |
| exec: chained 3-tool  | 143K         | 120K         | **-16%** |
| exec: flat array 10   | 46K          | 40K          | **-13%** |
| exec: flat array 100  | 5.0K         | 4.5K         | **-10%** |
| exec: flat array 1000 | 270          | 240          | **-11%** |

**Why it failed:**

Same root cause as #1: `wireTrunkKey(target)` builds a template string
(`${module}:${type}:${field}:${instance ?? ""}`) on every
`getWiresForTrunk()` call. At ~70ns per string allocation, this exceeds
the cost of linearly scanning 10 wires with `sameTrunk()` (~30ns). Even
though `Map.get()` is O(1), the key construction dominates.

Additional bugs found during testing:

1. `trunkKey()` treats `element: true` differently (`:*` suffix), so
   element wires went to wrong buckets — required a separate
   `wireTrunkKey()` that ignores element.
2. Removing `{ type, field }` destructuring from `run()` left orphaned
   variable references → `ReferenceError` at runtime.

**Lesson learned:**

- Reinforces #1's lesson: **any** scheme that replaces `sameTrunk()`'s
  zero-allocation 4-field comparison with string-keyed Map lookup loses
  for typical wire counts (5–20).
- This rules out ALL Map-based wire indexing approaches for the current
  architecture unless wire counts grow significantly.

### 4. Cache element trunk key

**Date:** March 2026
**Result:** ✅ ~0% (code cleanup, no measurable impact).

`trunkKey({ ...this.trunk, element: true })` was called 5 times across
shadow-tree hot paths. Each call spread the trunk object and built a
template string. Since `this.trunk` is fixed per tree, the result is
constant.

Pre-computed `elementTrunkKey` as a field, set once in the constructor
and copied in the `shadow()` factory:

```ts
private elementTrunkKey: string;
// In constructor:
this.elementTrunkKey = `${trunk.module}:${trunk.type}:${trunk.field}:*`;
// In shadow():
child.elementTrunkKey = this.elementTrunkKey;
```

Impact within noise (+1–2% on some array benchmarks). Each `trunkKey()`
call saves ~15ns; with 5 calls per shadow tree, a 1000-element array
saves ~75µs on a ~3.7ms benchmark (~2%). Kept because the code is
cleaner.

### 5. Skip OTel span when no tracer is configured

**Date:** March 2026
**Result:** ✅ +7–9% on tool-heavy benchmarks.

| Benchmark                          | Before (#2 only) | After | Change         |
| ---------------------------------- | ---------------- | ----- | -------------- |
| exec: passthrough                  | 625K             | 617K  | ~0% (no tools) |
| exec: short-circuit                | 759K             | 743K  | ~0% (no tools) |
| exec: simple chain                 | 391K             | 419K  | **+7%**        |
| exec: chained 3-tool fan-out       | 143K             | 156K  | **+9%**        |
| exec: flat array 10                | 46K              | 48K   | **+4%**        |
| exec: flat array 100               | 5.0K             | 5.1K  | **+2%**        |
| exec: flat array 1000              | 270              | 271   | ~0%            |
| exec: nested array 5×5             | 15.5K            | 15.9K | **+3%**        |
| exec: nested array 10×10           | 4.3K             | 4.4K  | **+2%**        |
| exec: nested array 20×10           | 2.1K             | 2.1K  | ~0%            |
| exec: array + tool-per-element 10  | 21K              | 22.4K | **+7%**        |
| exec: array + tool-per-element 100 | 2.2K             | 2.3K  | **+5%**        |

`callTool()` always called `otelTracer.startActiveSpan(...)`, allocated
`metricAttrs`, and recorded metrics — even when OpenTelemetry had its
default no-op provider and no internal tracer/logger was configured.
The span callback closure allocation + template string building added
~200–300ns overhead per tool call.

Lazy-probe the OTel tracer once on first tool call using
`span.isRecording()`. When the tracer is no-op AND no internal tracer
or logger is configured, take a fast path that calls `fnImpl()` directly:

```ts
let _otelActive: boolean | undefined;
function isOtelActive(): boolean {
  if (_otelActive === undefined) {
    const probe = otelTracer.startSpan("_bridge_probe_");
    _otelActive = probe.isRecording();
    probe.end();
  }
  return _otelActive;
}

// In callTool():
if (!tracer && !logger && !isOtelActive()) {
  return fnImpl(input, toolContext);
}
```

Biggest gains on benchmarks with many tool calls per operation (simple
chain, chained fan-out, tool-per-element). Array benchmarks with one
implicit tool see smaller gains because tool-call overhead is amortised
over per-element work.

**Caveat:** `_otelActive` is probed once on first tool call and cached.
If the OTel SDK is registered after the first tool call runs, the flag
will remain `false`. In practice, OTel SDKs are always registered at
application startup before any business logic.

### 6. Cache coerceConstant() results

**Date:** March 2026
**Result:** ✅ ~0% (no measurable impact, no regression).

Module-level `Map<string, unknown>` cache for `coerceConstant()`.
Avoids repeated `JSON.parse` for the same constant strings across
shadow trees. `JSON.parse` for short primitives (`"true"`, `"42"`) is
already very fast (~15ns), so no measurable improvement. Kept because
it prevents redundant work in constant-heavy bridges and has zero
regression.

**Caveat:** Only safe for immutable values (primitives, frozen objects).
If callers mutate the returned object, they'd corrupt the cache. Current
code does not mutate constant values, so this is safe today.

### 7. Replace pathEquals `.every()` with for-loop

**Date:** March 2026
**Result:** ✅ ~0% (code cleanup).

Replaced `.every()` callback with a manual for-loop. No measurable
impact — paths are typically 1–2 segments, so the closure overhead was
already negligible. Kept for consistency and micro-optimisation hygiene.
