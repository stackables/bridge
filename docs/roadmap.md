# Bridge Roadmap

Living document. Ideas start in **Open**, move to a release section when committed, and are marked DONE or DROPPED when resolved.

---

## Open

### Browser Playground

A fully client-side interactive playground — no server infra, no proxying, no client secrets leaving the browser.

**Four-panel layout:**
1. **Schema editor** — GraphQL SDL with syntax highlighting and validation
2. **Bridge editor** — `.bridge` file with full LSP (diagnostics, hover, completions)
3. **Query editor** — GraphQL operation editor with schema-aware intellisense
4. **Response panel** — live output from executing the query through the Bridge engine

**Key constraint:** All HTTP calls go directly from the browser to the user's APIs. We never see the traffic or the secrets.

**How it works:**

- **Monaco Editor** for all four panels (VS Code's editor, runs in browser)
- **Bridge LSP as a Web Worker** — `vscode-languageclient` has a browser/worker transport; `parseBridgeDiagnostics()` already runs in pure JS so it needs no Node APIs
- **GraphQL language service** — `graphql-language-service` in a second worker for schema + query intellisense; the schema panel feeds the query panel so completions reflect the user's actual types
- **Bridge engine in browser** — `@stackables/bridge` needs to be audited for Node-only APIs (likely just `httpCall` which we swap for a fetch-based implementation); `ExecutionTree` is pure JS and should bundle cleanly
- **Execution** — user registers tool functions (e.g. wrapping `fetch`) in a small JS snippet panel; the playground wires them into `executeGraph()` and runs the query

**Distribution:** A single `index.html` + static assets, deployable to GitHub Pages or any CDN. No backend.

**Challenges:**
- CORS — user's APIs must allow browser requests; we can surface a clear error when they don't
- Monaco + two language workers will be a large bundle; needs careful code-splitting
- The Bridge LSP worker needs a browser build of the parser (already CJS-compatible via esbuild)

---

Here is a spec for this feature that fits perfectly into your "Open" section. It leverages the fact that you just moved to Chevrotain (which is robust but heavier than regex), making an execution-only runtime incredibly valuable for edge and serverless gateways.


### Split Parser & Engine (AOT Compilation)

A lightweight, execution-only runtime that allows parsing `.bridge` files Ahead-Of-Time (AOT) during the build step or via a control-plane API, stripping the parser from the production deployment.

**Problem:** The new Chevrotain parser is fantastic for the LSP and correctness, but it adds unnecessary bundle size and cold-start latency to the runtime. Since `.bridge` files define static circuits, parsing them on every server start in an edge/serverless gateway is wasteful.

**Solution:** Separate the core execution engine from the parser. Allow the engine to accept a pre-parsed, serialized JSON AST (`Instruction[]`) instead of raw `.bridge` strings.

**How it works:**

* **JSON-Serializable AST:** Ensure the output of the parser is strictly JSON-serializable (no functions, closures, or class instances in the AST).
* **Subpath Exports:** Isolate the execution engine into a lightweight import (e.g., `@stackables/bridge/runtime` or `@stackables/bridge-engine`). This entry point includes zero Chevrotain or parsing dependencies.
* **CLI for CI/CD:** Introduce a simple CLI (`npx @stackables/bridge build`) that parses `.bridge` files, runs semantic validation, and outputs `.bridge.json` artifacts. A `check` command allows CI pipelines to fail on invalid graphs before deployment.
* **API-Driven Gateways:** For dynamic architectures, a central control plane can parse the `.bridge` files and serve the JSON ASTs directly to the fleet of gateways over an internal API. The gateways simply feed the JSON into the lightweight execution engine.

**Implementation sketch:**

1. Audit the current AST types to guarantee 100% JSON serialization.
2. Refactor package exports to split `parseBridge` from `bridgeTransform` / `executeGraph`.
3. Update `bridgeTransform` to accept either a raw string (which invokes the parser) or a pre-parsed AST array.
4. Build a thin Node CLI wrapper around the existing `parseBridgeDiagnostics()` function for the build/check commands.

### Execution-Inferred IntelliSense & Validation

A massive upgrade to the Language Server (LSP) that provides deep autocomplete, hover tooltips, and field validation for both internal GraphQL types and external API payloads.

**Problem:** While `.bridge` files are strictly typed on the GraphQL side (`input` and `output`), the external tools (`httpCall`) are opaque black boxes. Developers have to guess or manually check what fields an external REST API returns, leading to typos and frustrating trial-and-error wiring.

**Solution:** 

1. **Static GraphQL Binding:** The LSP reads the local `schema.graphql` to provide instant, strict IntelliSense for `i.*` (input arguments) and `o.*` (output fields).

2. **Dynamic Execution Inference:** During local development, the Bridge engine caches the actual JSON payloads sent to and received from external tools. The LSP reads this cache to dynamically "learn" the shape of the external APIs and provide IntelliSense for tool handles (e.g., `sg.*` or `geo.*`).

**How it works:**

* **GraphQL Resolution:** The VS Code extension accepts a path to the project's `schema.graphql`. When a user types `bridge Mutation.sendEmail { with input as i }`, typing `i.` immediately yields completions for the mutation's arguments (`to`, `subject`, `textBody`).
* **The Dev Cache (`.bridge-types.json`):** When the developer runs queries locally (via Yoga or the planned Browser Playground), the engine intercepts the raw input/output JSON of every tool execution. It recursively merges these payloads into a unified type shape and saves it to a local cache file.
* **The Feedback Loop:** The LSP watches the `.bridge-types.json` file. As the developer tests their graph, the LSP updates its internal symbol table in real-time. Typing `sg.` now offers completions based on the *actual data* SendGrid just returned.
* **Linting:** If a user maps `o.lat <- geo.ltt` (typo), the LSP flags `.ltt` with a warning: *"Field 'ltt' not found in execution history for tool 'geo'. Did you mean 'lat'?"*

**Implementation sketch:**

1. **Engine side:** Add a `recordExecutionTypes: boolean` flag to the engine options. When true, it pipes `JSON.stringify` shapes through a schema-inference utility (e.g., merging objects, turning arrays of mixed objects into optional fields) and writes to disk.
2. **LSP side:** Add a `schema` property to the Bridge AST nodes. For `input`/`output`, populate it from `graphql`. For tools, populate it by parsing the dev cache file.
3. **Language Server Providers:** Implement `CompletionItemProvider` (autocomplete dropdown) and `HoverProvider` (showing inferred JSON types on mouse hover) by walking the Chevrotain CST and matching the cursor position to the inferred scope.

**Challenges:**

* **Cold Start:** There is no tool autocomplete until the user executes at least one query. (Can mitigate this by eventually allowing users to manually point a tool to an OpenAPI spec or JSON schema, but execution-inference is the primary magic).
* **Shape Unioning:** If an API returns `{ "price": null }` on the first call and `{ "price": 10 }` on the second, the inference engine needs to correctly type it as `number | null` rather than throwing away data.
* **Process Sync:** Ensuring the VS Code LSP process can safely and quickly read the cache file written by the local Node/Yoga dev server process.

---

## v2.0 (Feb 2026)

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

Expressions compose with existing operators: `||` null coalesce, `??` error coalesce, `force` statements (both critical and fire-and-forget), and `[] as iter { }` array mapping all work with expression results.

### Force Critical by Default -- DONE

**Problem:** `force <handle>` was fire-and-forget — errors were silently swallowed. For essential side effects (payment capture, order creation), a failure must propagate to the caller.

**Solution:** `force <handle>` is now **critical by default**. If the forced tool throws, the error propagates into the GraphQL response alongside any data. To opt into the old fire-and-forget behaviour, append `?? null`: `force handle ?? null`.

**Syntax:**
```bridge
force audit              # critical — error breaks the response
force analytics ?? null  # fire-and-forget — errors silently caught
```

**Semantics:**
- Critical forces run in parallel with data resolution. Their promises are awaited alongside the main output pull — errors propagate via `Promise.all`.
- Fire-and-forget forces have `.catch(() => {})` applied — errors are silently discarded.
- Both variants schedule eagerly at bridge entry, before any field is demanded.

**Implementation:** Parser extended with optional `?? null` suffix on `bridgeForce` rule. AST `Bridge.forces` entries gain `catchError?: true` for fire-and-forget. `executeForced()` returns only critical promises; the engine awaits them in both the standalone `run()` path and the GraphQL adapter path (`bridge-transform.ts`).

### ~~Fat Wire IR Refactor~~ -- DROPPED

**Original concern:** The Wire type carries logic (`nullFallback`, `fallbackRef`, `force`, `pipe`), forcing heavy branching in the execution loop. Proposed splitting into separate `GraphNode` and `Edge` types.

**Resolution:** After analysis, this is a non-problem. Only 5 branch sites in the 831-line engine, each handling one wire property in isolation. The Wire type is a clean 2-variant discriminated union. Splitting into Node/Edge IR would add abstraction without reducing complexity.

### ~~Conditional Block (Scoped Wiring)~~ -- DROPPED

**Original idea:** `if condition { ... }` block syntax for gating multiple fields behind a condition.

**Resolution:** Syntactic sugar for N ternary wires where false maps to null. Introduces scoped wire groups (new IR concept) with nesting complexity. The lazy evaluation benefit already falls out from per-wire ternaries. Can be revisited as a parser-level desugaring if the pattern emerges in practice.
