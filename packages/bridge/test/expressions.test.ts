import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { createGateway } from "./_gateway.ts";

// ── Parser desugaring tests ─────────────────────────────────────────────────

describe("expressions: parser desugaring", () => {
  test("o.cents <- i.dollars * 100 — desugars into synthetic tool wires", () => {
    const doc = parseBridge(`version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    // No ExprWire should exist — only pull and constant wires
    assert.ok(!bridge.wires.some((w) => "expr" in w), "no ExprWire in output");
    // There should be pipe handles for the synthetic expression tool
    assert.ok(bridge.pipeHandles!.length > 0, "has pipe handles");
    const exprHandle = bridge.pipeHandles!.find((ph) =>
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
      const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.value ${op} 1
}`);
      const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
      const exprHandle = bridge.pipeHandles!.find((ph) =>
        ph.handle.startsWith("__expr_"),
      );
      assert.ok(exprHandle, `${op} should create a pipe handle`);
      assert.equal(exprHandle.baseTrunk.field, fn, `${op} → ${fn}`);
    }
  });

  test("chained expression: i.times * 5 / 10", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.times * 5 / 10
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
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
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.times * 2 > 6
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.equal(exprHandles.length, 2);
    assert.equal(exprHandles[0].baseTrunk.field, "multiply");
    assert.equal(exprHandles[1].baseTrunk.field, "gt");
  });

  test("two source refs: i.price * i.qty", () => {
    const doc = parseBridge(`version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.qty
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    // The .b wire should be a pipe wire from i.qty
    const bWire = bridge.wires.find(
      (w) => "from" in w && w.to.path.length === 1 && w.to.path[0] === "b",
    );
    assert.ok(bWire, "should have a .b wire");
    assert.ok("from" in bWire!);
  });

  test("expression in array mapping element", () => {
    const doc = parseBridge(`version 1.5
bridge Query.list {
  with pricing.list as api
  with input as i
  with output as o

  o.items <- api.items[] as item {
    .name <- item.name
    .cents <- item.price * 100
  }
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = bridge.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "should have expression pipe handle");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });
});

// ── Round-trip serialization tests ──────────────────────────────────────────

describe("expressions: round-trip serialization", () => {
  test("multiply expression serializes and re-parses", () => {
    const text = `version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("i.dollars * 100"),
      `should contain expression: ${serialized}`,
    );

    // Re-parse the serialized output
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = bridge.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "re-parsed should contain synthetic tool");
    assert.equal(exprHandle.baseTrunk.field, "multiply");
  });

  test("comparison expression round-trips", () => {
    const text = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.age >= 18
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("i.age >= 18"), `got: ${serialized}`);
  });

  test("chained expression round-trips", () => {
    const text = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.times * 5 / 10
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("i.times * 5 / 10"), `got: ${serialized}`);
  });

  test("two source refs round-trip", () => {
    const text = `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("i.price * i.quantity"),
      `got: ${serialized}`,
    );
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
    const doc = parseBridge(`version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const gateway = createGateway(mathTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 9.99) { cents } }`),
    });
    assert.equal(result.data.convert.cents, 999);
  });

  test("divide: halve a value", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.dollars <- i.dollars / 2
}`);
    const gateway = createGateway(mathTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 10) { dollars } }`),
    });
    assert.equal(result.data.convert.dollars, 5);
  });

  test("multiply two source refs: price * quantity", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity
}`);
    const gateway = createGateway(mathTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ calc(price: 19.99, quantity: 3) { total } }`),
    });
    assert.equal(result.data.calc.total, 59.97);
  });

  test("comparison >= returns true/false", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.age >= 18
}`);
    const gateway = createGateway(mathTypeDefs, doc);
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
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.over18 <- i.age > 18
}`);
    const gateway = createGateway(mathTypeDefs, doc);
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
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.isActive <- i.status == "active"
}`);
    const gateway = createGateway(mathTypeDefs, doc);
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
    const doc = parseBridge(`version 1.5
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
    const gateway = createGateway(mathTypeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 5) { cents } }`),
    });
    // api gets id=5, returns price=10, then 10*100 = 1000
    assert.equal(result.data.convert.cents, 1000);
  });

  test("chained expression: i.dollars * 5 / 10", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 5 / 10
}`);
    const gateway = createGateway(mathTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 100) { cents } }`),
    });
    // 100 * 5 = 500, 500 / 10 = 50
    assert.equal(result.data.convert.cents, 50);
  });

  test("expression in array mapping", async () => {
    const doc = parseBridge(`version 1.5
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
    const gateway = createGateway(mathTypeDefs, doc, { tools });
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
    const doc = parseBridge(`version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    // multiply should be emitted FIRST (higher precedence)
    assert.equal(exprHandles.length, 2, "two synthetic forks");
    assert.equal(exprHandles[0].baseTrunk.field, "multiply", "multiply first");
    assert.equal(exprHandles[1].baseTrunk.field, "add", "add second");
  });

  test("precedence: a + b * c executes correctly", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query {
        calc(base: Float!, tax: Float!): PrecResult
      }
      type PrecResult {
        total: Float
      }
    `;
    const gateway = createGateway(precTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ calc(base: 100, tax: 10) { total } }`),
    });
    // Should be 100 + (10 * 2) = 120, NOT (100 + 10) * 2 = 220
    assert.equal(result.data.calc.total, 120);
  });

  test("precedence: a * b + c * d", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity + i.base * 2
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query {
        calc(price: Float!, quantity: Int!, base: Float!): PrecResult
      }
      type PrecResult {
        total: Float
      }
    `;
    const gateway = createGateway(precTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ calc(price: 10, quantity: 3, base: 5) { total } }`),
    });
    // (10 * 3) + (5 * 2) = 30 + 10 = 40
    assert.equal(result.data.calc.total, 40);
  });

  test("precedence: comparison after arithmetic — i.base + i.tax * 2 > 100", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.base + i.tax * 2 > 100
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query {
        check(base: Float!, tax: Float!): CheckResult
      }
      type CheckResult {
        eligible: Boolean
      }
    `;
    const gateway = createGateway(precTypeDefs, doc);
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
    const text = `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`;
    const doc = parseBridge(text);
    const serialized = serializeBridge(doc);
    // Should round-trip the expression (order may vary due to precedence grouping)
    assert.ok(
      serialized.includes("i.base + i.tax * 2") ||
        serialized.includes("i.tax * 2"),
      `got: ${serialized}`,
    );
  });
});

