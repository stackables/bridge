# Runtime Error Source Mapping Plan

## Goal

When a runtime error occurs during Bridge execution, surface the `.bridge` source location instead of an engine-internal stack frame.

Target experience:

```text
Bridge Execution Error: Cannot read properties of undefined (reading 'name')
  --> src/catalog.bridge:14:5
   |
13 |   o.items <- catalog.results[] as item {
14 |     .name <- item.details.name ?? panic "Missing name"
   |     ^^^^^^^^^^^^^^^^^^^^^^^^^^
15 |     .price <- item.price
```

## Current Code Reality

### Shared Types

- `packages/bridge-types/src/index.ts` does not currently define a shared source-location type.
- `packages/bridge-core/src/types.ts` owns the `Wire` union and already re-exports shared types from `@stackables/bridge-types`.

### Parser

- `packages/bridge-parser/src/parser/parser.ts` already has token helpers:
  - `line(...)`
  - `findFirstToken(...)`
  - `collectTokens(...)`
- `BridgeParseResult` already exposes `startLines: Map<Instruction, number>`.
- Wire construction is spread across multiple helpers, not only `buildBridgeBody(...)`:
  - `processElementLines(...)`
  - `processElementHandleWires(...)`
  - `processScopeLines(...)`
  - top-level alias handling in `buildBridgeBody(...)`
  - top-level bridge wire handling in `buildBridgeBody(...)`
  - synthetic wire emitters:
    - `desugarTemplateString(...)`
    - `desugarExprChain(...)`
    - `desugarNot(...)`
- Define inlining clones wires from `defineDef.wires`, so wire-level locations should survive automatically if present on the parsed wires.

### Runtime

- Runtime errors currently propagate through:
  - `packages/bridge-core/src/resolveWires.ts`
  - `packages/bridge-core/src/ExecutionTree.ts`
  - `packages/bridge-core/src/tree-types.ts`
- Fatal-error classification currently lives in `isFatalError(...)` in `tree-types.ts`.
- `resolveWiresAsync(...)` already has the right catch boundary for associating a thrown error with the active wire.
- `ExecutionTree.applyPath(...)` is still the main source of bad-path traversal errors.

### Public Exports

- `packages/bridge-core/src/index.ts` is the public export surface for new runtime error helpers.
- `packages/bridge/src/index.ts` re-exports `@stackables/bridge-core`, so new core exports automatically flow through the umbrella package.

### Tests

- Parser tests do not live under `packages/bridge-parser/test` in this repo.
- Parser and language tests run from `packages/bridge/test/*.test.ts` via the umbrella package.
- New parser coverage for wire locations should therefore be added under `packages/bridge/test/`.

## Dependency Order

```text
Phase 1 (shared type + parser wire locs)
    ↓
Phase 2 (runtime enrichment + formatter)
    ↓
Phase 3 (compiler loc stamping)
    ↓
Phase 4 (source text + filename threading in user-facing entry points)
```

Phase 1 is the only prerequisite for the later phases.

## Phase 1 — Shared Wire Locations

### Scope

Files:

- `packages/bridge-types/src/index.ts`
- `packages/bridge-core/src/types.ts`
- `packages/bridge-core/src/index.ts`
- `packages/bridge-parser/src/parser/parser.ts`
- `packages/bridge/test/source-locations.test.ts` (new)

### Plan

1. Add a shared `SourceLocation` type in `bridge-types`.
2. Add optional `loc?: SourceLocation` to every `Wire` union arm in `bridge-core/src/types.ts`.
3. Re-export `SourceLocation` from `bridge-core`.
4. Add parser helpers for building locations from CST/token spans.
5. Stamp `loc` on all parser-emitted wire variants, including synthetic/desugared wires:
   - constant wires
   - pull wires
   - ternary wires
   - `condAnd` / `condOr` wires
   - spread wires
   - alias wires
   - template-string concat forks
   - expression/not synthetic forks
6. Add tests in `packages/bridge/test/source-locations.test.ts` covering representative wire variants and one desugared/internal path.

### Acceptance

- Parsed wires carry `loc` data with 1-based line/column spans.
- Existing parser behavior remains unchanged apart from the added metadata.
- `define`-inlined wires preserve locations because cloning keeps the `loc` field.

## Phase 2 — Runtime Error Enrichment

### Scope

Files:

- `packages/bridge-core/src/tree-types.ts`
- `packages/bridge-core/src/resolveWires.ts`
- `packages/bridge-core/src/ExecutionTree.ts`
- `packages/bridge-core/src/formatBridgeError.ts` (new)
- `packages/bridge-core/src/index.ts`
- `packages/bridge-core/test` coverage currently lives through `packages/bridge/test`, so new runtime tests can be placed there unless a direct core test harness is introduced first.

### Plan

1. Introduce `BridgeRuntimeError` in `tree-types.ts` with optional `bridgeLoc` and `cause`.
2. In `resolveWiresAsync(...)`, wrap non-fatal errors with `BridgeRuntimeError` using the active wire's `loc`, preserving the innermost location when one already exists.
3. Thread optional `loc` into `ExecutionTree.applyPath(...)` so bad-path traversal errors can be stamped at the point of throw.
4. Add `formatBridgeError(...)` to render a compact location header and optional source snippet.
5. Export the new error class and formatter from `bridge-core`.

## Phase 3 — AOT Compiler Loc Stamping

### Scope

Files:

- `packages/bridge-compiler/src/codegen.ts`
- compiler tests under `packages/bridge-compiler/test/`

### Plan

1. Thread `w.loc` into emitted try/catch templates for compiled wire execution.
2. Stamp `bridgeLoc` only when the caught error does not already carry one.
3. Skip fire-and-forget branches that intentionally swallow errors.

## Phase 4 — Source Text Threading

### Scope

Likely files:

- execution options in `bridge-core`
- `packages/bridge-graphql`
- `examples/without-graphql`
- any other user-facing entry points that print runtime errors

### Plan

1. Add optional `source` and `filename` to execution options.
2. Call `formatBridgeError(...)` in GraphQL and CLI-style entry points.
3. Add one end-to-end test that verifies a formatted snippet is surfaced from a real `.bridge` source.

## Notes

- This plan does not include JS source maps for compiled output.
- Locations are attached at the Bridge DSL layer only, not inside tool implementations.
- Parser coverage should prefer representative cases over exhaustively asserting every construction site line-by-line.
