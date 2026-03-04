# bridge-compiler test workflow

This folder contains unit tests, fuzz/property tests, and a backlog of known fuzz-discovered issues.

## Files and intent

- `codegen.test.ts` — deterministic, scenario-based behavior tests.
- `fuzz-compile.test.ts` — property/fuzz tests (syntax safety, determinism, AOT/runtime parity).
- `fuzz-regressions.todo.test.ts` — **backlog** of known issues as `test.todo(...)` entries.

## Why `test.todo` exists here

Fuzzing can find valid issues faster than we can fix them. `test.todo` is used to:

1. Preserve findings immediately (so they are not lost).
2. Keep CI green while investigation/fix work is queued.
3. Make known risk areas visible in test output.

`test.todo` is not a permanent state. It is a staging area between discovery and a real executable regression test.

## Preferred process when fuzz finds an issue

1. **Capture evidence immediately**
   - Seed, failure path, and minimized/counterexample input.
   - Whether mismatch is `AOT != runtime`, parser/serializer, or runtime crash.

2. **Add a `test.todo` entry** in `fuzz-regressions.todo.test.ts`
   - Include a short class label plus seed (if available).
   - Example format: `"nullish fallback parity ... (seed=123456)"`.

3. **Open a tracking issue/PR note**
   - Link to the todo label.
   - Add impact, expected behavior, and suspected component (`bridge-core`, `bridge-compiler`, `bridge-parser`).

4. **Create a deterministic reproducer test**
   - Prefer a minimal hand-authored bridge/input over rerunning random fuzz.
   - Add to `codegen.test.ts` (or a dedicated regression file) as a normal `test(...)`.

5. **Fix at root cause**
   - Update compiler/runtime/parser behavior.
   - Keep fix small and targeted.

6. **Promote and clean up**
   - Ensure reproducer test passes.
   - Remove corresponding `test.todo` entry.
   - Keep fuzz property in place to guard against nearby regressions.

## How we fix issues without losing them

- Discovery path: fuzz failure -> `test.todo` backlog entry.
- Stabilization path: add deterministic reproducer -> implement fix -> remove todo.
- Verification path: run package tests (`pnpm --filter @stackables/bridge-compiler test`) and then broader repo checks as needed.

## Practical tips

- Keep generated identifiers/simple values parser-safe in text round-trip fuzzers.
- Constrain parity fuzz generators when an oracle (runtime/parser) has known unstable surfaces.
- Prefer multiple small targeted properties over one giant mixed generator for easier shrinking and diagnosis.
