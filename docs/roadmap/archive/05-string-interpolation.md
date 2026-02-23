## String Interpolation (Template Strings)

**Status:** ✅ Fully implemented
**Target Release:** v1.x (Feature Addition)

### Implementation Notes

Implemented as designed. Key details:

- **`std.concat`** built-in tool added to `packages/bridge/src/tools/concat.ts`
- **Grammar** updated: `StringLiteral` accepted on RHS of `<-` in `bridgeWire` and `elementLine` rules
- **Parser visitor** detects `{…}` placeholders and desugars into synthetic `__concat_*` fork wires
- **Formatter** (`bridge-format.ts`) reconstructs template strings from `__concat_*` forks for round-trip formatting
- **ExecutionTree** updated: `hasElementWires` check extended to detect `to.element` for concat output wires in array mapping context
- **No new Wire variant, no new engine method, no new AST type** — as planned
- Constant wires (`=`) remain verbatim (no interpolation)
- Tests in `test/string-interpolation.test.ts` covering: tool unit tests, basic interpolation, tool interaction, array mapping, fallback chains, and formatter round-trip

### 📖 The Problem: No Way to Build Strings from Multiple Sources

Today, Bridge has no mechanism to concatenate or compose strings. This is a
critical limitation for two pervasive real-world patterns:

1. **Constructing REST URLs** — APIs that embed identifiers in the path
   (e.g. `/users/{id}/orders`) cannot be expressed in a single wire. The
   developer must either hard-code the full URL as a constant or resort to a
   custom tool that does nothing but string-join.

2. **Assembling human-readable text** — Display names (`"{first} {last}"`),
   formatted messages, or composite labels require concatenation of multiple
   source values with literal text.

There is no `concat` pipe, no template syntax, and no `+` operator for
strings. This forces users out of declarative Bridge into hand-written tool
functions for the most basic string operations.

### ✨ Proposed Solution: `{ref}` Interpolation Inside Quoted Strings

Extend the string literal syntax so that `{…}` placeholders inside a quoted
string are resolved at runtime against the current scope.

**New Syntax:**

```bridge
bridge Query.userOrders {
  with ordersApi as api
  with input as i
  with output as o

  # REST URL construction — the killer use case
  api.path <- "/users/{i.id}/orders"

  o.name <- "{i.firstName} {i.lastName}"
  o.greeting <- "Hello, {i.firstName}!"
}
```

Placeholders reference the same source addresses used in regular pull wires
(`i.field`, `api.field`, `ctx.field`, etc.). Anything between `{` and `}` is
parsed as a standard source reference.

### Interaction with Pipes

Interpolated strings work naturally as the input to pipe transforms — same
`:` pipe operator, no special syntax:

```bridge
o.name    <- trim:"{i.firstName} {i.lastName}"
o.display <- upperCase:"{api.title} — {api.subtitle}"
```

Under the hood the visitor desugars the template into a synthetic
`std.concat` fork (see Implementation Plan below) and wires its output as
the pipe's input. From the user's perspective nothing changes — the `:` pipe
works the same way it always has.

### Non-String Values in Placeholders

Placeholder values are coerced to strings via JavaScript `String()`:

| Source value | Interpolated as |
|---|---|
| `"hello"` | `hello` |
| `42` | `"42"` |
| `true` | `"true"` |
| `null` | `""` (empty string) |
| `undefined` | `""` (empty string) |
| `[1, 2]` | `"1,2"` |
| `{ a: 1 }` | `"[object Object]"` — a lint warning should fire |

### Escaping

A literal `{` inside a template string is written as `\{`:

```bridge
o.json <- "\{\"key\": \"{i.value}\"}"
```

Since the Bridge lexer already handles `\"` escapes inside `StringLiteral`,
this extends naturally.

### Interaction with Existing Features

| Feature | Behavior |
|---|---|
| Constants (`=`) | `api.path = "/static"` — unchanged, no interpolation (constants are verbatim) |
| Pull wires (`<-`) with plain string | `o.x <- "hello"` — today this is a constant string; **with interpolation**, strings containing `{…}` become templates |
| Fallback chains (`\|\|`, `??`) | `o.x <- "{i.a} {i.b}" \|\| "fallback"` — template is the primary source |
| Inline expressions | Not combinable: `o.x <- "{i.a}" * 2` is invalid. Use pipes or split into wires |
| Array mapping | Works inside `[] as it { }` blocks: `.url <- "/items/{it.id}"` |

### 🛠️ Implementation Plan — Desugar to Synthetic `std.concat`

The core insight: **the visitor is the complexity boundary, the engine stays
dumb.** This is how pipes and inline expressions already work — the visitor
emits synthetic tool forks and wires; the engine never learns about the
higher-level construct. Template strings follow the exact same pattern.

**No new Wire variant. No new engine method. No new AST type.**

#### How Desugaring Works

Given this Bridge code:

```bridge
o.url <- "/users/{i.id}/orders"
```

The visitor parses the string, detects `{…}` placeholders, and emits:

1. A **synthetic tool fork** mapped to the built-in `std.concat`:

   ```
   __concat_100001  →  std.concat
   ```

2. **Constant wires** for literal segments and **pull wires** for refs:

   ```
   { value: "/users/",  to: __concat_100001.parts.0 }   // text
   { from: i.id,        to: __concat_100001.parts.1 }   // ref
   { value: "/orders",  to: __concat_100001.parts.2 }   // text
   ```

