# PRD & Engineering Roadmap: The Bridge v2.0 Architecture

## 1. Executive Summary

**The Bridge** is evolving from a naive script executor into a **Cost-Based Declarative Dataflow Engine**.

Currently, the engine uses a "Fat Wire" Intermediate Representation (IR) that tightly couples graph topology with execution logic. Furthermore, it treats both explicit fallbacks (`||`) and implicit overdefinitions (multiple wires to the same target) as concurrent `Promise.all` races. This leads to wasted network calls, unnecessary API costs, and complex branching in the core execution loop.

Additionally, the current hand-rolled regex parser is fragile against edge cases (e.g., braces inside strings).

This document outlines the architectural refactor required to reach v2.0, split into a strict **Three-Phase Roadmap** to avoid a "Big Bang Rewrite." We will fix the execution semantics (The Brain) before we swap the parser (The Heart).

---

## 2. Roadmap Strategy

To isolate variables and minimize debugging nightmares, the rollout must follow this sequence:

1. **Phase 1: Engine Refactor.** Keep the current regex parser, but alter its output to generate a new AST (Nodes & Edges). Rewrite the `ExecutionTree` to optimize API calls.
2. **Phase 2: The Parser Swap.** Once the engine is stable, replace the regex parser with an industry-standard Chevrotain compiler architecture that outputs the *exact same* AST defined in Phase 1.
3. **Phase 3: IDE Tooling.** Leverage the new parser's error-recovery to build a VS Code Language Server.

---

## 3. Phase 1: The Engine Refactor (Semantics & Optimization)

### Pillar I: The Node / Edge IR Refactor

**The Problem:** Currently, the `Wire` type carries logic (`nullFallback`, `fallbackRef`, `force`, `pipe`). This forces the execution loop to contain heavy branching logic. Edges in a graph should be dumb pipes; operations should be Nodes.

**The Solution:** Separate the IR into two explicit constructs: `GraphNode` (computes/holds data) and `Edge` (dependency flow).

**Technical Specification:**
Update the AST types. The parser must map the `.bridge` syntax into these flattened structures.

```typescript
// 1. Edges are now strictly dumb pipes
export type Edge = {
  from: NodeRef;
  to: NodeRef;
};

// 2. Logic is shifted into synthetic AST Nodes
export type GraphNode = 
  | { kind: "ToolCall", trunk: Trunk, fn: string, deps: Edge[] }
  | { kind: "Constant", trunk: Trunk, value: any }
  | { kind: "Coalesce", trunk: Trunk, sources: NodeRef[], coalesceType: "null" | "error" }
  | { kind: "Force", trunk: Trunk, target: NodeRef } // Handles <-!

```

*Impact:* The execution loop (`pullSingle` and `schedule`) becomes a simple recursive lookup. It blindly follows `Edges` backward. If it hits a `ToolCall`, it executes it. If it hits a `Coalesce` node, it evaluates it based on its specific rules.

### Pillar II: Explicit Fallback Chains (`Coalesce` Node)

**The Problem:** If a user writes `o.label <- api.name || backup.name`, the engine races both concurrently. If both APIs are expensive, the user pays for both, violating the intent of a fallback.

**The Solution:** The `||` and `??` operators represent **Explicit Priority**. The engine must use strict short-circuit evaluation.

**Technical Specification:**

1. **Parser Update:** When encountering `||` or `??`, emit a `Coalesce` GraphNode.
2. **Executor Update:** Evaluate `Coalesce` nodes sequentially.

```typescript
// Inside the ExecutionTree / Node Evaluator
async evaluateCoalesce(node: CoalesceNode): Promise<any> {
  const errors: unknown[] = [];

  for (const sourceRef of node.sources) {
    try {
      const value = await this.pullSingle(sourceRef); // Sequential await
      
      if (node.coalesceType === "null" && value != null) {
        return value; // Short-circuit: Stop execution immediately!
      }
      if (node.coalesceType === "error") {
        return value; // Short-circuit: It didn't throw, return the value.
      }
    } catch (err) {
      if (node.coalesceType === "null") throw err; // || does not swallow errors
      errors.push(err); // ?? swallows errors and tries the next source
    }
  }

  if (node.coalesceType === "error" && errors.length === node.sources.length) {
    throw new AggregateError(errors, "All error fallbacks failed");
  }
  return undefined;
}

```

### Pillar III: Cost-Based Query Optimization (Overdefinition)

**The Problem:** If a user "overdefines" a field on separate lines (`o.lat <- input.lat`, `o.lat <- expensiveApi.lat`), the engine races them all via `Promise.all()`. This hits the network even when the data was instantly available in memory.

**The Solution:** The engine must become a "Smart Planner." Before executing multiple independent wires targeting the same output, it infers the cost of each source, sorts them, and executes them from cheapest to most expensive.

**Technical Specification:**

1. **Cost Inference Heuristic:** Implement a scoring function for `NodeRef` trunks.
* `Cost 0` (Memory): `input`, `context`, `const`.
* `Cost 1` (Fast/Cached): Tools with a `.cache` TTL.
* `Cost 10` (Network/Compute): Standard Tools.
* `Cost 100` (Desperation): Wires from `on error` tool fallbacks.


2. **Sequential, Cost-Sorted Execution:** Refactor the `pull(refs)` method.

```typescript
// Refactored ExecutionTree.pull()
async pull(refs: NodeRef[]): Promise<any> {
  if (refs.length === 1) return this.pullSingle(refs[0]);

  // 1. Sort refs by engine-inferred cost (cheapest first)
  const sortedRefs = refs.sort((a, b) => this.inferCost(a) - this.inferCost(b));
  const errors: unknown[] = [];

  // 2. Try sequentially. Only pay for expensive tools if cheap ones fail/return null.
  for (const ref of sortedRefs) {
    try {
      const value = await this.pullSingle(ref);
      if (value != null) return value; // Short-circuit: We found cheap data!
    } catch (err) {
      errors.push(err);
    }
  }

  if (errors.length === refs.length) {
    throw new AggregateError(errors, "All overdefined sources failed to resolve.");
  }
  return undefined; 
}

```

*Note: Ensure the scope chain bug (shadow trees not looking up past their immediate parent for `context`) is patched during this phase using a recursive `getState(key)` loop.*

---

## 4. Phase 2: The Parser Swap (Compiler Architecture)

Once Phase 1 is stable and unit tests prove expensive APIs are no longer DDoSed, replace the regex frontend.

**The Problem:** The regex parser relies on string splitting and manual bracket counting. It is fragile and breaks if users put `#` or `{` inside strings. It also fails completely on the first syntax error, making it useless for IDE tooling.

**The Solution:** Implement a formal compiler pipeline using **Chevrotain**.

**Technical Specification:**

1. **Lexer:** Define tokens (`BridgeKw`, `Identifier`, `LCurly`, etc.). Configure the Lexer to automatically drop whitespace and comments (resolving all string-cleaning bugs).
2. **Parser:** Write a `CstParser` class that defines the grammar rules natively in TypeScript. Enable Chevrotain's error recovery.
3. **Visitor:** Write a CST Visitor that walks Chevrotain's output and transforms it into the exact `GraphNode` and `Edge` interfaces defined in Phase 1.

*Validation:* The new parser must output the exact same AST as the old parser against the existing test suite before the old parser is deleted.

---

## 5. Phase 3: IDE Tooling & DX

**The Problem:** Developers writing `.bridge` files lack standard IDE support.
**The Solution:** Leverage Chevrotain's error recovery to build Language Server Protocol (LSP) features.

