# Refactoring: ArrayMap as Expression

## Problem

Array mapping (`source[] as i { ... }`) is not an expression. It's stored as:

- Flat element wires with `element: true` on NodeRef, mixed in with all other wires
- `Bridge.arrayIterators = { "path": "iteratorName" }` metadata
- `NodeRef.elementDepth` for nested arrays

This makes composition impossible — array mapping can't appear in `||` fallback chains, ternaries, or as alias sources without extensive special-casing. The serializer needs 500+ lines to reconstruct array blocks from scattered flat wires.

## Lessons from First Attempt

The first implementation attempt achieved functional correctness (all tests green) but
**failed to simplify the architecture**. Key anti-patterns to avoid:

### 1. Overlay Wire Injection (Do Not Repeat)

The first attempt moved element wires into `arrayMap.elementWires` but then created
an `overlayWires` + `allWires` mechanism to re-flatten them onto shadow trees so that
7 existing wire-scanning methods could find them. This is *worse* than the original —
it added 3 fields, a getter, a 50-line `expandElementWires()` static method, and 4
copy-pasted `injectOverlayWires()` call sites.

**Root cause:** The wire-scanning sites (`pullOutputField`, `resolveNestedField`,
`collectOutput`, `response`, `planShadowOutput`) all do linear scans of `bridge.wires`
or `this.allWires`. Instead of adding an overlay shim, the correct approach is to make
those sites **resolve element wires through the arrayMap expression directly**.

### 2. Compiler Iterator Map Reconstruction (Do Not Repeat)

The compiler reconstructed a flat `Record<string, string>` arrayIterators map from the
hierarchical arrayMap AST, then `buildElementBody` re-hierarchified it via TreeNode
grouping. Net effect: +300 lines, same complexity.

**Correct approach:** `wireToExpr()` should handle `arrayMap` directly and recurse
into `elementWires`, generating `.map(iter => ({ ... }))` inline. No iterator map needed.

### 3. Traversal Coverage Regression (Must Fix)

The first attempt dropped all element-internal wires from traversal enumeration,
replacing per-field primary/fallback/catch/error entries with a single `empty-array`
entry. This loses API-level behavioral coverage for array element processing.

**Correct approach:** `enumerateTraversalIds` must recurse into `arrayMap.elementWires`
with prefixed targets , preserving all traversal entries from element wires.

### 4. Complexity Scorecard (First Attempt)

| File | Before | After | Delta | Verdict |
|------|--------|-------|-------|---------|
| ExecutionTree.ts | 1869 | 2040 | **+171** | Worse — overlay shim added |
| codegen.ts | 4862 | 5164 | **+302** | Worse — iterator map reconstruction |
| bridge-format.ts | 2690 | 2148 | **−542** | Better — serializer simplified |
| materializeShadows.ts | 293 | 328 | **+35** | Worse — second elementWire expansion |
| enumerate-traversals.ts | 729 | 736 | **+7** | Neutral but lost coverage |
| scheduleTools.ts | 395 | 397 | **+2** | Neutral |
| **Total** | **10838** | **10813** | **−25** | Negligible net change |

Target for second attempt: **net −500 to −800 lines** across these files, with improved
traversal coverage.

## Solution

Make `arrayMap` a first-class `Expression` variant. Array blocks become self-contained
expression trees that compose naturally with all other expressions.

### New `arrayMap` Expression

```typescript
{
  type: "arrayMap";
  source: Expression;         // e.g., ref(api.users)
  iterator: string;           // "u"
  elementWires: Wire[];       // inner wires with RELATIVE target paths
  handles?: HandleBinding[];  // element-scoped tool/define declarations
  loc?: SourceLocation;
}
```

Inner wire targets use relative paths: `{ path: ["name"] }` (no module/type/field trunk).
Element-scoped handles live in `arrayMap.handles` (self-contained body).

### Iterator References: `ITER_MODULE`

Element refs like `item.name` become `{ module: "__iter", type: "", field: "item", path: ["name"] }`.
This replaces `element: true` + `elementDepth` — depth is structural (looking up the
iterator name through nested arrayMap scopes). `ITER_MODULE = "__iter"` is a module
sentinel, analogous to `SELF_MODULE = "_"`.

### Fields Removed

- `Bridge.arrayIterators` — iterator info lives inside `arrayMap` expression
- `DefineDef.arrayIterators` — same
- `NodeRef.element` — becomes `module === ITER_MODULE`
- `NodeRef.elementDepth` — depth is structural (nesting)
- `HandleBinding.element` — element-scoped handles move into `arrayMap.handles`

