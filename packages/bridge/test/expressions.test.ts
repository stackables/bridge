import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./utils/dual-run.ts";

// ── Execution tests ─────────────────────────────────────────────────────────

forEachEngine("expressions: execution", (run) => {
  test("multiply: dollars to cents", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`,
      "Query.convert",
      { dollars: 9.99 },
      {},
    );
    assert.equal(data.cents, 999);
  });

  test("divide: halve a value", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.dollars <- i.dollars / 2
}`,
      "Query.convert",
      { dollars: 10 },
      {},
    );
    assert.equal(data.dollars, 5);
  });

  test("multiply two source refs: price * quantity", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity
}`,
      "Query.calc",
      { price: 19.99, quantity: 3 },
      {},
    );
    assert.equal(data.total, 59.97);
  });

  test("comparison >= returns true/false", async () => {
    const bridgeText = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.age >= 18
}`;
    const r18 = await run(bridgeText, "Query.check", { age: 18 }, {});
    assert.equal(r18.data.eligible, true);

    const r17 = await run(bridgeText, "Query.check", { age: 17 }, {});
    assert.equal(r17.data.eligible, false);
  });

  test("comparison > returns true/false", async () => {
    const bridgeText = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.over18 <- i.age > 18
}`;
    const r18 = await run(bridgeText, "Query.check", { age: 18 }, {});
    assert.equal(r18.data.over18, false);

    const r19 = await run(bridgeText, "Query.check", { age: 19 }, {});
    assert.equal(r19.data.over18, true);
  });

  test("comparison == with string returns true/false", async () => {
    const bridgeText = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.isActive <- i.status == "active"
}`;
    const rActive = await run(
      bridgeText,
      "Query.check",
      { status: "active" },
      {},
    );
    assert.equal(rActive.data.isActive, true);

    const rInactive = await run(
      bridgeText,
      "Query.check",
      { status: "inactive" },
      {},
    );
    assert.equal(rInactive.data.isActive, false);
  });

  test("expression with tool source", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.convert {
  with pricing.lookup as api
  with input as i
  with output as o

  api.id <- i.dollars
  o.cents <- api.price * 100
}`,
      "Query.convert",
      { dollars: 5 },
      {
        "pricing.lookup": async (input: { id: number }) => ({
          price: input.id * 2,
        }),
      },
    );
    // api gets id=5, returns price=10, then 10*100 = 1000
    assert.equal(data.cents, 1000);
  });

  test("chained expression: i.dollars * 5 / 10", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 5 / 10
}`,
      "Query.convert",
      { dollars: 100 },
      {},
    );
    // 100 * 5 = 500, 500 / 10 = 50
    assert.equal(data.cents, 50);
  });

  test("expression in array mapping", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.products {
  with pricing.list as api
  with output as o

  o <- api.items[] as item {
    .name <- item.name
    .cents <- item.price * 100
  }
}`,
      "Query.products",
      {},
      {
        "pricing.list": async () => ({
          items: [
            { name: "Widget", price: 9.99 },
            { name: "Gadget", price: 24.5 },
          ],
        }),
      },
    );
    assert.equal(data[0].name, "Widget");
    assert.equal(data[0].cents, 999);
    assert.equal(data[1].name, "Gadget");
    assert.equal(data[1].cents, 2450);
  });
});

// ── Operator precedence tests ─────────────────────────────────────────────

forEachEngine("expressions: operator precedence", (run) => {
  test("precedence: a + b * c executes correctly", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.base + i.tax * 2
}`,
      "Query.calc",
      { base: 100, tax: 10 },
      {},
    );
    // Should be 100 + (10 * 2) = 120, NOT (100 + 10) * 2 = 220
    assert.equal(data.total, 120);
  });

  test("precedence: a * b + c * d", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.quantity + i.base * 2
}`,
      "Query.calc",
      { price: 10, quantity: 3, base: 5 },
      {},
    );
    // (10 * 3) + (5 * 2) = 30 + 10 = 40
    assert.equal(data.total, 40);
  });

  test("precedence: comparison after arithmetic — i.base + i.tax * 2 > 100", async () => {
    const bridgeText = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.eligible <- i.base + i.tax * 2 > 100
}`;

    // 100 + (10 * 2) = 120 > 100 → true
    const r1 = await run(bridgeText, "Query.check", { base: 100, tax: 10 }, {});
    assert.equal(r1.data.eligible, true);

    // 50 + (10 * 2) = 70 > 100 → false
    const r2 = await run(bridgeText, "Query.check", { base: 50, tax: 10 }, {});
    assert.equal(r2.data.eligible, false);
  });
});

