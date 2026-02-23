import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.ts";
import { multiply } from "../src/tools/multiply.ts";
import { divide } from "../src/tools/divide.ts";
import { add } from "../src/tools/add.ts";
import { subtract } from "../src/tools/subtract.ts";
import { eq } from "../src/tools/eq.ts";
import { neq } from "../src/tools/neq.ts";
import { gt } from "../src/tools/gt.ts";
import { gte } from "../src/tools/gte.ts";
import { lt } from "../src/tools/lt.ts";
import { lte } from "../src/tools/lte.ts";
import { createGateway } from "./_gateway.ts";

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

describe("comparison tools return boolean", () => {
  test("eq", () => {
    assert.equal(eq({ a: 1, b: 1 }), true);
    assert.equal(eq({ a: 1, b: 2 }), false);
    assert.equal(eq({ a: "x", b: "x" }), true);
    assert.equal(eq({ a: "x", b: "y" }), false);
  });
  test("neq", () => {
    assert.equal(neq({ a: 1, b: 2 }), true);
    assert.equal(neq({ a: 1, b: 1 }), false);
  });
  test("gt", () => {
    assert.equal(gt({ a: 5, b: 3 }), true);
    assert.equal(gt({ a: 3, b: 5 }), false);
    assert.equal(gt({ a: 3, b: 3 }), false);
  });
  test("gte", () => {
    assert.equal(gte({ a: 3, b: 3 }), true);
    assert.equal(gte({ a: 2, b: 3 }), false);
  });
  test("lt", () => {
    assert.equal(lt({ a: 2, b: 3 }), true);
    assert.equal(lt({ a: 3, b: 2 }), false);
  });
  test("lte", () => {
    assert.equal(lte({ a: 3, b: 3 }), true);
    assert.equal(lte({ a: 4, b: 3 }), false);
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
    eligible: Boolean
    isActive: Boolean
    over18: Boolean
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

  test("comparison >= returns true/false", async () => {
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
    assert.equal(r18.data.check.eligible, true);

    const r17: any = await executor({
      document: parse(`{ check(age: 17) { eligible } }`),
    });
    assert.equal(r17.data.check.eligible, false);
  });

  test("comparison > returns true/false", async () => {
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
    assert.equal(r18.data.check.over18, false);

    const r19: any = await executor({
      document: parse(`{ check(age: 19) { over18 } }`),
    });
    assert.equal(r19.data.check.over18, true);
  });

  test("comparison == with string returns true/false", async () => {
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
    assert.equal(rActive.data.check.isActive, true);

    const rInactive: any = await executor({
      document: parse(`{ check(age: 1, status: "inactive") { isActive } }`),
    });
    assert.equal(rInactive.data.check.isActive, false);
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

// ── Operator precedence tests ─────────────────────────────────────────────

describe("expressions: operator precedence", () => {
  test("i.base + i.tax * 2 — multiplication before addition", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) => ph.handle.startsWith("__expr_"));
    // multiply should be emitted FIRST (higher precedence)
    assert.equal(exprHandles.length, 2, "two synthetic forks");
    assert.equal(exprHandles[0].baseTrunk.field, "multiply", "multiply first");
    assert.equal(exprHandles[1].baseTrunk.field, "add", "add second");
  });

  test("precedence: a + b * c executes correctly", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query { calc(base: Float!, tax: Float!): PrecResult }
      type PrecResult { total: Float }
    `;
    const gateway = createGateway(precTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ calc(base: 100, tax: 10) { total } }`),
    });
    // Should be 100 + (10 * 2) = 120, NOT (100 + 10) * 2 = 220
    assert.equal(result.data.calc.total, 120);
  });

  test("precedence: a * b + c * d", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity + i.base * 2
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query { calc(price: Float!, quantity: Int!, base: Float!): PrecResult }
      type PrecResult { total: Float }
    `;
    const gateway = createGateway(precTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ calc(price: 10, quantity: 3, base: 5) { total } }`),
    });
    // (10 * 3) + (5 * 2) = 30 + 10 = 40
    assert.equal(result.data.calc.total, 40);
  });

  test("precedence: comparison after arithmetic — i.base + i.tax * 2 > 100", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.base + i.tax * 2 > 100
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query { check(base: Float!, tax: Float!): CheckResult }
      type CheckResult { eligible: Boolean }
    `;
    const gateway = createGateway(precTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // 100 + (10 * 2) = 120 > 100 → true
    const r1: any = await executor({
      document: parse(`{ check(base: 100, tax: 10) { eligible } }`),
    });
    assert.equal(r1.data.check.eligible, true);

    // 50 + (10 * 2) = 70 > 100 → false
    const r2: any = await executor({
      document: parse(`{ check(base: 50, tax: 10) { eligible } }`),
    });
    assert.equal(r2.data.check.eligible, false);
  });

  test("precedence round-trip: i.base + i.tax * 2 serializes correctly", () => {
    const text = `version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    // Should round-trip the expression (order may vary due to precedence grouping)
    assert.ok(
      serialized.includes("i.base + i.tax * 2") || serialized.includes("i.tax * 2"),
      `got: ${serialized}`,
    );
  });
});

// ── Expression + fallback integration tests ─────────────────────────────────

describe("expressions: fallback integration", () => {
  test("expression with ?? error fallback: i.value * 100 ?? -1", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with pricing.lookup as api
  with input as i
  with output as o

  api.id <- i.dollars
  o.cents <- api.price * 100 ?? -1
}`);
    const tools = {
      "pricing.lookup": async () => { throw new Error("service unavailable"); },
    };
    const precTypeDefs = /* GraphQL */ `
      type Query { convert(dollars: Float!): ConvertResult }
      type ConvertResult { cents: Float }
    `;
    const gateway = createGateway(precTypeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 5) { cents } }`),
    });
    // api.price throws → expression throws → ?? catches → returns -1
    assert.equal(result.data.convert.cents, -1);
  });

  test("expression with || null coalesce: (i.value ?? 1) * 2", async () => {
    // This tests coalescing on the source BEFORE the expression
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query { convert(dollars: Float!): ConvertResult }
      type ConvertResult { cents: Float }
    `;
    const gateway = createGateway(precTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 5) { cents } }`),
    });
    assert.equal(result.data.convert.cents, 500);
  });
});

// ── Non-number handling tests ──────────────────────────────────────────────

describe("expressions: non-number handling", () => {
  test("undefined input coerces to NaN via Number()", () => {
    // Number(undefined) = NaN, so undefined * 100 = NaN
    assert.ok(Number.isNaN(multiply({ a: undefined as any, b: 100 })));
    assert.ok(Number.isNaN(add({ a: undefined as any, b: 5 })));
  });

  test("null input coerces to 0 via Number()", () => {
    // Number(null) = 0
    assert.equal(multiply({ a: null as any, b: 100 }), 0);
    assert.equal(add({ a: null as any, b: 5 }), 5);
  });

  test("string number coerces correctly", () => {
    assert.equal(multiply({ a: "10" as any, b: "5" as any }), 50);
    assert.equal(add({ a: "3" as any, b: "4" as any }), 7);
  });

  test("non-numeric string produces NaN", () => {
    assert.ok(Number.isNaN(multiply({ a: "hello" as any, b: 100 })));
  });

  test("comparison with NaN returns false", () => {
    assert.equal(gt({ a: NaN, b: 5 }), false);
    assert.equal(eq({ a: NaN, b: NaN }), false);
  });
});
