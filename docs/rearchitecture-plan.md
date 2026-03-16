# Rearchitect Bridge IR to Nested Scoped Statements

## TL;DR

Replace the flat `Wire[]` + detached `arrayIterators: Record<string, string>` IR
with a recursive `Statement[]` tree that preserves scope boundaries, supports
`with` declarations at any scope level with shadowing semantics, and treats
array iterators as first-class expression-level constructs.

This is the foundational change that enables all future language evolution —
the parser→IR→engine→compiler pipeline is rebuilt bottom-up across 7 phases.

---

## Current Architecture (What's Broken)

**Problem 1 — Flat Wire List:** `Bridge.wires: Wire[]` is a flat array. The
parser flattens all scope nesting at parse time (e.g., `o { .lat <- x }` becomes
flat wire `o.lat <- x`). This destroys scope boundaries that are meaningful for
tool registration and execution.

**Problem 2 — Detached Array Iterators:** Array mappings are split into:
(a) a regular wire for the source, (b) element-marked wires with `element: true`
in the flat list, (c) a `Record<string, string>` metadata map (`arrayIterators`).
This makes arrays non-composable and non-aliasable.

**Problem 3 — No `with` in Scopes:** Tool registrations (`with`) only work at
bridge body level. The EBNF grammar defines `statement = with | wire | wire_alias | scope` —
meaning `with` should work anywhere statements are allowed, including inside
scopes and array bodies.

**Problem 4 — EBNF Divergence:** The grammar treats array mapping as a
`base_expression` (`ref[] as id { statement* }`) — it should be an expression
chainable with `||`, `??`, `catch`, and `alias`. Currently it's baked into wire syntax.

---

## Phase 1: Preparation — Disable Coupled Tests ✅ COMPLETE

_No dependencies. Single commit._

1. ✅ Mark compiler tests as disabled — prefix all scripts in `bridge-compiler/package.json`
2. ✅ Mark compiler fuzz tests as disabled
3. ✅ Disable parser roundtrip in regression harness — `isDisabled()` globally
   returns `true` for `"compiled"` and `"parser"` checks
4. ✅ Skip parser roundtrip test files:
   - `packages/bridge-parser/test/bridge-format.test.ts`
   - `packages/bridge-parser/test/bridge-printer.test.ts`
   - `packages/bridge-parser/test/bridge-printer-examples.test.ts`
5. ✅ Skip IR-structure-dependent core tests:
   - `packages/bridge-core/test/execution-tree.test.ts`
   - `packages/bridge-core/test/enumerate-traversals.test.ts`
   - `packages/bridge-core/test/resolve-wires.test.ts`
6. ✅ **Kept enabled:** All behavioral `regressionTest` tests in `packages/bridge/test/`
   (runtime path) — these are the correctness anchor
7. ✅ Verified `pnpm build && pnpm test` passes with skipped tests noted

---

## Phase 2: Define New IR Data Structures ✅ COMPLETE

_Depends on Phase 1. Changes `bridge-core/src/types.ts` + `index.ts`._

### Types added:

```typescript
// Shared RHS — the evaluation chain reused by wire and alias statements
interface SourceChain {
  sources: WireSourceEntry[];
  catch?: WireCatch;
}

// Scope-aware statement — the building block of nested bridge bodies
type Statement =
  | WireStatement // target <- expression chain (SourceChain & { target })
  | WireAliasStatement // alias name <- expression chain (SourceChain & { name })
  | SpreadStatement // ... <- expression chain (SourceChain, inherits scope target)
  | WithStatement // with <name> [as <handle>] [memoize]
  | ScopeStatement // target { Statement[] }
  | ForceStatement; // force handle [catch null]

// New expression variants added to Expression union:
// { type: "array"; source: Expression; iteratorName: string; body: Statement[] }
// { type: "pipe"; source: Expression; handle: string; path?: string[] }
// { type: "binary"; op: BinaryOp; left: Expression; right: Expression }
// { type: "unary"; op: "not"; operand: Expression }
// { type: "concat"; parts: Expression[] }
// BinaryOp = "add" | "sub" | "mul" | "div" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
```

### Modifications to existing types (transition period):

- ✅ **`Bridge`**: Added `body?: Statement[]` alongside existing `wires`.
  `wires`, `arrayIterators`, `forces`, `pipeHandles` marked `@deprecated`.
- ✅ **`ToolDef`**: Added `body?: Statement[]` alongside existing `wires`.
  `pipeHandles` marked `@deprecated`.
- ✅ **`DefineDef`**: Added `body?: Statement[]` alongside existing `wires`.
  `arrayIterators`, `pipeHandles` marked `@deprecated`.
