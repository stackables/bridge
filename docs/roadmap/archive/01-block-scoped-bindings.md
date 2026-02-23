## Block-Scoped Bindings (Local `with` in Array Iterators)

**Status:** Fully implemented
**Target Release:** v1.x (Feature Addition)

### 📖 The Problem: The "Redundant Fan-out" Issue

When mapping over arrays, it is common to take each item (`it`) and pass it into a secondary enrichment tool (like a pipe).

Currently, if a user wants to extract multiple fields from that secondary tool, they have to write this:

```bridge
o.list <- tool1.list[] as it {
  .a <- pipe:it.a
  .b <- pipe:it.b
}

```

**The Architectural Flaw:** Because of how the parser desugars expressions, this generates *two separate synthetic pipe forks* per row. The engine will execute `pipe` twice for every single item in the array, destroying performance. We need a declarative way to say "evaluate this sub-graph once per row and reuse the result," without resorting to imperative programming keywords like `const` or `let`.

### ✨ Proposed Solution: Block-Scoped `with`

We will extend the existing `with` keyword so it can be used inside array mapping blocks. It will act as a local sub-graph binding.

By pulling the tool execution into a local handle (`resp`), the engine evaluates it exactly once per shadow-tree (row), caches it in the local state, and serves all subsequent field pulls at Cost 0.

**New Syntax:**

```bridge
bridge Query.getPrice {
  with input as i
  with tool1
  with pipe
  with output as o

  o.list <- tool1.list[] as it {
    # 1. Bring the result of the pipe into this local shadow scope
    with pipe:it as resp
   
    # 2. Pull from the local handle (Cost 0 memory reads)
    .a <- resp.a
    .b <- resp.b
  }
}

```

### 🛠️ Implementation Notes

This feature leverages the existing `ExecutionTree.shadow()` mechanics, requiring mostly parser-level changes.

1. **Parser & Grammar:**
   * Added `elementWithDecl` rule to the Chevrotain grammar, matching `with <sourceExpr> as <nameToken>` inside array mapping blocks.
   * The `arrayMapping` rule now accepts both `elementLine` and `elementWithDecl` as child alternatives.
   * A `processLocalBindings` helper in `buildBridgeBody` handles iterator-aware source resolution (plain refs, pipe chains with iterator data sources, and regular handle refs).

2. **AST / Wire Generation:**
   * For each `with <source> as <alias>`, the parser emits a wire: `{ from: <resolved source>, to: { module: "__local", type: "Shadow", field: "<alias>" } }`.
   * The alias is temporarily registered in `handleRes` so subsequent element lines can reference it (cleaned up after processing the block).
   * Pipe chains where the data source is the iterator are handled specially — the iterator reference is converted to an element-scoped `NodeRef`.

3. **Execution Engine (`ExecutionTree.ts`):**
   * `__local` module trunks are always scheduled locally in shadow trees (never delegated to parent), since they are inherently element-scoped.
   * For path=[] wires (e.g., a pipe returning a primitive like a string), the resolved value is returned directly instead of wrapping in an input object.
   * The `hasElementWires` detection in `run()` also considers `__local` sources as element-scoped, ensuring array-mapped output is correctly detected.

4. **Serializer (`bridge-format.ts`):**
   * `__local` wires are excluded from regular wire serialization and emitted inside array blocks as `with <source> as <alias>`.
   * Pipe wire detection for source reconstruction walks the pipe chain backward, correctly handling iterator-relative data sources.
   * Pipe wires with `from.element=true` are excluded from `elementPullAll` to avoid double-serialization.

### ⚠️ Migration Path

None. This is a purely additive, non-breaking feature that heavily optimizes existing array-mapping patterns.