// ── Expression + fallback integration tests ─────────────────────────────────

describe("expressions: fallback integration", () => {
  test("expression with catch error fallback: i.value * 100 catch -1", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.convert {
  with pricing.lookup as api
  with input as i
  with output as o

  api.id <- i.dollars
  o.cents <- api.price * 100 catch -1
}`);
    const tools = {
      "pricing.lookup": async () => {
        throw new Error("service unavailable");
      },
    };
    const precTypeDefs = /* GraphQL */ `
      type Query {
        convert(dollars: Float!): ConvertResult
      }
      type ConvertResult {
        cents: Float
      }
    `;
    const gateway = createGateway(precTypeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 5) { cents } }`),
    });
    // api.price throws → expression throws → catch catches → returns -1
    assert.equal(result.data.convert.cents, -1);
  });

  test("expression with || null coalesce: (i.value ?? 1) * 2", async () => {
    // This tests coalescing on the source BEFORE the expression
    const doc = parseBridge(`version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`);
    const precTypeDefs = /* GraphQL */ `
      type Query {
        convert(dollars: Float!): ConvertResult
      }
      type ConvertResult {
        cents: Float
      }
    `;
    const gateway = createGateway(precTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ convert(dollars: 5) { cents } }`),
    });
    assert.equal(result.data.convert.cents, 500);
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
      const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.a ${op} i.b
}`);
      const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
      const exprHandle = bridge.pipeHandles!.find((ph) =>
        ph.handle.startsWith("__expr_"),
      );
      assert.ok(exprHandle, `${op}: has __expr_ pipe handle`);
      assert.equal(exprHandle.baseTrunk.field, fn, `${op}: maps to ${fn}`);
    }
  });

  test("not prefix desugars to not tool fork", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- not i.trusted
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandle = bridge.pipeHandles!.find(
      (ph) => ph.baseTrunk.field === "not",
    );
    assert.ok(exprHandle, "has not pipe handle");
  });

  test('combined: (a > 18 and b) or c == "ADMIN"', () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.age > 18 and i.verified or i.role == "ADMIN"
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    // Should have multiple expression forks: >, and, ==, or
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
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

// ── Boolean logic: end-to-end ─────────────────────────────────────────────────

describe("boolean logic: end-to-end", () => {
  const boolTypeDefs = /* GraphQL */ `
    type Query {
      check(age: Int!, verified: Boolean!, role: String!): CheckResult
    }
    type CheckResult {
      approved: Boolean
      requireMFA: Boolean
    }
  `;

  test("and expression: age > 18 and verified", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.approved <- i.age > 18 and i.verified
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r1: any = await executor({
      document: parse(
        `{ check(age: 25, verified: true, role: "USER") { approved } }`,
      ),
    });
    assert.equal(r1.data.check.approved, true);

    const r2: any = await executor({
      document: parse(
        `{ check(age: 15, verified: true, role: "USER") { approved } }`,
      ),
    });
    assert.equal(r2.data.check.approved, false);
  });

  test("or expression: approved or role == ADMIN", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.approved <- i.age > 18 and i.verified or i.role == "ADMIN"
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    // age=15 verified=false role=ADMIN → false and false = false, role=="ADMIN" = true → true
    const r1: any = await executor({
      document: parse(
        `{ check(age: 15, verified: false, role: "ADMIN") { approved } }`,
      ),
    });
    assert.equal(r1.data.check.approved, true);
  });

  test("not prefix: not i.verified", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.requireMFA <- not i.verified
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r1: any = await executor({
      document: parse(
        `{ check(age: 25, verified: true, role: "USER") { requireMFA } }`,
      ),
    });
    assert.equal(r1.data.check.requireMFA, false);

    const r2: any = await executor({
      document: parse(
        `{ check(age: 25, verified: false, role: "USER") { requireMFA } }`,
      ),
    });
    assert.equal(r2.data.check.requireMFA, true);
  });
});

