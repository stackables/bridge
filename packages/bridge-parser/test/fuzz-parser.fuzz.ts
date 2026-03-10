import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import {
  parseBridgeFormat as parseBridge,
  parseBridgeDiagnostics,
  serializeBridge,
  prettyPrintToSource,
} from "../src/index.ts";
import type { BridgeDocument } from "@stackables/bridge-core";

// ── Token-soup arbitrary ────────────────────────────────────────────────────
// Generates strings composed of a weighted mix of Bridge-like tokens and noise.
// The goal is to exercise the parser/lexer on inputs that are structurally
// plausible but semantically invalid — the space where crashes lurk.

const bridgeKeywords = [
  "version",
  "bridge",
  "tool",
  "define",
  "const",
  "with",
  "input",
  "output",
  "context",
  "as",
  "memoize",
  "from",
  "force",
  "catch",
  "throw",
  "panic",
  "continue",
  "break",
  "on",
  "error",
  "null",
  "true",
  "false",
];

const bridgeOperators = [
  "<-",
  "=",
  "||",
  "??",
  "?.",
  ".",
  ",",
  "&&",
  "?",
  ":",
  "+",
  "-",
  "*",
  "/",
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "!",
];

const bridgeStructural = ["{", "}", "(", ")", "[", "]", "\n", "\n\n", "  "];

const bridgeTokenArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...bridgeKeywords) },
  { weight: 3, arbitrary: fc.constantFrom(...bridgeOperators) },
  { weight: 4, arbitrary: fc.constantFrom(...bridgeStructural) },
  { weight: 3, arbitrary: fc.stringMatching(/^[a-zA-Z_]\w{0,12}$/) }, // identifiers
  { weight: 2, arbitrary: fc.stringMatching(/^"[^"\\]{0,20}"$/) }, // string literals
  { weight: 2, arbitrary: fc.integer({ min: -1000, max: 1000 }).map(String) }, // numbers
  { weight: 1, arbitrary: fc.stringMatching(/^1\.\d$/) }, // version-like
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) }, // random noise
  { weight: 1, arbitrary: fc.constant("#") }, // comment start
);

const bridgeTokenSoupArb = fc
  .array(bridgeTokenArb, { minLength: 1, maxLength: 60 })
  .map((tokens) => tokens.join(" "));

// ── Valid bridge text arbitrary ─────────────────────────────────────────────
// Generates structurally valid .bridge text for round-trip testing.

const canonicalIdArb = fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h");
const toolAliasArb = fc.constantFrom("fetch", "http", "load", "lookup");

const textConstantValueArb = fc.oneof(
  fc.boolean().map((v) => (v ? "true" : "false")),
  fc.constant("null"),
  fc.integer({ min: -1_000_000, max: 1_000_000 }).map(String),
  fc.string({ maxLength: 32 }).map((v) => JSON.stringify(v)),
);

const wireSpecArb = fc.oneof(
  fc.record({
    kind: fc.constant<"pull">("pull"),
    to: canonicalIdArb,
    from: canonicalIdArb,
  }),
  fc.record({
    kind: fc.constant<"constant">("constant"),
    to: canonicalIdArb,
    value: textConstantValueArb,
  }),
);

const bridgeTextSpecArb = fc.record({
  type: canonicalIdArb,
  field: canonicalIdArb,
  wires: fc.uniqueArray(wireSpecArb, {
    minLength: 1,
    maxLength: 8,
    selector: (wire) => wire.to,
  }),
});

function buildBridgeText(spec: {
  type: string;
  field: string;
  wires: Array<
    | { kind: "pull"; to: string; from: string }
    | { kind: "constant"; to: string; value: string }
  >;
}): string {
  return "version 1.5\n" + buildBridgeBlock(spec);
}

