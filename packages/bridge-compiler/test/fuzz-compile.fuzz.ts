import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import { parseBridgeFormat, serializeBridge } from "@stackables/bridge-parser";
import type {
  Bridge,
  BridgeDocument,
  NodeRef,
  WireLegacy,
  WireFallback,
} from "@stackables/bridge-core";
import { legacyToV2 } from "@stackables/bridge-core";
import { executeBridge as executeRuntime } from "@stackables/bridge-core";
import {
  BridgeCompilerIncompatibleError,
  compileBridge,
  executeBridge as executeAot,
} from "../src/index.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const forbiddenPathSegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

const identifierArb = fc
  .stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/)
  // Runtime blocks unsafe traversal segments; fuzz should stay in valid domain.
  .filter((segment) => !forbiddenPathSegments.has(segment));
const canonicalIdentifierArb = fc.constantFrom(
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
);
const toolAliasArb = fc.constantFrom("fetch", "http", "load", "lookup");
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

function inputRef(type: string, field: string, path: string[]): NodeRef {
  return {
    module: "_",
    type,
    field,
    path,
  };
}

function outputRef(type: string, field: string, path: string[]): NodeRef {
  return {
    module: "_",
    type,
    field,
    path,
  };
}

const wireArb = (type: string, field: string): fc.Arbitrary<WireLegacy> => {
  const toArb = pathArb.map((path) => outputRef(type, field, path));
  const fromArb = pathArb.map((path) => inputRef(type, field, path));

  return fc.oneof(
    // 1. Constant Wires
    fc.record({
      value: constantValueArb,
      to: toArb,
    }),

    // 2. Complex Pull Wires (Randomly injecting fallbacks)
    fc.record(
      {
        from: fromArb,
        to: toArb,
        fallbacks: fc.array(
          fc.oneof(
            fc.record({
              type: fc.constant<"falsy">("falsy"),
              value: constantValueArb,
            }),
            fc.record({
              type: fc.constant<"nullish">("nullish"),
              value: constantValueArb,
            }),
          ) as fc.Arbitrary<WireFallback>,
          { minLength: 0, maxLength: 2 },
        ),
        catchFallback: constantValueArb,
      },
      { requiredKeys: ["from", "to"] }, // Fallbacks are randomly omitted
    ),

    // 3. Ternary Conditional Wires
    fc.record(
      {
        cond: fromArb,
        to: toArb,
        thenValue: constantValueArb,
        elseValue: constantValueArb,
      },
      { requiredKeys: ["cond", "to"] }, // then/else are randomly omitted
    ),

    // 4. Logical AND
    fc.record({
      condAnd: fc.record(
        {
          leftRef: fromArb,
          rightValue: constantValueArb,
        },
        { requiredKeys: ["leftRef"] },
      ),
      to: toArb,
    }),

    // 5. Logical OR
    fc.record({
      condOr: fc.record(
        {
          leftRef: fromArb,
          rightValue: constantValueArb,
        },
        { requiredKeys: ["leftRef"] },
      ),
      to: toArb,
    }),
  );
};

const flatWireArb = (type: string, field: string): fc.Arbitrary<WireLegacy> => {
  const toArb = flatPathArb.map((path) => outputRef(type, field, path));
  const fromArb = flatPathArb.map((path) => inputRef(type, field, path));

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

const bridgeArb: fc.Arbitrary<Bridge> = fc
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
      wires: fc
        .array(wireArb(type, field), { minLength: 1, maxLength: 20 })
        .map((ws) => ws.map(legacyToV2)),
    }),
  );

const flatBridgeArb: fc.Arbitrary<Bridge> = fc
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
      wires: fc
        .uniqueArray(flatWireArb(type, field), {
          minLength: 1,
          maxLength: 20,
          selector: (wire) => wire.to.path.join("."),
        })
        .map((ws) => ws.map(legacyToV2)),
    }),
  );

const inputArb = fc.dictionary(identifierArb, fc.jsonValue(), {
  maxKeys: 16,
});

const textConstantValueArb = fc.oneof(
  fc.boolean().map((v) => (v ? "true" : "false")),
  fc.constant("null"),
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
  fc.string({ maxLength: 32 }).map((v) => JSON.stringify(v)),
);

const wireSpecArb = fc.oneof(
  fc.record({
    kind: fc.constant<"pull">("pull"),
    to: canonicalIdentifierArb,
    from: canonicalIdentifierArb,
  }),
  fc.record({
    kind: fc.constant<"constant">("constant"),
    to: canonicalIdentifierArb,
    value: textConstantValueArb,
  }),
);

const bridgeTextSpecArb = fc.record({
  type: canonicalIdentifierArb,
  field: canonicalIdentifierArb,
  wires: fc.uniqueArray(wireSpecArb, {
    minLength: 1,
    maxLength: 8,
    selector: (wire) => wire.to,
  }),
  input: inputArb,
});

