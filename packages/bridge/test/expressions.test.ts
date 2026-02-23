import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import { multiply } from "../src/tools/multiply.js";
import { divide } from "../src/tools/divide.js";
import { add } from "../src/tools/add.js";
import { subtract } from "../src/tools/subtract.js";
import { eq } from "../src/tools/eq.js";
import { neq } from "../src/tools/neq.js";
import { gt } from "../src/tools/gt.js";
import { gte } from "../src/tools/gte.js";
import { lt } from "../src/tools/lt.js";
import { lte } from "../src/tools/lte.js";
import { createGateway } from "./_gateway.js";

// ── Unit tests for math/comparison tools ────────────────────────────────────

describe("math tools", () => {
  test("multiply", () => {
    assert.equal(multiply({ a: 3, b: 4 }), 12);
    assert.equal(multiply({ a: 9.99, b: 100 }), 999);
  });
  test("divide", () => {
    assert.equal(divide({ a: 10, b: 2 }), 5);
    assert.equal(divide({ a: 100, b: 3 }), 100 / 3);
  });
  test("add", () => {
    assert.equal(add({ a: 3, b: 4 }), 7);
    assert.equal(add({ a: -1, b: 1 }), 0);
  });
  test("subtract", () => {
    assert.equal(subtract({ a: 10, b: 3 }), 7);
  });
});

describe("comparison tools return 1/0", () => {
  test("eq", () => {
    assert.equal(eq({ a: 1, b: 1 }), 1);
    assert.equal(eq({ a: 1, b: 2 }), 0);
    assert.equal(eq({ a: "x", b: "x" }), 1);
    assert.equal(eq({ a: "x", b: "y" }), 0);
  });
  test("neq", () => {
    assert.equal(neq({ a: 1, b: 2 }), 1);
    assert.equal(neq({ a: 1, b: 1 }), 0);
  });
  test("gt", () => {
    assert.equal(gt({ a: 5, b: 3 }), 1);
    assert.equal(gt({ a: 3, b: 5 }), 0);
    assert.equal(gt({ a: 3, b: 3 }), 0);
  });
  test("gte", () => {
    assert.equal(gte({ a: 3, b: 3 }), 1);
    assert.equal(gte({ a: 2, b: 3 }), 0);
  });
  test("lt", () => {
    assert.equal(lt({ a: 2, b: 3 }), 1);
    assert.equal(lt({ a: 3, b: 2 }), 0);
  });
  test("lte", () => {
    assert.equal(lte({ a: 3, b: 3 }), 1);
    assert.equal(lte({ a: 4, b: 3 }), 0);
  });
});

// ── Parser desugaring tests ─────────────────────────────────────────────────

describe("expressions: parser desugaring", () => {
  test("o.cents <- i.dollars * 100 — desugars into synthetic tool wires", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    // No ExprWire should exist — only pull and constant wires
    assert.ok(!bridge.wires.some((w) => "expr" in w), "no ExprWire in output");
    // There should be pipe handles for the synthetic expression tool
    assert.ok(bridge.pipeHandles!.length > 0, "has pipe handles");
    const exprHandle = bridge.pipeHandles!.find((ph) => ph.handle.startsWith("__expr_"));
    assert.ok(exprHandle, "has __expr_ pipe handle");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });

  test("all operators desugar to correct tool names", () => {
    const ops: Record<string, string> = {
      "*": "multiply", "/": "divide", "+": "add", "-": "subtract",
      "==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte",
    };
    for (const [op, fn] of Object.entries(ops)) {
      const instructions = parseBridge(`version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.value ${op} 1
}`);
      const bridge = instructions.find((i) => i.kind === "bridge")!;
      const exprHandle = bridge.pipeHandles!.find((ph) => ph.handle.startsWith("__expr_"));
      assert.ok(exprHandle, `${op} should create a pipe handle`);
      assert.equal(exprHandle.baseTrunk.field, fn, `${op} → ${fn}`);
    }
  });

  test("chained expression: i.times * 5 / 10", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.times * 5 / 10
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) => ph.handle.startsWith("__expr_"));
    assert.equal(exprHandles.length, 2, "two synthetic tools for chained expression");
    assert.equal(exprHandles[0].baseTrunk.field, "multiply");
    assert.equal(exprHandles[1].baseTrunk.field, "divide");
  });

  test("chained expression: i.times * 2 > 6", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.times * 2 > 6
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) => ph.handle.startsWith("__expr_"));
    assert.equal(exprHandles.length, 2);
    assert.equal(exprHandles[0].baseTrunk.field, "multiply");
    assert.equal(exprHandles[1].baseTrunk.field, "gt");
  });

  test("two source refs: i.price * i.qty", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.qty
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    // The .b wire should be a pipe wire from i.qty
    const bWire = bridge.wires.find(
      (w) => "from" in w && w.to.path.length === 1 && w.to.path[0] === "b",
    );
    assert.ok(bWire, "should have a .b wire");
    assert.ok("from" in bWire!);
  });

  test("expression in array mapping element", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.list {
  with pricing.list as api
  with input as i
  with output as o

  o.items <- api.items[] as item {
    .name <- item.name
    .cents <- item.price * 100
  }
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = bridge.pipeHandles!.find((ph) => ph.handle.startsWith("__expr_"));
    assert.ok(exprHandle, "should have expression pipe handle");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });
});

