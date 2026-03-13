# Fuzz Testing

> Reference document for fuzz/property-based testing coverage and workflow in the Bridge codebase.

## Overview

Bridge uses [fast-check](https://github.com/dubzzz/fast-check) (^4.5.3) for property-based testing alongside the standard `node:test` + `node:assert` framework. Fuzz tests live co-located with each package and run as part of the normal `pnpm test` suite.

### Test files

| File                                 | Package           | Purpose                                                                                         |
| ------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------- |
| `test/fuzz-compile.test.ts`          | `bridge-compiler` | JS syntax validity, determinism, flat-path AOT/runtime parity                                   |
| `test/fuzz-runtime-parity.test.ts`   | `bridge-compiler` | Deep-path parity, array mapping parity, loop-tool parity and fallback, tool-call timeout parity |
| `test/fuzz-regressions.todo.test.ts` | `bridge-compiler` | Backlog of known fuzz-discovered divergences as `test.todo` entries                             |
| `test/fuzz-stdlib.test.ts`           | `bridge-stdlib`   | Array and string tool crash-safety                                                              |
| `test/fuzz-parser.test.ts`           | `bridge`          | Parser crash-safety, serializer round-trip, formatter stability, loop-scoped tool syntax        |

---

## Coverage

### What's tested

- JS syntax validity of AOT compiler output
- Compiler determinism
- AOT/runtime parity on flat single-segment paths (`fc.jsonValue()` inputs)
- AOT/runtime parity on deep multi-segment paths with chaotic inputs (`NaN`, `Infinity`, `-0`, `undefined`, deeply nested objects)
- AOT/runtime parity on array-mapping bridges (`[] as el { ... }`) with chaotic element data
- AOT/runtime parity on compiler-compatible loop-scoped tool bridges
- Fallback parity for compiler-incompatible loop-scoped tool bridges that use nested loop-local tools, memoized handles, or shadowed loop-local tool aliases
- AOT/runtime parity on tool-call timeout (`BridgeTimeoutError` class and message match)
- Parser round-trip: text → parse → serialize → reparse → execute parity
- `parseBridge` never throws unstructured errors on random input
- `parseBridgeDiagnostics` never throws (LSP/IDE safety)
- `prettyPrintToSource` idempotence and output parseability (bridge, tool, const blocks)
- `prettyPrintToSource` stability for loop-scoped `with ... memoize` declarations inside array mappings, plus `serializeBridge` round-trip coverage for non-shadowed loop-scoped handles
- `arr.filter`, `arr.find`, `arr.first`, `arr.toArray` crash-safety on any input type
- `str.toLowerCase`, `str.toUpperCase`, `str.trim`, `str.length` crash-safety on any input type

### Known gaps (P3)

- `Symbol`, `BigInt`, circular-ref handling across all stdlib tools
- `parseBridgeDiagnostics` completeness: valid input should produce zero error-severity diagnostics
- Randomized fallback/nullish edge cases for every compiler-incompatible shape beyond loop-scoped tool handles

---

## Property run counts

| Test                                                 | Runs  |
| ---------------------------------------------------- | ----- |
| Deep-path AOT/runtime parity                         | 3,000 |
| Array mapping parity                                 | 1,000 |
| Loop-scoped tool AOT/runtime parity                  | 400   |
| Loop-scoped tool fallback parity                     | 300   |
| Tool-call timeout parity                             | 500   |
| `parseBridge` never panics                           | 5,000 |
| `parseBridgeDiagnostics` never throws                | 5,000 |
| Serializer round-trip                                | 2,000 |
| `prettyPrintToSource` idempotence (basic)            | 2,000 |
| `prettyPrintToSource` parseability (basic)           | 2,000 |
| `prettyPrintToSource` idempotence (extended blocks)  | 1,000 |
| `prettyPrintToSource` parseability (extended blocks) | 1,000 |
| Loop-scoped tool round-trip / formatter properties   | 1,000 |
| stdlib tool crash-safety (per tool)                  | 2,000 |

---

## Generator design principles

**Text-first over AST-first.** Generating valid `.bridge` text strings and parsing them is preferred over building `Bridge` AST objects directly with `fc.letrec`. Text-first generation avoids exponential shrinking blowup: fast-check shrinks by removing tokens from a string, not by exploring recursive AST tree variants. This is especially important for array mapping and nested-block tests.

**Depth limits with `fc.letrec`.** When recursive arbitraries are necessary (e.g. `chaosValueArb` for deep input objects), always pass `depthFactor` or cap with `maxLength`/`maxKeys` at every level. Without this, the shrinking phase can explore exponentially many candidates and halt CI.

**Safety margins for timing tests.** Timer-based parity tests skip inputs in the "grey zone" where `|toolDelay - toolTimeout| < 20ms` to avoid flakiness on slow CI runners.

**Forbidden path segments.** All generated identifier arbitraries filter out `__proto__`, `prototype`, and `constructor` to stay within the valid domain for path traversal.

---

## Regression workflow

When a fuzz run finds a new issue:

1. **Capture evidence immediately** — seed, failure path, counterexample input, whether it is `AOT != runtime`, a parser crash, or a runtime panic.

2. **Add a `test.todo` entry** in `packages/bridge-compiler/test/fuzz-regressions.todo.test.ts`:

   ```ts
   test.todo("class label — short description (seed=123456)");
   ```

3. **Open a tracking note** — link to the todo, add impact, expected vs actual behaviour, suspected component.

4. **Create a deterministic reproducer** — prefer a minimal hand-authored bridge + input over rerunning fuzz with a seed. Add it to `codegen.test.ts` or a dedicated regression file as a normal `test(...)`.

5. **Fix at root cause** — keep fixes small and targeted.

6. **Promote and clean up** — ensure reproducer passes, remove the `test.todo` entry, keep the fuzz property in place.

---

## Running fuzz tests

```bash
# All tests (includes fuzz)
pnpm test

# Single fuzz file
node --experimental-transform-types --test packages/bridge-compiler/test/fuzz-runtime-parity.test.ts
node --experimental-transform-types --test packages/bridge/test/fuzz-parser.test.ts
node --experimental-transform-types --test packages/bridge-stdlib/test/fuzz-stdlib.test.ts

# Reproduce a specific failing seed
# Add { seed: -1234567, path: "0", endOnFailure: true } to fc.assert options
```

---

## Implementation notes

- **Test framework:** `node:test` + `node:assert` (no Jest/Vitest)
- **Fuzz library:** `fast-check` ^4.5.3 — devDependency of `bridge-compiler`, `bridge-stdlib`, `bridge`
- Parser fuzz tests live in `packages/bridge/test/`
- Stdlib fuzz tests live in `packages/bridge-stdlib/test/`
- Compiler parity fuzz tests live in `packages/bridge-compiler/test/`