3. A **pull wire** from the concat result to the original target:

   ```
   { from: __concat_100001.value, to: o.url }
   ```

The `setNested` helper in the engine already builds arrays from numeric path
segments, so `parts.0`, `parts.1`, `parts.2` naturally produces
`{ parts: ["/users/", "abc123", "/orders"] }`.

#### Pipe Interaction

For `trim:"{i.first} {i.last}"` the visitor does the same concat desugar,
then wires the concat output as the pipe's input — identical to how a source
ref is wired through a pipe chain today.

#### 1. `std.concat` Built-in Tool

Register a new tool in `packages/bridge/src/tools/`:

```ts
// std.concat — join ordered parts into a single string
async function concat(input: { parts: unknown[] }): Promise<{ value: string }> {
  const result = input.parts
    .map(v => (v == null ? "" : String(v)))
    .join("");
  return { value: result };
}
```

This is a trivially unit-testable function. It follows the same pattern as
`upperCase`, `lowerCase`, `pickFirst`, etc.

#### 2. Visitor — Template Detection & Desugar

When the visitor encounters a `StringLiteral` on the RHS of a `<-` wire:

1. **Scan** for unescaped `{…}` in the string value.
2. If none found → emit a normal constant wire (unchanged behavior).
3. If found → **split** into an ordered list of segments:
   - `{ kind: "text", value: "…" }` for literal text
   - `{ kind: "ref", path: "i.id" }` for placeholder refs
4. **Allocate** a synthetic fork name: `__concat_{monotonic_id}`.
5. **Emit** constant and pull wires targeting `__concat.parts.N`.
6. **Emit** a pull wire from `__concat.value` to the original target.

This lives entirely in the visitor — the same file that desugars pipes and
inline expressions today. The synthetic fork counter uses the same ID space
as existing synthetic forks to avoid collisions.

#### 3. Lexer — No Changes Needed

The existing `StringLiteral` token (`/"(?:[^"\\]|\\.)*"/`) already matches
strings containing `{…}`. Template detection happens in the visitor, not
the lexer — keeping the lexer simple.

#### 4. AST / `types.ts` — No Changes Needed

All emitted wires use existing types:

- `{ value: string; to: NodeRef }` — constant wire (literal segments)
- `{ from: NodeRef; to: NodeRef }` — pull wire (ref segments + final output)

No new Wire union member. No new type consumers need to handle.

#### 5. Execution Engine — No Changes Needed

The engine already:

- Resolves tool inputs from constant and pull wires ✓
- Builds arrays via `setNested` with numeric path segments ✓
- Calls registered tool functions ✓
- Handles synthetic forks (pipes, expressions) ✓
- Clones synthetic wires into shadow trees (array mapping) ✓

#### 6. Formatter (`bridge-format.ts`)

The formatter already collapses synthetic pipe forks back to `:`  notation.
Apply the same pattern: detect `__concat_*` synthetic forks and reconstruct
the original template string:

```ts
// Detect: target is __concat_* fork with parts.0, parts.1, ...
// Collapse: rebuild "literal{ref}literal" from the ordered wires
```

#### 7. Linter (`bridge-lint.ts`)

New diagnostics:

- **`template-object-ref`** — Warn when a placeholder resolves to an object
  (likely a mistake producing `[object Object]`).
- **`template-in-constant`** — Error if `{…}` appears in a `=` constant wire
  (constants are not interpolated).

#### 8. Language Service

- **Completions** inside `{…}` offer the same source references as pull wires.
- **Hover** on a template string shows the segment breakdown.
- **Go-to-definition** on a `{ref}` placeholder navigates to the handle
  declaration.

### 🏗️ Architecture: Why Desugar Instead of a New Wire Type

| Concern | New `template` wire variant | Synthetic `std.concat` desugar |
|---|---|---|
| Engine changes | New `resolveTemplate()` method | **None** |
| New Wire type | New union member every consumer must handle | **None** — uses existing wire types |
| Cost scheduling | Custom parallel resolution logic | **Free** — engine already resolves tool inputs in parallel |
| Shadow trees | Must handle template wires in shadow cloning | **Free** — synthetic wires clone like any other |
| Testability | Template resolution tested via integration | **`std.concat` is unit-testable in isolation** |
| Formatter | Custom template reconstruction | Same pattern as pipe collapsing |
| Consistency | Special case in the engine | **Same pattern** as pipes and inline expressions |

### 📐 Syntax & Architecture Alternatives Considered

| Alternative | Rejected because |
|---|---|
| `${}` (JS-style) | Requires backtick strings — a new quoting style that breaks syntax highlighting |
| `concat` pipe: `o.x <- concat:i.a:i.b` | Cannot interleave literal text; ugly for URL paths |
| `+` operator for strings | Ambiguous with arithmetic `+`; multi-operand chains quickly become unreadable |
| Dedicated `url` tool | Too narrow — interpolation is needed far beyond URLs |
| New `template` Wire variant in the AST | Adds a union member every consumer must handle; requires new engine method; inconsistent with how pipes and expressions desugar |

### ⚠️ Migration Path

**Non-breaking.** Existing `.bridge` files are unaffected:

- Plain `StringLiteral` values without `{…}` behave exactly as before.
- The `=` constant operator remains verbatim (no interpolation).
- Pipes with string literals (`trim:"…"`) already work; adding `{…}` detection inside them is purely additive.

Code that currently works around the limitation with custom concat tools can
be simplified, but the old pattern remains valid.
