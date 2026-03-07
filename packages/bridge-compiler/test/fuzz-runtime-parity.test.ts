import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import type {
  Bridge,
  BridgeDocument,
  NodeRef,
  Wire,
} from "@stackables/bridge-core";
import {
  BridgeTimeoutError,
  executeBridge as executeRuntime,
} from "@stackables/bridge-core";
import { parseBridgeFormat } from "@stackables/bridge-parser";
import {
  BridgeCompilerIncompatibleError,
  compileBridge,
  executeBridge as executeAot,
} from "../src/index.ts";

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
function inputRef(type: string, field: string, path: string[]): NodeRef {
  return { module: "_", type, field, path };
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

// ── P2-1B-ext: Array mapping parity ───────────────────────────────────────
//
// Design note (re: Suggestion 2 / AST depth limits):
// We generate valid .bridge TEXT rather than Bridge AST objects directly.
// This avoids fc.letrec recursive-depth explosions during the shrinking phase:
// fast-check shrinks text by removing tokens, not by exploring AST tree variants,
// so there is no exponential blowup. Text is bounded by the token-count limit.

const canonicalIdArb = fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h");
const toolAliasArb = fc.constantFrom("fetch", "http", "load", "lookup");
const toolValueArb = fc.constantFrom("alpha", "beta", "gamma", "delta");

// A single "leaf" value — safe for array element fields.
const chaosLeafArb2 = fc.oneof(
  { weight: 4, arbitrary: fc.string({ maxLength: 32 }) },
  { weight: 3, arbitrary: fc.integer() },
  { weight: 2, arbitrary: fc.boolean() },
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: fc.double({ noNaN: false }) }, // includes NaN
);

// A single array element object.
// Note: null or primitive elements trigger a known null/undefined divergence —
// the runtime throws TypeError when accessing `.field` on a null element (no
// rootSafe on element refs from the parser), while AOT silently returns
// undefined via `?.`. Tracked in fuzz-regressions.todo.test.ts.
// We restrict to objects here so the test covers value-type parity, not the
// null-element divergence.
const chaosElementArb = fc.dictionary(canonicalIdArb, chaosLeafArb2, {
  maxKeys: 4,
});

// Source value for the array field: one of several chaotic shapes.
// undefined is excluded: AOT's `?.map(...) ?? null` returns null, runtime returns
// undefined — the same null/undefined divergence tracked in fuzz-regressions.todo.test.ts.
// Primitive (string/number) sources are excluded: AOT throws TypeError (.map is not
// a function), while the runtime iterates strings character-by-character (strings
// are iterable) or treats numbers as empty. Both tracked in regressions.
const chaosArraySourceArb = fc.oneof(
  { weight: 5, arbitrary: fc.array(chaosElementArb, { maxLength: 8 }) },
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 1, arbitrary: fc.constant([]) },
);

const arrayBridgeSpecArb = fc
  .record({
    type: canonicalIdArb,
    field: canonicalIdArb,
    // source field on the input (the array)
    srcField: canonicalIdArb,
    // output field for the mapped array
    outField: canonicalIdArb,
    // element fields to map inside the iterator block (max 3 to keep bridges concise)
    elemFields: fc.uniqueArray(canonicalIdArb, { minLength: 1, maxLength: 3 }),
  })
  // Filter out cases where element field names overlap with srcField or outField.
  // When elemField == srcField, the runtime resolver conflates the shadow-tree
  // element wire with the outer input-array source wire (same trunk key),
  // producing wrong values. Tracked in fuzz-regressions.todo.test.ts.
  .filter(
    (spec) =>
      !spec.elemFields.includes(spec.srcField) &&
      !spec.elemFields.includes(spec.outField) &&
      spec.srcField !== spec.outField,
  );