- ✅ **`Expression`**: Added `"array"`, `"pipe"`, `"binary"`, `"unary"`, `"concat"` variants.
  Binary/unary/concat replace the legacy desugaring that created synthetic tool
  forks (`Tools.add`, `Tools.eq`, `Tools.not`, `Tools.concat`) for built-in operators.
- ✅ **`BinaryOp`**: New type alias — `"add" | "sub" | "mul" | "div" | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"`.
- ✅ **`WireStatement`**: Flattened — uses `SourceChain & { target: NodeRef }`,
  no longer wraps `Wire`.
- ✅ **`WireAliasStatement`**: Uses `SourceChain & { name }`.
- ✅ **`SpreadStatement`**: New — `SourceChain & { kind: "spread" }`, no target
  (inherits enclosing scope).
- ✅ **`SourceChain`**: Extracted shared `sources + catch` interface.
- ✅ All exhaustive Expression switches updated for `"array"`, `"pipe"`,
  `"binary"`, `"unary"`, `"concat"` cases.
- ✅ Exported `SourceChain`, `SpreadStatement`, `BinaryOp` from index.ts.

### Design constraints:

- `Statement[]` is ordered — execution engine walks sequentially for wiring,
  pulls lazily for values
- Each `ScopeStatement` and `ArrayExpression.body` creates a new scope layer
- Scope lookup is lexical: inner shadowing, fallthrough to parent for missing handles
- Legacy `Wire` type stays for backward compat with old engine path

---

## Phase 3: New AST Builder ✅ COMPLETE

_Depends on Phase 2. New file `bridge-parser/src/parser/ast-builder.ts`._

Created a new CST→AST visitor (`buildBody()`) that produces `body: Statement[]`
directly from Chevrotain CST nodes, separate from the legacy `buildBridgeBody()`.

### Changes:

- ✅ New file: `packages/bridge-parser/src/parser/ast-builder.ts` (~2050 lines)
- ✅ `buildBody()` — core visitor: CST body lines → `Statement[]` with nested scoping
- ✅ `buildBodies()` — top-level hook for future integration
- ✅ Scope blocks (`target { ... }`) → `ScopeStatement` (not flattened)
- ✅ Array mappings → `ArrayExpression` in expression tree with `body: Statement[]`
- ✅ `with` declarations → `WithStatement` with handle resolution
- ✅ `force` → `ForceStatement`
- ✅ Operators (+,-,\*,/,==,!=,>,<,>=,<=) → `BinaryExpression` (not tool forks)
- ✅ `not` → `UnaryExpression` (not tool fork)
- ✅ Template strings → `ConcatExpression` (not tool fork)
- ✅ Pipe chains → `PipeExpression` (not synthetic fork wires)
- ✅ Literal values pre-parsed as `JsonValue`
- ✅ Self-contained helpers (duplicated from parser.ts to avoid coupling)
- ✅ Spread lines → `SpreadStatement`
- ✅ Coalesce chains, ternary, catch handlers all preserved
- ✅ build + lint + test all pass (0 errors, 0 failures)

**No Chevrotain grammar changes needed** — only the CST→AST visitor.

---

## Phase 4: Update Execution Engine

_Depends on Phase 3. Most critical phase._

Files: `ExecutionTree.ts`, `scheduleTools.ts`, `resolveWires.ts`,
`resolveWiresSources.ts`, `materializeShadows.ts`, `parser.ts`.

### Completed

- ✅ **Expression evaluators** in `resolveWiresSources.ts`:
  - `evaluateBinary` — all 10 BinaryOp cases (add/sub/mul/div/eq/neq/gt/gte/lt/lte)
  - `evaluateUnary` — not operator
  - `evaluateConcat` — template string concatenation
- ✅ **WireCatch.value → JsonValue** — proper JSON literal support (not string fallback)
- ✅ **Hook ast-builder into parser** — `buildBody()` called in `buildBridge`,
  `buildToolDef`, `buildDefineDef`; `body: Statement[]` populated alongside legacy `wires`
- ✅ **Wire pre-indexing** — `WireIndex` class in `tree-utils.ts`:
  - Two-level index: `byTrunk` (trunk key → Wire[]) and `byTrunkAndPath` (trunk+path → Wire[])
  - Element-scoped wire awareness (`:*` suffix keys merged with non-element queries)
  - Built once at construction in O(n), shared across shadow trees
  - All 22 linear-scan sites in `ExecutionTree.ts`, `scheduleTools.ts`, `materializeShadows.ts`
    refactored to use O(1) index lookups
  - `sameTrunk` and `pathEquals` no longer imported in ExecutionTree.ts

### Remaining

1. **Scope chain**: `ScopeFrame { handles, wires, parent? }` — tool lookup
   walks frames upward (shadowing semantics)