function buildBridgeText(spec: {
  type: string;
  field: string;
  wires: Array<
    | { kind: "pull"; to: string; from: string }
    | { kind: "constant"; to: string; value: string }
  >;
}): string {
  const lines = [
    "version 1.5",
    `bridge ${spec.type}.${spec.field} {`,
    "  with input as i",
    "  with output as o",
    "",
  ];

  for (const wire of spec.wires) {
    if (wire.kind === "pull") {
      lines.push(`  o.${wire.to} <- i.${wire.from}`);
    } else {
      lines.push(`  o.${wire.to} = ${wire.value}`);
    }
  }

  lines.push("}");
  return lines.join("\n");
}

const loopScopedCompileSpecArb = fc
  .record({
    type: canonicalIdentifierArb,
    field: canonicalIdentifierArb,
    names: fc.uniqueArray(canonicalIdentifierArb, {
      minLength: 5,
      maxLength: 5,
    }),
    outerAlias: toolAliasArb,
    innerAlias: toolAliasArb,
    nested: fc.boolean(),
    memoizeOuter: fc.boolean(),
    memoizeInner: fc.boolean(),
    shadowInnerAlias: fc.boolean(),
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
    }),
  );

function buildLoopScopedCompileBridgeText(spec: {
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

const fallbackHeavyBridgeArb: fc.Arbitrary<Bridge> = fc
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
      wires: fc
        .uniqueArray(
          fc.record({
            from: flatPathArb.map((path) => inputRef(type, field, path)),
            to: flatPathArb.map((path) => outputRef(type, field, path)),
            fallbacks: fc.array(
              fc.oneof(
                fc.record({
                  type: fc.constant<"falsy">("falsy"),
                  value: constantValueArb,
                }),
                fc.record({
                  type: fc.constant<"nullish">("nullish"),
                  value: constantValueArb,
                }),
              ) as fc.Arbitrary<WireFallback>,
              { minLength: 0, maxLength: 2 },
            ),
            catchFallback: constantValueArb,
          }),
          {
            minLength: 1,
            maxLength: 20,
            selector: (wire) => wire.to.path.join("."),
          },
        )
        .map((ws) => ws.map(legacyToV2)),
    }),
  );

const logicalBridgeArb: fc.Arbitrary<Bridge> = fc
  .record({
    type: identifierArb,
    field: identifierArb,
  })
  .chain(({ type, field }) => {
    const toArb = flatPathArb.map((path) => outputRef(type, field, path));
    const fromArb = flatPathArb.map((path) => inputRef(type, field, path));

    return fc.record({
      kind: fc.constant<"bridge">("bridge"),
      type: fc.constant(type),
      field: fc.constant(field),
      handles: fc.constant([
        { kind: "input", handle: "i" } as const,
        { kind: "output", handle: "o" } as const,
      ]),
      wires: fc
        .uniqueArray(
          fc.oneof(
            fc.record(
              {
                cond: fromArb,
                to: toArb,
                thenValue: constantValueArb,
                elseValue: constantValueArb,
              },
              { requiredKeys: ["cond", "to"] },
            ),
            fc.record({
              condAnd: fc.record(
                {
                  leftRef: fromArb,
                  rightValue: constantValueArb,
                },
                { requiredKeys: ["leftRef"] },
              ),
              to: toArb,
            }),
            fc.record({
              condOr: fc.record(
                {
                  leftRef: fromArb,
                  rightValue: constantValueArb,
                },
                { requiredKeys: ["leftRef"] },
              ),
              to: toArb,
            }),
          ),
          {
            minLength: 1,
            maxLength: 20,
            selector: (wire) => wire.to.path.join("."),
          },
        )
        .map((ws) => ws.map(legacyToV2)),
    });
  });

