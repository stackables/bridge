import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import { bridge } from "@stackables/bridge-core";
import { flatWires } from "./utils/parse-test-utils.ts";

// -- Helper: find a binary/unary expression in the body wires --

function exprContainsOp(expr: any, op: string): boolean {
  if (!expr) return false;
  if (expr.type === "binary" && expr.op === op) return true;
  if (expr.type === "unary" && expr.op === op) return true;
  if (expr.type === "binary")
    return exprContainsOp(expr.left, op) || exprContainsOp(expr.right, op);
  if (expr.type === "and")
    return exprContainsOp(expr.left, op) || exprContainsOp(expr.right, op);
  if (expr.type === "or")
    return exprContainsOp(expr.left, op) || exprContainsOp(expr.right, op);
  if (expr.type === "unary") return exprContainsOp(expr.operand, op);
  if (expr.type === "ternary")
    return (
      exprContainsOp(expr.cond, op) ||
      exprContainsOp(expr.then, op) ||
      exprContainsOp(expr.else, op)
    );
  return false;
}

function findBinaryOp(
  doc: ReturnType<typeof parseBridge>,
  op: string,
): boolean {
  const instr = doc.instructions.find((i) => i.kind === "bridge")!;
  const wires = flatWires(instr.body);
  return wires.some((w) => exprContainsOp(w.sources[0]?.expr, op));
}

function getOutputExpr(doc: ReturnType<typeof parseBridge>): any {
  const instr = doc.instructions.find((i) => i.kind === "bridge")!;
  const wires = flatWires(instr.body);
  const outputWire = wires.find((w) => w.to.path.includes("result"));
  return outputWire?.sources[0]?.expr;
}

// -- Parser desugaring tests --

describe("expressions: parser desugaring", () => {
  test("o.cents <- i.dollars * 100 -- produces binary expression", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.convert {
        with input as i
        with output as o

        o.cents <- i.dollars * 100
      }
    `);
    assert.ok(findBinaryOp(doc, "mul"), "should have mul binary expression");
  });

  test("all operators produce correct expression nodes", () => {
    const ops: Record<string, string> = {
      "*": "mul",
      "/": "div",
      "+": "add",
      "-": "sub",
      "==": "eq",
      "!=": "neq",
      ">": "gt",
      ">=": "gte",
      "<": "lt",
      "<=": "lte",
    };
    for (const [op, exprOp] of Object.entries(ops)) {
      const doc = parseBridge(bridge`
        version 1.5
        bridge Query.test {
          with input as i
          with output as o

          o.result <- i.value ${op} 1
        }
      `);
      assert.ok(findBinaryOp(doc, exprOp), `${op} should produce ${exprOp}`);
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
    assert.ok(findBinaryOp(doc, "mul"), "has mul");
    assert.ok(findBinaryOp(doc, "div"), "has div");
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
    assert.ok(findBinaryOp(doc, "mul"), "has mul");
    assert.ok(findBinaryOp(doc, "gt"), "has gt");
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
    assert.ok(findBinaryOp(doc, "mul"), "has mul expression");
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
    assert.ok(findBinaryOp(doc, "mul"), "has mul expression in array element");
  });
});

// -- Round-trip serialization tests --

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
    assert.ok(
      findBinaryOp(reparsed, "mul"),
      "re-parsed should contain mul expression",
    );
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

// -- Operator precedence: parser --

describe("expressions: operator precedence (parser)", () => {
  test("i.base + i.tax * 2 -- multiplication before addition", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.calc {
        with input as i
        with output as o

        o.total <- i.base + i.tax * 2
      }
    `);
    const instr = doc.instructions.find((i) => i.kind === "bridge")!;
    const wires = flatWires(instr.body);
    const outputWire = wires.find((w) => w.to.path.includes("total"));
    assert.ok(outputWire, "should have output wire");
    const expr = outputWire!.sources[0]?.expr;
    assert.equal(expr.type, "binary");
    assert.equal(expr.op, "add", "outer op should be add");
    assert.equal(
      expr.right.type === "binary" ? expr.right.op : null,
      "mul",
      "inner op should be mul",
    );
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

// -- Boolean logic: parser desugaring --

describe("boolean logic: parser desugaring", () => {
  test("and / or produce correct expression types", () => {
    for (const op of ["and", "or"]) {
      const doc = parseBridge(bridge`
        version 1.5
        bridge Query.test {
          with input as i
          with output as o

          o.result <- i.a ${op} i.b
        }
      `);
      const expr = getOutputExpr(doc);
      assert.ok(expr, `${op}: has output expr`);
      assert.equal(expr.type, op, `${op}: expr type`);
    }
  });

  test("not prefix produces unary expression", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- not i.trusted
      }
    `);
    const expr = getOutputExpr(doc);
    assert.ok(expr);
    assert.equal(expr.type, "unary");
    assert.equal(expr.op, "not");
  });

  test("combined boolean expression", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.age > 18 and i.verified or i.role == "ADMIN"
      }
    `);
    const expr = getOutputExpr(doc);
    assert.ok(expr, "has output expr");
    assert.ok(exprContainsOp(expr, "gt"), "has gt in tree");
  });
});

// -- Boolean logic: serializer round-trip --

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

// -- Parenthesized expressions: parser desugaring --

describe("parenthesized expressions: parser desugaring", () => {
  test("(A and B) or C -- groups correctly", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- (i.a and i.b) or i.c
      }
    `);
    const expr = getOutputExpr(doc);
    assert.equal(expr.type, "or", "outer should be or");
    assert.equal(expr.left.type, "and", "left should be and");
  });

  test("A or (B and C) -- groups correctly", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- i.a or (i.b and i.c)
      }
    `);
    const expr = getOutputExpr(doc);
    assert.equal(expr.type, "or", "outer should be or");
    assert.equal(expr.right.type, "and", "right should be and");
  });

  test("not (A and B) -- not wraps grouped expr", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- not (i.a and i.b)
      }
    `);
    const expr = getOutputExpr(doc);
    assert.equal(expr.type, "unary", "outer should be unary");
    assert.equal(expr.op, "not");
    assert.equal(expr.operand.type, "and", "operand should be and");
  });

  test("(i.price + i.discount) * i.qty -- math with parens", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o

        o.result <- (i.price + i.discount) * i.qty
      }
    `);
    const expr = getOutputExpr(doc);
    assert.equal(expr.type, "binary");
    assert.equal(expr.op, "mul", "outer should be mul");
    assert.equal(
      expr.left.type === "binary" ? expr.left.op : null,
      "add",
      "inner should be add",
    );
  });
});

// -- Parenthesized expressions: serializer round-trip --

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

  test("A or (B and C) round-trips correctly", () => {
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

// -- Keyword strings in serializer --

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
      const instr = reparsed.instructions.find((i) => i.kind === "bridge")!;
      const wire = flatWires(instr.body).find(
        (w) =>
          w.sources?.[0]?.expr?.type === "literal" &&
          w.to?.path?.[0] === "result",
      );
      assert.equal(
        wire?.sources[0]?.expr.type === "literal"
          ? wire.sources[0].expr.value
          : undefined,
        kw,
      );
    });
  }
});
