# Performance Optimisations

Tracks engine performance work: what was tried, what failed, and what's planned.

## Summary

| #   | Optimisation                       | Date       | Result                                 |
| --- | ---------------------------------- | ---------- | -------------------------------------- |
| 1   | WeakMap-cached DocumentIndex       | March 2026 | ✗ Failed (–4–11%)                      |
| 2   | Lightweight shadow construction    | March 2026 | ✅ Done (+5–7%)                        |
| 3   | Wire index by trunk key            | March 2026 | ✗ Failed (–10–23%)                     |
| 4   | Cached element trunk key           | March 2026 | ✅ Done (~0%, code cleanup)            |
| 5   | Skip OTel when idle                | March 2026 | ✅ Done (+7–9% tool-heavy)             |
| 6   | Constant cache                     | March 2026 | ✅ Done (~0%, no regression)           |
| 7   | pathEquals loop                    | March 2026 | ✅ Done (~0%, code cleanup)            |
| 8   | Pre-group element wires            | March 2026 | ✅ Done (see #9)                       |
| 9   | Batch element materialisation      | March 2026 | ✅ Done (+44–130% arrays)              |
| 10  | Sync fast path for resolved values | March 2026 | ✅ Done (+8–17% all, +42–114% arrays)  |
| 11  | Pre-compute keys & cache wire tags | March 2026 | ✅ Done (+12–16% all, +60–129% arrays) |
| 12  | De-async schedule() & callTool()   | March 2026 | ✅ Done (+11–18% tool, ~0% arrays)     |

## Baseline (main, March 2026)

Benchmarks live in `packages/bridge/bench/engine.bench.ts` (tinybench).
Historical tracking via [Bencher](https://bencher.dev/console/projects/the-bridge/perf).

Run locally: `pnpm bench`

**Hardware:** MacBook Air M4 (4th gen, 15″). All numbers in this
document are from this machine — compare only against the same hardware.

| Benchmark                          | ops/sec | avg (ms) |
| ---------------------------------- | ------- | -------- |
| parse: simple bridge               | ~43K    | 0.023    |
| parse: large bridge (20×5)         | ~2.5K   | 0.40     |
| exec: passthrough (no tools)       | ~830K   | 0.001    |
| exec: short-circuit                | ~801K   | 0.001    |
| exec: simple chain (1 tool)        | ~558K   | 0.002    |
| exec: chained 3-tool fan-out       | ~216K   | 0.005    |
| exec: flat array 10                | ~175K   | 0.006    |
| exec: flat array 100               | ~28.2K  | 0.036    |
| exec: flat array 1000              | ~2,980  | 0.335    |
| exec: nested array 5×5             | ~47.7K  | 0.021    |
| exec: nested array 10×10           | ~17.5K  | 0.057    |
| exec: nested array 20×10           | ~9.0K   | 0.110    |
| exec: array + tool-per-element 10  | ~36.5K  | 0.028    |
| exec: array + tool-per-element 100 | ~3.98K  | 0.253    |

This table is the current perf level. It is updated after a successful optimisation is committed.

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

### 8. Pre-group element wires

**Date:** March 2026
**Result:** ✅ Combined with #9 (eliminates per-element wire filtering).

Every `pullOutputField` call did
`bridge.wires.filter(w => sameTrunk(...) && pathEquals(...))` — for a
1000-element array with 3 output fields that's 5 wires × 3 fields ×
1000 elements = **15,000 comparisons per execution**.

Added a `wireGroupsByPath: Map<string, Wire[]>` built once per
`materializeShadows` call, keyed by `\0`-joined path. Added a thin
`resolvePreGrouped(wires)` method to `ExecutionTree` that lets
`materializeShadows` call `resolveWires` on a shadow with pre-grouped
wires rather than passing a path to re-filter. The map key uses `\0` as
a separator since field names are identifiers and can't contain it.

### 9. Batch element materialisation

**Date:** March 2026
**Result:** ✅ +44–130% on flat array benchmarks, +14–43% on all array benchmarks.

| Benchmark                          | Before | After | Change    |
| ---------------------------------- | ------ | ----- | --------- |
| exec: passthrough                  | 610K   | 610K  | ~0%       |
| exec: short-circuit                | 751K   | 745K  | ~0%       |
| exec: simple chain                 | 417K   | 418K  | ~0%       |
| exec: chained 3-tool fan-out       | 152K   | 156K  | ~0%       |
| exec: flat array 10                | 48K    | 69K   | **+44%**  |
| exec: flat array 100               | 5.1K   | 8.0K  | **+57%**  |
| exec: flat array 1000              | 270    | 627   | **+132%** |
| exec: nested array 5×5             | 15.8K  | 21K   | **+33%**  |
| exec: nested array 10×10           | 4.3K   | 6.1K  | **+42%**  |
| exec: nested array 20×10           | 2.1K   | 3.0K  | **+43%**  |
| exec: array + tool-per-element 10  | 22K    | 25K   | **+14%**  |
| exec: array + tool-per-element 100 | 2.2K   | 2.6K  | **+18%**  |

Instead of `Promise.all(N × Promise.all(F fields))`, the common case
(no nested arrays in the output — `deepPaths.size === 0`) now uses a
single flat `Promise.all` over all `N × F` resolutions:

```ts
// Before: Promise.all(1000 × Promise.all(3 fields))
// After:  Promise.all(3000 flat resolutions)
const flatValues = await Promise.all(
  items.flatMap((shadow) =>
    directFieldArray.map((name) =>
      shadow.resolvePreGrouped(wireGroupsByPath.get(pathKey)!),
    ),
  ),
);
```

This collapses 1001 nested `Promise.all` calls into one, cutting
significant microtask scheduling overhead. Combined with #8
(pre-grouped wires), each resolution also skips the `bridge.wires.filter`
call entirely.

Nested arrays (where `deepPaths.size > 0`) take a slow path that uses
#8 pre-grouped wires for direct fields but keeps the existing
`Promise.all(tasks)` structure. Inner nested levels — which have no
`deepPaths` of their own — also benefit from the fast path, which
explains the +33–43% gains on nested benchmarks.

**Why non-tools aren't affected:** Benchmarks without array iteration
(passthrough, simple chain, chained fan-out) don't call `materializeShadows`
at all, so they see no change.

### 10. Sync fast path for resolved values

**Date:** March 2026
**Result:** ✅ +8–17% on all benchmarks, +42–114% on array benchmarks.

| Benchmark                          | Before | After | Change    |
| ---------------------------------- | ------ | ----- | --------- |
| exec: passthrough                  | 610K   | 728K  | **+19%**  |
| exec: short-circuit                | 745K   | 778K  | **+4%**   |
| exec: simple chain                 | 418K   | 457K  | **+9%**   |
| exec: chained 3-tool fan-out       | 156K   | 175K  | **+12%**  |
| exec: flat array 10                | 69K    | 101K  | **+46%**  |
| exec: flat array 100               | 8.0K   | 13.0K | **+63%**  |
| exec: flat array 1000              | 627    | 1,336 | **+113%** |
| exec: nested array 5×5             | 21K    | 29.4K | **+40%**  |
| exec: nested array 10×10           | 6.1K   | 9.0K  | **+48%**  |
| exec: nested array 20×10           | 3.0K   | 4.6K  | **+53%**  |
| exec: array + tool-per-element 10  | 25K    | 27.6K | **+10%**  |
| exec: array + tool-per-element 100 | 2.6K   | 2.97K | **+14%**  |

`pullSingle()` always returned `Promise<any>`, but for element wires like
`.id <- it.id` the value is already synchronously available in
`this.state[key]`. The previous code did `await Promise.resolve(value)` even
when the value was not a Promise, producing **6–7 microtask hops per
element** × 1000 elements = 6000–7000 scheduled microtasks costing
~2.8ms of the 3.7ms total for flat-array-1000.

**Changes made:**

1. **`MaybePromise<T>` type + `isPromise()` helper** — module-level type alias
   and guard (`'then' in (value as any)`) to distinguish live Promises from
   synchronous values without ever constructing a new Promise.

2. **`pullSingle` de-asynced** — `async pullSingle()` replaced with a
   sync-first implementation:

   ```ts
   // sync fast path
   if (!isPromise(value)) return this.applyPath(value, ref);
   // async path only when tool result is still pending
   return (value as Promise<any>).then((resolved) =>
     this.applyPath(resolved, ref),
   );
   ```

   Extracted `applyPath(resolved, ref)` as a private helper for the shared
   path-traversal logic used by both paths.

3. **`resolveWires` fast path** — new method that detects the common case:
   a single `from` wire with no modifiers (no `safe`, no falsy/nullish/catch
   fallbacks). In that case it calls `pullSingle` directly and returns
   `MaybePromise<any>`. All other cases fall through to the existing async
   `resolveWiresAsync` (renamed from the old `resolveWires`).

4. **`materializeShadows` sync collection** — replaced
   `Promise.all(items.flatMap(...))` with a loop that writes into a
   pre-allocated flat array and sets a `hasAsync` flag on the first
   Promise it encounters:
   ```ts
   const rawValues: MaybePromise<unknown>[] = new Array(nItems * nFields);
   let hasAsync = false;
   for (...) {
     const v = shadow.resolvePreGrouped(wireGroupsByPath.get(pathKey)!);
     rawValues[i * nFields + j] = v;
     if (!hasAsync && isPromise(v)) hasAsync = true;
   }
   const flatValues = hasAsync
     ? await Promise.all(rawValues)
     : (rawValues as unknown[]);
   ```
   For element wires where all values come from `state`, `hasAsync` stays
   `false` and no `Promise.all` is ever constructed — zero microtask overhead.

**Why non-array benchmarks also improve (+4–19%):** `resolveWires` is
called for every output field, not just inside array loops. PassThrough,
simple-chain, and fan-out all resolve output wires after tools complete;
those values are already in `state`, so they now go through the sync path
too, eliminating one microtask hop per resolved output field.

### 11. Pre-compute keys & cache wire tags

**Date:** March 2026
**Result:** ✅ +12–16% on all benchmarks, +60–129% on array benchmarks.

| Benchmark                          | Before | After | Change    |
| ---------------------------------- | ------ | ----- | --------- |
| exec: passthrough                  | 728K   | 846K  | **+16%**  |
| exec: short-circuit                | 778K   | 811K  | **+4%**   |
| exec: simple chain                 | 457K   | 486K  | **+6%**   |
| exec: chained 3-tool fan-out       | 175K   | 194K  | **+11%**  |
| exec: flat array 10                | 101K   | 170K  | **+68%**  |
| exec: flat array 100               | 13.0K  | 28.3K | **+118%** |
| exec: flat array 1000              | 1,336  | 3,064 | **+129%** |
| exec: nested array 5×5             | 29.4K  | 46.7K | **+59%**  |
| exec: nested array 10×10           | 9.0K   | 17.5K | **+94%**  |
| exec: nested array 20×10           | 4.6K   | 8.8K  | **+91%**  |
| exec: array + tool-per-element 10  | 27.6K  | 30.9K | **+12%**  |
| exec: array + tool-per-element 100 | 2.97K  | 3.43K | **+15%**  |

Four micro-optimisations that eliminate string allocation and redundant
property checks from the hottest loops:

1. **Cached `trunkKey` on NodeRef** — `pullSingle` memoises the
   state-map key per AST node as `ref[TRUNK_KEY_CACHE] ??= trunkKey(ref)`.
   For a 1000-element array pulling 3 fields, this eliminates 3000
   template-literal concatenations per execution. The cache is stored
   under a `Symbol` key so V8 keeps it in a separate backing store that
   doesn't participate in hidden-class transitions — the parser's object
   shapes remain stable even though the engine writes to them at runtime.

2. **Pre-computed `pathKeys` in `materializeShadows`** — the path-key
   array (`[...pathPrefix, field].join("\0")`) only depends on the field
   index, not the element index. Hoisted out of the N×F loop into an
   F-length pre-computed array, eliminating N×F array spreads and joins
   (e.g. 3000 down to 3 for flat-array-1000).

3. **Cached `getSimplePullRef(wire)`** — the 11-property fast-path check
   in `resolveWires` is now computed once per wire and cached as
   `wire[SIMPLE_PULL_CACHE]` (the `from` NodeRef, or `null`). Subsequent
   calls are a single property read. Also a `Symbol` key (same rationale
   as `TRUNK_KEY_CACHE`). For element wires in the hot path this turns
   11 sequential null checks per field per element into 1.

4. **Constant cache cap** — `constantCache` is now hard-capped at 10,000
   entries. When exceeded the Map is cleared rather than growing
   unboundedly. No performance impact; pure safety hygiene for
   long-lived processes.

### 12. De-async schedule() & callTool()

**Date:** March 2026
**Result:** ✅ +11–18% on tool-calling benchmarks, ~0% on pure array benchmarks.

| Benchmark                          | Before | After | Change   |
| ---------------------------------- | ------ | ----- | -------- |
| exec: passthrough                  | 846K   | 830K  | ~0%      |
| exec: short-circuit                | 811K   | 801K  | ~0%      |
| exec: simple chain                 | 486K   | 558K  | **+15%** |
| exec: chained 3-tool fan-out       | 194K   | 216K  | **+11%** |
| exec: flat array 10                | 170K   | 175K  | ~0%      |
| exec: flat array 100               | 28.3K  | 28.2K | ~0%      |
| exec: flat array 1000              | 3,064  | 2,980 | ~0%      |
| exec: nested array 5×5             | 46.7K  | 47.7K | ~0%      |
| exec: nested array 10×10           | 17.5K  | 17.5K | ~0%      |
| exec: nested array 20×10           | 8.8K   | 9.0K  | ~0%      |
| exec: array + tool-per-element 10  | 30.9K  | 36.5K | **+18%** |
| exec: array + tool-per-element 100 | 3.43K  | 3.98K | **+16%** |

`schedule()` previously wrapped its entire body in `(async () => { ... })()`,
always creating a Promise — even for `__local` bindings, `__define_` pass-throughs,
and `__and`/`__or` logic nodes that need no tool call and whose wires resolve
synchronously. Similarly, `callTool` was declared `async`, forcing a Promise
wrapper even when the tool function (e.g. internal math/string ops) returns
synchronously.

**Changes made:**

1. **`schedule` returns `MaybePromise<any>`** — Wire collection, grouping,
   and `resolveToolDefByName` remain synchronous at the top. For targets
   with a `toolDef`, the new `scheduleToolDef` async helper handles the
   full async path. For targets without a `toolDef` (locals, defines,
   logic nodes, pipe forks with sync tools), bridge wires are resolved
   via `resolveWires` (which already returns `MaybePromise`). If all
   wires resolve sync, `scheduleFinish` assembles the result and returns
   synchronously.

2. **`callTool` de-asynced** — Removed the `async` keyword. The
   no-instrumentation fast path (`return fnImpl(input, toolContext)`) now
   returns whatever `fnImpl` returns directly — sync for internal tools
   (math, string ops, concat, etc.), Promise for async tools (httpCall).
   The instrumented path returns a Promise via `otelTracer.startActiveSpan`.

3. **`scheduleFinish` helper** — Extracted the input-assembly + direct-fn-lookup
   - pass-through logic into a private method that returns `MaybePromise<any>`.
     For `__local`/`__define_`/logic targets with no direct function, this
     returns synchronously. For pipe forks backed by sync internal tools,
     `callTool` returns sync too, so the entire call chain stays sync.

**Why pure array benchmarks are unchanged:** Flat/nested array benchmarks
use element passthrough wires (`.id <- it.id`) with no per-element tool
calls. Their inner loop never calls `schedule` or `callTool` — it
resolves wires directly via `resolvePreGrouped` → `resolveWires` →
`pullSingle`, which were already sync-capable from #10.

**Why tool-calling benchmarks improve (+11–18%):** `simple chain` and
`chained 3-tool fan-out` each schedule 1–3 internal tool calls. Now that
`schedule` skips the async IIFE and `callTool` skips the `async` wrapper,
each tool call eliminates 2 microtask hops. `tool-per-element` benefits
the most: 10–100 tool calls per execution, each now fully synchronous.