describe("compileBridge fuzzing", () => {
  test(
    "never emits syntactically invalid function bodies",
    { timeout: 90_000 },
    () => {
      fc.assert(
        fc.property(bridgeArb, (bridge) => {
          const document: BridgeDocument = {
            instructions: [bridge],
          };

          const result = compileBridge(document, {
            operation: `${bridge.type}.${bridge.field}`,
          });

          assert.equal(typeof result.functionBody, "string");
          assert.ok(result.functionBody.length > 0);

          // If the compiler output is missing a brace, comma, or await keyword
          // where it shouldn't be, V8 will immediately throw a SyntaxError here.
          assert.doesNotThrow(() => {
            new AsyncFunction(
              "input",
              "tools",
              "context",
              "__opts",
              result.functionBody,
            );
          });
        }),
        {
          numRuns: 10_000,
          endOnFailure: true,
        },
      );
    },
  );

  test("is deterministic for the same bridge AST", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(bridgeArb, (bridge) => {
        const document: BridgeDocument = {
          instructions: [bridge],
        };
        const operation = `${bridge.type}.${bridge.field}`;

        const first = compileBridge(document, { operation });
        const second = compileBridge(document, { operation });

        assert.equal(first.code, second.code);
        assert.equal(first.functionBody, second.functionBody);
        assert.equal(first.functionName, second.functionName);
      }),
      {
        numRuns: 3_000,
        endOnFailure: true,
      },
    );
  });

  test(
    "AOT execution matches runtime execution on randomized bridges",
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(flatBridgeArb, inputArb, async (bridge, input) => {
          const document: BridgeDocument = {
            instructions: [bridge],
          };
          const operation = `${bridge.type}.${bridge.field}`;

          const runtime = await executeRuntime({
            document,
            operation,
            input,
            tools: {},
          });

          const aot = await executeAot({
            document,
            operation,
            input,
            tools: {},
          });

          assert.deepEqual(aot.data, runtime.data);
        }),
        {
          numRuns: 2_000,
          endOnFailure: true,
        },
      );
    },
  );

  test(
    "parse -> serialize -> parse keeps AOT/runtime parity on generated bridge text",
    { timeout: 120_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(bridgeTextSpecArb, async (spec) => {
          const operation = `${spec.type}.${spec.field}`;
          const sourceText = buildBridgeText(spec);

          const parsed = parseBridgeFormat(sourceText);
          const serialized = serializeBridge(parsed);
          let reparsed: BridgeDocument;
          try {
            reparsed = parseBridgeFormat(serialized);
          } catch (error) {
            assert.fail(
              `serializeBridge produced unparsable output: ${String(error)}\n--- SOURCE ---\n${sourceText}\n--- SERIALIZED ---\n${serialized}`,
            );
          }

          const runtime = await executeRuntime({
            document: reparsed,
            operation,
            input: spec.input,
            tools: {},
          });

          const aot = await executeAot({
            document: reparsed,
            operation,
            input: spec.input,
            tools: {},
          });

          assert.deepEqual(aot.data, runtime.data);
        }),
        {
          numRuns: 1_500,
          endOnFailure: true,
        },
      );
    },
  );

  test(
    "never emits invalid JS for fallback-heavy randomized bridges",
    { timeout: 90_000 },
    () => {
      fc.assert(
        fc.property(fallbackHeavyBridgeArb, (bridge) => {
          const document: BridgeDocument = { instructions: [bridge] };
          const result = compileBridge(document, {
            operation: `${bridge.type}.${bridge.field}`,
          });

          assert.doesNotThrow(() => {
            new AsyncFunction(
              "input",
              "tools",
              "context",
              "__opts",
              result.functionBody,
            );
          });
        }),
        {
          numRuns: 4_000,
          endOnFailure: true,
        },
      );
    },
  );

  test(
    "never emits invalid JS for logical-wire randomized bridges",
    { timeout: 90_000 },
    () => {
      fc.assert(
        fc.property(logicalBridgeArb, (bridge) => {
          const document: BridgeDocument = { instructions: [bridge] };
          const result = compileBridge(document, {
            operation: `${bridge.type}.${bridge.field}`,
          });

          assert.doesNotThrow(() => {
            new AsyncFunction(
              "input",
              "tools",
              "context",
              "__opts",
              result.functionBody,
            );
          });
        }),
        {
          numRuns: 4_000,
          endOnFailure: true,
        },
      );
    },
  );

  test(
    "loop-scoped tool bridges compile deterministically or reject deterministically",
    { timeout: 90_000 },
    () => {
      fc.assert(
        fc.property(loopScopedCompileSpecArb, (spec) => {
          const sourceText = buildLoopScopedCompileBridgeText(spec);
          const document = parseBridgeFormat(sourceText);
          const operation = `${spec.type}.${spec.field}`;

          let first:
            | ReturnType<typeof compileBridge>
            | BridgeCompilerIncompatibleError;
          let second:
            | ReturnType<typeof compileBridge>
            | BridgeCompilerIncompatibleError;

          try {
            first = compileBridge(document, { operation });
          } catch (error) {
            assert.ok(error instanceof BridgeCompilerIncompatibleError);
            first = error;
          }

          try {
            second = compileBridge(document, { operation });
          } catch (error) {
            assert.ok(error instanceof BridgeCompilerIncompatibleError);
            second = error as BridgeCompilerIncompatibleError;
          }

          if (first instanceof BridgeCompilerIncompatibleError) {
            assert.ok(second instanceof BridgeCompilerIncompatibleError);
            assert.equal(second.message, first.message);
            assert.match(
              first.message,
              /(memoize|memoized|shadowed loop-scoped tool handles|nested loop-scoped tool handles)/i,
            );
            return;
          }

          assert.ok(!(second instanceof BridgeCompilerIncompatibleError));
          assert.equal(first.code, second.code);
          assert.equal(first.functionBody, second.functionBody);
          assert.doesNotThrow(() => {
            new AsyncFunction(
              "input",
              "tools",
              "context",
              "__opts",
              first.functionBody,
            );
          });
        }),
        {
          numRuns: 1_000,
          endOnFailure: true,
        },
      );
    },
  );
});
