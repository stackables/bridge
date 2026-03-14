# Wire Unification — Unified Sources Model

> Tracking doc for the refactor of Wire storage and execution.

## Motivation

Today a wire is a 5-variant discriminated union (`from` | `value` | `cond` |
`condAnd` | `condOr`), each with repeated catch/fallback fields. The primary
source and fallback sources are stored differently (`from` + `fallbacks[]`)
even though they're conceptually the same thing: an ordered sequence of
"try this expression, and if the gate opens, try the next one."

**Goal:** unify storage so every wire is:

1. An **ordered list of source entries** — each entry is an _expression_ to
   evaluate plus an optional _gate_ that decides whether to fall through.
2. A **global catch handler** for the whole wire.

---

## Key Distinction: Expression vs Gate

Bridge source like:

```bridge
o.twoSource   <- a.label || b.label
o.threeSource <- a.label || b.label || c.label
o.withLiteral <- a.label || b.label || "default"
o.withCatch   <- a.label || b.label || "null-default" catch "error-default"
```

The `||` and `??` here are **wire-level fallback gates** — they control when
the engine moves to the next source entry. They are _not_ expression
operators. They live on the wire's source list:

```
sources: [
  { expr: ref(a.label) },                          // always evaluated
  { expr: ref(b.label),      gate: "falsy" },      // evaluated if previous was falsy
  { expr: literal("default"), gate: "falsy" },      // evaluated if previous was falsy
]
catch: { value: "error-default" }
```

Inside an expression, the only binary operators are the boolean-producing
`&&` and `||` from `condAnd`/`condOr` wire shapes (e.g. `a.active && b.ready`
evaluates to `true`/`false`). These are genuinely recursive expression
operators and belong in the `Expression` tree.

---

## New Types

### Expression

A recursive tree that evaluates to a single value within one source entry.

```typescript
export type Expression =
  // ── Base values ──────────────────────────────────
  | {
      /** Pull a data source reference */
      type: "ref";
      ref: NodeRef;
      safe?: true; // ?. safe navigation
      refLoc?: SourceLocation; // location of the ref token
      loc?: SourceLocation;
    }
  | {
      /** JSON-encoded constant: "\"hello\"", "42", "true", "null" */
      type: "literal";
      value: string;
      loc?: SourceLocation;
    }

  // ── Branching ────────────────────────────────────
  | {
      /** Ternary: `cond ? then : else` */
      type: "ternary";
      cond: Expression;
      then: Expression;
      else: Expression;
      condLoc?: SourceLocation;
      thenLoc?: SourceLocation;
      elseLoc?: SourceLocation;
      loc?: SourceLocation;
    }

  // ── Boolean operators ────────────────────────────
  | {
      /** Short-circuit logical AND: `left && right` → boolean */
      type: "and";
      left: Expression;
      right: Expression;
      leftSafe?: true;
      rightSafe?: true;
      loc?: SourceLocation;
    }
  | {
      /** Short-circuit logical OR: `left || right` → boolean */
      type: "or";
      left: Expression;
      right: Expression;
      leftSafe?: true;
      rightSafe?: true;
      loc?: SourceLocation;
    }

  // ── Control flow ─────────────────────────────────
  | {
      /** Loop/error control: throw, panic, continue, break */
      type: "control";
      control: ControlFlowInstruction;
      loc?: SourceLocation;
    };
```

### WireSourceEntry

One entry in the wire's ordered fallback chain. The first entry has no gate
(always evaluated); subsequent entries have a gate that opens when the
running value meets the condition.

```typescript
export interface WireSourceEntry {
  /** The expression to evaluate for this source */
  expr: Expression;
  /**
   * When to try this entry:
   * - absent  → always (first entry)
   * - "falsy" → previous value was falsy (0, "", false, null, undefined)
   * - "nullish" → previous value was null or undefined
   *
   * Corresponds to `||` (falsy) and `??` (nullish) in bridge source.
   */
  gate?: "falsy" | "nullish";
  loc?: SourceLocation;
}
```

### WireCatch

Unified catch handler — replaces the current `catchFallback` / `catchFallbackRef` / `catchControl` triple.

```typescript
export type WireCatch =
  | { ref: NodeRef; loc?: SourceLocation }
  | { value: string; loc?: SourceLocation }
  | { control: ControlFlowInstruction; loc?: SourceLocation };
```

### Wire (unified)

No longer a discriminated union. Every wire has the same shape.

```typescript
export type Wire = {
  to: NodeRef;
  sources: WireSourceEntry[];
  catch?: WireCatch;
  pipe?: true;
  spread?: true;
  loc?: SourceLocation;
};
```

---

## Mapping Current Shapes → New Model

