import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type {
  Bridge,
  BridgeDocument,
  NodeRef,
  Wire,
} from "@stackables/bridge-core";
import { executeBridge as executeRuntime } from "@stackables/bridge-core";
import { executeBridge as executeAot } from "../src/index.ts";

// ── Shared infrastructure ───────────────────────────────────────────────────

const forbiddenPathSegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const identifierArb = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/)
  .filter((segment) => !forbiddenPathSegments.has(segment));

const pathArb = fc.array(identifierArb, { minLength: 1, maxLength: 4 });
const flatPathArb = fc.array(identifierArb, { minLength: 1, maxLength: 1 });

const constantValueArb = fc
  .oneof(
    fc.string({ maxLength: 64 }),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
  )
  .map((value) => JSON.stringify(value));

// ── Chaotic input arbitrary ─────────────────────────────────────────────────
// Goes beyond fc.jsonValue() to exercise type-coercion and null-navigation
// edge cases the engine must handle without crashing.

const chaosLeafArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 64 }) },
  { weight: 3, arbitrary: fc.integer() },
  { weight: 2, arbitrary: fc.double({ noNaN: false }) }, // includes NaN
  { weight: 2, arbitrary: fc.boolean() },
  { weight: 3, arbitrary: fc.constant(null) },
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 1, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(-0) },
  { weight: 1, arbitrary: fc.constant(Infinity) },
  { weight: 1, arbitrary: fc.constant(-Infinity) },
);

const chaosValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  tree: fc.oneof(
    { weight: 6, arbitrary: chaosLeafArb },
    {
      weight: 2,
      arbitrary: fc.array(tie("tree"), { maxLength: 5 }),
    },
    {
      weight: 2,
      arbitrary: fc.dictionary(identifierArb, tie("tree"), { maxKeys: 6 }),
    },
  ),
})).tree;

const chaosInputArb = fc.dictionary(identifierArb, chaosValueArb, {
  maxKeys: 16,
});

// ── Ref helpers ─────────────────────────────────────────────────────────────
// rootSafe: true mirrors the parser's `?.` safe-navigation semantics on input
// refs: missing keys return undefined rather than throwing TypeError. This lets
// us test value-coercion parity (NaN, Infinity, etc.) without hitting the
// known unsafe-path-traversal divergence between AOT and runtime
// (tracked separately as fuzz-regressions seeds 1798655022 / -481664925).

function inputRef(type: string, field: string, path: string[]): NodeRef {
  // rootSafe + pathSafe mirror full `?.` safe-navigation on all segments so
  // missing keys return undefined rather than throwing TypeError. This lets
  // us test value-coercion parity (NaN, Infinity, etc.) without hitting the
  // known unsafe-path-traversal divergence between AOT and runtime
  // (tracked separately as fuzz-regressions seeds 1798655022 / -481664925).
  return {
    module: "_",
    type,
    field,
    path,
    rootSafe: true,
    pathSafe: Array(path.length).fill(true),
  };
}

function outputRef(type: string, field: string, path: string[]): NodeRef {
  return { module: "_", type, field, path };
}

// ── Deep-path bridge arbitrary ──────────────────────────────────────────────
// Uses multi-segment paths (1–4 segments) to exercise deep property access.

const deepWireArb = (type: string, field: string): fc.Arbitrary<Wire> => {
  const toArb = flatPathArb.map((path) => outputRef(type, field, path));
  const fromArb = pathArb.map((path) => inputRef(type, field, path));

  return fc.oneof(
    fc.record({
      value: constantValueArb,
      to: toArb,
    }),
    fc.record({
      from: fromArb,
      to: toArb,
    }),
  );
};

const deepBridgeArb: fc.Arbitrary<Bridge> = fc
  .record({
    type: identifierArb,
    field: identifierArb,
  })
  .chain(({ type, field }) =>
    fc.record({
      kind: fc.constant<"bridge">("bridge"),
      type: fc.constant(type),
      field: fc.constant(field),
      handles: fc.constant([
        { kind: "input", handle: "i" } as const,
        { kind: "output", handle: "o" } as const,
      ]),
      wires: fc.uniqueArray(deepWireArb(type, field), {
        minLength: 1,
        maxLength: 20,
        selector: (wire) => wire.to.path.join("."),
      }),
    }),
  );

// Note: deepFallbackBridgeArb / deepFallbackWireArb are intentionally omitted —
// parity testing of fallback chains with chaotic inputs exposes an AOT/runtime
// null-vs-undefined divergence tracked in fuzz-regressions.todo.test.ts.

// ── Parity assertion helper ─────────────────────────────────────────────────

async function assertParity(bridge: Bridge, input: Record<string, unknown>) {
  const document: BridgeDocument = { instructions: [bridge] };
  const operation = `${bridge.type}.${bridge.field}`;

  let runtimeResult: { data: any } | undefined;
  let runtimeError: unknown;
  let aotResult: { data: any } | undefined;
  let aotError: unknown;

  try {
    runtimeResult = await executeRuntime({
      document,
      operation,
      input,
      tools: {},
    });
  } catch (err) {
    runtimeError = err;
  }

  try {
    aotResult = await executeAot({ document, operation, input, tools: {} });
  } catch (err) {
    aotError = err;
  }

  // Both must succeed or both must fail.
  if (runtimeError && !aotError) {
    assert.fail(
      `Runtime threw but AOT did not.\nRuntime error: ${runtimeError}\nAOT data: ${JSON.stringify(aotResult?.data)}`,
    );
  }
  if (!runtimeError && aotError) {
    assert.fail(
      `AOT threw but runtime did not.\nAOT error: ${aotError}\nRuntime data: ${JSON.stringify(runtimeResult?.data)}`,
    );
  }

  if (runtimeError && aotError) {
    // Both threw — they should be the same error class.
    const rName = (runtimeError as Error)?.name ?? "unknown";
    const aName = (aotError as Error)?.name ?? "unknown";
    assert.equal(
      aName,
      rName,
      `Error class mismatch: runtime=${rName}, aot=${aName}`,
    );
    return;
  }

  // Both succeeded — normalize NaN for comparison since JSON.stringify drops NaN.
  // deepEqual handles NaN correctly (NaN === NaN in assert).
  assert.deepEqual(aotResult!.data, runtimeResult!.data);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("runtime parity fuzzing — deep paths + chaotic inputs", () => {
  test(
    "AOT matches runtime on deep-path bridges with chaotic inputs",
    { timeout: 180_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          deepBridgeArb,
          chaosInputArb,
          async (bridge, input) => {
            await assertParity(bridge, input);
          },
        ),
        {
          numRuns: 3_000,
          endOnFailure: true,
        },
      );
    },
  );

  // Note: parity testing of fallback chains with chaotic inputs is deferred —
  // the AOT compiler and runtime diverge on null-vs-undefined semantics when
  // fallback constants resolve to null. Tracked in fuzz-regressions.todo.test.ts.
});