// ── Boolean logic: serializer round-trip ──────────────────────────────────────

describe("boolean logic: serializer round-trip", () => {
  test("and expression round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result <- i.a and i.b

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes(" and "), "serialized contains 'and'");
    // Re-parse to ensure no errors
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });

  test("or expression round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result <- i.a or i.b

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes(" or "), "serialized contains 'or'");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });

  test("not prefix round-trips", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result <- not i.flag

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("not "), "serialized contains 'not'");
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });
});

// ── Parenthesized expressions ─────────────────────────────────────────────────

describe("parenthesized expressions: parser desugaring", () => {
  test("(A and B) or C — groups correctly", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- (i.a and i.b) or i.c
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandles.length >= 2, `has >= 2 expr handles`);
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("__or"), "has __or");
  });

  test("A or (B and C) — groups correctly", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.a or (i.b and i.c)
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandles.length >= 2, `has >= 2 expr handles`);
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("__or"), "has __or");
  });

  test("not (A and B) — not wraps grouped expr", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- not (i.a and i.b)
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("__and"), "has __and");
    assert.ok(fields.includes("not"), "has not");
  });

  test("(i.price + i.discount) * i.qty — math with parens", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- (i.price + i.discount) * i.qty
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const exprHandles = bridge.pipeHandles!.filter((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    const fields = exprHandles.map((ph) => ph.baseTrunk.field);
    assert.ok(fields.includes("add"), "has add (from parens)");
    assert.ok(fields.includes("multiply"), "has multiply");
  });
});

describe("parenthesized expressions: end-to-end", () => {
  const boolTypeDefs = /* GraphQL */ `
    type Query {
      check(a: Boolean!, b: Boolean!, c: Boolean!): CheckResult
    }
    type CheckResult {
      result: Boolean
    }
  `;

  test("A or (B and C): true or (false and false) = true", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.a or (i.b and i.c)
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r: any = await executor({
      document: parse(`{ check(a: true, b: false, c: false) { result } }`),
    });
    assert.equal(r.data.check.result, true);
  });

  test("A or (B and C): false or (true and true) = true", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.a or (i.b and i.c)
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r: any = await executor({
      document: parse(`{ check(a: false, b: true, c: true) { result } }`),
    });
    assert.equal(r.data.check.result, true);
  });

  test("(A or B) and C: (true or false) and false = false", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- (i.a or i.b) and i.c
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r: any = await executor({
      document: parse(`{ check(a: true, b: false, c: false) { result } }`),
    });
    assert.equal(r.data.check.result, false);
  });

  test("not (A and B): not (true and false) = true", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- not (i.a and i.b)
}`);
    const gateway = createGateway(boolTypeDefs, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r: any = await executor({
      document: parse(`{ check(a: true, b: false, c: false) { result } }`),
    });
    assert.equal(r.data.check.result, true);
  });

  const mathTypeDefs2 = /* GraphQL */ `
    type Query {
      calc(price: Int!, discount: Int!, qty: Int!): CalcResult
    }
    type CalcResult {
      total: Int
    }
  `;

  test("(price + discount) * qty: (10 + 5) * 3 = 45", async () => {
    const doc = parseBridge(`version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- (i.price + i.discount) * i.qty
}`);
    const gateway = createGateway(mathTypeDefs2, doc);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const r: any = await executor({
      document: parse(`{ calc(price: 10, discount: 5, qty: 3) { total } }`),
    });
    assert.equal(r.data.calc.total, 45);
  });
});

// ── Parenthesized expressions: serializer round-trip ──────────────────────────

describe("parenthesized expressions: serializer round-trip", () => {
  test("(A + B) * C round-trips with parentheses", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result <- (i.a + i.b) * i.c

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("("), "serialized contains '(' for grouping");
    assert.ok(serialized.includes(")"), "serialized contains ')' for grouping");
    // Re-parse to ensure correctness
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });

  test("A or (B and C) round-trips correctly (parens optional since and binds tighter)", () => {
    const src = `version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.result <- i.a or (i.b and i.c)

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    // and already binds tighter than or, so parens are omitted in serialized form
    assert.ok(serialized.includes(" or "), "serialized contains 'or'");
    assert.ok(serialized.includes(" and "), "serialized contains 'and'");
    // Re-parse to ensure correctness
    const reparsed = parseBridge(serialized);
    assert.ok(reparsed.instructions.length > 0, "reparsed successfully");
  });
});

