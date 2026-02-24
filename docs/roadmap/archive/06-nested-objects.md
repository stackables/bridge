## Path Scoping Blocks (Nested Object Wiring)

**Status:** ✅ Fully implemented
**Target Release:** v1.x (Feature Addition)

### Implementation Notes

Implemented as designed. Key details:

- **Lexer**: No changes needed — reuses existing `Dot`, `Arrow`, `Equals`, `LCurly`, and `RCurly` tokens
- **Grammar**: New `pathScopeLine` rule added to `packages/bridge/src/parser/parser.ts`. The `bridgeWire` rule now accepts `{ pathScopeLines }` as a third alternative after `addressPath`, alongside `=` (constant) and `<-` (pull)
- **CST → AST Visitor**: `processScopeLines()` function inside `buildBridgeBody` recursively flattens scope blocks by prepending the accumulated path prefix to each inner target. Supports all wire features: pull, constant, pipe chains, expressions, ternary, string interpolation, and fallback operators (`||`, `??`)
- **No engine changes** — purely parser-level syntactic sugar, as planned
- **Serializer**: Scope blocks are flattened during parsing. The serializer emits standard flat wires; round-trip produces equivalent ASTs
- **Define blocks** get scope support automatically (they use the same `bridgeBodyLine` rule and `buildBridgeBody` visitor)
- Tests in `test/path-scoping.test.ts` covering: constants, pull wires, nested scoping, pipes, fallbacks, expressions, ternary, string interpolation, tool handle targets, wire equivalence with flat syntax, serializer round-trip, and execution

### 📖 The Problem: Deep Path Repetition

When developers map data to external REST APIs, the required JSON payloads are often deeply nested. Currently, constructing these payloads inline requires repeating the full target path for every single field:

```bridge
# Current syntax requires heavy repetition
api.body.user.profile.id <- i.id
api.body.user.profile.name <- std.str.toUpperCase:i.name
api.body.user.settings.theme = "dark"
api.body.user.settings.notifications = true

```

While developers can extract this into a `define` block, doing so for every medium-sized payload breaks the flow of reading a bridge top-to-bottom. We need a way to visually construct nested objects inline, **without** introducing foreign, JSON-style syntax (`"key": value`) that clashes with our native wire operators (`<-` and `=`).

### ✨ Proposed Solution: Path Scoping

We will introduce "Path Scoping" blocks. A developer can open a `{ ... }` block on any target path. Inside the block, any wire starting with a dot (`.`) implicitly appends to the parent path.

This perfectly mirrors the syntax and mental model we already use for array iterators (`[] as it { .field <- ... }`), keeping the language unified and strictly declarative.

**New Syntax:**

```bridge
bridge Mutation.createUser {
  with std.httpCall as api
  with input as i

  api.method = "POST"

  # Path Scoping Block
  api.body.user {
    .profile {
      .id <- i.id
      .name <- std.str.toUpperCase:i.name
    }
    .settings {
      .theme = "dark"
      .notifications = true
    }
  }
}

```

### 🛠️ Architecture & Implementation Plan

The most powerful aspect of this feature is that **the Execution Engine requires absolutely zero changes.** This is purely parser-level syntactic sugar.

1. **Lexer Updates:**

- NONE. We reuse the exact same `Dot`, `Arrow`, `Equals`, `LCurly`, and `RCurly` tokens already in the grammar.

2. **Parser Grammar (`BridgeParser`):**

- Introduce a new rule: `pathScopeBlock`.
- It matches an `addressPath` followed by a block `{ ... }`.
- Inside the block, it accepts either standard element lines (`.field <- source`) or nested `pathScopeBlock`s.

3. **CST → AST Visitor (`toBridgeAst`):**

- When the visitor enters a `pathScopeBlock`, it pushes the parent path (e.g., `["api", "body", "user"]`) onto a local `pathPrefix` stack.
- When it visits a wire inside the block (e.g., `.profile.id <- i.id`), it prepends the stack to the target path.
- The visitor emits a perfectly flat list of standard `Wire` objects to the engine. The engine natively executes them as deep `setNested` operations, completely unaware that a block was ever used.