function buildBridgeBlock(spec: {
  type: string;
  field: string;
  wires: Array<
    | { kind: "pull"; to: string; from: string }
    | { kind: "constant"; to: string; value: string }
  >;
}): string {
  const lines = [
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("parser fuzz — textual fuzzing", () => {
  test(
    "parseBridge never throws unstructured errors on random input",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(bridgeTokenSoupArb, (text) => {
          try {
            parseBridge(text);
          } catch (err) {
            // Structured Error is acceptable — the parser is allowed to reject
            // invalid input by throwing an Error with a message.
            if (err instanceof Error) {
              assert.ok(
                typeof err.message === "string" && err.message.length > 0,
                `Error must have a non-empty message, got: ${String(err)}`,
              );
              return;
            }
            // Non-Error throws are a parser bug.
            assert.fail(
              `parseBridge threw a non-Error value: ${typeof err} — ${String(err)}`,
            );
          }
        }),
        {
          numRuns: 5_000,
          endOnFailure: true,
        },
      );
    },
  );

  test(
    "parseBridgeDiagnostics never throws on random input",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(bridgeTokenSoupArb, (text) => {
          // This function is used in the IDE/LSP — it must NEVER throw.
          const result = parseBridgeDiagnostics(text);

          assert.ok(
            result !== null && result !== undefined,
            "must return a result",
          );
          assert.ok("document" in result, "result must have a document");
          assert.ok("diagnostics" in result, "result must have diagnostics");
          assert.ok(
            Array.isArray(result.diagnostics),
            "diagnostics must be an array",
          );
        }),
        {
          numRuns: 5_000,
          endOnFailure: true,
        },
      );
    },
  );
});

describe("parser fuzz — serializer round-trip", () => {
  test(
    "serializeBridge output is always parseable for valid documents",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(bridgeTextSpecArb, (spec) => {
          const sourceText = buildBridgeText(spec);
          const parsed = parseBridge(sourceText);
          const serialized = serializeBridge(parsed);

          // The serialized output must parse without errors.
          let reparsed: BridgeDocument;
          try {
            reparsed = parseBridge(serialized);
          } catch (error) {
            assert.fail(
              `serializeBridge produced unparsable output: ${String(error)}\n--- SOURCE ---\n${sourceText}\n--- SERIALIZED ---\n${serialized}`,
            );
          }

          // The reparsed document must have the same number of instructions.
          assert.equal(
            reparsed.instructions.length,
            parsed.instructions.length,
            "instruction count must survive round-trip",
          );

          // Each bridge instruction must preserve its wires.
          for (let i = 0; i < parsed.instructions.length; i++) {
            const orig = parsed.instructions[i]!;
            const rt = reparsed.instructions[i]!;
            assert.equal(rt.kind, orig.kind, "instruction kind must match");
            if (orig.kind === "bridge" && rt.kind === "bridge") {
              assert.equal(
                rt.wires.length,
                orig.wires.length,
                "wire count must match",
              );
            }
          }
        }),
        {
          numRuns: 2_000,
          endOnFailure: true,
        },
      );
    },
  );

  test("prettyPrintToSource is idempotent", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(bridgeTextSpecArb, (spec) => {
        const sourceText = buildBridgeText(spec);

        // First format pass
        const formatted1 = prettyPrintToSource(sourceText);
        // Second format pass
        const formatted2 = prettyPrintToSource(formatted1);

        // Must be identical — formatting is idempotent.
        assert.equal(
          formatted2,
          formatted1,
          "prettyPrintToSource must be idempotent\n--- FIRST ---\n" +
            formatted1 +
            "\n--- SECOND ---\n" +
            formatted2,
        );
      }),
      {
        numRuns: 2_000,
        endOnFailure: true,
      },
    );
  });

  test(
    "prettyPrintToSource output is always parseable",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(bridgeTextSpecArb, (spec) => {
          const sourceText = buildBridgeText(spec);
          const formatted = prettyPrintToSource(sourceText);

          try {
            parseBridge(formatted);
          } catch (error) {
            assert.fail(
              `prettyPrintToSource produced unparsable output: ${String(error)}\n--- SOURCE ---\n${sourceText}\n--- FORMATTED ---\n${formatted}`,
            );
          }
        }),
        {
          numRuns: 2_000,
          endOnFailure: true,
        },
      );
    },
  );
});

