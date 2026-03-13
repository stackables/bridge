import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import { bridge } from "@stackables/bridge-core";

// ── Parser desugaring tests ─────────────────────────────────────────────────

describe("expressions: parser desugaring", () => {
  test("o.cents <- i.dollars * 100 — desugars into synthetic tool wires", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.convert {
        with input as i
        with output as o

        o.cents <- i.dollars * 100
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    assert.ok(!instr.wires.some((w) => "expr" in w), "no ExprWire in output");
    assert.ok(instr.pipeHandles!.length > 0, "has pipe handles");
    const exprHandle = instr.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "has __expr_ pipe handle");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });

  test("all operators desugar to correct tool names", () => {
    const ops: Record<string, string> = {
      "*": "multiply",
      "/": "divide",
      "+": "add",
      "-": "subtract",
      "==": "eq",
      "!=": "neq",
      ">": "gt",
      ">=": "gte",
      "<": "lt",
      "<=": "lte",
    };
    for (const [op, fn] of Object.entries(ops)) {
      const doc = parseBridge(bridge`
        version 1.5
        bridge Query.test {
          with input as i
          with output as o

          o.result <- i.value ${op} 1
        }
      `);
      const instr = doc.instructions.find((i) => i.kind === "bridge")!;
      const exprHandle = instr.pipeHandles!.find((ph) =>
        ph.handle.startsWith("__expr_"),
      );
      assert.ok(exprHandle, `${op} should create a pipe handle`);
      assert.equal(exprHandle.baseTrunk.field, fn, `${op} → ${fn}`);
    }
  });

  test("chained expression: i.times * 5 / 10", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.times * 5 / 10
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.equal(
      exprHandles.length,
      2,
      "two synthetic tools for chained expression",
    );
    assert.equal(exprHandles[0].baseTrunk.field, "multiply");
    assert.equal(exprHandles[1].baseTrunk.field, "divide");
  });

  test("chained expression: i.times * 2 > 6", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.times * 2 > 6
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.equal(exprHandles.length, 2);
    assert.equal(exprHandles[0].baseTrunk.field, "multiply");
    assert.equal(exprHandles[1].baseTrunk.field, "gt");
  });

  test("two source refs: i.price * i.qty", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.calc {
        with input as i
        with output as o

        o.total <- i.price * i.qty
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const bWire = instr.wires.find(
      (w) => "from" in w && w.to.path.length === 1 && w.to.path[0] === "b",
    );
    assert.ok(bWire, "should have a .b wire");
    assert.ok("from" in bWire!);
  });

  test("expression in array mapping element", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.list {
        with pricing.list as api
        with input as i
        with output as o

        o.items <- api.items[] as item {
          .name <- item.name
          .cents <- item.price * 100
        }
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = instr.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "should have expression pipe handle");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });
});

// ── Round-trip serialization tests ──────────────────────────────────────────