### Composition Examples

```bridge
# Array with fallback — two arrayMap expressions in one wire
o.users <- api.users[] as u {
  .name <- u.name
} || backup_db.users[] as b {
  .name <- b.name
} catch []

# Alias over array mapping — just a wire with arrayMap source
alias mapped <- source[] as i {
  .name <- i.name
}

# Nested arrays — recursive structure
o.routes <- api.routes[] as r {
  .name <- r.routeName
  .legs <- r.legs[] as l {
    .station <- l.station
  }
}
```

## Implementation Steps

Each step produces a green build + test suite. Steps are ordered to minimize
the number of files touched simultaneously and to make each change independently
verifiable.

### Step 1: Add `arrayMap` Expression Type + `ITER_MODULE` (additive only)

**Files:** `bridge-core/src/types.ts`, `bridge-core/src/index.ts`

**Changes:**
1. Add `arrayMap` variant to `Expression` union type
2. Add `ITER_MODULE = "__iter"` constant
3. Export `ITER_MODULE` from index

**Do NOT remove anything yet.** All old fields stay. This is purely additive.

**Checkpoint:** `pnpm build` — zero errors. No runtime changes, no test changes.

---

### Step 2: Parser emits `arrayMap` expressions

**Files:** `bridge-parser/src/parser/parser.ts`

**Changes:**
1. In `buildBridgeBody()`, where it currently produces element wires + populates
   `arrayIterators`: use a splice pattern to collect element wires, then wrap them in
   an `arrayMap` expression on the source wire.
2. In `processElementLines()`, iterator refs become `{ module: ITER_MODULE, type: "", field: iterName, path: [...] }` instead of `{ module: SELF_MODULE, ..., element: true, elementDepth: N }`.
3. Element wire targets get relative paths: `{ path: ["name"] }` not `{ path: ["results", "name"] }`.
4. Nested array blocks recurse: inner `processElementLines` produces inner `arrayMap` expressions.
5. Alias + array mapping: same pattern — arrayMap expression on the alias wire.
6. Define handles inside array bodies: collect into `arrayMap.handles`, then run
   `inlineDefine()` recursively on `arrayMap.elementWires`.
7. Stop populating `arrayIterators` on Bridge/DefineDef.

**Key rule:** Parser STILL populates the old fields (`element`, `elementDepth`,
`arrayIterators`) on `Bridge` in ADDITION to the new `arrayMap` expression. This is a
**dual-emit** strategy so that downstream consumers continue working unchanged.

Wait — that would defeat the purpose. Better approach:

**Key rule:** Parser emits ONLY the new format. Old fields are removed from Bridge
output. All downstream breakage is fixed in subsequent steps. But we keep `element`
and `elementDepth` on NodeRef type temporarily (not populated, but type still exists)
so `bridge.wires` type still compiles.

Actually, the cleanest approach per first-attempt lessons:

**Key rule:** Remove `arrayIterators` from output. Remove `element`/`elementDepth`
from NodeRef type. Remove `HandleBinding.element`. Fix each downstream consumer
in subsequent steps. Accept type errors as a migration checklist.

**Checkpoint:** `pnpm build` on bridge-parser (may have type errors in dependents).
Run `pnpm test --filter bridge-parser` — parser tests green after updating assertions
to expect `arrayMap` expressions instead of flat element wires.

---

### Step 3: Update parser tests

**Files:** `bridge-parser/test/bridge-format.test.ts`, `bridge-parser/test/path-scoping-parser.test.ts`, `bridge-parser/test/source-locations.test.ts`, `bridge-parser/test/parser-compat.test.ts`

**Changes:**
1. Tests that assert `element: true` on refs → assert `module: "__iter"` instead
2. Tests that count `bridge.wires` including element wires → find the `arrayMap`
   expression and check `elementWires` within it
3. Source location tests → look inside `arrayMap.elementWires` for wire locations
4. Round-trip (format) tests → verify parse → serialize → parse produces identical
   `arrayMap` structure

**Checkpoint:** `pnpm test --filter bridge-parser` — all green.

---

### Step 4: Serializer reads `arrayMap` expressions directly

**Files:** `bridge-parser/src/bridge-format.ts`