// ── P2-3B: prettyPrintToSource advanced stability — all block types ────────
//
// Design note (re: Suggestion 2 / depth limits):
// We generate text directly using bounded arbitraries rather than recursive
// AST objects. This is the same "text-first" strategy used throughout this
// file. There is no fc.letrec here — every block type is generated with a
// fixed small output size, and fast-check shrinks by reducing the string,
// not by traversing a recursive data structure.

const constBlockArb = fc
  .record({
    name: canonicalIdArb.map((n) => n.toUpperCase()),
    value: textConstantValueArb,
  })
  .map(({ name, value }) => `const ${name} = ${value}`);

const toolBlockArb = fc
  .record({
    name: canonicalIdArb,
    // Use a limited set of real stdlib tools available in the parser's namespace
    fn: fc.constantFrom(
      "std.httpCall",
      "std.str.toUpperCase",
      "std.arr.filter",
    ),
    wireCount: fc.integer({ min: 0, max: 3 }),
    wireKey: canonicalIdArb,
    wireValue: textConstantValueArb,
  })
  .map(({ name, fn, wireCount, wireKey, wireValue }) => {
    const lines = [`tool ${name} from ${fn} {`];
    for (let i = 0; i < wireCount; i++) {
      lines.push(`  .${wireKey}${i > 0 ? i : ""} = ${wireValue}`);
    }
    lines.push("}");
    return lines.join("\n");
  });

// Extended document spec: optional const + optional tool + required bridge block.
const extendedDocSpecArb = fc.record({
  includeConst: fc.boolean(),
  includeTool: fc.boolean(),
  constBlock: constBlockArb,
  toolBlock: toolBlockArb,
  bridge: bridgeTextSpecArb,
});

const loopScopedToolBridgeSpecArb = fc
  .record({
    type: canonicalIdArb,
    field: canonicalIdArb,
    names: fc.uniqueArray(canonicalIdArb, {
      minLength: 6,
      maxLength: 6,
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
      srcField: names[0]!,
      outField: names[1]!,
      valueField: names[2]!,
      childField: names[3]!,
      childOutField: names[4]!,
      childValueField: names[5]!,
      outerAlias,
      innerAlias: shadowInnerAlias ? outerAlias : innerAlias,
      nested,
      memoizeOuter,
      memoizeInner,
    }),
  );

const serializableLoopScopedToolBridgeSpecArb =
  loopScopedToolBridgeSpecArb.filter(
    (spec) => !spec.nested || spec.innerAlias !== spec.outerAlias,
  );

function buildExtendedDocText(spec: {
  includeConst: boolean;
  includeTool: boolean;
  constBlock: string;
  toolBlock: string;
  bridge: {
    type: string;
    field: string;
    wires: Array<
      | { kind: "pull"; to: string; from: string }
      | { kind: "constant"; to: string; value: string }
    >;
  };
}): string {
  const parts: string[] = ["version 1.5"];
  if (spec.includeConst) parts.push(spec.constBlock);
  if (spec.includeTool) parts.push(spec.toolBlock);
  parts.push(buildBridgeBlock(spec.bridge));
  return parts.join("\n\n");
}

function buildLoopScopedToolBridgeText(spec: {
  type: string;
  field: string;
  srcField: string;
  outField: string;
  valueField: string;
  childField: string;
  childOutField: string;
  childValueField: string;
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
    `  o.${spec.outField} <- ctx.${spec.srcField}[] as el {`,
    `    with std.httpCall as ${spec.outerAlias}${spec.memoizeOuter ? " memoize" : ""}`,
    "",
    `    ${spec.outerAlias}.value <- el.${spec.valueField}`,
    `    .${spec.valueField} <- ${spec.outerAlias}.data`,
  ];

  if (spec.nested) {
    lines.push(
      `    .${spec.childOutField} <- el.${spec.childField}[] as child {`,
    );
    lines.push(
      `      with std.httpCall as ${spec.innerAlias}${spec.memoizeInner ? " memoize" : ""}`,
    );
    lines.push("");
    lines.push(
      `      ${spec.innerAlias}.value <- child.${spec.childValueField}`,
    );
    lines.push(`      .${spec.childValueField} <- ${spec.innerAlias}.data`);
    lines.push(`      .parent <- el.${spec.valueField}`);
    lines.push("    }");
  }

  lines.push("  }");
  lines.push("}");
  return lines.join("\n");
}

describe("parser fuzz — advanced formatter stability (P2-3B)", () => {
  test(
    "prettyPrintToSource is idempotent on documents with tool and const blocks",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(extendedDocSpecArb, (spec) => {
          const sourceText = buildExtendedDocText(spec);
          const formatted1 = prettyPrintToSource(sourceText);
          const formatted2 = prettyPrintToSource(formatted1);
          assert.equal(
            formatted2,
            formatted1,
            "prettyPrintToSource must be idempotent\n--- FIRST ---\n" +
              formatted1 +
              "\n--- SECOND ---\n" +
              formatted2,
          );
        }),
        { numRuns: 1_000, endOnFailure: true },
      );
    },
  );

  test(
    "prettyPrintToSource output is always parseable for documents with tool and const blocks",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(extendedDocSpecArb, (spec) => {
          const sourceText = buildExtendedDocText(spec);
          const formatted = prettyPrintToSource(sourceText);
          try {
            parseBridge(formatted);
          } catch (error) {
            assert.fail(
              `prettyPrintToSource produced unparsable output: ${String(error)}\n--- SOURCE ---\n${sourceText}\n--- FORMATTED ---\n${formatted}`,
            );
          }
        }),
        { numRuns: 1_000, endOnFailure: true },
      );
    },
  );
});

