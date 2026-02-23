## Alias Declarations (`alias` keyword)

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

The `alias` keyword (not `with`, to avoid conflict with handle declarations):

```bridge
bridge Query.getPrice {
  with input as i
  with tool1
  with pipe
  with output as o

  # Top-level alias: cache a pipe result
  alias pipe:i.category as upperCat

  o.list <- tool1.list[] as it {
    # Array-scoped alias: evaluate once per element
    alias pipe:it as resp
   
    # Pull from the local handle (Cost 0 memory reads)
    .a <- resp.a
    .b <- resp.b
    .cat <- upperCat
  }
}
```

Also works as a simple rename for deeply nested paths:

```bridge
  alias api.company.address as addr
  o.city <- addr.city
  o.state <- addr.state
```

### 🛠️ Implementation Notes

This feature leverages the existing `ExecutionTree.shadow()` mechanics, requiring mostly parser-level changes.

1. **Lexer & Grammar:**
   * Added `AliasKw` token to the lexer. Since `alias` is a dedicated keyword, there is no ambiguity with the existing `with` keyword used for handle declarations.
   * Added `bridgeNodeAlias` grammar rule (`alias <sourceExpr> as <name>`) in `bridgeBodyLine` for top-level aliases.
   * Added `elementWithDecl` grammar rule (`alias <sourceExpr> as <name>`) in `arrayMapping` for element-scoped aliases.
   * A `processLocalBindings` helper in `buildBridgeBody` handles iterator-aware source resolution (plain refs, pipe chains with iterator data sources, and regular handle refs).

2. **AST / Wire Generation:**
   * For each `alias <source> as <name>`, the parser emits a wire: `{ from: <resolved source>, to: { module: "__local", type: "Shadow", field: "<name>" } }`.
   * The alias is registered in `handleRes` so subsequent wires can reference it. Inside array blocks, aliases are cleaned up after processing the block.
   * Pipe chains where the data source is the iterator are handled specially — the iterator reference is converted to an element-scoped `NodeRef`.

3. **Execution Engine (`ExecutionTree.ts`):**
   * `__local` module trunks in shadow trees use transitive element-source detection: if the `__local` trunk's source is a pipe fork with element-sourced wires, it's scheduled locally. Otherwise, it delegates to the parent (for top-level aliases).
   * For path=[] wires (e.g., a pipe returning a primitive like a string), the resolved value is returned directly instead of wrapping in an input object.
   * The `hasElementWires` detection in `run()` also considers `__local` sources as element-scoped, ensuring array-mapped output is correctly detected.

4. **Serializer (`bridge-format.ts`):**
   * `__local` wires are excluded from regular wire serialization.
   * Element-scoped aliases are emitted as `alias <source> as <name>` inside array blocks.
   * Top-level aliases are emitted separately, with pipe chain reconstruction walking backward.

### ⚠️ Migration Path

None. This is a purely additive, non-breaking feature that heavily optimizes existing array-mapping patterns.