**Changes:**
1. Add `serializeArrayMapBody(am, indent)` — walk `am.elementWires`, emit `.field <- source` lines, recurse for nested arrayMap
2. In main wire loop, detect `isArrayMap(w)` → emit `target <- source[] as iter {`, call `serializeArrayMapBody`, emit `}`
3. Handle element-scoped tool/define declarations from `am.handles`
4. Handle element-scoped aliases (wires to `__local` inside elementWires)
5. Handle element-scoped pipes, expressions, concat/template strings inside elementWires
6. **DELETE:** `serializeArrayElements()` (~250 lines), `isUnderArrayScope()`,
   `ITER.` placeholder system, `elementPullWires`, `elementConstWires`,
   `elementExprWires`, `elementPipeWires`, `elementToolTrunkKeys`,
   `elementToolScope`, `elementHandleScope`, `serializeElemRef()`,
   `serializeElemExprTreeFn()`, `isElementToolWire()`, `isDefineOutElementWire()`
7. **DELETE:** Element-scoped ternary handling, depth-stack resolution

**This is where the big deletion happens.** Target: bridge-format.ts drops from
2690 → ~1800 lines (net −900).

**Checkpoint:** Parse → serialize → parse round-trip tests green. Full bridge-parser
test suite green.

---

### Step 5: Runtime — `evaluateExpression` + `createShadowArray`

**Files:** `bridge-core/src/resolveWiresSources.ts`, `bridge-core/src/ExecutionTree.ts`

**Changes to resolveWiresSources.ts:**
1. Add `case "arrayMap":` to `evaluateExpression()` — evaluate only `expr.source`,
   return the raw array. Shadow tree creation is the caller's job.

**Changes to ExecutionTree.ts — shadow tree creation:**
1. `createShadowArray(items, arrayPathKey, iteratorName)` stores each element under
   both `elementTrunkKey` and `ITER_MODULE::iteratorName:*` in shadow state
2. No `overlayWires` field. No `_allWires` cache. No `allWires` getter.
   No `injectOverlayWires`. No `expandElementWires`.

**Key design:** Shadow trees receive the `arrayMap` expression itself (or its
`elementWires`) as a parameter. The 7 wire-scanning sites are updated to also check
the shadow's element wires. This is done by passing `elementWires` to a new
`resolveElementField(path, elementWires)` helper — NOT by injecting them into a flat
merged array.

Wait, that still threads element wires everywhere. Better:

**Key design decision (critical):** Each shadow tree stores a reference to its
`arrayMap` expression (specifically `elementWires` and `handles`). Wire-scanning
methods check `this.elementWires` first (for element-scoped wires), then fall through
to `bridge.wires` (for parent-scoped wires delegate to parent). This is a simple
two-level lookup, not a merged flat array.

Implementation:
```typescript
// On ExecutionTree (shadow instances only):
private elementWires?: readonly Wire[];
private elementHandles?: readonly HandleBinding[];
```

When `pullOutputField`, `resolveNestedField`, `collectOutput`, or `response` scan
for wires matching a trunk+path:
```typescript
// Instead of:  this.allWires.filter(w => sameTrunk(w.to, ...) && ...)
// Do:
const fromElement = this.elementWires?.filter(w => pathEquals(w.to.path, path)) ?? [];
if (fromElement.length > 0) return this.resolveWires(fromElement);
// else fall through to bridge.wires (handled by parent delegation)
```

The element wires have RELATIVE paths (`["name"]` not `["results", "name"]`), so the
match is direct — no path prefix stripping needed. This is the simplification payoff
of relative paths.

**Do NOT change:** `pullSingle`, `schedule`, `trunkDependsOnElement`, `hasCachedRef`,
`computeRefCost` — these already delegate to parent for non-element refs. For
`ITER_MODULE` refs, `pullSingle` looks up iterator state from the shadow chain.

**Checkpoint:** `pnpm build --filter bridge-core && pnpm test --filter bridge-core` — green.

---

### Step 6: Runtime — `pullOutputField` and `response` array materialisation

**Files:** `bridge-core/src/ExecutionTree.ts`

**Changes:**
1. In `pullOutputField(path, array)`: when the matching wire has an `arrayMap` source
   expression, resolve it, create shadow trees, store `elementWires` on each shadow.
   Remove the `hasElementWires` scan pattern (3 occurrences using `getPrimaryRef`).
2. In `response()` (GraphQL path): same — detect arrayMap, create shadows with
   element wires, materialise.
