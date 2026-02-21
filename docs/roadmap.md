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

### LSP: Completions

After `with `, suggest declared tool/define names from the file. After `handle.`, suggest known field paths from the tool's wire definitions.

### LSP: Go-to-Definition

From a handle reference in a wire, jump to the `with <handle>` declaration line.

### LSP: Prettify Error Messages

Map verbose Chevrotain token-type names (e.g. "Expecting one of: Identifier, InputKw...") to human-readable descriptions.

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