2. **Array execution**: `ArrayExpression` evaluated → shadow tree per element
   with nested `body: Statement[]` and iterator binding
3. **Define inlining**: Inline as nested `Statement[]` blocks
4. **`schedule()`/`pullSingle()`**: Scope-aware resolution

**Gate:** All behavioral `regressionTest` suites must pass.

---

## Phase 5: Reimplement Serializer + Re-enable Parser Tests

_Depends on Phase 4. Can run parallel with early Phase 6._

1. Rewrite `bridge-format.ts` to walk `Statement[]` tree
2. Update `bridge-printer.ts` for new AST shape
3. Update `bridge-lint.ts` to walk `Statement[]`
4. Re-enable parser roundtrip tests (with updated fixtures)
5. Re-enable `execution-tree.test.ts`, `resolve-wires.test.ts`,
   `enumerate-traversals.test.ts` with updated assertions

---

## Phase 6: Reimplement Compiler + Re-enable Compiler Tests

_Depends on Phase 4. Mostly parallel with Phase 5._

1. Update `codegen.ts` `CodegenContext` to walk `Statement[]`
2. Element scoping is now explicit — wires inside `ArrayExpression.body`
   are inherently element-scoped (simpler detection)
3. Array codegen from `ArrayExpression` nodes
4. Topological sort on wire graph from statement tree
5. Re-enable `codegen.test.ts` + fuzz tests

---

## Phase 7: Final Validation

_Depends on all phases._

1. `pnpm build` — 0 type errors
2. `pnpm lint` — 0 lint errors
3. `pnpm test` — all tests pass, no remaining skips
4. `pnpm e2e` — all example E2E tests pass
5. Verify playground, VS Code extension language server, GraphQL adapter
6. Remove legacy `wires` field from `Bridge`, `ToolDef`, `DefineDef`
7. `pnpm changeset`

---

## Key Decisions

| Decision              | Choice                             | Rationale                                     |
| --------------------- | ---------------------------------- | --------------------------------------------- |
| Scope shadowing       | Inner `with` shadows outer         | Follows lexical scoping convention            |
| Array model           | Single-level + nesting in body     | Simpler than chained expression form          |
| Define blocks         | Adopt nested `Statement[]`         | Consistent with bridges                       |
| Migration             | Single branch, incremental commits | Behavioral tests are continuous anchor        |
| Lexer/grammar         | NO changes                         | Chevrotain already parses nested syntax       |
| Expression desugaring | Keep at expression level           | Self-contained, doesn't interact with scoping |

---

## Relevant Files

| Area         | File                                             | Impact                                                            |
| ------------ | ------------------------------------------------ | ----------------------------------------------------------------- |
| Types        | `packages/bridge-core/src/types.ts`              | Add Statement, ArrayExpression; modify Bridge, ToolDef, DefineDef |
| Parser       | `packages/bridge-parser/src/parser/parser.ts`    | `toBridgeAst()` visitor only                                      |
| Lexer        | `packages/bridge-parser/src/parser/lexer.ts`     | NO changes                                                        |
| Engine       | `packages/bridge-core/src/ExecutionTree.ts`      | Scope chain, wire collection, shadow creation                     |
| Engine       | `packages/bridge-core/src/scheduleTools.ts`      | Scope-aware tool scheduling                                       |
| Engine       | `packages/bridge-core/src/resolveWires.ts`       | Wire resolution from tree                                         |
| Engine       | `packages/bridge-core/src/materializeShadows.ts` | Array materialization                                             |
| Serializer   | `packages/bridge-parser/src/bridge-format.ts`    | Full rewrite for `Statement[]`                                    |
| Compiler     | `packages/bridge-compiler/src/codegen.ts`        | `CodegenContext` tree walking                                     |
| Linter       | `packages/bridge-parser/src/bridge-lint.ts`      | Walk `Statement[]` instead of `Wire[]`                            |
| Lang Service | `packages/bridge-parser/src/language-service.ts` | Update for new AST                                                |

---

## Verification Checkpoints

| After   | Check                      | Criteria                                                 |
| ------- | -------------------------- | -------------------------------------------------------- |
| Phase 1 | `pnpm build && pnpm test`  | Passes with noted skips, 0 failures                      |
| Phase 2 | `pnpm build`               | Type-checks with 0 errors                                |
| Phase 3 | Parser produces nested IR  | Behavioral parse tests still work                        |
| Phase 4 | `pnpm test` (runtime path) | All ~36 regression suites pass                           |
| Phase 5 | Parse → serialize → parse  | Roundtrip tests pass                                     |
| Phase 6 | AOT parity                 | Compiler tests + fuzz parity pass                        |
| Phase 7 | Full suite                 | `pnpm build && pnpm lint && pnpm test && pnpm e2e` green |
