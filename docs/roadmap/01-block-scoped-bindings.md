## Block-Scoped Bindings (Local `with` in Array Iterators)

**Status:** Planned
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

### 🛠️ Implementation Plan

This feature leverages the existing `ExecutionTree.shadow()` mechanics, requiring mostly parser-level changes.

1. **Parser & Lexer Updates:**
* Update the `elementLine` Chevrotain rule to accept `toolWithDecl` as a valid alternative.
* When the visitor encounters `with <expr> as <alias>` inside an array map, it registers `<alias>` in the `arrayIterators` tracking map (or a new `localHandles` map).


2. **AST Schema Changes:**
* Array mappings currently just hold a list of child wires. We need the parser to emit a synthetic wire for the `with` declaration targeting a special local trunk.
* Emit a wire like: `{ from: pipe:it, to: { module: "__local", type: "Shadow", field: "resp" } }`.


3. **Execution Engine (`ExecutionTree.ts`):**
* The engine's `shadow()` tree already creates an isolated execution scope per row!
* Ensure `resolveAddress` allows routing to these `__local` trunks. When `.a <- resp.a` is evaluated, the engine will natively find `resp` in the shadow tree's `this.state` and return it without triggering a network call.



### ⚠️ Migration Path

None. This is a purely additive, non-breaking feature that heavily optimizes existing array-mapping patterns.