function buildArrayBridgeText(spec: {
  type: string;
  field: string;
  srcField: string;
  outField: string;
  elemFields: string[];
}): string {
  const lines = [
    "version 1.5",
    `bridge ${spec.type}.${spec.field} {`,
    "  with input as i",
    "  with output as o",
    "",
    `  o.${spec.outField} <- i.${spec.srcField}[] as el {`,
  ];
  for (const f of spec.elemFields) {
    lines.push(`    .${f} <- el.${f}`);
  }
  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

const loopToolParitySpecArb = fc
  .record({
    type: canonicalIdArb,
    field: canonicalIdArb,
    names: fc.uniqueArray(canonicalIdArb, {
      minLength: 5,
      maxLength: 5,
    }),
    outerAlias: toolAliasArb,
    innerAlias: toolAliasArb,
    nested: fc.boolean(),
    memoizeOuter: fc.boolean(),
    memoizeInner: fc.boolean(),
    shadowInnerAlias: fc.boolean(),
    catalog: fc.array(
      fc.record({
        id: toolValueArb,
        children: fc.array(
          fc.record({
            id: toolValueArb,
          }),
          { maxLength: 3 },
        ),
      }),
      { maxLength: 5 },
    ),
  })
  .map(
    ({
      type,
      field,
      names,
      outerAlias,
      innerAlias,
      nested,
      memoizeOuter,
      memoizeInner,
      shadowInnerAlias,
      catalog,
    }) => ({
      type,
      field,
      outField: names[0]!,
      outerValueField: names[1]!,
      childrenField: names[2]!,
      innerValueField: names[3]!,
      parentField: names[4]!,
      outerAlias,
      innerAlias: shadowInnerAlias ? outerAlias : innerAlias,
      nested,
      memoizeOuter,
      memoizeInner,
      shadowInnerAlias,
      catalog,
    }),
  );

const supportedLoopToolSpecArb = loopToolParitySpecArb.filter(
  (spec) => !spec.memoizeOuter && !spec.nested,
);

const fallbackLoopToolSpecArb = loopToolParitySpecArb.filter(
  (spec) => spec.memoizeOuter || spec.nested,
);

function buildLoopToolBridgeText(spec: {
  type: string;
  field: string;
  outField: string;
  outerValueField: string;
  childrenField: string;
  innerValueField: string;
  parentField: string;
  outerAlias: string;
  innerAlias: string;
  nested: boolean;
  memoizeOuter: boolean;
  memoizeInner: boolean;
}): string {
  const lines = [
    "version 1.5",
    `bridge ${spec.type}.${spec.field} {`,
    "  with context as ctx",
    "  with output as o",
    "",
    `  o.${spec.outField} <- ctx.catalog[] as cat {`,
    `    with std.httpCall as ${spec.outerAlias}${spec.memoizeOuter ? " memoize" : ""}`,
    "",
    `    ${spec.outerAlias}.value <- cat.id`,
    `    .${spec.outerValueField} <- ${spec.outerAlias}.data`,
  ];

  if (spec.nested) {
    lines.push(`    .${spec.childrenField} <- cat.children[] as child {`);
    lines.push(
      `      with std.httpCall as ${spec.innerAlias}${spec.memoizeInner ? " memoize" : ""}`,
    );
    lines.push("");
    lines.push(`      ${spec.innerAlias}.value <- child.id`);
    lines.push(`      .${spec.innerValueField} <- ${spec.innerAlias}.data`);
    lines.push("    }");
  }

  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

function expectedLoopToolCalls(spec: {
  catalog: Array<{ id: string; children: Array<{ id: string }> }>;
  nested: boolean;
  memoizeOuter: boolean;
  memoizeInner: boolean;
}): number {
  const outerCalls = spec.memoizeOuter
    ? new Set(spec.catalog.map((cat) => cat.id)).size
    : spec.catalog.length;

  if (!spec.nested) {
    return outerCalls;
  }

  const childIds = spec.catalog.flatMap((cat) =>
    cat.children.map((child) => child.id),
  );
  const innerCalls = spec.memoizeInner
    ? new Set(childIds).size
    : childIds.length;

  return outerCalls + innerCalls;
}

describe("runtime parity fuzzing — array mapping (P2-1B-ext)", () => {
  test(
    "AOT matches runtime on array-mapping bridges with chaotic inputs",
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          arrayBridgeSpecArb,
          chaosArraySourceArb,
          async (spec, sourceValue) => {
            const bridgeText = buildArrayBridgeText(spec);
            const document = parseBridgeFormat(bridgeText);
            const operation = `${spec.type}.${spec.field}`;
            const input = { [spec.srcField]: sourceValue };

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
              aotResult = await executeAot({
                document,
                operation,
                input,
                tools: {},
              });
            } catch (err) {
              aotError = err;
            }

            if (runtimeError && !aotError) {
              assert.fail(
                `Runtime threw but AOT did not.\nBridge:\n${bridgeText}\nInput: ${JSON.stringify(input)}\nRuntime error: ${runtimeError}\nAOT data: ${JSON.stringify(aotResult?.data)}`,
              );
            }
            if (!runtimeError && aotError) {
              assert.fail(
                `AOT threw but runtime did not.\nBridge:\n${bridgeText}\nInput: ${JSON.stringify(input)}\nAOT error: ${aotError}\nRuntime data: ${JSON.stringify(runtimeResult?.data)}`,
              );
            }
            if (runtimeError && aotError) {
              // Both threw — acceptable regardless of error class.
              // Array mapping error-class divergence from mismatched input
              // types (e.g. non-array values) is a known engine behaviour
              // difference tracked separately.
              return;
            }

            assert.deepEqual(aotResult!.data, runtimeResult!.data);
          },
        ),
        { numRuns: 1_000, endOnFailure: true },
      );
    },
  );
});

