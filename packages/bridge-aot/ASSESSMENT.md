# Bridge AOT Compiler — Feasibility Assessment

> **Status:** Experimental proof-of-concept  
> **Package:** `@stackables/bridge-aot`  
> **Date:** March 2026

---

## What It Does

The AOT (Ahead-of-Time) compiler takes a parsed `BridgeDocument` and a target
operation (e.g. `"Query.livingStandard"`) and generates a **standalone async
JavaScript function** that executes the same data flow as the runtime
`ExecutionTree` — but without any of the runtime overhead.

### Supported features (POC)

| Feature | Status | Example |
|---------|--------|---------|
| Pull wires (`<-`) | ✅ | `out.name <- api.name` |
| Constant wires (`=`) | ✅ | `api.method = "GET"` |
| Nullish coalescing (`??`) | ✅ | `out.x <- api.x ?? "default"` |
| Falsy fallback (`\|\|`) | ✅ | `out.x <- api.x \|\| "fallback"` |
| Falsy ref chain (`\|\|`) | ✅ | `out.x <- primary.x \|\| backup.x` |
| Conditional/ternary | ✅ | `api.mode <- i.premium ? "full" : "basic"` |
| Array mapping | ✅ | `out.items <- api.list[] as el { .id <- el.id }` |
| Context access | ✅ | `api.token <- ctx.apiKey` |
| Nested input paths | ✅ | `api.q <- i.address.city` |
| Root passthrough | ✅ | `o <- api` |

### Not yet supported

| Feature | Complexity | Notes |
|---------|-----------|-------|
| `catch` fallbacks | Medium | Requires try/catch wrapping around tool calls |
| `force` statements | Medium | Side-effect tools, fire-and-forget |
| Tool definitions (ToolDef) | High | Wire merging, inheritance, `on error` |
| `define` blocks | High | Inline subgraph expansion |
| Pipe operator chains | High | Fork routing, pipe handles |
| Overdefinition | Medium | Multiple wires to same target, null-boundary |
| `safe` navigation (`?.`) | Low | Already uses `?.` for all paths; needs error swallowing |
| `break` / `continue` | Medium | Array control flow sentinels |
| Tracing / observability | High | Would need to inject instrumentation |
| Abort signal support | Low | Check `signal.aborted` between tool calls |
| Tool timeout | Medium | `Promise.race` with timeout |

---

## Performance Analysis

### What the runtime ExecutionTree does per request

1. **State map management** — creates a `Record<string, any>` state object,
   computes trunk keys (string concatenation + map lookups) for every wire
   resolution.

2. **Wire resolution loop** — for each output field, walks backward through
   wires: matches trunk keys, evaluates fallback layers (falsy → nullish →
   catch), handles overdefinition boundaries.

3. **Dynamic dispatch** — `pullSingle` recursively schedules tool calls via
   `schedule()`, which groups wires by target, looks up ToolDefs, resolves
   dependencies, merges inherited wires, and finally calls the tool function.

4. **Shadow trees** — for array mapping, creates lightweight clones
   (`shadow()`) per array element, each with its own state map.

5. **Promise management** — `isPromise` checks, `MaybePromise` type unions,
   sync/async branching at every level.

### What AOT eliminates

| Overhead | Runtime cost | AOT |
|----------|-------------|-----|
| Trunk key computation | String concat + map lookup per wire | **Zero** — resolved at compile time |
| Wire matching | `O(n)` scan per target | **Zero** — direct variable references |
| State map reads/writes | Hash map get/set per resolution | **Zero** — local variables |
| Topological ordering | Implicit via recursive pull | **Zero** — pre-sorted at compile time |
| ToolDef resolution | Map lookup + inheritance chain walk | **Zero** — inlined at compile time |
| Shadow tree creation | `Object.create` + state setup per element | **Replaced** by `.map()` call |
| Promise branching | `isPromise()` check at every level | **Simplified** — single `await` per tool |
| Safe-navigation | try/catch wrapping | `?.` optional chaining (V8-optimized) |

### Expected performance characteristics

**Latency reduction:**
- The runtime ExecutionTree has ~0.5–2ms of pure framework overhead per
  request (measured on simple bridges with fast/mocked tools). This overhead
  comes from trunk key computation, wire matching, state map operations, and
  promise management.
- AOT-compiled code eliminates this entirely. The generated function is a
  straight-line sequence of `await` calls and property accesses — the only
  latency is the actual tool execution time.
- For bridges with many tools (5+), the savings compound because the runtime
  does O(wires × tools) work for scheduling, while AOT does O(tools) with
  pre-computed dependency order.