// ── Expression + fallback integration tests ─────────────────────────────────

forEachEngine("expressions: fallback integration", (run, { engine }) => {
  test(
    "expression with catch error fallback: api.price * 100 catch -1",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.convert {
  with pricing.lookup as api
  with input as i
  with output as o

  api.id <- i.dollars
  o.cents <- api.price * 100 catch -1
}`,
        "Query.convert",
        { dollars: 5 },
        {
          "pricing.lookup": async () => {
            throw new Error("service unavailable");
          },
        },
      );
      assert.equal(data.cents, -1);
    },
  );

  test("expression with input source works normally", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.convert {
  with input as i
  with output as o

  o.cents <- i.dollars * 100
}`,
      "Query.convert",
      { dollars: 5 },
      {},
    );
    assert.equal(data.cents, 500);
  });
});

// ── Boolean logic: end-to-end ─────────────────────────────────────────────────

forEachEngine("boolean logic: end-to-end", (run, { engine }) => {
  test(
    "and expression: age > 18 and verified",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.approved <- i.age > 18 and i.verified
}`;
      const r1 = await run(
        bridgeText,
        "Query.check",
        { age: 25, verified: true, role: "USER" },
        {},
      );
      assert.equal(r1.data.approved, true);

      const r2 = await run(
        bridgeText,
        "Query.check",
        { age: 15, verified: true, role: "USER" },
        {},
      );
      assert.equal(r2.data.approved, false);
    },
  );

  test(
    "or expression: approved or role == ADMIN",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.approved <- i.age > 18 and i.verified or i.role == "ADMIN"
}`,
        "Query.check",
        { age: 15, verified: false, role: "ADMIN" },
        {},
      );
      assert.equal(data.approved, true);
    },
  );

  test(
    "not prefix: not i.verified",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.requireMFA <- not i.verified
}`;
      const r1 = await run(
        bridgeText,
        "Query.check",
        { age: 25, verified: true, role: "USER" },
        {},
      );
      assert.equal(r1.data.requireMFA, false);

      const r2 = await run(
        bridgeText,
        "Query.check",
        { age: 25, verified: false, role: "USER" },
        {},
      );
      assert.equal(r2.data.requireMFA, true);
    },
  );
});

// ── Parenthesized expressions: end-to-end ─────────────────────────────────────

forEachEngine("parenthesized expressions: end-to-end", (run, { engine }) => {
  test(
    "A or (B and C): true or (false and false) = true",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.a or (i.b and i.c)
}`,
        "Query.check",
        { a: true, b: false, c: false },
        {},
      );
      assert.equal(data.result, true);
    },
  );

  test(
    "A or (B and C): false or (true and true) = true",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- i.a or (i.b and i.c)
}`,
        "Query.check",
        { a: false, b: true, c: true },
        {},
      );
      assert.equal(data.result, true);
    },
  );

  test(
    "(A or B) and C: (true or false) and false = false",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- (i.a or i.b) and i.c
}`,
        "Query.check",
        { a: true, b: false, c: false },
        {},
      );
      assert.equal(data.result, false);
    },
  );

  test(
    "not (A and B): not (true and false) = true",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.result <- not (i.a and i.b)
}`,
        "Query.check",
        { a: true, b: false, c: false },
        {},
      );
      assert.equal(data.result, true);
    },
  );

  test("(price + discount) * qty: (10 + 5) * 3 = 45", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- (i.price + i.discount) * i.qty
}`,
      "Query.calc",
      { price: 10, discount: 5, qty: 3 },
      {},
    );
    assert.equal(data.total, 45);
  });
});

// ── Short-circuit tests ───────────────────────────────────────────────────────