### Pull wire (`from`)

```
// Before
{ from: ref(a.label), to: ref(o.x), safe: true, fallbacks: [...], catchFallback: "err" }

// After
{
  to: ref(o.x),
  sources: [{ expr: { type: "ref", ref: ref(a.label), safe: true } }, ...],
  catch: { value: "err" },
}
```

### Constant wire (`value`)

```
// Before
{ value: "42", to: ref(o.x) }

// After
{ to: ref(o.x), sources: [{ expr: { type: "literal", value: "42" } }] }
```

### Ternary wire (`cond`)

```
// Before
{
  cond: ref(flag), thenRef: ref(a.x), elseValue: "fallback",
  to: ref(o.x), fallbacks: [...]
}

// After
{
  to: ref(o.x),
  sources: [
    {
      expr: {
        type: "ternary",
        cond: { type: "ref", ref: ref(flag) },
        then: { type: "ref", ref: ref(a.x) },
        else: { type: "literal", value: "fallback" },
      }
    },
    ...fallback entries with gates...
  ],
}
```

### condAnd / condOr wire

```
// Before
{ condAnd: { leftRef: ref(a), rightRef: ref(b), safe: true }, to: ref(o.x) }

// After
{
  to: ref(o.x),
  sources: [{
    expr: {
      type: "and",
      left: { type: "ref", ref: ref(a) },
      right: { type: "ref", ref: ref(b) },
      leftSafe: true,
    }
  }],
}
```

---

## Migration Stages

### Stage 1: Foundation — types + helpers ✅

- [x] Define `Expression`, `WireSourceEntry`, `WireCatch`, `WireV2` in
      `packages/bridge-core/src/types.ts` alongside existing types
- [x] Write `legacyToV2(old: Wire): WireV2` conversion helper in
      `packages/bridge-core/src/wire-compat.ts`
- [x] Write `v2ToLegacy(w: WireV2): Wire` reverse conversion
- [x] Write type guards: `isRef(e)`, `isLiteral(e)`, `isTernary(e)`, etc.
- [x] Export new types from `packages/bridge-core/src/index.ts`
- [x] **Verify:** `pnpm build` passes, no behavioral changes

### Stage 2: V2 resolver module ✅

- [x] Write recursive `evaluateExpression(ctx, expr, pullChain)` function
      → `packages/bridge-core/src/resolveWiresV2.ts`
- [x] Write `resolveSourceEntries(ctx, w, pullChain, bits)` — unified
      source loop with gate semantics and catch handling
- [x] Write `applyFallbackGatesV2`, `applyCatchV2` — exported V2 equivalents
- [x] Unify trace recording: `recordSourceBit(index)` replaces
      `recordPrimary` + `recordFallback(i)` — accepts TraceWireBits directly
- [x] Write V2 test suite: 53 tests in `resolve-wires-v2.test.ts`
- [x] **Verify:** `pnpm build && pnpm test` — all 1916 tests pass

### Stage 3: Execution engine delegation

- [ ] In `resolveWires.ts`: make `resolveWiresAsync()` convert each wire
      via `legacyToV2()` and delegate to `resolveSourceEntries()` from V2
- [ ] Update `refsInWire()` in `scheduleTools.ts` to also extract refs
      from WireV2 via a recursive Expression walker
- [ ] Update `canResolveWireWithoutScheduling()` in `ExecutionTree.ts`
      to handle WireV2 via recursive Expression walk
- [ ] **Verify:** `pnpm build && pnpm test`

### Stage 4: Parser

- [ ] Update wire construction in `parser.ts` to produce `WireV2`
  - Pull wires: `from` → `sources: [{ expr: { type: "ref", ref, safe } }]`,
    append fallbacks as subsequent entries with gates
  - Constant wires: `value` → `sources: [{ expr: { type: "literal", value } }]`
  - Ternary: `cond` → `sources: [{ expr: { type: "ternary", ... } }]`
  - condAnd/condOr → `sources: [{ expr: { type: "and"|"or", ... } }]`
  - Catch fields → `catch: { ref | value | control }`
- [ ] Remove `legacyToV2()` adapter from execution engine
- [ ] **Verify:** `pnpm build && pnpm test && pnpm e2e`

### Stage 5: Serializer

- [ ] Update `bridge-format.ts` — replace `"from" in w` / `w.from` /
      `w.fallbacks` patterns with `sources[]` iteration + expression visitors
- [ ] **Verify:** `pnpm build && pnpm test` — round-trip tests

### Stage 6: Compiler

- [ ] Update `codegen.ts` — `wireToExpr()`, `applyFallbacks()`,
      `emitToolCall()` (~70 sites)
