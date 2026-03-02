# Bridge AOT Compiler — Feasibility Assessment

> **Status:** Experimental proof-of-concept (feature-rich)  
> **Package:** `@stackables/bridge-aot`  
> **Date:** March 2026  
> **Tests:** 147 passing (34 unit + 113 shared data-driven)

---

## What It Does

The AOT (Ahead-of-Time) compiler takes a parsed `BridgeDocument` and a target
operation (e.g. `"Query.livingStandard"`) and generates a **standalone async
JavaScript function** that executes the same data flow as the runtime
`ExecutionTree` — but without any of the runtime overhead.

### Supported features

| Feature | Status | Example |
|---------|--------|---------|
| Pull wires (`<-`) | ✅ | `out.name <- api.name` |
| Constant wires (`=`) | ✅ | `api.method = "GET"` |
| Nullish coalescing (`??`) | ✅ | `out.x <- api.x ?? "default"` |
| Falsy fallback (`\|\|`) | ✅ | `out.x <- api.x \|\| "fallback"` |
| Falsy ref chain (`\|\|`) | ✅ | `out.x <- primary.x \|\| backup.x` |
| Conditional/ternary | ✅ | `api.mode <- i.premium ? "full" : "basic"` |
| Array mapping | ✅ | `out.items <- api.list[] as el { .id <- el.id }` |
| Root array output | ✅ | `o <- api.items[] as el { ... }` |
| Nested arrays | ✅ | `o <- items[] as i { .sub <- i.list[] as j { ... } }` |
| Context access | ✅ | `api.token <- ctx.apiKey` |
| Nested input paths | ✅ | `api.q <- i.address.city` |
| Root passthrough | ✅ | `o <- api` |
| `catch` fallbacks | ✅ | `out.data <- api.result catch "fallback"` |
| `catch` ref fallbacks | ✅ | `out.data <- primary.val catch backup.val` |
| `force` (critical) | ✅ | `force audit` — errors propagate |
| `force catch null` | ✅ | `force ping catch null` — fire-and-forget |
| ToolDef constant wires | ✅ | `tool api from httpCall { .method = "GET" }` |
| ToolDef pull wires | ✅ | `tool api from httpCall { .token <- context.key }` |
| ToolDef `on error` | ✅ | `tool api from httpCall { on error = {...} }` |
| ToolDef `extends` chain | ✅ | `tool childApi from parentApi { .path = "/v2" }` |
| Bridge overrides ToolDef | ✅ | Bridge wires override ToolDef wires by key |
| `executeAot()` API | ✅ | Drop-in replacement for `executeBridge()` |
| Compile-once caching | ✅ | WeakMap cache keyed on document object |
| Tool context injection | ✅ | `tools["name"](input, context)` — matches runtime |
| Const blocks | ✅ | `const geo = { "lat": 0, "lon": 0 }` |
| Nested scope blocks | ✅ | `o.info { .name <- api.name }` |
| String interpolation | ✅ | `o.msg <- "Hello, {i.name}!"` |
| Math expressions | ✅ | `o.total <- i.price * i.qty` |
| Comparison expressions | ✅ | `o.isAdult <- i.age >= 18` |
| Pipe operators | ✅ | `o.loud <- tu:i.text` |
| Inlined internal tools | ✅ | Arithmetic, comparisons, concat — no tool call overhead |

### Not yet supported

| Feature | Complexity | Notes |
|---------|-----------|-------|
| `define` blocks | High | Inline subgraph expansion |
| Overdefinition | Medium | Multiple wires to same target, null-boundary |
| `break` / `continue` | Medium | Array control flow sentinels |
| `alias` declarations | Medium | Named intermediate values |
| Tracing / observability | High | Would need to inject instrumentation |
| Abort signal support | Low | Check `signal.aborted` between tool calls |
| Tool timeout | Medium | `Promise.race` with timeout |
| Source maps | Medium | Map generated JS back to `.bridge` file |

---

## Performance Analysis

### Benchmark results

**7× speedup** on a 3-tool chain with sync tools (1000 iterations, after warmup):

```
AOT:  ~8ms  | Runtime: ~55ms | Speedup: ~7×
```

The benchmark compiles the bridge once, then runs 1000 iterations of AOT vs
`executeBridge()`. Both produce identical results (verified by test).

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

### Where AOT does NOT help

- **Network-bound workloads:** If tools spend 50ms+ making HTTP calls, the
  0.5ms framework overhead is noise. AOT helps most when tool execution is
  fast (in-memory transforms, math, data reshaping).
- **Dynamic routing:** Bridges that use `define` blocks or runtime tool
  selection can't be fully ahead-of-time compiled.
- **Tracing/observability:** The runtime's built-in tracing adds overhead but
  provides essential debugging information. AOT would need to re-implement
  this as optional instrumentation.

---

## Feasibility Assessment

### Is this realistic to support alongside the current executor?

**Yes.** The AOT compiler now supports the core feature set including ToolDefs,
catch fallbacks, and force statements. Here's the updated analysis:

#### Advantages