describe("runtime parity fuzzing — loop-scoped tools and memoize", () => {
  test(
    "AOT matches runtime on compiler-compatible loop-scoped tool bridges",
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(supportedLoopToolSpecArb, async (spec) => {
          const bridgeText = buildLoopToolBridgeText(spec);
          const document = parseBridgeFormat(bridgeText);
          const operation = `${spec.type}.${spec.field}`;
          const input = {};
          const tools = {
            std: {
              httpCall: async (params: { value: string }) => ({
                data: `tool:${params.value}`,
              }),
            },
          };
          const context = { catalog: spec.catalog };

          assert.doesNotThrow(() => {
            compileBridge(document, { operation });
          });

          const runtimeResult = await executeRuntime({
            document,
            operation,
            input,
            tools,
            context,
          });
          const aotResult = await executeAot({
            document,
            operation,
            input,
            tools,
            context,
          });

          assert.deepEqual(aotResult.data, runtimeResult.data);
        }),
        { numRuns: 400, endOnFailure: true },
      );
    },
  );

  test(
    "compiler-incompatible loop-scoped tool bridges fall back with runtime-equivalent results",
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(fallbackLoopToolSpecArb, async (spec) => {
          const bridgeText = buildLoopToolBridgeText(spec);
          const document = parseBridgeFormat(bridgeText);
          const operation = `${spec.type}.${spec.field}`;
          const expectedCalls = expectedLoopToolCalls(spec);

          assert.throws(
            () => compileBridge(document, { operation }),
            (error: unknown) =>
              error instanceof BridgeCompilerIncompatibleError &&
              /(memoize|memoized|shadowed loop-scoped tool handles|nested loop-scoped tool handles)/i.test(
                error.message,
              ),
          );

          let runtimeCalls = 0;
          const runtimeResult = await executeRuntime({
            document,
            operation,
            input: {},
            tools: {
              std: {
                httpCall: async (params: { value: string }) => {
                  runtimeCalls++;
                  return { data: `tool:${params.value}` };
                },
              },
            },
            context: { catalog: spec.catalog },
          });

          let aotCalls = 0;
          const warnings: string[] = [];
          const aotResult = await executeAot({
            document,
            operation,
            input: {},
            tools: {
              std: {
                httpCall: async (params: { value: string }) => {
                  aotCalls++;
                  return { data: `tool:${params.value}` };
                },
              },
            },
            context: { catalog: spec.catalog },
            logger: {
              warn: (message: string) => warnings.push(message),
            },
          });

          assert.deepEqual(aotResult.data, runtimeResult.data);
          assert.equal(runtimeCalls, expectedCalls);
          assert.equal(aotCalls, expectedCalls);
          assert.equal(warnings.length, 1);
          assert.match(warnings[0]!, /Falling back to core executeBridge/i);
        }),
        { numRuns: 300, endOnFailure: true },
      );
    },
  );
});