- [ ] Update `bridge-asserts.ts` (compiler + graphql)
- [ ] Update `fuzz-compile.fuzz.ts` — wire arbitraries
- [ ] **Verify:** `pnpm build && pnpm test && pnpm e2e`

### Stage 7: Cleanup

- [ ] Rename `WireV2` → `Wire`, remove old type + `WireFallback`
- [ ] Remove conversion utilities and `wire-compat.ts`
- [ ] Update package exports
- [ ] `pnpm changeset` for bridge-core, bridge-parser, bridge-compiler,
      bridge-graphql
- [ ] **Verify:** `pnpm build && pnpm lint && pnpm test && pnpm e2e`

---

## Files in Scope

| File                                           | What changes                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `bridge-core/src/types.ts`                     | New types (`Expression`, `WireSourceEntry`, `WireCatch`, `WireV2`), eventually replaces old `Wire` + `WireFallback` |
| `bridge-core/src/wire-compat.ts`               | NEW — conversion between old and new wire shapes (temporary)                                                        |
| `bridge-core/src/resolveWires.ts`              | Merge 3-layer model into `evaluateExpression()` + source-loop; unify trace recording                                |
| `bridge-core/src/tree-utils.ts`                | `getSimplePullRef()` fast-path for new shape                                                                        |
| `bridge-core/src/enumerate-traversals.ts`      | `TraceWireBits` rename, bit allocation over `sources[]`                                                             |
| `bridge-core/src/ExecutionTree.ts`             | Wire scheduling, caching, dependency extraction                                                                     |
| `bridge-core/src/scheduleTools.ts`             | Ref extraction from recursive `Expression`                                                                          |
| `bridge-core/src/toolLookup.ts`                | Tool wire resolution                                                                                                |
| `bridge-parser/src/parser/parser.ts`           | Wire construction → `WireV2` with `Expression` nodes                                                                |
| `bridge-parser/src/bridge-format.ts`           | Serializer: ~60 `w.from` sites, fallback/catch serialization                                                        |
| `bridge-compiler/src/codegen.ts`               | Compiler: ~70 sites, `wireToExpr()`, `applyFallbacks()`                                                             |
| `bridge-compiler/src/bridge-asserts.ts`        | Compiler validation                                                                                                 |
| `bridge-graphql/src/bridge-asserts.ts`         | GraphQL validation                                                                                                  |
| `bridge-core/test/resolve-wires-gates.test.ts` | ~30 direct wire constructions                                                                                       |
| `bridge-compiler/test/fuzz-compile.fuzz.ts`    | Fuzz test wire arbitraries                                                                                          |

---

## Design Decisions

1. **Bridge `||` and `??` are NOT expression operators.** They are wire-level
   fallback gates that control when the engine moves to the next source entry.
   They live on `WireSourceEntry.gate`, not inside the `Expression` tree.

2. **`Expression` is recursive.** A ternary can contain refs, a ref can be
   safe-navigated, boolean `&&`/`||` (which produce booleans, unlike the
   fallback gates) are expression-level operators.

3. **`condAnd` and `condOr` become `Expression` nodes of type `"and"` and
   `"or"`.** These are the boolean-producing short-circuit operators
   (`a.active && b.ready` → `true`/`false`). Distinct from wire fallback gates.

4. **Constant wires unify.** `{ value: "42", to }` becomes
   `{ sources: [{ expr: { type: "literal", value: "42" } }], to }`.

5. **Catch handler unifies.** The three separate fields (`catchFallback`,
   `catchFallbackRef`, `catchControl`) merge into a single `catch?: WireCatch`.

6. **Wire is no longer a discriminated union.** Variant detection moves from
   wire level (`"from" in w`) to expression level (`sources[0].expr.type`).

7. **`pipe` and `spread` stay at wire level.** These are routing concepts,
   not per-source concerns.

8. **Staged migration.** New types coexist with old via `WireV2` naming.
   Conversion utilities bridge the gap. Old type removed in final cleanup.

9. **No syntax/language changes.** This is purely internal storage
   restructuring. Playground and VS Code extension don't need updates.

---

## Open Questions

- **Performance:** Single-ref wires (the common case) now allocate a
  `sources: [{ expr: { type: "ref", ref } }]` array + expression object.
  Benchmark against loadtest suite after Stage 2 to quantify.

- **Future operators:** The `Expression` type is designed for extension.
  Arithmetic (`+`, `-`), comparison (`==`, `!=`), string interpolation, etc.
  could be added as new expression variants without changing the wire model.

- **Recursive expression in fallback position:** The type allows
  `sources[1].expr` to be a ternary or `and`/`or` expression, even though
  the parser doesn't emit that today. This is intentional — it keeps the
  type system honest and future-proof.