// ── Round-trip serialization tests ──────────────────────────────────────────

describe("expressions: round-trip serialization", () => {
  test("multiply expression serializes and re-parses", () => {
    const text = `version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("i.dollars * 100"), `should contain expression: ${serialized}`);

    // Re-parse the serialized output
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.find((i) => i.kind === "bridge")!;
    const exprHandle = bridge.pipeHandles!.find((ph) => ph.handle.startsWith("__expr_"));
    assert.ok(exprHandle, "re-parsed should contain synthetic tool");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });

  test("comparison expression round-trips", () => {
    const text = `version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.age >= 18
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("i.age >= 18"), `got: ${serialized}`);
  });

  test("chained expression round-trips", () => {
    const text = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.times * 5 / 10
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("i.times * 5 / 10"), `got: ${serialized}`);
  });

  test("two source refs round-trip", () => {
    const text = `version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("i.price * i.quantity"), `got: ${serialized}`);
  });
});

// ── Execution tests ─────────────────────────────────────────────────────────

const mathTypeDefs = /* GraphQL */ `
  type Query {
    convert(dollars: Float!): ConvertResult
    check(age: Int!, status: String): CheckResult
    calc(price: Float!, quantity: Int!): CalcResult
    products: [Product!]!
  }
  type ConvertResult {
    cents: Float
    dollars: Float
  }
  type CheckResult {
    eligible: Int
    isActive: Int
    over18: Int
  }
  type CalcResult {
    total: Float
    diff: Float
  }
  type Product {
    name: String
    cents: Float
  }
`;

describe("expressions: execution", () => {
  test("multiply: dollars to cents", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 9.99) { cents } }`),
    });
    assert.equal(result.data.convert.cents, 999);
  });

  test("divide: halve a value", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.dollars <- i.dollars / 2
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 10) { dollars } }`),
    });
    assert.equal(result.data.convert.dollars, 5);
  });

  test("multiply two source refs: price * quantity", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ calc(price: 19.99, quantity: 3) { total } }`),
    });
    assert.equal(result.data.calc.total, 59.97);
  });

  test("comparison >= returns 1/0", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.age >= 18
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const r18: any = await executor({
      document: parse(`{ check(age: 18) { eligible } }`),
    });
    assert.equal(r18.data.check.eligible, 1);

    const r17: any = await executor({
      document: parse(`{ check(age: 17) { eligible } }`),
    });
    assert.equal(r17.data.check.eligible, 0);
  });

  test("comparison > returns 1/0", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.over18 <- i.age > 18
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const r18: any = await executor({
      document: parse(`{ check(age: 18) { over18 } }`),
    });
    assert.equal(r18.data.check.over18, 0);

    const r19: any = await executor({
      document: parse(`{ check(age: 19) { over18 } }`),
    });
    assert.equal(r19.data.check.over18, 1);
  });

  test("comparison == with string returns 1/0", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.isActive <- i.status == "active"
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const rActive: any = await executor({
      document: parse(`{ check(age: 1, status: "active") { isActive } }`),
    });
    assert.equal(rActive.data.check.isActive, 1);

    const rInactive: any = await executor({
      document: parse(`{ check(age: 1, status: "inactive") { isActive } }`),
    });
    assert.equal(rInactive.data.check.isActive, 0);
  });

  test("expression with tool source", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with pricing.lookup as api
  with input as i
  with output as o

  api.id <- i.dollars
  o.cents <- api.price * 100
}`);
    const tools = {
      "pricing.lookup": async (input: { id: number }) => ({
        price: input.id * 2,
      }),
    };
    const gateway = createGateway(mathTypeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 5) { cents } }`),
    });
    // api gets id=5, returns price=10, then 10*100 = 1000
    assert.equal(result.data.convert.cents, 1000);
  });

  test("chained expression: i.dollars * 5 / 10", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 5 / 10
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 100) { cents } }`),
    });
    // 100 * 5 = 500, 500 / 10 = 50
    assert.equal(result.data.convert.cents, 50);
  });

  test("expression in array mapping", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.products {
  with pricing.list as api
  with output as o

  o <- api.items[] as item {
    .name <- item.name
    .cents <- item.price * 100
  }
}`);
    const tools = {
      "pricing.list": async () => ({
        items: [
          { name: "Widget", price: 9.99 },
          { name: "Gadget", price: 24.5 },
        ],
      }),
    };
    const gateway = createGateway(mathTypeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ products { name cents } }`),
    });
    assert.equal(result.data.products[0].name, "Widget");
    assert.equal(result.data.products[0].cents, 999);
    assert.equal(result.data.products[1].name, "Gadget");
    assert.equal(result.data.products[1].cents, 2450);
  });
});