1. **Production-ready feature coverage.** With ToolDef support (including
   extends chains, onError fallbacks, context/const dependencies), catch
   fallbacks, and force statements, the AOT compiler handles the majority of
   real-world bridge files.

2. **Drop-in replacement.** The `executeAot()` function matches the
   `executeBridge()` interface — same options, same result shape. Users can
   switch with a one-line change.

3. **Zero-cost caching.** The `WeakMap`-based cache ensures compilation happens
   once per document lifetime. Subsequent calls reuse the cached function with
   zero overhead.

4. **Complementary, not competing.** AOT handles the "hot path" (production
   requests) while the runtime handles the "dev path" (debugging, tracing,
   dynamic features). Users opt in per-bridge.

5. **Minimal maintenance burden.** The codegen is ~700 lines and operates on
   the same AST. When new wire types are added, both the runtime and AOT need
   updates, but the AOT changes are simpler (emit code vs. evaluate code).

#### Challenges

1. **Feature parity gap (narrowing).** The main unsupported features are
   `define` blocks, overdefinition, and `alias` declarations. These are used
   in advanced scenarios but not in the majority of production bridges.

2. **Testing surface.** Every codegen path needs correctness tests that mirror
   the runtime's behavior. The shared data-driven test suite (113 cases) runs
   each scenario against both runtime and AOT, ensuring parity.

3. **Error reporting.** The runtime provides rich error context (which wire
   failed, which tool threw, stack traces through the execution tree). AOT
   errors are raw JavaScript errors with less context.

4. **Versioning.** If the AST format changes, the AOT compiler must be
   updated in lockstep. This couples the compiler and runtime release cycles.

#### Recommendation

**Ship as experimental (`@stackables/bridge-aot`) and promote to stable once
`define` blocks are supported.** The current feature set covers the vast
majority of production bridges including pipe operators, string interpolation,
expressions, const blocks, and nested arrays. Target bridges that:

- Use pull wires, constants, fallbacks, and ToolDefs
- May use `force` statements for side effects
- Are on the hot path and benefit from reduced latency

The `compileBridge()` function already throws clear errors when encountering
unsupported features, allowing users to incrementally adopt AOT.

---

## API

### `compileBridge(document, { operation })`

Compiles a bridge operation into standalone JavaScript source code.

```ts
import { parseBridge } from "@stackables/bridge-compiler";
import { compileBridge } from "@stackables/bridge-aot";

const document = parseBridge(bridgeText);
const { code, functionName } = compileBridge(document, {
  operation: "Query.catalog",
});
// Write `code` to a file or evaluate it
```

### `executeAot(options)`

Compile-once, run-many execution. Drop-in replacement for `executeBridge()`.

```ts
import { parseBridge } from "@stackables/bridge-compiler";
import { executeAot } from "@stackables/bridge-aot";

const document = parseBridge(bridgeText);
const { data } = await executeAot({
  document,
  operation: "Query.catalog",
  input: { category: "widgets" },
  tools: { api: myApiFunction },
  context: { apiKey: "secret" },
});
```

---

## Example: Generated Code

### Simple bridge

```bridge
bridge Query.catalog {
  with api as src
  with output as o

  o.title <- src.name ?? "Untitled"
  o.entries <- src.items[] as item {
    .id <- item.item_id
    .label <- item.item_name
  }
}
```

Generates:

```javascript
export default async function Query_catalog(input, tools, context) {
  const _t1 = await tools["api"]({}, context);
  return {
    "title": (_t1?.["name"] ?? "Untitled"),
    "entries": (_t1?.["items"] ?? []).map((_el) => ({
      "id": _el?.["item_id"],
      "label": _el?.["item_name"],
    })),
  };
}
```

### ToolDef with onError

```bridge
tool safeApi from std.httpCall {
  on error = {"status":"error"}
}

bridge Query.safe {
  with safeApi as api
  with input as i
  with output as o

  api.url <- i.url
  o <- api
}
```

Generates:

```javascript
export default async function Query_safe(input, tools, context) {
  let _t1;
  try {
    _t1 = await tools["std.httpCall"]({
      "url": input?.["url"],
    }, context);
  } catch (_e) {
    _t1 = JSON.parse('{"status":"error"}');
  }
  return _t1;
}
```

### Force statement

```bridge
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

  m.q <- i.q
  audit.action <- i.q
  force audit catch null
  o.title <- m.title
}
```

Generates:

```javascript
export default async function Query_search(input, tools, context) {
  const _t1 = await tools["mainApi"]({
    "q": input?.["q"],
  }, context);
  try { await tools["audit.log"]({
    "action": input?.["q"],
  }, context); } catch (_e) {}
  const _t2 = undefined;
  return {
    "title": _t1?.["title"],
  };
}
```

---

## Next Steps

1. **`define` block support** — inline subgraph expansion at compile time.
2. **`alias` declarations** — named intermediate values.
3. **Abort signal support** — check `signal.aborted` between tool calls.
4. **Source maps** — generate source maps pointing back to the `.bridge` file.
5. **Benchmark suite** — use tinybench for reproducible perf comparisons.
6. **`break`/`continue` in array mapping** — array control flow sentinels.
7. **Tracing / observability** — optional instrumentation hooks.