describe("expressions: round-trip serialization", () => {
  test("multiply expression serializes and re-parses", () => {
    const text = bridge`
      version 1.5
      bridge Query.convert {
        with input as i
        with output as o

        o.cents <- i.dollars * 100
      }
    `;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("i.dollars * 100"),
      `should contain expression: ${serialized}`,
    );

    const reparsed = parseBridge(serialized);
    const instr = reparsed.instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = instr.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "re-parsed should contain synthetic tool");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });

  test("comparison expression round-trips", () => {
    const text = bridge`
      version 1.5
      bridge Query.check {
        with input as i
        with output as o

        o.eligible <- i.age >= 18
      }
    `;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("i.age >= 18"), `got: ${serialized}`);
  });

  test("chained expression round-trips", () => {
    const text = bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.times * 5 / 10
      }
    `;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("i.times * 5 / 10"), `got: ${serialized}`);
  });

  test("two source refs round-trip", () => {
    const text = bridge`
      version 1.5
      bridge Query.calc {
        with input as i
        with output as o

        o.total <- i.price * i.quantity
      }
    `;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("i.price * i.quantity"),
      `got: ${serialized}`,
    );
  });
});

// ── Operator precedence: parser ───────────────────────────────────────────

describe("expressions: operator precedence (parser)", () => {
  test("i.base + i.tax * 2 — multiplication before addition", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.calc {
        with input as i
        with output as o

        o.total <- i.base + i.tax * 2
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.equal(exprHandles.length, 2, "two synthetic forks");
    assert.equal(exprHandles[0].baseTrunk.field, "multiply", "multiply first");
    assert.equal(exprHandles[1].baseTrunk.field, "add", "add second");
  });

  test("precedence round-trip: i.base + i.tax * 2 serializes correctly", () => {
    const text = bridge`
      version 1.5
      bridge Query.calc {
        with input as i
        with output as o

        o.total <- i.base + i.tax * 2
      }
    `;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("i.base + i.tax * 2") ||
        serialized.includes("i.tax * 2"),
      `got: ${serialized}`,
    );
  });
});

// ── Boolean logic: parser desugaring ──────────────────────────────────────────

describe("boolean logic: parser desugaring", () => {
  test("and / or desugar to condAnd/condOr wires", () => {
    const boolOps: Record<string, string> = {
      and: "__and",
      or: "__or",
    };
    for (const [op, fn] of Object.entries(boolOps)) {
      const doc = parseBridge(bridge`
        version 1.5
        bridge Query.test {
          with input as i
          with output as o

          o.result <- i.a ${op} i.b
        }
      `);
      const instr = doc.instructions.find((i) => i.kind === "bridge")!;
      const exprHandle = instr.pipeHandles!.find((ph) =>
        ph.handle.startsWith("__expr_"),
      );
      assert.ok(exprHandle, `${op}: has __expr_ pipe handle`);
      assert.equal(exprHandle.baseTrunk.field, fn, `${op}: maps to ${fn}`);
    }
  });

  test("not prefix desugars to not tool fork", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- not i.trusted
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = instr.pipeHandles!.find(
      (ph) => ph.baseTrunk.field === "not",
    );
    assert.ok(exprHandle, "has not pipe handle");
  });

  test('combined: (a > 18 and b) or c == "ADMIN"', () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.age > 18 and i.verified or i.role == "ADMIN"
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(
      exprHandles.length >= 4,
      `has >= 4 expr handles, got ${exprHandles.length}`,
    );
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("gt"), "has gt");
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("eq"), "has eq");
    assert.ok(fields.includes("__or"), "has __or");
  });
});

// ── Boolean logic: serializer round-trip ──────────────────────────────────────

describe("boolean logic: serializer round-trip", () => {
  test("and expression round-trips", () => {
    const src = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.a and i.b

      }
    `;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes(" and "), "serialized contains 'and'");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });

  test("or expression round-trips", () => {
    const src = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.a or i.b

      }
    `;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes(" or "), "serialized contains 'or'");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });

  test("not prefix round-trips", () => {
    const src = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.result <- not i.flag

      }
    `;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("not "), "serialized contains 'not'");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });
});

// ── Parenthesized expressions: parser desugaring ─────────────────────────────

describe("parenthesized expressions: parser desugaring", () => {
  test("(A and B) or C — groups correctly", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- (i.a and i.b) or i.c
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandles.length >= 2, `has >= 2 expr handles`);
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("__or"), "has __or");
  });

  test("A or (B and C) — groups correctly", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.a or (i.b and i.c)
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandles.length >= 2, `has >= 2 expr handles`);
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("__or"), "has __or");
  });

  test("not (A and B) — not wraps grouped expr", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- not (i.a and i.b)
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("not"), "has not");
  });

  test("(i.price + i.discount) * i.qty — math with parens", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- (i.price + i.discount) * i.qty
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = instr.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("add"), "has add (from parens)");
    assert.ok(fields.includes("multiply"), "has multiply");
  });
});

// ── Parenthesized expressions: serializer round-trip ──────────────────────────

describe("parenthesized expressions: serializer round-trip", () => {
  test("(A + B) * C round-trips with parentheses", () => {
    const src = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.result <- (i.a + i.b) * i.c

      }
    `;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("("), "serialized contains '(' for grouping");
    assert.ok(serialized.includes(")"), "serialized contains ')' for grouping");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });

  test("A or (B and C) round-trips correctly (parens optional since and binds tighter)", () => {
    const src = bridge`
      version 1.5

      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.a or (i.b and i.c)

      }
    `;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes(" or "), "serialized contains 'or'");
    assert.ok(serialized.includes(" and "), "serialized contains 'and'");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });
});

// ── Keyword strings in serializer ─────────────────────────────────────────────

describe("serializeBridge: keyword strings are quoted", () => {
  const keywords = [
    "or",
    "and",
    "not",
    "version",
    "bridge",
    "tool",
    "define",
    "with",
    "input",
    "output",
    "context",
    "const",
    "from",
    "as",
    "alias",
    "on",
    "error",
    "force",
    "catch",
    "continue",
    "break",
    "throw",
    "panic",
    "if",
    "pipe",
  ];

  for (const kw of keywords) {
    test(`constant value "${kw}" round-trips through serializer`, () => {
      const src = bridge`
        version 1.5
        bridge Query.x {
          with output as o
          o.result = "${kw}"
        }
      `;
      const doc = parseBridge(src);
      const serialized = serializeBridge(doc);
      assert.ok(
        !serialized.includes(`= ${kw}`),
        `Expected "${kw}" to be quoted in: ${serialized}`,
      );
      const reparsed = parseBridge(serialized);
      const instr = reparsed.instructions.find(
        (i) => i.kind === "bridge",
      ) as any;
      const wire = instr.wires.find(
        (w: any) => "value" in w && w.to?.path?.[0] === "result",
      );
      assert.equal(wire?.value, kw);
    });
  }
});
