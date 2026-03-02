# Profiling Guide

A systematic approach to finding and diagnosing performance bottlenecks in the Bridge engine. This guide is designed for both humans and LLM agents.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [When to Profile](#when-to-profile)
3. [Profiling Decision Tree](#profiling-decision-tree)
4. [Tool Reference](#tool-reference)
   - [Benchmarks (tinybench)](#1-benchmarks-tinybench)
   - [CPU Profiling](#2-cpu-profiling)
   - [Flamegraphs](#3-flamegraphs)
   - [V8 Tick Profiling](#4-v8-tick-profiling)
   - [Deoptimization Analysis](#5-deoptimization-analysis)
   - [Heap Profiling](#6-heap-profiling)
   - [GC Analysis](#7-gc-analysis)
   - [A/B Comparison](#8-ab-comparison)
5. [Profiling Methodology](#profiling-methodology)
6. [Interpreting Results](#interpreting-results)
7. [Architecture Hot Paths](#architecture-hot-paths)
8. [Common Bottleneck Patterns](#common-bottleneck-patterns)
9. [Checklist: Performance Investigation](#checklist-performance-investigation)
10. [Tips for LLM Agents](#tips-for-llm-agents)

---

## Quick Start

```bash
# Install dependencies (once)
pnpm install

# 1. Run benchmarks — establish baseline
pnpm bench

# 2. Generate a CPU profile for a specific benchmark
pnpm profile:cpu -- --filter "flat array 1000"

# 3. View as flamegraph
pnpm profile:flamegraph

# 4. Compare your branch to main
pnpm bench:compare main
```

All profiling output goes to `profiles/` (gitignored).

---

## When to Profile

Profile when you observe or suspect one of these:

| Signal                             | What to use                             |
| ---------------------------------- | --------------------------------------- |
| Benchmark ops/sec dropped          | `pnpm bench:compare main`               |
| Specific benchmark is slow         | `pnpm profile:cpu -- --filter "<name>"` |
| Need to understand where time goes | `pnpm profile:flamegraph -- --generate` |
| Suspecting GC pressure             | `pnpm profile:heap -- --gc`             |
| Object shape / hidden class issues | `pnpm profile:deopt`                    |
| Need low-level V8 internals        | `pnpm profile:ticks`                    |
| Memory leak in long-running server | `pnpm profile:heap`                     |

**Do NOT profile without a hypothesis.** Aimless profiling wastes time. Formulate a question first: "Is the regression in wire resolution or tool scheduling?" Then choose the narrowest tool that answers it.

---

## Profiling Decision Tree

Follow this flowchart when investigating a performance issue:

```
Start: "Something is slow"
  │
  ├─ Is it a regression from a specific change?
  │   YES → pnpm bench:compare <base-ref>
  │          Identifies WHICH benchmarks regressed
  │   │
  │   └─ Which benchmark regressed?
  │       → pnpm profile:cpu -- --filter "<benchmark>"
  │       → Compare flamegraphs before/after
  │
  ├─ Is it a new optimisation attempt?
  │   YES → 1. pnpm bench (save baseline numbers)
  │          2. Make the change
  │          3. pnpm bench (compare)
  │          4. If improved: pnpm profile:deopt (check no new deopts)
  │          5. If regressed: pnpm profile:cpu -- --filter "<worst>"
  │
  ├─ General "where is time spent?"
  │   → pnpm profile:cpu -- --filter "<scenario>"
  │   → pnpm profile:flamegraph
  │   → Look for wide bars = functions consuming most time
  │
  ├─ Suspecting allocation pressure / GC?
  │   → pnpm profile:heap -- --gc
  │   → Check GC pause frequency and duration
  │   → Look at heap profile for top allocators
  │
  └─ Suspecting type instability / deopts?
      → pnpm profile:deopt
      → Look for repeated deopts on the same function
      → Check for polymorphic property accesses
```

---

## Tool Reference

### 1. Benchmarks (tinybench)

**What:** Micro-benchmarks measuring ops/sec for 14 scenarios covering parsing and execution.

**When:** Always. This is the ground truth for "is it faster or slower?"

```bash
# Run all benchmarks locally (human-readable table)
pnpm bench

# Run in CI mode (JSON output for Bencher)
CI=true pnpm bench
```

**Output:**

```
┌─────────┬───────────────────────────────────────────────┬───────────┬──────────┬──────────┬──────────┬─────────┐
│ (index) │ Name                                          │ ops/sec   │ avg (ms) │ p75 (ms) │ p99 (ms) │ samples │
├─────────┼───────────────────────────────────────────────┼───────────┼──────────┼──────────┼──────────┼─────────┤
│ 0       │ parse: simple bridge                          │ 43,210    │ 0.023    │ 0.023    │ 0.031    │ 129630  │
│ 1       │ exec: flat array 1000 items                   │ 2,980     │ 0.335    │ 0.340    │ 0.410    │ 8940    │
...
```

**Key numbers:**

- `ops/sec` — throughput (higher is better)
- `avg (ms)` — mean latency (lower is better)
- `p75 / p99` — tail latency (check for outliers caused by GC)

**Interpreting changes:**

- < 3% change: noise (within run-to-run variance)
- 3–10%: likely real, but run 3× to confirm
- \> 10%: definitely real

**Benchmark categories and what they stress:**

| Benchmark                | Primary hot path                                           |
| ------------------------ | ---------------------------------------------------------- |
| `parse: simple`          | Chevrotain lexer + parser                                  |
| `parse: large`           | Parser scaling with instruction count                      |
| `exec: passthrough`      | `collectOutput` → `resolveWires` → `pullSingle` (no tools) |
| `exec: short-circuit`    | Overdefinition bypass logic                                |
| `exec: simple chain`     | `schedule` → `callTool` → wire resolution                  |
| `exec: chained 3-tool`   | Multi-handle dependency chains                             |
| `exec: flat array N`     | `materializeShadows` → `shadow()` → `resolvePreGrouped`    |
| `exec: nested array`     | Recursive shadow trees                                     |
| `exec: tool-per-element` | `schedule` + `callTool` per array element                  |

### 2. CPU Profiling

**What:** V8's sampling CPU profiler. Takes a snapshot of the call stack at regular intervals (default: every 100µs) to build a statistical profile of where CPU time is spent.

**When:** You know WHICH scenario is slow and want to know WHERE inside it.

```bash
# Profile all benchmarks
pnpm profile:cpu

# Profile one scenario with high-res sampling
pnpm profile:cpu -- --filter "flat array 1000" --interval 50

# Profile a custom script
pnpm profile:cpu -- --target scripts/profile-target.mjs

# Use the focused profiling target for clean results
BRIDGE_PROFILE_FILTER="flat array 1000" BRIDGE_PROFILE_ITERATIONS=10000 \
  pnpm profile:cpu -- --target scripts/profile-target.mjs
```

**Output:** `profiles/cpu-<timestamp>.cpuprofile`

**View in:**

1. **speedscope** (recommended): `pnpm profile:flamegraph` or https://www.speedscope.app
2. **Chrome DevTools**: Performance tab → Load profile
3. **VS Code**: Install "JavaScript Profiler" extension → load file

**Parameters:**

- `--interval <µs>`: Sampling interval. Lower = more detail but higher overhead. Default 100µs is good. Use 50µs for very fast functions, 200µs to reduce overhead.
- `--filter <name>`: Substring match on benchmark name
- `--target <file>`: Profile an arbitrary Node.js script

### 3. Flamegraphs

**What:** Visual representation of CPU profiles. Wide bars = lots of time. Drill down to see call hierarchy.

**When:** After generating a CPU profile. This is the primary visual analysis tool.

```bash
# Open the latest .cpuprofile
pnpm profile:flamegraph

# Generate a new profile and open it
pnpm profile:flamegraph -- --generate --filter "flat array 1000"

# Open a specific file
pnpm profile:flamegraph -- profiles/cpu-2026-03-02T12-00-00.cpuprofile
```

**Reading a flamegraph:**

- **X-axis** = time proportion (wider = more time)
- **Y-axis** = call stack depth (bottom = entry point, top = leaf functions)
- **Color** = arbitrary (no meaning, just for visual distinction)
- **Click** to zoom into a subtree
- **Look for:** Wide plateaus (functions that dominate), tall narrow spikes (deep call stacks)

**speedscope views:**

- **Time Order**: Shows execution over time (good for spotting GC pauses)
- **Left Heavy**: Merges identical stacks (best for finding hot functions)
- **Sandwich**: Shows both callers and callees of a selected function

### 4. V8 Tick Profiling

**What:** V8's internal profiler (`--prof`). Lower-level than `--cpu-prof` — shows time in JS, C++, GC, IC stubs, and compiler. The most detailed view of V8 internals.

**When:** CPU profile shows time is in "native" or "system" code, or you need to understand GC/compilation overhead.

```bash
pnpm profile:ticks
pnpm profile:ticks -- --filter "simple chain"
```

**Output:**

- `profiles/v8-ticks-<timestamp>.log` — raw tick log
- `profiles/v8-ticks-<timestamp>.txt` — processed summary

**Reading the output:**

```
 [JavaScript]:
   ticks  total  nonlib   name
    234   45.2%   52.1%  resolveWires (bridge-core/src/resolveWires.ts:42)
    156   30.1%   34.7%  pullSingle (bridge-core/src/ExecutionTree.ts:455)
    ...

 [C++]:
   ticks  total  nonlib   name
     32    6.2%    7.1%  v8::internal::Runtime_StringAdd
     ...

 [GC]:
   ticks  total  nonlib   name
     15    2.9%
```

- **JavaScript section**: Time in your JS/TS code. Top functions are the ones to optimise.
- **C++ section**: Time in V8 builtins (string ops, object creation, etc.). High numbers here mean your JS is triggering expensive native operations.
- **GC section**: Time spent in garbage collection. > 5% suggests allocation pressure.

### 5. Deoptimization Analysis

**What:** Detects when V8's optimising compiler (TurboFan) has to "deoptimise" a function — bail out of optimised machine code back to the interpreter because an assumption was violated.

**When:** A function should be fast but isn't. Benchmarks show unexpectedly low ops/sec for simple code. Run-to-run variance is high.

```bash
pnpm profile:deopt
pnpm profile:deopt -- --filter "simple chain"
```

**Output:** `profiles/deopt-<timestamp>.log`

**What deopts mean:**

| Deopt type | Meaning                                       | Severity                             |
| ---------- | --------------------------------------------- | ------------------------------------ |
| `eager`    | Type mismatch detected immediately            | High — function can't stay optimised |
| `soft`     | V8 speculatively deoptimised; may re-optimise | Medium — watch for repeats           |
| `lazy`     | Speculative assumption failed at runtime      | Medium — indicates type instability  |

**Common causes in Bridge code:**

- Changing object shapes after construction (adding properties conditionally)
- Polymorphic `state[key]` accesses where values have different hidden classes
- Using `delete` on objects (changes hidden class)
- Mixing `null` and `undefined` (different types to V8)

**No deopts is the goal.** The Bridge engine has been carefully designed to maintain stable object shapes.

### 6. Heap Profiling

**What:** V8's allocation profiler. Shows which functions allocate the most memory and what types of objects are being created.

**When:** Suspecting memory-related slowdowns: high GC frequency, growing memory usage, allocation-heavy code paths.

```bash
pnpm profile:heap
pnpm profile:heap -- --filter "flat array 1000"
```

**Output:** `profiles/heap-<timestamp>.heapprofile`

**View in:** Chrome DevTools → Memory tab → Load profile

**What to look for:**

- Functions allocating large amounts of short-lived objects (GC pressure)
- Unexpected object types (strings from unnecessary template literals, arrays from spreads)
- Growing retained size (potential memory leak)

### 7. GC Analysis

**What:** Detailed log of every garbage collection event, including pause duration and type.

**When:** Suspecting GC pauses are affecting latency. High p99 vs p75 in benchmarks.

```bash
pnpm profile:heap -- --gc
```

**Output:** `profiles/gc-<timestamp>.log`

**GC event types:**

| Type               | What                        | Impact                    |
| ------------------ | --------------------------- | ------------------------- |
| Scavenge           | Young generation collection | Fast (~0.5ms), frequent   |
| Mark-Compact       | Full heap collection        | Slow (5-50ms), infrequent |
| Minor Mark-Compact | Partial collection          | Medium                    |

**Healthy pattern:** Many scavenges, few mark-compacts, < 5% total time in GC.

**Problematic pattern:** Frequent mark-compacts, objects surviving to old generation, > 10% GC time.

### 8. A/B Comparison

**What:** Runs benchmarks on two git refs and produces a side-by-side comparison table.

**When:** Evaluating a change. This is the definitive "did it get faster or slower?" tool.

```bash
# Compare current working tree against main
pnpm bench:compare main

# Compare two specific branches
pnpm bench:compare main feature-x

# More runs for statistical confidence
pnpm bench:compare main -- --runs 5

# Compare against a specific commit
pnpm bench:compare abc123f
```

**Output:**

```
══════════════════════════════════════════════════════════════════════════════════════════
  Benchmark                                    Base ops/s    Head ops/s     Change
──────────────────────────────────────────────────────────────────────────────────────────
  exec: flat array 1000 items                       2,980         3,200     +7.4% ✅
  exec: simple chain (1 tool)                         558           530     -5.0% ⚠️
══════════════════════════════════════════════════════════════════════════════════════════
```

**Note:** This checks out the base ref, runs benchmarks, then returns to your current branch. It auto-stashes uncommitted changes.

Raw data is saved to `profiles/compare-<timestamp>.json` for further analysis.

---

## Profiling Methodology

### The Scientific Method for Performance

Every performance investigation should follow this structure:

#### Step 1: Observe

Run benchmarks. Note the numbers. Compare to the baseline in `docs/performance.md`.

```bash
pnpm bench
```

Write down: "Benchmark X is Y ops/sec. Expected Z ops/sec. That's a W% difference."

#### Step 2: Hypothesise

Before profiling, write down what you think the cause is. If you can't form a hypothesis, that's fine — the CPU profile will help you form one.

Examples:

- "The regression is in `materializeShadows` because I changed how wire groups are built."
- "The new string interpolation is allocating too many template strings."
- "The fallback chain is triggering unnecessary tool calls."

#### Step 3: Profile (narrow scope)

Profile ONLY the affected benchmark, not everything:

```bash
# Good: focused
pnpm profile:cpu -- --filter "flat array 1000"

# Bad: everything at once (noise drowns the signal)
pnpm profile:cpu
```

#### Step 4: Analyze

Load the profile. Look for:

1. **The widest bar** in the flamegraph — that's where time goes
2. **Unexpected functions** — is something being called that shouldn't be?
3. **Call count** — is a function called 1000× when it should be called 3×?

#### Step 5: Fix & Verify

Make the change. Run the benchmark again. If the number improved:

```bash
# Verify no regressions in other benchmarks
pnpm bench

# Check for deoptimisations introduced
pnpm profile:deopt

# A/B comparison for the record
pnpm bench:compare main
```

#### Step 6: Document

If the change is significant (> 5%), add an entry to `docs/performance.md` following the existing format. Include before/after numbers, what was changed, and why it worked (or didn't).

### Controlling Noise

Benchmark noise is the #1 enemy of performance work. Follow these rules:

1. **Close other applications.** Browsers, Slack, Spotify — anything competing for CPU.
2. **Stay plugged in.** Battery power = thermal throttling = noise.
3. **Run 3× minimum.** One run means nothing. Three runs with consistent results mean something.
4. **Same machine.** Never compare numbers across different hardware.
5. **Let the machine cool.** If you just ran benchmarks, wait 30 seconds before the next run.
6. **Disable Turbo Boost** (if possible). Turbo Boost introduces variance.

For Apple Silicon Macs, the most reliable approach is:

```bash
# Run 3 times, take the median
for i in 1 2 3; do pnpm bench; sleep 10; done
```

### The Focused Profiling Target

The bench harness (tinybench) adds overhead: task management, statistics collection, and time measurement. For CPU profiling, this noise can obscure your actual code.

Use the focused profiling target instead:

```bash
# Runs a single scenario in a tight loop — cleaner profiles
BRIDGE_PROFILE_FILTER="flat array 1000" BRIDGE_PROFILE_ITERATIONS=10000 \
  node --experimental-transform-types --conditions source \
  --cpu-prof --cpu-prof-dir profiles --cpu-prof-interval 50 \
  scripts/profile-target.mjs
```

This:

- Runs 500 warmup iterations (ensures V8 optimisation)
- Runs N iterations in a tight loop (no measurement overhead)
- Produces a clean `.cpuprofile` with only your code

---

## Interpreting Results

### CPU Profile: What the Numbers Mean

A CPU profile shows **self time** and **total time** for each function:

- **Self time**: Time spent IN this function (not in callees)
- **Total time**: Time in this function + all functions it calls

**High self time** = the function itself is expensive (tight loops, string ops, allocations).
**High total time but low self time** = the function is an orchestrator; look at its callees.

### Mapping Profile Functions to Bridge Architecture

When reading profiles, you'll see these function names. Here's what they mean:

| Profile function      | Source file             | What it does                                                 | Why it might be hot                                                     |
| --------------------- | ----------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `_resolveWires`       | `resolveWires.ts`       | Unified wire resolution with 3 modifier layers               | Called per output field per element. Check if fast-path is being taken. |
| `pullSingle`          | `ExecutionTree.ts`      | Resolves a single NodeRef from state or schedules its source | Called for every wire. Check trunk-key cache hits.                      |
| `_schedule`           | `scheduleTools.ts`      | Schedules a tool call, builds input from wires               | Called per tool invocation. Check if sync fast-path is working.         |
| `callTool`            | `ExecutionTree.ts`      | Invokes tool function with tracing                           | Should be fast-pathed when no OTel/logger.                              |
| `_materializeShadows` | `materializeShadows.ts` | Array element materialisation                                | Core array hot path. Check pre-grouped wires and sync fast-path.        |
| `shadow`              | `ExecutionTree.ts`      | Create child execution tree                                  | Should be lightweight (~5 property copies).                             |
| `applyPath`           | `ExecutionTree.ts`      | Traverse `ref.path` on resolved value                        | Short paths (1-2 segments) should be near-zero cost.                    |
| `trunkKey`            | `tree-utils.ts`         | Build state map key from NodeRef                             | Should be cached via `TRUNK_KEY_CACHE` Symbol key.                      |
| `sameTrunk`           | `tree-utils.ts`         | Compare two NodeRefs                                         | Zero-allocation 4-field comparison.                                     |
| `collectOutput`       | `ExecutionTree.ts`      | Materialise all output wires to plain object                 | Orchestrator — check its callees.                                       |
| `parseBridge`         | `bridge-compiler`       | Parse `.bridge` text to AST                                  | Relevant only for parse benchmarks.                                     |

### Red Flags in Profiles

| What you see                                 | What it means                           | Action                                               |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `StringAdd` or `StringConcat` in C++ section | Template literal allocation in hot loop | Cache the string (see opt #4, #11 in performance.md) |
| `NewObject` / `ObjectCreate` in C++          | Object allocation in hot loop           | Reuse objects, avoid spreads in hot paths            |
| `MapGet` / `MapSet` taking > 10%             | Map operations dominant                 | Check if Map keys are strings (allocation) vs cached |
| `Promise` / `AsyncFunctionResume` > 5%       | Async overhead                          | Check if sync fast-path is being bypassed            |
| GC > 5%                                      | Allocation pressure                     | Profile heap to find top allocators                  |
| A function appearing that shouldn't          | Wrong code path taken                   | Check conditional logic, fast-path guards            |
| `Builtin:InterpreterEntryTrampoline`         | Code running interpreted, not optimised | Check for deoptimisations on that function           |

---

## Architecture Hot Paths

These are the critical execution paths, ordered by how frequently they're hit in array-heavy workloads:

### Path 1: Array Element Resolution (hottest)

```
materializeShadows
  → for each element:
      → shadow()                    # ~5ns per element (lightweight clone)
      → resolvePreGrouped(wires)    # delegate to resolveWires
        → resolveWires              # fast-path: single pull wire, no modifiers
          → pullSingle(ref)         # sync: state[trunkKey] → applyPath
```

**Target:** < 300ns per element for simple field copies.

**What makes it fast:**

- `shadow()` copies 12 properties, no constructor
- `resolvePreGrouped` skips per-element wire filtering
- `resolveWires` fast-path: 1 property read (cached `SIMPLE_PULL_CACHE`)
- `pullSingle` sync path: state lookup + path traversal, zero Promises

### Path 2: Tool Scheduling

```
schedule(target)
  → resolveToolDefByName(name)     # cached lookup
  → resolveWires (for each input wire)   # may be sync
  → callTool(name, input)
      → fast-path: no OTel, no logger → fnImpl(input, ctx) directly
```

**Target:** < 2µs overhead per tool call (excluding the tool function itself).

### Path 3: Output Collection

```
collectOutput / response
  → for each output field:
      → resolveWires(field)     # resolves from state (post-tool)
```

**Target:** < 500ns per output field.

---

## Common Bottleneck Patterns

These are the performance anti-patterns discovered during optimisation work (see `docs/performance.md` for the full history):

### 1. String Allocation in Hot Loops

**Symptom:** `StringAdd` / `StringConcat` in V8 tick profile.
**Cause:** Template literals like `` `${a}:${b}:${c}` `` allocating per-call.
**Fix:** Cache the result (e.g., `TRUNK_KEY_CACHE` Symbol on NodeRef).
**Lesson:** For template strings called > 1000×/operation, always cache.

### 2. Unnecessary Promise Wrapping

**Symptom:** `Promise` / `AsyncFunctionResume` / `MicrotaskExecution` in profile.
**Cause:** `async` functions returning synchronous values still create Promises.
**Fix:** Use `MaybePromise<T>` return type + `isPromise()` guard.
**Lesson:** An `async function` always wraps its return in a Promise, even for `return 42`. Remove `async` and return the value directly when possible.

### 3. Map Lookup with Dynamic Keys

**Symptom:** High self-time in `MapGet` / `MapSet`.
**Cause:** Building Map key strings (template literals) on every access.
**Fix:** Don't. Linear scan with `sameTrunk()` beats Map<string, Wire[]> for N ≤ 20.
**Lesson:** O(n) with zero allocation beats O(1) with per-call string allocation for small N.

### 4. WeakMap on Hot Path

**Symptom:** Regression when adding WeakMap-based caching.
**Cause:** `WeakMap.get()` costs ~50-100ns (hash + GC barrier) vs ~5ns for property access.
**Fix:** Don't use WeakMap for per-operation caching. Use plain properties or Symbol keys.
**Lesson:** WeakMap is for long-lived cross-concern caching, not per-request hot paths.

### 5. Nested Promise.all

**Symptom:** Microtask scheduling overhead in array benchmarks.
**Cause:** `Promise.all(N × Promise.all(F fields))` creates N+1 Promise.all calls.
**Fix:** Flatten to single `Promise.all(N × F)`. Or use sync fast-path when all values are resolved.
**Lesson:** `Promise.all` has ~200ns overhead per call. For 1000 elements that's 200µs of pure overhead.

### 6. Object Spread in Hot Paths

**Symptom:** `NewObject` / `CopyObject` in tick profile.
**Cause:** `{ ...parentObj, newProp: value }` creates a full object copy.
**Fix:** Set properties directly or use `Object.create(proto)` for inheritance.
**Lesson:** Every `{ ... }` spread allocates. Fine in setup code, expensive in per-element loops.

---

## Checklist: Performance Investigation

Use this checklist when investigating a regression or evaluating an optimisation:

### Before Starting

- [ ] `pnpm bench` — record baseline numbers
- [ ] Close non-essential applications
- [ ] Plug in power adapter
- [ ] Note hardware (results are machine-specific)

### Identifying the Problem

- [ ] Which benchmark(s) regressed? (or which is the target for optimisation?)
- [ ] How big is the change? (< 3% = noise, 3-10% = maybe, > 10% = real)
- [ ] Is it consistent across 3 runs?
- [ ] If regression: `pnpm bench:compare <last-known-good-ref>`

### Profiling

- [ ] Generate focused CPU profile: `pnpm profile:cpu -- --filter "<name>"`
- [ ] View flamegraph: `pnpm profile:flamegraph`
- [ ] Identify the top 3 functions by self-time
- [ ] Are they expected? (Check against "Architecture Hot Paths" above)
- [ ] Run deopt check: `pnpm profile:deopt -- --filter "<name>"`
- [ ] If GC suspected: `pnpm profile:heap -- --gc --filter "<name>"`

### After Making Changes

- [ ] `pnpm bench` — did the target benchmark improve?
- [ ] `pnpm bench` — did any OTHER benchmarks regress?
- [ ] `pnpm test` — all tests pass?
- [ ] `pnpm e2e` — all e2e tests pass?
- [ ] `pnpm build` — clean build?
- [ ] `pnpm profile:deopt` — no new deoptimisations?
- [ ] If > 5% improvement: document in `docs/performance.md`

---

## Tips for LLM Agents

When asked to investigate or improve performance, follow this protocol:

### 1. Establish baseline first

```bash
pnpm bench
```

Record the exact ops/sec numbers for all benchmarks. You'll need them for before/after comparison.

### 2. Use targeted profiling

Don't profile everything. Pick the benchmark most relevant to your task:

```bash
# For array performance:
pnpm profile:cpu -- --filter "flat array 1000"

# For tool-calling performance:
pnpm profile:cpu -- --filter "simple chain"

# For parsing:
pnpm profile:cpu -- --filter "parse"
```

### 3. Read the existing optimisation history

Before attempting an optimisation, read `docs/performance.md`. Several approaches have already been tried and failed — don't repeat them:

- **Map-based wire indexing** — fails because string key allocation > linear scan for N ≤ 20
- **WeakMap caching** — fails because WeakMap.get() overhead > property access
- Any scheme that replaces `sameTrunk()` with string comparison

### 4. Check the sync fast-path

Many functions have a sync fast-path that avoids Promise creation. When profiling, verify the fast-path is being taken:

- `resolveWires`: should return `MaybePromise`, not always `Promise`
- `pullSingle`: should return sync when value is in `state`
- `schedule`: should avoid async IIFE for locals/defines
- `callTool`: should skip OTel wrapper when no tracer configured

If you see `AsyncFunctionResume` or `Promise.then` in the profile for these functions, the fast-path is being bypassed.

### 5. Measure, don't guess

Never assume an optimisation will work. Run the benchmark before and after:

```bash
# Before
pnpm bench 2>&1 | tee /tmp/bench-before.txt

# Make changes...

# After
pnpm bench 2>&1 | tee /tmp/bench-after.txt

# Compare
diff /tmp/bench-before.txt /tmp/bench-after.txt
```

### 6. Watch for deoptimisations

Any change to object shapes in hot paths can cause V8 deoptimisations:

```bash
pnpm profile:deopt
```

Zero bridge deoptimisations is the target. If your change introduces one, it's likely a net negative even if the algorithmic improvement is sound.

### 7. Small changes, measured individually

Don't combine multiple optimisations in one change. Each should be measured independently because:

- Some optimisations conflict with each other
- A 10% improvement + a 12% regression = net -2% but you won't know which caused what

---

## Available Scripts

| Script                         | npm alias                 | Description                                         |
| ------------------------------ | ------------------------- | --------------------------------------------------- |
| `scripts/profile-cpu.mjs`      | `pnpm profile:cpu`        | Generate V8 CPU profile (.cpuprofile)               |
| `scripts/profile-v8-ticks.mjs` | `pnpm profile:ticks`      | V8 tick profiler (low-level C++/GC breakdown)       |
| `scripts/profile-heap.mjs`     | `pnpm profile:heap`       | Heap allocation profiling + optional GC trace       |
| `scripts/profile-deopt.mjs`    | `pnpm profile:deopt`      | Deoptimization & inline cache analysis              |
| `scripts/flamegraph.mjs`       | `pnpm profile:flamegraph` | Open CPU profile as flamegraph                      |
| `scripts/bench-compare.mjs`    | `pnpm bench:compare`      | A/B benchmark comparison between git refs           |
| `scripts/profile-target.mjs`   | —                         | Focused profiling target (tight loop, clean signal) |

All output goes to `profiles/` (gitignored).
