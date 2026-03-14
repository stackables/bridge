# Bridge Language Specification by Example

This folder contains a curated set of regression tests that double as
**executable documentation** for the Bridge language. Each file focuses on one
language concept and is written to be read top-to-bottom — the Bridge code
explains the feature, and the scenario titles describe the expected behaviour in
plain English.

> **Rule:** one file · one concept · every facet covered.

---

## Test Index

### 1. `wires.test.ts` — How data flows through a Bridge program

The two fundamental wire types and where they can read from.

- **Pull wires** (`<-`) connect data sources to tool inputs and output fields.
- **Constant wires** (`=`) assign literal JSON values.
- **Passthrough wires** return an entire object or array as the root output.
- Sources: `input`, `context`, `const`, tool output, nested paths.

### 2. `constants.test.ts` — Static values embedded in the program

`const` blocks hold JSON data that can be referenced anywhere via
`with const as c`. Covers primitives, objects, arrays, and nested access paths.

### 3. `tools.test.ts` — Calling external functions

How tools are declared (`tool X from source`), configured with input parameters,
and composed through inheritance (`tool child from parent`). Also covers
tool-level `on error` fallback.

### 4. `scope-and-handles.test.ts` — `with` bindings and handle visibility

Every dependency enters a block through a `with` declaration. Shows
`with input`, `with context`, `with const`, `with tool`, and `with define`;
handle naming; and the rule that handles are block-scoped (no leaking, no
implicit access).

### 5. `path-scoping.test.ts` — Nested scope blocks and spread

Scope blocks (`target { .a <- x; .b <- y }`) factor out repeated path prefixes.
The spread operator (`... <- source`) unpacks all fields. Covers nesting depth,
path concatenation, and spread-then-override.

### 6. `expressions.test.ts` — Arithmetic, comparison, and boolean logic

Inline expressions: `+`, `-`, `*`, `/`, `==`, `!=`, `>`, `>=`, `<`, `<=`,
`and`, `or`, `not`, and parentheses. Shows operator precedence and
short-circuit evaluation of `and`/`or`.

### 7. `string-interpolation.test.ts` — Template strings

`"/users/{i.id}/profile"` — placeholder resolution at runtime. Covers multiple
placeholders, type coercion (null → `""`), escaping (`\{`), and usage inside
different wire positions.

### 8. `ternary.test.ts` — Conditional wires

`condition ? trueSource : falseSource` — the only branching primitive. Lazy
evaluation (only the chosen branch executes), expression conditions, nesting,
and combination with fallback operators.

### 9. `array-mapping.test.ts` — Iterating over arrays

`source[] as item { ... }` maps each element into a new shape. Covers flat
mapping, nested arrays, empty/null arrays, shadow scopes (element isolation),
and the iterator variable.

### 10. `continue-and-break.test.ts` — Array control flow

`continue` skips an element, `break` stops the loop. Multi-level variants
`continue N` / `break N` pierce nested array boundaries. Only valid inside
array blocks.

### 11. `fallback-chain.test.ts` — Resilience operators

The four fallback layers, each triggered by a different condition:

- `||` — falsy (0, "", false, null, undefined)
- `??` — nullish only (null, undefined)
- `catch` — tool/resolution error
- `?.` — safe navigation (error → undefined)

Shows individual behaviour and composed chains.

### 12. `throw-and-panic.test.ts` — Raising errors

`throw "msg"` fails one field (partial error, GraphQL-compatible).
`panic "msg"` kills the entire request (fatal). Shows how `catch` swallows
`throw` but not `panic`, and how `?.` handles each.

### 13. `overdefinition.test.ts` — Cost-based resolution

When multiple wires target the same field, the engine tries the cheapest source
first (input/context = cost 0, tools = cost 1) and returns the first non-null
result. This enables progressive enrichment without explicit conditionals.

### 14. `alias.test.ts` — Caching resolved values

`alias source as name` evaluates once and caches the result. Prevents duplicate
tool calls. Top-level aliases live for the whole request; iterator-scoped
aliases are re-evaluated per array element.

### 15. `memoization.test.ts` — Deduplicating tool calls

`with tool as handle memoize` caches tool results keyed by input. When the same
inputs appear (e.g., in a loop), the tool is called only once. Different from
`alias` (which caches a value, not a tool invocation).

### 16. `pipes.test.ts` — Tool chaining shorthand

`target <- trim:upper:i.name` chains tools right-to-left. Each segment is an
independent tool call. Multiple pipes to the same tool produce parallel,
independent invocations.

### 17. `define-blocks.test.ts` — Reusable subgraphs

`define` blocks are parameterised, inlined subgraphs. They have their own
`input`/`output` and can be invoked multiple times with different wiring.
Bridge's only abstraction/reuse mechanism within a file.

### 18. `force.test.ts` — Eager side-effect scheduling

`force handle` runs a tool even if no output field reads from it. Used for
audit logging, analytics, webhooks. `force handle catch null` makes it
fire-and-forget (errors silently swallowed).

### 19. `array-batching.test.ts` — Native call batching in loops

Loop-scoped tools can receive all iterations as a single batched call instead of
N individual calls. Reduces network round-trips. Shows the batching contract
and partial-failure semantics per element.

### 20. `builtin-tools.test.ts` — The `std.*` standard library

Built-in tools: `std.httpCall`, `std.str.*` (toUpperCase, toLowerCase, trim,
length), `std.arr.*` (filter, find, first, toArray), and `std.audit`. The
batteries-included toolkit.

### 21. `error-reporting.test.ts` — Error locations and formatting

How Bridge reports errors: source locations pointing to the failing tool/wire,
structured messages, and context for nested errors (inside ternaries, arrays,
scope blocks).

### 22. `circular-dependency.test.ts` — Cycle detection

When wires form A → B → A loops, the engine detects the cycle before execution
and raises a panic. Shows what cyclical graphs look like and how the engine
rejects them.

### 23. `tracing.test.ts` — Execution traces and observability

Traces record every tool call with name, inputs, outputs, and duration.
Verifies trace counts (important for deduplication/memoization/batching) and
the trace output shape.
