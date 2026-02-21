# Bridge Roadmap

Living document. Ideas start in **Open**, move to a release section when committed, and are marked DONE or DROPPED when resolved.

---

## Open

### Conditional Wire (Ternary)

A conditional wire selects between two sources based on a boolean predicate.
Distinct from the existing operators:

- `||` = null-coalescing (try A, if null try B)
- `??` = error-coalescing (try A, if it throws try B)
- `? :` = **selection** (check condition, pull exactly one branch)

**Syntax:**
```hcl
define smartPrice {
  with stripe
  with output as o
  with input as i

  o.amount <- i.isPro ? stripe.proPrice : stripe.basicPrice
}
```

**Semantics:** The condition is itself a pull. The engine pulls `i.isPro` first (cost 0), then pulls **only** the chosen branch. The other branch is never touched.

**Implementation sketch:** ~50-80 lines -- one new Wire variant, one parser rule, one engine path in `resolveWires()`.

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

## v2.0 (Feb 2026)

Transformed Bridge from a naive script executor into a cost-based declarative dataflow engine, replaced the hand-rolled regex parser with Chevrotain, and shipped a VS Code extension with LSP.

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

### ~~Fat Wire IR Refactor~~ -- DROPPED

**Original concern:** The Wire type carries logic (`nullFallback`, `fallbackRef`, `force`, `pipe`), forcing heavy branching in the execution loop. Proposed splitting into separate `GraphNode` and `Edge` types.

**Resolution:** After analysis, this is a non-problem. Only 5 branch sites in the 831-line engine, each handling one wire property in isolation. The Wire type is a clean 2-variant discriminated union. Splitting into Node/Edge IR would add abstraction without reducing complexity.

### ~~Conditional Block (Scoped Wiring)~~ -- DROPPED

**Original idea:** `if condition { ... }` block syntax for gating multiple fields behind a condition.

**Resolution:** Syntactic sugar for N ternary wires where false maps to null. Introduces scoped wire groups (new IR concept) with nesting complexity. The lazy evaluation benefit already falls out from per-wire ternaries. Can be revisited as a parser-level desugaring if the pattern emerges in practice.