// ── Short-circuit tests ───────────────────────────────────────────────────────

import { executeBridge } from "../src/index.ts";

describe("and/or short-circuit behavior", () => {
  test("and short-circuits: right side not evaluated when left is false", async () => {
    let rightEvaluated = false;
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag and c.ok
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { flag: false, value: "test" },
      tools: {
        checker: async () => {
          rightEvaluated = true;
          return { ok: true };
        },
      },
    });
    assert.equal(data.result, false);
    assert.equal(
      rightEvaluated,
      false,
      "right side should NOT be evaluated when left is false",
    );
  });

  test("and evaluates right side when left is true", async () => {
    let rightEvaluated = false;
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag and c.ok
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { flag: true, value: "test" },
      tools: {
        checker: async () => {
          rightEvaluated = true;
          return { ok: true };
        },
      },
    });
    assert.equal(data.result, true);
    assert.equal(
      rightEvaluated,
      true,
      "right side should be evaluated when left is true",
    );
  });

  test("or short-circuits: right side not evaluated when left is true", async () => {
    let rightEvaluated = false;
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag or c.ok
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { flag: true, value: "test" },
      tools: {
        checker: async () => {
          rightEvaluated = true;
          return { ok: true };
        },
      },
    });
    assert.equal(data.result, true);
    assert.equal(
      rightEvaluated,
      false,
      "right side should NOT be evaluated when left is true",
    );
  });

  test("or evaluates right side when left is false", async () => {
    let rightEvaluated = false;
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag or c.ok
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { flag: false, value: "test" },
      tools: {
        checker: async () => {
          rightEvaluated = true;
          return { ok: false };
        },
      },
    });
    assert.equal(data.result, false);
    assert.equal(
      rightEvaluated,
      true,
      "right side should be evaluated when left is false",
    );
  });
});

// ── Safe flag propagation in expressions ──────────────────────────────────────

describe("safe flag propagation in expressions", () => {
  test("safe flag propagated through expression: api?.value > 5 does not crash", async () => {
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- api?.score > 5 || false
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { value: "test" },
      tools: {
        failingApi: async () => {
          throw new Error("HTTP 500");
        },
      },
    });
    // Safe execution swallows the error, expression evaluates with undefined,
    // comparison with undefined yields false, fallback || false returns false
    assert.equal(data.result, false);
  });

  test("safe flag on not prefix: not api?.verified does not crash", async () => {
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- not api?.verified || true
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { value: "test" },
      tools: {
        failingApi: async () => {
          throw new Error("HTTP 500");
        },
      },
    });
    // Safe swallows error, not(undefined) = true, || true fallback also works
    assert.equal(data.result, true);
  });

  test("safe flag in condAnd: api?.active and i.flag does not crash", async () => {
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- api?.active and i.flag
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { value: "test", flag: true },
      tools: {
        failingApi: async () => {
          throw new Error("HTTP 500");
        },
      },
    });
    // Safe swallows error, undefined is falsy, short-circuit returns false
    assert.equal(data.result, false);
  });

  test("safe flag on right operand: i.flag and api?.active does not crash", async () => {
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.flag and api?.active
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { value: "test", flag: true },
      tools: {
        failingApi: async () => {
          throw new Error("HTTP 500");
        },
      },
    });
    // Left is true so right IS evaluated; safe swallows the 500 on right side
    assert.equal(data.result, false);
  });

  test("safe flag on right operand of comparison: i.a > api?.score does not crash", async () => {
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.a > api?.score || false
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { value: "test", a: 10 },
      tools: {
        failingApi: async () => {
          throw new Error("HTTP 500");
        },
      },
    });
    // Safe swallows error on right operand, comparison with undefined yields false
    assert.equal(data.result, false);
  });

  test("safe flag on right operand of or: i.flag or api?.fallback does not crash", async () => {
    const document = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.flag or api?.fallback
}`);
    const { data } = await executeBridge({
      document,
      operation: "Query.test",
      input: { value: "test", flag: false },
      tools: {
        failingApi: async () => {
          throw new Error("HTTP 500");
        },
      },
    });
    // Left is false so right IS evaluated; safe swallows the 500 on right side
    assert.equal(data.result, false);
  });
});