**Throughput improvement:**
- Fewer allocations: no state maps, no trunk key strings, no wire arrays.
- Better V8 optimization: the generated function has a stable shape that V8
  can inline and optimize. The runtime's polymorphic dispatch (multiple wire
  types, MaybePromise branches) defeats V8's inline caches.
- Reduced GC pressure: no per-request shadow trees or intermediate objects.

**Estimated improvement: 2–5× for simple bridges, 5–10× for complex ones**
(based on framework overhead ratio to total request time).

### Where AOT does NOT help

- **Network-bound workloads:** If tools spend 50ms+ making HTTP calls, the
  0.5ms framework overhead is noise. AOT helps most when tool execution is
  fast (in-memory transforms, math, data reshaping).
- **Dynamic routing:** Bridges that use `define` blocks, pipe operators, or
  runtime tool selection can't be fully ahead-of-time compiled.
- **Tracing/observability:** The runtime's built-in tracing adds overhead but
  provides essential debugging information. AOT would need to re-implement
  this as optional instrumentation.

---

## Feasibility Assessment

### Is this realistic to support alongside the current executor?

**Yes, with caveats.** The AOT compiler can coexist with the runtime executor
as an optional optimization path. Here's the analysis:

#### Advantages

1. **Complementary, not competing.** AOT handles the "hot path" (production
   requests) while the runtime handles the "dev path" (debugging, tracing,
   dynamic features). Users opt in per-bridge.

2. **Minimal maintenance burden.** The codegen is ~500 lines and operates on
   the same AST. When new wire types are added, both the runtime and AOT need
   updates, but the AOT changes are simpler (emit code vs. evaluate code).

3. **Clear subset.** Not every feature needs AOT support. ToolDefs with
   inheritance, define blocks, and pipe operators can fall back to the runtime.
   The AOT compiler can throw a clear error: "This bridge uses features not
   supported by AOT compilation."

4. **Easy integration.** The generated function has the same interface as
   `executeBridge` — `(input, tools, context) → Promise<data>`. It can be a
   drop-in replacement in the GraphQL resolver layer.

#### Challenges

1. **Feature parity gap.** The runtime supports features that are hard to
   compile statically: overdefinition (multiple wires targeting the same path
   with null-boundary semantics), error recovery chains, and dynamic tool
   resolution. Supporting these would roughly double the codegen complexity.

2. **Testing surface.** Every codegen path needs correctness tests that mirror
   the runtime's behavior. This is a significant ongoing investment — any
   semantic change in the runtime needs a corresponding codegen update.

3. **Error reporting.** The runtime provides rich error context (which wire
   failed, which tool threw, stack traces through the execution tree). AOT
   errors are raw JavaScript errors with less context.

4. **Versioning.** If the AST format changes, the AOT compiler must be
   updated in lockstep. This couples the compiler and runtime release cycles.

#### Recommendation

**Ship as experimental (`@stackables/bridge-aot`) with a clear feature
subset.** Target bridges that:

- Use only pull wires, constants, and simple fallbacks
- Don't use ToolDefs with inheritance or `define` blocks
- Are on the hot path and benefit from reduced latency

Add a `compileBridge()` check that validates the bridge uses only supported
features, and throw a descriptive error otherwise. This lets users
incrementally adopt AOT for their performance-critical bridges while keeping
the full runtime for everything else.

---

## Example: Generated Code

Given this bridge:

```bridge
bridge Query.catalog {
  with api as src
  with output as o

  o.title <- src.name
  o.entries <- src.items[] as item {
    .id <- item.item_id
    .label <- item.item_name
  }
}
```

The AOT compiler generates:

```javascript
export default async function Query_catalog(input, tools, context) {
  const _t1 = await tools["api"]({});
  return {
    "title": _t1?.["name"],
    "entries": (_t1?.["items"] ?? []).map((_el) => ({
      "id": _el?.["item_id"],
      "label": _el?.["item_name"],
    })),
  };
}
```

This is a zero-overhead function — the only cost is the tool call itself.

---

## Next Steps

If the team decides to proceed:

1. **Add `catch` fallback support** — wrap tool calls in try/catch, emit
   fallback expressions.
2. **Add `force` statement support** — emit `Promise.all` for side-effect
   tools.
3. **Add ToolDef support** — merge tool definition wires with bridge wires at
   compile time.
4. **Benchmark suite** — use tinybench (already in the repo) to compare
   runtime vs. AOT on representative bridges.
5. **Integration with `executeBridge`** — add an `aot: true` option that
   automatically compiles and caches the generated function.
6. **Source maps** — generate source maps pointing back to the `.bridge` file
   for debugging.