3. In `resolveNestedField()`: same pattern.
4. In `run()` (root array output): same pattern.
5. **DELETE:** `getPrimaryRef` import, `hasElementWires` pattern (3 sites),
   `overlayWires`, `_allWires`, `allWires`, `injectOverlayWires`, `expandElementWires`.

**Checkpoint:** `pnpm test --filter bridge-core` — green. Then `pnpm test --filter bridge` — green (the big integration suite).

---

### Step 7: Runtime — `materializeShadows` + `planShadowOutput`

**Files:** `bridge-core/src/materializeShadows.ts`

**Changes:**
1. `planShadowOutput` reads element wires from the shadow tree's stored `elementWires`
   reference. No expansion/prepend needed — element wires have relative paths, and the
   materialiser iterates them directly.
2. **DELETE:** `expandArrayMap` helper, `isOutputWire` helper, path-prepending logic.

**Checkpoint:** `pnpm test --filter bridge-core` + `pnpm test --filter bridge` — green.

---

### Step 8: Runtime — `scheduleTools` + `enumerate-traversals`

**Files:** `bridge-core/src/scheduleTools.ts`, `bridge-core/src/enumerate-traversals.ts`

**Changes to scheduleTools.ts:**
1. `trunkDependsOnElement`: check `ITER_MODULE` instead of `ref.element`
2. `schedule`: use `this.bridge.wires` (not `allWires`) — element wires don't appear
   in the top-level wires anymore, so no filtering needed
3. Remove `allWires` from `SchedulerContext` interface

**Changes to enumerate-traversals.ts (CRITICAL — preserve coverage):**
1. When encountering an `arrayMap` wire, add the `empty-array` entry AND recurse
   into `elementWires` to enumerate primary/fallback/catch/error entries with prefixed
   target paths
2. `isPlainArraySourceWire`: detect `arrayMap` type
3. `canRefError`: check `ITER_MODULE` instead of `ref.element`/`ref.elementDepth`
4. `refLabel`: check `ITER_MODULE` instead of `ref.element`

**Test:** Verify the `o <- api.items[] as a { .data <- a.a ?? a.b }` example produces
3 traversals (empty-array + primary + nullish-fallback), NOT 1.

**Checkpoint:** `pnpm test --filter bridge-core` — green, with traversal coverage
preserved.

---

### Step 9: Runtime — `tree-utils.ts` cleanup

**Files:** `bridge-core/src/tree-utils.ts`

**Changes:**
1. Remove `element?: boolean` from `trunkKey()` parameter type
2. Remove the `if (ref.element)` branch — this key pattern is now handled by
   `ITER_MODULE` module-based state keys

**Checkpoint:** `pnpm build --filter bridge-core` — if anything still references the
old `element` trunkKey pattern, it will fail here. Fix those callers.

---

### Step 10: Compiler — `wireToExpr` handles `arrayMap` directly

**Files:** `bridge-compiler/src/codegen.ts`

**Changes:**
1. In `wireToExpr()`, add `case "arrayMap":` — generate
   `(source)?.map(iter => ({ field1: iter.x, field2: iter.y })) ?? null`
2. For nested arrayMaps: recurse. The generated code naturally nests
   `.map(() => ({ inner: source.map(() => ({...})) }))`.
3. For element-scoped tool preambles: generate tool calls inside the map callback.
4. For control flow (break/continue): generate `flatMap` or imperative loop as before,
   but driven from `arrayMap.elementWires` directly.
5. **DELETE:** `arrayIterators` reconstruction from `arrayMap` expressions (~30 lines),
   `relativeArrayIterators` helper.
6. **After parity proven:** DELETE `buildElementBody` (~160 lines) and
   `buildElementBodyWithControlFlow` (~90 lines) if they're no longer called.

**Checkpoint:** `pnpm test --filter bridge-compiler` — green. Then
`pnpm test --filter bridge` (shared parity tests) — green.

---

### Step 11: GraphQL driver + bridge-asserts

**Files:** `bridge-graphql/src/bridge-asserts.ts`

**Changes:**
1. `assertBridgeGraphQLCompatible`: recurse into `arrayMap.elementWires` to check for
   break/continue control flow, instead of scanning flat `bridge.wires` for element wires.

**Checkpoint:** `pnpm test --filter bridge-graphql` — green.

---

### Step 12: Playground + VS Code extension

**Files:** `playground/src/engine.ts`, `playground/src/codemirror/bridge-lang.ts`

**Changes:**
1. `extractInputSkeleton`: remove `!ref.element` filter — with ITER_MODULE refs,
   iterator refs naturally won't match `module === "_"` so the filter is implicit.
