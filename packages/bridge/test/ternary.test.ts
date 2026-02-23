import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ── Parser / desugaring tests ─────────────────────────────────────────────

describe("ternary: parser", () => {
  test("simple ref ? ref : ref produces a conditional wire", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`);
    const bridge = instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire, "should have a conditional wire");
    assert.ok("cond" in condWire);
    assert.ok(condWire.thenRef, "thenRef should be a NodeRef");
    assert.ok(condWire.elseRef, "elseRef should be a NodeRef");
    assert.deepEqual(condWire.thenRef!.path, ["proPrice"]);
    assert.deepEqual(condWire.elseRef!.path, ["basicPrice"]);
  });

  test("string literal branches produce thenValue / elseValue", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.label {
  with input as i
  with output as o

  o.tier <- i.isPro ? "premium" : "basic"
}`);
    const bridge = instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, '"premium"');
    assert.equal(condWire.elseValue, '"basic"');
  });

  test("numeric literal branches produce thenValue / elseValue", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.pricing {
  with input as i
  with output as o

  o.discount <- i.isPro ? 20 : 0
}`);
    const bridge = instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, "20");
    assert.equal(condWire.elseValue, "0");
  });

  test("boolean literal branches", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.cond ? true : false
}`);
    const bridge = instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, "true");
    assert.equal(condWire.elseValue, "false");
  });

  test("null literal branch", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.cond ? i.value : null
}`);
    const bridge = instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.ok(condWire.thenRef, "thenRef should be NodeRef");
    assert.equal(condWire.elseValue, "null");
  });

  test("condition with expression chain: i.age >= 18 ? a : b", () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.age >= 18 ? i.proValue : i.basicValue
}`);
    const bridge = instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    // The cond should point to the expression fork result
    assert.ok(condWire.cond.instance != null && condWire.cond.instance >= 100000,
      "cond should be an expression fork result");
    // Expression fork should exist for >=
    const exprHandle = bridge.pipeHandles!.find((ph) => ph.handle.startsWith("__expr_"));
    assert.ok(exprHandle, "should have expression fork");
    assert.equal(exprHandle.baseTrunk.field, "gte");
  });
});

// ── Round-trip serialization tests ───────────────────────────────────────

describe("ternary: round-trip serialization", () => {
  test("simple ref ternary round-trips", () => {
    const text = `version 1.4
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("? i.proPrice : i.basicPrice"), `got: ${serialized}`);
    // Re-parse
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire, "re-parsed should have conditional wire");
  });

  test("string literal ternary round-trips", () => {
    const text = `version 1.4
bridge Query.label {
  with input as i
  with output as o

  o.tier <- i.isPro ? "premium" : "basic"
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes(`? "premium" : "basic"`), `got: ${serialized}`);
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.find((inst) => inst.kind === "bridge")!;
    const condWire = bridge.wires.find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, '"premium"');
  });

  test("expression condition ternary round-trips", () => {
    const text = `version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.age >= 18 ? i.proValue : i.basicValue
}`;
    const instructions = parseBridge(text);
    const serialized = serializeBridge(instructions);
    assert.ok(
      serialized.includes("i.age >= 18 ? i.proValue : i.basicValue"),
      `got: ${serialized}`,
    );
  });
});

// ── Execution tests ───────────────────────────────────────────────────────

const ternaryTypeDefs = /* GraphQL */ `
  type Query {
    pricing(isPro: Boolean!, proPrice: Float!, basicPrice: Float!): PricingResult
    label(isPro: Boolean!): LabelResult
    check(age: Int!): CheckResult
    smartPrice(isPro: Boolean!): SmartPriceResult
    products: [ProductResult!]!
  }
  type PricingResult {
    amount: Float
    discount: Float
  }
  type LabelResult {
    tier: String
  }
  type CheckResult {
    result: Float
    eligible: Boolean
  }
  type SmartPriceResult {
    price: Float
  }
  type ProductResult {
    name: String
    price: Float
  }
`;

describe("ternary: execution — truthy condition", () => {
  test("selects then branch when condition is truthy", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`);
    const gateway = createGateway(ternaryTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ pricing(isPro: true, proPrice: 99.99, basicPrice: 9.99) { amount } }`),
    });
    assert.equal(result.data.pricing.amount, 99.99);
  });

  test("selects else branch when condition is falsy", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.pricing {
  with input as i
  with output as o

  o.amount <- i.isPro ? i.proPrice : i.basicPrice
}`);
    const gateway = createGateway(ternaryTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ pricing(isPro: false, proPrice: 99.99, basicPrice: 9.99) { amount } }`),
    });
    assert.equal(result.data.pricing.amount, 9.99);
  });
});

