# Fuzz Testing Expansion Plan

> Tracking document for expanding fuzz/property-based testing coverage across the Bridge codebase.

## Current State

All fuzzing lives in `packages/bridge-compiler/test/fuzz-compile.test.ts` (6 tests, ~24,500 property runs).  
`fast-check` is a devDependency of `bridge-compiler` only.

**What's covered:**

- JS syntax validity of AOT compiler output
- Compiler determinism
- AOT/runtime parity on flat single-segment paths with `fc.jsonValue()` inputs
- Parser round-trip (text spec → parse → serialize → reparse → execute parity)
- Fallback-heavy and logical-wire syntax validity

**Key gaps:**

- No deep-path parity testing with chaotic inputs (`NaN`, `undefined`, nested shapes)
- No purely textual parser fuzzing (random `.bridge` strings)
- No serializer round-trip fuzzing on full ASTs (only limited text specs)
- No stdlib tool fuzzing (known crash in `arr.filter`/`arr.find` on non-array input)
- No array mapping / shadow tree parity testing
- No simulated tool call parity testing

---

## P0 — Critical (implement first)

### [x] 1A. Deep-path AOT/runtime parity with chaotic inputs

**File:** `packages/bridge-compiler/test/fuzz-runtime-parity.test.ts`

- `chaosInputArb` that extends beyond `fc.jsonValue()`: includes `NaN`, `Infinity`, `-0`, `undefined`, empty strings, deeply nested objects (5+ levels), arrays where objects expected and vice versa
- `deepBridgeArb` using multi-segment paths (1–4 segments) instead of `flatPathArb`; all input refs use `rootSafe: true` + `pathSafe` for safe navigation
- Property: `executeRuntime` vs `executeAot` → `deepEqual` on `.data`, or both throw the same error class
- 3,000 runs

**Regressions discovered during implementation (tracked in `fuzz-regressions.todo.test.ts`):**

- Unsafe path traversal divergence: AOT silently returns `undefined` where runtime throws `TypeError` when `rootSafe` is not set (seeds 1798655022, -481664925)
- Fallback chain null/undefined divergence: AOT returns `null` where runtime returns `undefined` when a fallback constant resolves to `"null"` — see `deepFallbackBridgeArb` investigation needed

**What this catches:** Type coercion divergence (verified working), NaN propagation, deep path access with missing keys.

### [x] 1B. arr.filter / arr.find crash proof + bug fix

**File:** `packages/bridge-stdlib/test/fuzz-stdlib.test.ts`  
**Fixes applied in `packages/bridge-stdlib/src/tools/`:**

- `arrays.ts`: Added `Array.isArray(arr)` guard in `filter` and `find`
- `arrays.ts`: Added `obj == null || typeof obj !== "object"` guard inside filter/find callback (null array elements)
- `strings.ts`: Replaced `?.` optional chaining with `typeof === "string"` guards in all four string tools (the `?.` only guards null/undefined, not non-string types like arrays whose method property is `undefined`, causing `TypeError: undefined is not a function`)

- 2,000 runs per tool, across both array and string tools

---

## P1 — Important (implement after P0)

### [x] 2A. Parser textual fuzzing — `parseBridge` never panics

**File:** `packages/bridge/test/fuzz-parser.test.ts`

- `bridgeTokenSoupArb` — weighted mix of Bridge-like tokens (keywords, identifiers, `{`, `}`, `<-`, `=`, `.`, `||`, `??`) + random noise
- Property: `parseBridge(text)` either returns a `BridgeDocument` or throws a standard `Error`. Must never throw `TypeError`, `RangeError`, or crash with a stack overflow.
- 5,000 runs

**What this catches:** Null dereferences in CST→AST visitor, unbounded recursion, Chevrotain edge cases.

### [x] 2B. Parser textual fuzzing — `parseBridgeDiagnostics` never crashes

**File:** same file, separate test

- Same `bridgeTokenSoupArb`
- Property: `parseBridgeDiagnostics(text)` **always** returns `{ document, diagnostics }`, never throws
- 5,000 runs

**What this catches:** Uncaught exceptions in recovery mode, diagnostic formatting crashes.

### [x] 3A. Serializer round-trip (AST → text → AST)

**File:** same file, separate test

- Valid `.bridge` text → `parseBridge` → `serializeBridge` → `parseBridge` → instruction count and wire count must match
- Also: `prettyPrintToSource` idempotence — `format(format(text)) === format(text)`
- Also: `prettyPrintToSource` output is always parseable
- 2,000 runs each

---

## P2 — Valuable (future work)

### [ ] 1B-ext. Array mapping parity

- Generate bridges with `arrayIterators` (the `[] as iter { ... }` pattern)
- Test shadow tree execution parity between AOT and runtime
- Complex arbitrary: needs `element: true` NodeRefs, iterator handles

### [ ] 1C. Simulated tool call parity

- Generate bridges referencing mock tools (`identity`, `fail`)
- Test tool error propagation + `catchFallback` + `onError` wires between engines

### [ ] 3B. `prettyPrintToSource` advanced stability

- Deeper formatter testing with all block types (tool, define, const, bridge)

### [ ] 4C. `httpCall` input surface

- URL construction edge cases, `JSON.stringify` on circular refs
- Requires fetch mocking

---

## P3 — Nice to have

### [ ] Additional string tool coverage

- Confirm Symbol, BigInt, circular refs are handled gracefully across all stdlib tools

### [ ] Parser diagnostics completeness

- Valid text parsed via `parseBridgeDiagnostics` produces zero error-severity diagnostics
- Returned document matches strict `parseBridge` output

---

## Implementation Notes

- **Test framework:** `node:test` + `node:assert` (no Jest/Vitest)
- **Fuzz library:** `fast-check` ^4.5.3
- **Regression workflow:** fuzz finding → `test.todo` entry with seed → tracking issue → deterministic reproducer → fix → cleanup (see `packages/bridge-compiler/test/README.md`)
- Parser fuzz tests go in `packages/bridge/test/` (that's where all parser/integration tests live)
- Stdlib fuzz tests go in `packages/bridge-stdlib/test/`
- Run a single test: `node --experimental-transform-types --conditions source --test <file>`