2. Any other `ref.element` references → remove.

**Checkpoint:** Playground builds. Manual smoke test in browser.

---

### Step 13: Type system cleanup — remove old fields

**Files:** `bridge-core/src/types.ts`

**Changes:**
1. Remove `element?: boolean` from NodeRef
2. Remove `elementDepth?: number` from NodeRef
3. Remove `arrayIterators` from Bridge
4. Remove `arrayIterators` from DefineDef
5. Remove `element?: true` from HandleBinding (tool variant)

**Checkpoint:** `pnpm build` — zero errors. This is the moment of truth. Any remaining
references to old fields will surface as type errors. Fix them.

---

### Step 14: Full verification

```bash
pnpm build       # 0 errors
pnpm lint        # 0 errors
pnpm test        # 0 failures, traversal coverage preserved
pnpm e2e         # all examples pass
```

Review complexity scorecard — target deltas:
| File | Before | Target | Delta |
|------|--------|--------|-------|
| ExecutionTree.ts | 1869 | ~1750 | −120 |
| codegen.ts | 4862 | ~4600 | −260 |
| bridge-format.ts | 2690 | ~1800 | −890 |
| materializeShadows.ts | 293 | ~260 | −33 |
| enumerate-traversals.ts | 729 | ~720 | −9 |
| **Total** | **10443** | **~9130** | **−1310** |

---

### Step 15: Changeset + documentation

1. `pnpm changeset` — major for bridge-core, bridge-parser, bridge-compiler
2. Update `docs/llm-notes.md` if architecture description changed
3. Delete this refactoring doc or move to `docs/decisions/` as a decision record

## Key Architectural Rules

### DO:
- Element wires have **relative paths** — `{ path: ["name"] }` not `{ path: ["results", "name"] }`
- Shadow trees store a reference to their `elementWires` — two-level lookup, not merged arrays
- Iterator refs use `ITER_MODULE` — `{ module: "__iter", field: "item", path: ["name"] }`
- Compiler generates array code directly from `arrayMap` expression AST — no flat iterator map
- Traversal enumeration recurses into `arrayMap.elementWires` for full coverage

### DO NOT:
- Do not inject/merge/overlay element wires into `bridge.wires` or any flat wire array
- Do not reconstruct `Record<string, string>` iterator maps from `arrayMap` expressions
- Do not re-flatten hierarchical data that the AST already encodes
- Do not drop traversal entries for element-internal wires
- Do not add `allWires` getter or similar merged-view abstractions

## Files

### Must Modify (ordered by step)

1. `packages/bridge-core/src/types.ts` — add arrayMap expression, ITER_MODULE (step 1), remove old fields (step 13)
2. `packages/bridge-parser/src/parser/parser.ts` — emit arrayMap expressions (step 2)
3. `packages/bridge-parser/src/bridge-format.ts` — serialize from arrayMap (step 4)
4. `packages/bridge-core/src/resolveWiresSources.ts` — evaluateExpression arrayMap case (step 5)
5. `packages/bridge-core/src/ExecutionTree.ts` — shadow tree element wire storage (steps 5-6)
6. `packages/bridge-core/src/materializeShadows.ts` — direct element wire iteration (step 7)
7. `packages/bridge-core/src/scheduleTools.ts` — ITER_MODULE checks (step 8)
8. `packages/bridge-core/src/enumerate-traversals.ts` — recursive traversal enumeration (step 8)
9. `packages/bridge-core/src/tree-utils.ts` — remove element trunk key (step 9)
10. `packages/bridge-compiler/src/codegen.ts` — direct arrayMap codegen (step 10)
11. `packages/bridge-graphql/src/bridge-asserts.ts` — recursive element wire check (step 11)
12. `packages/playground/src/engine.ts` — remove ref.element (step 12)

### Tests to Update

- `packages/bridge-parser/test/bridge-format.test.ts`
- `packages/bridge-parser/test/path-scoping-parser.test.ts`
- `packages/bridge-parser/test/source-locations.test.ts`
- `packages/bridge-parser/test/parser-compat.test.ts`
- `packages/bridge-core/test/enumerate-traversals.test.ts`
- `packages/bridge/test/alias.test.ts`
- `packages/bridge/test/execute-bridge.test.ts`
- `packages/bridge-compiler/test/codegen.test.ts`

### No Changes Expected

- Linter rules, language service, TextMate grammar — no direct element/array handling