describe("ternary: execution — literal branches", () => {
  test("string literal then branch", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.label {
  with input as i
  with output as o

  o.tier <- i.isPro ? "premium" : "basic"
}`);
    const gateway = createGateway(ternaryTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const pro: any = await executor({
      document: parse(`{ label(isPro: true) { tier } }`),
    });
    assert.equal(pro.data.label.tier, "premium");

    const basic: any = await executor({
      document: parse(`{ label(isPro: false) { tier } }`),
    });
    assert.equal(basic.data.label.tier, "basic");
  });

  test("numeric literal branches", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.pricing {
  with input as i
  with output as o

  o.discount <- i.isPro ? 20 : 0
}`);
    const gateway = createGateway(ternaryTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const pro: any = await executor({
      document: parse(`{ pricing(isPro: true, proPrice: 1, basicPrice: 1) { discount } }`),
    });
    assert.equal(pro.data.pricing.discount, 20);

    const basic: any = await executor({
      document: parse(`{ pricing(isPro: false, proPrice: 1, basicPrice: 1) { discount } }`),
    });
    assert.equal(basic.data.pricing.discount, 0);
  });
});

describe("ternary: execution — expression condition", () => {
  test("i.age >= 18 ? i.proPrice : i.basicPrice", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.age >= 18 ? i.proPrice : i.basicPrice
}`);
    const checkTypeDefs = /* GraphQL */ `
      type Query {
        check(age: Int!, proPrice: Float!, basicPrice: Float!): CheckResult
      }
      type CheckResult { result: Float }
    `;
    const gateway = createGateway(checkTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const adult: any = await executor({
      document: parse(`{ check(age: 20, proPrice: 99, basicPrice: 9) { result } }`),
    });
    assert.equal(adult.data.check.result, 99);

    const minor: any = await executor({
      document: parse(`{ check(age: 15, proPrice: 99, basicPrice: 9) { result } }`),
    });
    assert.equal(minor.data.check.result, 9);
  });
});

describe("ternary: execution — tool branches (lazy evaluation)", () => {
  test("only the chosen branch tool is called", async () => {
    let proCalls = 0;
    let basicCalls = 0;

    const instructions = parseBridge(`version 1.4
bridge Query.smartPrice {
  with pro.getPrice as proTool
  with basic.getPrice as basicTool
  with input as i
  with output as o

  o.price <- i.isPro ? proTool.price : basicTool.price
}`);
    const tools = {
      "pro.getPrice": async () => {
        proCalls++;
        return { price: 99.99 };
      },
      "basic.getPrice": async () => {
        basicCalls++;
        return { price: 9.99 };
      },
    };
    const gateway = createGateway(ternaryTypeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // When isPro=true: only proTool should be called
    const pro: any = await executor({
      document: parse(`{ smartPrice(isPro: true) { price } }`),
    });
    assert.equal(pro.data.smartPrice.price, 99.99);
    assert.equal(proCalls, 1, "proTool called once");
    assert.equal(basicCalls, 0, "basicTool not called");

    // When isPro=false: only basicTool should be called
    const basic: any = await executor({
      document: parse(`{ smartPrice(isPro: false) { price } }`),
    });
    assert.equal(basic.data.smartPrice.price, 9.99);
    assert.equal(proCalls, 1, "proTool still called only once");
    assert.equal(basicCalls, 1, "basicTool called once");
  });
});

describe("ternary: execution — in array mapping", () => {
  test("ternary works inside array element mapping", async () => {
    const instructions = parseBridge(`version 1.4
bridge Query.products {
  with catalog.list as api
  with output as o

  o <- api.items[] as item {
    .name <- item.name
    .price <- item.isPro ? item.proPrice : item.basicPrice
  }
}`);
    const tools = {
      "catalog.list": async () => ({
        items: [
          { name: "Widget", isPro: true, proPrice: 99, basicPrice: 9 },
          { name: "Gadget", isPro: false, proPrice: 199, basicPrice: 19 },
        ],
      }),
    };
    const gateway = createGateway(ternaryTypeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ products { name price } }`),
    });
    assert.equal(result.data.products[0].name, "Widget");
    assert.equal(result.data.products[0].price, 99, "isPro=true → proPrice");
    assert.equal(result.data.products[1].name, "Gadget");
    assert.equal(result.data.products[1].price, 19, "isPro=false → basicPrice");
  });
});
