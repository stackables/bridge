## 🚀 Decouple Side-Effects from Data Wires (The `force` keyword)

**Status:** Fully implemented
**Target Release:** v2.0 (or upcoming v1.x minor release)

### 📖 The Problem: The "204 No Content" Edge Case

Currently, to guarantee that a mutation or side-effect executes in The Bridge's lazy evaluation engine, we use the forced wire operator (`<-!`).

```bridge
# Current (Anti-pattern)
o.messageId <-! sg.headers.x-message-id

```

While this works for APIs that return data, it creates a fatal conceptual flaw for endpoints that return nothing (e.g., a `204 No Content` from a `DELETE` request). If there is no output data to wire, there is nowhere to attach the `<-!` operator. Developers are forced to invent dummy wires just to trigger the execution queue.

Architecturally, we were forcing an **edge** (the wire) to trigger execution, when we actually needed to force the **node** (the tool/entity).

### ✨ Proposed Solution: The `force` Statement

We will deprecate the `<-!` operator entirely. Wires will return to being purely lazy data-routing mechanisms.

To handle side-effects (Mutations, POST/DELETE requests), we will introduce a declarative `force <handle>` statement. This acts as an explicit execution sink, telling the engine: *"Evaluate this tool eagerly, regardless of what the GraphQL client asks for."*

**New Syntax:**

```bridge
bridge Mutation.deleteUser {
  with userApi as api
  with input as i
  
  # 1. Map the inputs (Lazy)
  api.pathParams.userId <- i.id
  api.method = DELETE

  # 2. Trigger the side-effect (Eager)
  force api 
  
  # 3. Output mapping is now completely optional
}

```

### 🛠️ Implementation Plan

This is a clean, localized refactor spanning the Parser and the Engine:

1. **Lexer & Parser Updates:**
* Remove `ForceArrow` (`<-!`) from the Lexer.
* Introduce a new keyword token: `ForceKw` (`force`).
* Add a new parser rule in `bridgeBodyLine` to accept `force <nameToken>`.


2. **AST Schema Changes:**
* **Remove:** `force?: true` from the `Wire` type union.
* **Add:** `forces?: string[]` to the `Bridge` definition type. (e.g., `forces: ["api"]`).


3. **Execution Engine (`ExecutionTree.ts`):**
* Rewrite `executeForced()`: Instead of scanning all wires for `w.force === true`, the engine will simply read `this.bridge.forces`, resolve the handles to their root `NodeRef` (Trunk), and push them directly into `this.schedule()`.



### ⚠️ Migration Path

Because this is a breaking syntax change, we will need to update all existing mutation examples in the documentation and `bridge-recipes` repository.

**Before:**

```bridge
o.success <-! api.status

```

**After:**

```bridge
force api
o.success <- api.status

```