describe("parser fuzz — loop-scoped tool syntax", () => {
  test(
    "serializeBridge keeps non-shadowed loop-scoped tool and memoize documents parseable",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(serializableLoopScopedToolBridgeSpecArb, (spec) => {
          const sourceText = buildLoopScopedToolBridgeText(spec);
          const parsed = parseBridge(sourceText);
          const serialized = serializeBridge(parsed);

          let reparsed: BridgeDocument;
          try {
            reparsed = parseBridge(serialized);
          } catch (error) {
            assert.fail(
              `serializeBridge produced unparsable loop-scoped tool output: ${String(error)}\n--- SOURCE ---\n${sourceText}\n--- SERIALIZED ---\n${serialized}`,
            );
          }

          const originalBridge = parsed.instructions[0];
          const reparsedBridge = reparsed.instructions[0];
          assert.ok(originalBridge?.kind === "bridge");
          assert.ok(reparsedBridge?.kind === "bridge");
          assert.equal(
            reparsedBridge.handles.length,
            originalBridge.handles.length,
            "handle count must survive round-trip",
          );
          assert.equal(
            reparsedBridge.handles.filter(
              (handle) => handle.kind === "tool" && handle.memoize,
            ).length,
            originalBridge.handles.filter(
              (handle) => handle.kind === "tool" && handle.memoize,
            ).length,
            "memoized handle count must survive round-trip",
          );
        }),
        { numRuns: 1_000, endOnFailure: true },
      );
    },
  );

  test(
    "prettyPrintToSource is idempotent for loop-scoped tool documents",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(loopScopedToolBridgeSpecArb, (spec) => {
          const sourceText = buildLoopScopedToolBridgeText(spec);
          const formatted1 = prettyPrintToSource(sourceText);
          const formatted2 = prettyPrintToSource(formatted1);
          assert.equal(formatted2, formatted1);

          assert.doesNotThrow(() => {
            parseBridge(formatted2);
          });
        }),
        { numRuns: 1_000, endOnFailure: true },
      );
    },
  );
});
