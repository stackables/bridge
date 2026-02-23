# Bridge Roadmap

## v2.0 (Feb-Mar 2026)

Transformed Bridge from a naive script executor into a cost-based declarative dataflow engine, replaced the hand-rolled regex parser with Chevrotain, and shipped a VS Code extension with LSP.

### Conditional Wire (Ternary) -- DONE

A conditional wire selects between two sources based on a boolean predicate.
Distinct from the existing operators:

- `||` = null-coalescing (try A, if null try B)
- `??` = error-coalescing (try A, if it throws try B)
- `? :` = **selection** (check condition, pull exactly one branch)

**Syntax:**
```bridge
bridge Query.smartPrice {
  with stripe
  with input as i
  with output as o

  o.amount <- i.isPro ? stripe.proPrice : stripe.basicPrice
}
```

**Semantics:** The condition is evaluated first (benefits from cost-0 fast-path for input/context reads), then **only** the chosen branch is pulled. The other branch is never touched — lazy evaluation of each branch prevents unnecessary tool calls.

The condition can be any source expression, including comparison expressions: `i.age >= 18 ? i.proPrice : i.basicPrice`. String, number, boolean, and null literals are supported as branches. Ternary composes naturally with the array mapping syntax (`[] as iter { .price <- item.isPro ? item.proPrice : item.basicPrice }`).

**Implementation:** One new `Wire` variant (`{ cond, thenRef?, thenValue?, elseRef?, elseValue?, to }`), a `ternaryBranch` grammar rule with a `?` token, and a dedicated code path in `ExecutionTree.resolveWires()` that evaluates the condition then pulls the appropriate branch sequentially.

### Sequential Cost-Sorted Fallbacks -- DONE

**Problem:** `||` and `??` operators raced sources concurrently via `Promise.all`, paying for expensive API calls even when cheap data was available.

**Solution:** `pull()` now evaluates multiple refs sequentially with short-circuit, sorted by `inferCost()` (cost 0 = memory reads, cost 1 = network calls). The only `Promise.all` remaining is across independent target paths (correct -- they are independent).

### Overdefinition Optimization -- DONE

**Problem:** Multiple wires to the same target were raced via `Promise.all()`.

**Solution:** Same `inferCost()` + sequential `pull()` mechanism. Cheap memory reads (input, context, const) are always tried before expensive network calls.

### Scope Chain Fix -- DONE

**Problem:** Shadow trees didn't look up past their immediate parent for `context` and `const`.

**Solution:** All lookup paths (`pullSingle`, `resolveToolSource`, `resolveToolDep`, `inferCost`) now walk the full parent chain via iterative `while (cursor) { cursor = cursor.parent }` loops.

### Chevrotain Parser -- DONE

**Problem:** The regex parser (~2000 lines) relied on string splitting and manual bracket counting. It broke on `#` or `{` inside strings and failed completely on the first syntax error.

**Solution:** Full Chevrotain compiler pipeline: ~40 token types, CstParser with grammar rules, CST-to-AST visitor producing the same `Instruction[]` types. Two parser instances: strict (runtime) and recovery-enabled (LSP). Old regex parser stripped to thin shim + serializer. Validated against 311 unit tests + 19 e2e tests.

### VS Code Extension (LSP) -- DONE

**Problem:** No IDE support for `.bridge` files.

**Solution:** Published `bridge-syntax-highlight` v0.5.0 with TextMate grammar, Language Server with real-time diagnostics (lex, parse, and semantic errors), hover provider, and `parseBridgeDiagnostics()` public API.

### Observability -- DONE

**Problem:** The engine was a black box — no visibility into which tools were called, how long they took, or why a request failed.

**Solution:** Three complementary pillars, all opt-in and zero-cost when disabled:

- **OpenTelemetry spans** — every tool call gets a span named `bridge.tool.<tool>.<fn>` with `bridge.tool.name` and `bridge.tool.fn` attributes. `span.recordException()` + `SpanStatusCode.ERROR` on failure. Works with any OTel-compatible backend (Jaeger, Honeycomb, Datadog, etc.).
- **OTel metrics** — three instruments on the `@stackables/bridge` meter: `bridge.tool.calls` (counter), `bridge.tool.duration` (histogram, ms), `bridge.tool.errors` (counter). All share the same attribute keys so they join cleanly in dashboards.
- **Structured tool traces** — per-request `ToolTrace[]` returned alongside the GraphQL response. Two levels: `"basic"` (tool, fn, timing, errors) and `"full"` (adds input/output). A Yoga plugin (`useBridgeTracing`) exposes traces in the response extensions under `bridgeTraces`.
- **Structured logging** — `logger?: Logger` option accepts any pino/winston/console-compatible interface. Debug on success, error on failure, warn on array-access footguns. Silent no-ops by default.

**API:** `trace?: "off" | "basic" | "full"` (default `"off"`). All instrumentation funnels through a single `callTool()` method — one instrumentation site, three tool-call paths covered.

### Inline Expressions (Math & Comparisons) -- DONE

**Problem:** E-commerce and business logic use cases require arithmetic transformations and boolean conditions directly in wire assignments. Without expressions, users must create custom tools for trivial operations like `price * 100` or `age >= 18`.

**Solution:** Infix expression syntax on the right side of `<-`: `o.cents <- i.dollars * 100`, `o.eligible <- i.age >= 18`. Supports `*`, `/`, `+`, `-` (arithmetic) and `==`, `!=`, `>`, `>=`, `<`, `<=` (comparison). Standard operator precedence applies (`*`/`/` before `+`/`-` before comparisons). Comparisons return native booleans (`true`/`false`).

Expressions are **parser-level syntactic sugar**: the Chevrotain parser desugars them into synthetic tool forks using built-in `math` namespace tools (`multiply`, `divide`, `add`, `subtract`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`). The execution engine never sees expression syntax — it processes standard pull/constant wires. This keeps `inferCost`, `pull`, and OpenTelemetry logic clean.

Expressions compose with existing operators: `||` null coalesce, `??` error coalesce, `<-!` force wires, and `[] as iter { }` array mapping all work with expression results.

### ~~Fat Wire IR Refactor~~ -- DROPPED

**Original concern:** The Wire type carries logic (`nullFallback`, `fallbackRef`, `force`, `pipe`), forcing heavy branching in the execution loop. Proposed splitting into separate `GraphNode` and `Edge` types.

**Resolution:** After analysis, this is a non-problem. Only 5 branch sites in the 831-line engine, each handling one wire property in isolation. The Wire type is a clean 2-variant discriminated union. Splitting into Node/Edge IR would add abstraction without reducing complexity.

### ~~Conditional Block (Scoped Wiring)~~ -- DROPPED

**Original idea:** `if condition { ... }` block syntax for gating multiple fields behind a condition.

**Resolution:** Syntactic sugar for N ternary wires where false maps to null. Introduces scoped wire groups (new IR concept) with nesting complexity. The lazy evaluation benefit already falls out from per-wire ternaries. Can be revisited as a parser-level desugaring if the pattern emerges in practice.