// ── P2-1C: Simulated tool call parity with timeout fuzzing ────────────────
//
// Tests that AOT and runtime agree on success/failure under varying tool delays
// and timeout settings.
//
// Design note (re: Suggestion 1 / timeout fuzzing):
// The original AOT preamble threw new Error("Tool timeout"), diverging from the
// runtime's BridgeTimeoutError. This was fixed before this test was added — both
// engines now throw BridgeTimeoutError with the same message format.
//
// We avoid flakiness by maintaining a 20ms safety margin around the timeout
// boundary. Tests in the "grey zone" (|delay - timeout| < 20ms) are skipped.
//
// Promise leak concern: both engines clear their timer in try/finally (AOT) or
// .finally() (runtime raceTimeout), so the timeout Promise itself never leaks.
// The underlying tool function may still be pending but that is inherent to
// JavaScript Promises with no native cancellation.

const toolCallBridgeText = `version 1.5
bridge Query.toolTest {
  with mockTool as t
  with output as o
  o.value <- t.value
}`;

const toolCallDocument = parseBridgeFormat(toolCallBridgeText);

const timeoutParityArb = fc.record({
  toolDelayMs: fc.integer({ min: 0, max: 80 }),
  toolTimeoutMs: fc.integer({ min: 10, max: 50 }),
});

describe("runtime parity fuzzing — tool call timeout (P2-1C)", () => {
  test(
    "AOT and runtime agree on success/failure for varying tool delays and timeouts",
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          timeoutParityArb,
          async ({ toolDelayMs, toolTimeoutMs }) => {
            // Skip timing-sensitive grey zone to avoid flakiness on slow CI.
            const margin = 20;
            const clearlyTimedOut = toolDelayMs > toolTimeoutMs + margin;
            const clearlySucceeds = toolDelayMs < toolTimeoutMs - margin;
            if (!clearlyTimedOut && !clearlySucceeds) return;

            const mockTool = async () => {
              await new Promise((r) => setTimeout(r, toolDelayMs));
              return { value: "ok" };
            };
            const opts = {
              document: toolCallDocument,
              operation: "Query.toolTest",
              input: {},
              tools: { mockTool },
              toolTimeoutMs,
            };

            let runtimeResult: { data: any } | undefined;
            let runtimeError: unknown;
            let aotResult: { data: any } | undefined;
            let aotError: unknown;

            try {
              runtimeResult = await executeRuntime(opts);
            } catch (err) {
              runtimeError = err;
            }
            try {
              aotResult = await executeAot(opts);
            } catch (err) {
              aotError = err;
            }

            if (clearlyTimedOut) {
              // Both must throw BridgeTimeoutError.
              assert.ok(
                runtimeError instanceof BridgeTimeoutError,
                `Runtime should throw BridgeTimeoutError (delay=${toolDelayMs}ms, timeout=${toolTimeoutMs}ms), got: ${runtimeError}`,
              );
              assert.equal(
                (aotError as Error)?.name,
                "BridgeTimeoutError",
                `AOT should throw BridgeTimeoutError (delay=${toolDelayMs}ms, timeout=${toolTimeoutMs}ms), got: ${aotError}`,
              );
            } else {
              // Both must succeed with the same data.
              assert.equal(
                runtimeError,
                undefined,
                `Runtime should not throw (delay=${toolDelayMs}ms, timeout=${toolTimeoutMs}ms): ${runtimeError}`,
              );
              assert.equal(
                aotError,
                undefined,
                `AOT should not throw (delay=${toolDelayMs}ms, timeout=${toolTimeoutMs}ms): ${aotError}`,
              );
              assert.deepEqual(aotResult!.data, runtimeResult!.data);
            }
          },
        ),
        { numRuns: 500, endOnFailure: true },
      );
    },
  );
});