forEachEngine("and/or short-circuit behavior", (run, { engine }) => {
  test(
    "and short-circuits: right side not evaluated when left is false",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag and c.ok
}`,
        "Query.test",
        { flag: false, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: true };
          },
        },
      );
      assert.equal(data.result, false);
      assert.equal(
        rightEvaluated,
        false,
        "right side should NOT be evaluated when left is false",
      );
    },
  );

  test(
    "and evaluates right side when left is true",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag and c.ok
}`,
        "Query.test",
        { flag: true, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: true };
          },
        },
      );
      assert.equal(data.result, true);
      assert.equal(
        rightEvaluated,
        true,
        "right side should be evaluated when left is true",
      );
    },
  );

  test(
    "or short-circuits: right side not evaluated when left is true",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag or c.ok
}`,
        "Query.test",
        { flag: true, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: true };
          },
        },
      );
      assert.equal(data.result, true);
      assert.equal(
        rightEvaluated,
        false,
        "right side should NOT be evaluated when left is true",
      );
    },
  );

  test(
    "or evaluates right side when left is false",
    { skip: engine === "compiled" },
    async () => {
      let rightEvaluated = false;
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with checker as c
  with output as o

  c.in <- i.value
  o.result <- i.flag or c.ok
}`,
        "Query.test",
        { flag: false, value: "test" },
        {
          checker: async () => {
            rightEvaluated = true;
            return { ok: false };
          },
        },
      );
      assert.equal(data.result, false);
      assert.equal(
        rightEvaluated,
        true,
        "right side should be evaluated when left is false",
      );
    },
  );
});

// ── Safe flag propagation in expressions ──────────────────────────────────────

forEachEngine("safe flag propagation in expressions", (run, { engine }) => {
  test(
    "safe flag propagated through expression: api?.value > 5 does not crash",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- api?.score > 5 || false
}`,
        "Query.test",
        { value: "test" },
        {
          failingApi: async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.result, false);
    },
  );

  test(
    "safe flag on not prefix: not api?.verified does not crash",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- not api?.verified || true
}`,
        "Query.test",
        { value: "test" },
        {
          failingApi: async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.result, true);
    },
  );

  test(
    "safe flag in condAnd: api?.active and i.flag does not crash",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- api?.active and i.flag
}`,
        "Query.test",
        { value: "test", flag: true },
        {
          failingApi: async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.result, false);
    },
  );

  test(
    "safe flag on right operand: i.flag and api?.active does not crash",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.flag and api?.active
}`,
        "Query.test",
        { value: "test", flag: true },
        {
          failingApi: async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.result, false);
    },
  );

  test(
    "safe flag on right operand of comparison: i.a > api?.score does not crash",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.a > api?.score || false
}`,
        "Query.test",
        { value: "test", a: 10 },
        {
          failingApi: async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.result, false);
    },
  );

  test(
    "safe flag on right operand of or: i.flag or api?.fallback does not crash",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with input as i
  with failingApi as api
  with output as o

  api.in <- i.value
  o.result <- i.flag or api?.fallback
}`,
        "Query.test",
        { value: "test", flag: false },
        {
          failingApi: async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.result, false);
    },
  );
});

// ── Sync tool fast path for condAnd / condOr ────────────────────────────────

forEachEngine("condAnd / condOr with synchronous tools", (run, { engine }) => {
  test(
    "and expression with sync tools resolves correctly",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o

  api.x <- i.x
  o.result <- api.score > 5 and api.active
}`,
        "Query.test",
        { x: 1 },
        {
          api: (_p: any) => ({ score: 10, active: true }),
        },
      );
      assert.equal(data.result, true);
    },
  );

  test(
    "or expression with sync tools resolves correctly",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o

  api.x <- i.x
  o.result <- api.score > 100 or api.active
}`,
        "Query.test",
        { x: 1 },
        {
          api: (_p: any) => ({ score: 10, active: true }),
        },
      );
      assert.equal(data.result, true);
    },
  );

  test(
    "and short-circuits: false and sync-tool is false",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o

  api.x <- i.x
  o.result <- api.score > 100 and api.active
}`,
        "Query.test",
        { x: 1 },
        {
          api: (_p: any) => ({ score: 10, active: true }),
        },
      );
      assert.equal(data.result, false);
    },
  );

  test(
    "safe navigation with sync tool: api?.score > 5 or false",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.test {
  with failApi as api
  with input as i
  with output as o

  api.x <- i.x
  o.result <- api?.score > 5 or false
}`,
        "Query.test",
        { x: 1 },
        {
          failApi: () => {
            throw new Error("sync failure");
          },
        },
      );
      assert.equal(data.result, false);
    },
  );
});
