import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ── Parser tests ────────────────────────────────────────────────────────────

describe("expressions: parser", () => {
  test("multiplication: o.value <- i.value * 100", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire, "should have an expression wire");
    assert.equal(exprWire.expr.op, "*");
    assert.equal(exprWire.expr.left.kind, "ref");
    assert.equal(exprWire.expr.right.kind, "literal");
    assert.equal(exprWire.expr.right.value, 100);
  });

  test("division: o.dollars <- i.cents / 100", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.dollars <- i.cents / 100
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "/");
  });

  test("addition: o.total <- i.subtotal + i.tax", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.subtotal + i.tax
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "+");
    assert.equal(exprWire.expr.left.kind, "ref");
    assert.equal(exprWire.expr.right.kind, "ref");
  });

  test("subtraction: o.diff <- i.a - i.b", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.diff <- i.a - i.b
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "-");
  });

  test("comparison ==", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.match <- i.status == "active"
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "==");
    assert.deepEqual(exprWire.expr.right, { kind: "literal", value: "active" });
  });

  test("comparison !=", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.notAdmin <- i.role != "admin"
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "!=");
  });

  test("comparison > and >=", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.over18 <- i.age > 18
  o.adult <- i.age >= 18
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWires = bridge.wires.filter((w) => "expr" in w);
    assert.equal(exprWires.length, 2);
    assert.equal(exprWires[0].expr.op, ">");
    assert.equal(exprWires[1].expr.op, ">=");
  });

  test("comparison < and <=", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.under18 <- i.age < 18
  o.minor <- i.age <= 17
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWires = bridge.wires.filter((w) => "expr" in w);
    assert.equal(exprWires.length, 2);
    assert.equal(exprWires[0].expr.op, "<");
    assert.equal(exprWires[1].expr.op, "<=");
  });

  test("boolean literal operand", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.isTrue <- i.flag == true
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.deepEqual(exprWire.expr.right, { kind: "literal", value: true });
  });

  test("null literal operand", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.hasValue <- i.data != null
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.deepEqual(exprWire.expr.right, { kind: "literal", value: null });
  });

  test("tool source in expression: o.cents <- api.price * 100", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with pricing.lookup as api
  with input as i
  with output as o

  api.id <- i.productId
  o.cents <- api.price * 100
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "*");
    assert.equal(exprWire.expr.left.kind, "ref");
  });

  test("expression with force arrow: o.value <-! i.value * 100", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.convert {
  with input as i
  with output as o

  o.value <-! i.value * 100
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.force, true);
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
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire, "should have expression wire in element block");
    assert.equal(exprWire.expr.op, "*");
    assert.ok(exprWire.to.element, "target should be an element ref");
  });

  test("mixed regular and expression wires", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.order {
  with input as i
  with output as o

  o.name <- i.name
  o.total <- i.price * i.quantity
  o.currency = USD
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    assert.equal(bridge.wires.length, 3);
    const pullWire = bridge.wires.find((w) => "from" in w);
    const constWire = bridge.wires.find((w) => "value" in w);
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(pullWire);
    assert.ok(constWire);
    assert.ok(exprWire);
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
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire, "re-parsed should contain expression wire");
    assert.equal(exprWire.expr.op, "*");
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
    assert.ok(serialized.includes("i.age >= 18"));
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, ">=");
  });

  test("expression with string operand round-trips", () => {
    const text = `version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.isActive <- i.status == "active"
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.find((i) => i.kind === "bridge")!;
    const exprWire = bridge.wires.find((w) => "expr" in w);
    assert.ok(exprWire);
    assert.equal(exprWire.expr.op, "==");
    assert.deepEqual(exprWire.expr.right, { kind: "literal", value: "active" });
  });

  test("expression with two source refs round-trips", () => {
    const text = `version 1.4
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("i.price * i.quantity"));
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

  test("divide: cents to dollars", async () => {
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

  test("comparison >=: age check", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.age >= 18
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result18: any = await executor({
      document: parse(`{ check(age: 18) { eligible } }`),
    });
    assert.equal(result18.data.check.eligible, true);

    const result17: any = await executor({
      document: parse(`{ check(age: 17) { eligible } }`),
    });
    assert.equal(result17.data.check.eligible, false);
  });

  test("comparison >: strict greater than", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.over18 <- i.age > 18
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result18: any = await executor({
      document: parse(`{ check(age: 18) { over18 } }`),
    });
    assert.equal(result18.data.check.over18, false);

    const result19: any = await executor({
      document: parse(`{ check(age: 19) { over18 } }`),
    });
    assert.equal(result19.data.check.over18, true);
  });

  test("comparison ==: string equality", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.isActive <- i.status == "active"
}`);
    const gateway = createGateway(mathTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const resultActive: any = await executor({
      document: parse(`{ check(age: 1, status: "active") { isActive } }`),
    });
    assert.equal(resultActive.data.check.isActive, true);

    const resultInactive: any = await executor({
      document: parse(`{ check(age: 1, status: "inactive") { isActive } }`),
    });
    assert.equal(resultInactive.data.check.isActive, false);
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
