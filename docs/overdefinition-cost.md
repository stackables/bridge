# Overdefinition Cost Model

When multiple wires target the same output field (overdefinition), the engine
must decide which to evaluate first. A cheaper wire that resolves non-null
lets us skip expensive ones entirely.

## Current model (binary)

```
cost 0 — can resolve without scheduling a tool call
cost 1 — requires a new tool call
```

`classifyOverdefinitionWire()` returns 0 or 1. `orderOverdefinedWires()`
sorts ascending, ties broken by authoring order.

## New model (granular)

### Cost tiers

| Cost | Source description                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Already resolved (value in `state`), already scheduled (Promise in `state`), input, context, const, literal, control, element ref |
| 1    | Sync tools (default), defines/locals chaining through cheap sources                                                               |
| 2    | Async tools (default), unknown/unresolvable tools                                                                                 |
| n    | Explicit `ToolMetadata.cost` override                                                                                             |

### Key rules

1. **Already resolved or scheduled → cost 0.** If `state[trunkKey(ref)]`
   is defined, the work is already done or in flight — using it is free.

2. **Already-scheduled promises → cost 0** (not 1). The cost is already
   paid by the time we reach overdefinition ordering. Awaiting a promise
   that's already in flight costs nothing extra.

3. **Pessimistic wire cost = sum of source costs.** A fallback chain
   (`a || b || c`) may evaluate all sources, so the total potential cost is
   the sum. Used for define/local recursive resolution.

4. **Optimistic wire cost = cost of the first source.** The minimum you
   will pay to try the wire. Used for overdefinition ordering
   (`classifyOverdefinitionWire` returns this).

5. **Define/local cost = min of incoming wire costs (pessimistic).** Defines
   are inlined — the engine picks the cheapest incoming wire.

6. **Tool cost defaults:** `sync: true` → cost 1, otherwise → cost 2.
   An explicit `cost` on `ToolMetadata` overrides both.

### ToolMetadata addition

```ts
export interface ToolMetadata {
  // ... existing fields ...

  /**
   * Overdefinition priority cost.  Lower values are tried first when
   * multiple wires target the same field.
   *
   * Default: 1 for sync tools, 2 for async tools.
   */
  cost?: number;
}
```

## Files changed

| File                                | Change                                                  |
| ----------------------------------- | ------------------------------------------------------- |
| `bridge-types/src/index.ts`         | Add `cost?: number` to `ToolMetadata`                   |
| `bridge-core/src/ExecutionTree.ts`  | Replace 3 boolean helpers with 3 numeric cost functions |
| `bridge-compiler/src/codegen.ts`    | Replace boolean classification with numeric             |
| `bridge/test/coalesce-cost.test.ts` | Add sync-vs-async and explicit-cost scenarios           |

No changes needed to `resolveWires.ts` (`orderOverdefinedWires` already
sorts by arbitrary numbers) or `tree-types.ts` (interface already returns
`number`).

## Implementation: ExecutionTree

Replace `classifyOverdefinitionWire` body:

```
classifyOverdefinitionWire(wire) → computeExprCost(wire.sources[0].expr)
```

Optimistic cost — only the first source determines ordering priority.

### `computeWireCost(wire, visited?)` — pessimistic

- For each `source` in `wire.sources`: sum `computeExprCost(source.expr)`
- If `wire.catch?.ref`: add `computeRefCost(wire.catch.ref)`
- Return **sum** of all costs

Used for recursive define/local resolution ("what's the total potential
cost of using this define?").

### `computeExprCost(expr, visited?)`

- `literal` / `control` → 0
- `ref` → `computeRefCost(expr.ref)`
- `ternary` → max(cond, then, else)
- `and` / `or` → max(left, right)

### `computeRefCost(ref, visited?)`

- `ref.element` → 0
- `hasCachedRef(ref)` → 0 _(includes already-scheduled promises)_
- `SELF_MODULE` input/context/const → 0
- `__define_*` / `__local` → min of incoming wire costs (recursive, cycle → ∞)
- External tool → `lookupToolFn(this, toolName)` → read
  `.bridge?.cost ?? (.bridge?.sync ? 1 : 2)`, default 2 for unknown

## Implementation: Compiler

Same tier logic but no runtime state and no `hasCachedRef`. Compiler
defaults unknown external tools to cost 2 (conservative). Defines and
locals use the same recursive-min approach.
