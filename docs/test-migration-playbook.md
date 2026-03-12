# Test Migration Playbook: Legacy → regressionTest

Migrate `packages/bridge/test/legacy/*.test.ts` to the `regressionTest` framework.

## Prerequisites

- Read `packages/bridge/test/utils/regression.ts` (the framework — DO NOT EDIT)
- Read `packages/bridge/test/utils/bridge-tools.ts` (test multitools)
- Study `packages/bridge/test/coalesce-cost.test.ts` as the gold-standard example

## Step-by-step process

### 1. Categorise every test in the legacy file

Read the file and sort each test into one of these buckets:

| Bucket                                                              | Action                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Parser-only** (parses AST, checks wire structure)                 | DELETE — regressionTest's `parse → serialise → parse` covers this automatically              |
| **Serializer roundtrip** (parse → serialize → parse)                | DELETE — regressionTest does this automatically                                              |
| **Runtime execution** (runs bridge, asserts data/errors)            | MIGRATE to `regressionTest` scenarios                                                        |
| **Non-runtime tests** (class constructors, pure unit tests)         | MOVE to the corresponding package test dir (e.g. `bridge-core/test/`, `bridge-parser/test/`) |
| **Tests requiring custom execution** (AbortSignal, custom contexts) | Keep using `forEachEngine` in the new file                                                   |

### 2. Design bridges for regressionTest

Group related runtime-execution tests into **logical regressionTest blocks**. Each block has:

```typescript
regressionTest("descriptive name", {
  bridge: `
    version 1.5
    bridge Operation.field {
      with test.multitool as a
      with input as i
      with output as o
      // ... wires
    }
  `,
  tools,  // import { tools } from "./utils/bridge-tools.ts"
  scenarios: {
    "Operation.field": {
      "scenario name": { input: {...}, assertData: {...}, assertTraces: N },
    },
  },
});
```

**Design rules:**

- One regressionTest can have **multiple bridges** (multiple operations in scenarios)
- Group by **feature/behavior** (e.g. "throw control flow", "continue/break in arrays")
- Each bridge needs enough scenarios to achieve **traversal coverage** (all non-error paths hit)
- Keep bridge definitions minimal — test one concept per wire

### 3. Use test.multitool everywhere possible

The multitool (`with test.multitool as a`) is a passthrough: input → output (minus `_`-prefixed keys).

**Capabilities:**

- `_error`: `input: { a: { _error: "boom" } }` → tool throws `Error("boom")`
- `_delay`: `input: { a: { _delay: 100, name: "A" } }` → delays 100ms, returns `{ name: "A" }`
- All other `_` keys are stripped from output
- Correctly handles nested objects and arrays

**Wiring pattern:**

```
a <- i.a     // sends i.a as input to tool, tool returns cleaned copy
o.x <- a.y   // reads .y from tool output
```

**Only use custom tool definitions when:**

- You need a tool that transforms data (not passthrough)
- You need AbortSignal handling on the tool side
- You need `ctx.signal` inspection

### 4. Write scenarios

Each scenario needs:

| Field            | Required | Description                                                             |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `input`          | Yes      | Input object passed to bridge                                           |
| `assertTraces`   | Yes      | Number of tool calls (or function for custom check)                     |
| `assertData`     | No       | Expected output data (object or function)                               |
| `assertError`    | No       | Expected error (regex or function) — mutually exclusive with assertData |
| `fields`         | No       | Restrict which output fields are resolved                               |
| `context`        | No       | Context values (for `with context as ctx`)                              |
| `tools`          | No       | Per-scenario tool overrides                                             |
| `allowDowngrade` | No       | Set `true` if compiler can't handle this bridge feature                 |
| `assertGraphql`  | No       | GraphQL-specific expectations (object or function)                      |
| `assertLogs`     | No       | Log assertions                                                          |

**assertData shorthand:** For simple cases, use object literal:

```typescript
assertData: { name: "Alice", age: 30 }
```

**assertError with regex:** Matches against `${error.name} ${error.message}`:

```typescript
assertError: /BridgeRuntimeError/; // matches error name
assertError: /name is required/; // matches error message
assertError: /BridgePanicError.*fatal/; // matches both
```

**assertError with function** (for instanceof checks):

```typescript
assertError: (err: any) => {
  assert.ok(err instanceof BridgePanicError);
  assert.equal(err.message, "fatal");
};
```

**fields for isolating wires:** When one wire throws but others don't, use `fields` to test them separately:

```typescript
"error on fieldA only": {
  input: { ... },
  fields: ["fieldA"],       // only resolve this field
  assertError: /message/,
  assertTraces: 0,
},
```

### 5. Handle traversal coverage

The framework automatically checks that all non-error traversal paths are covered. Common uncovered paths:

- **empty-array**: Add a scenario with an empty array: `input: { a: { items: [] } }`
- **Fallback paths**: Add a scenario where each fallback fires
- **Short-circuit paths**: Add scenarios for each branch of ||/?? chains

If traversal coverage fails, the error message tells you exactly which paths are missing.

### 6. Handle compiler downgrade

The compiled engine doesn't support all features. When the compiler downgrades, add `allowDowngrade: true` to the scenario. Common triggers:

- `?.` (safe execution modifier) without `catch`
- Some complex expressions
- Certain nested array patterns

**Important:** `allowDowngrade` applies per-scenario, but the bridge is shared. If ANY wire in the bridge triggers downgrade, ALL scenarios need `allowDowngrade: true`.

### 7. Handle errors in GraphQL

as graphql has partial errors then we need to assert it separately

```typescript
assertGraphql: {
  fieldA: /error message/i,  // expect GraphQL error for this field
  fieldB: "fallback-value",  // expect this value
}
```

### 8. Move non-runtime tests

Tests that don't invoke the bridge execution engine belong in the corresponding package:

| Test type                | Target                                             |
| ------------------------ | -------------------------------------------------- |
| Error class constructors | `packages/bridge-core/test/execution-tree.test.ts` |
| Parser AST structure     | `packages/bridge-parser/test/`                     |
| Serializer output format | `packages/bridge-parser/test/`                     |
| Type definitions         | `packages/bridge-types/test/`                      |

### 9. Final verification

```bash
pnpm build    # 0 type errors
pnpm lint     # 0 lint errors
pnpm test     # 0 failures
```

Run the specific test file first for fast iteration:

```bash
node --experimental-transform-types --test packages/bridge/test/<new-file>.test.ts
```

## Migration checklist template

For each legacy test file:

- [ ] Read and categorise all tests
- [ ] Delete parser-only and roundtrip tests (covered by regressionTest)
- [ ] Design bridges using test.multitool
- [ ] Write scenarios with correct assertions
- [ ] Ensure traversal coverage (add empty-array, fallback scenarios)
- [ ] Add `allowDowngrade: true` where compiler downgrades
- [ ] Handle GraphQL replay bugs with `assertGraphql: () => {}`
- [ ] Move non-runtime tests to corresponding package
- [ ] Keep tests needing custom execution (AbortSignal) using `forEachEngine`
- [ ] Verify: `pnpm build && pnpm lint && pnpm test`
- [ ] Don't delete the legacy file until confirmation

## Files remaining to migrate

```
packages/bridge/test/legacy/           # check for remaining legacy tests
packages/bridge/test/expressions.test.ts  # if still using forEachEngine
packages/bridge/test/infinite-loop-protection.test.ts  # if still using forEachEngine
```
