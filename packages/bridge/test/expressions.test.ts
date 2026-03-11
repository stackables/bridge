import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./utils/dual-run.ts";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";

// ── Execution tests (regressionTest) ────────────────────────────────────────

regressionTest("expressions: execution", {
  bridge: `
    version 1.5

    bridge Query.multiply {
      with input as i
      with output as o

      o.cents <- i.dollars * 100
    }

    bridge Query.divide {
      with input as i
      with output as o

      o.dollars <- i.dollars / 2
    }

    bridge Query.multiplyRefs {
      with input as i
      with output as o

      o.total <- i.price * i.quantity
    }

    bridge Query.compareGte {
      with input as i
      with output as o

      o.eligible <- i.age >= 18
    }

    bridge Query.compareGt {
      with input as i
      with output as o

      o.over18 <- i.age > 18
    }

    bridge Query.toolExpr {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.cents <- api.price * 100
    }

    bridge Query.chainedExpr {
      with input as i
      with output as o

      o.cents <- i.dollars * 5 / 10
    }

    bridge Query.boolNot {
      with input as i
      with output as o

      o.requireMFA <- not i.verified
    }

    bridge Query.parenArith {
      with input as i
      with output as o

      o.total <- (i.price + i.discount) * i.qty
    }
  `,
  tools: tools,
  scenarios: {
    "Query.multiply": {
      "multiply: dollars to cents": {
        input: { dollars: 9.99 },
        assertData: { cents: 999 },
        assertTraces: 0,
      },
      "expression with input source works normally": {
        input: { dollars: 5 },
        assertData: { cents: 500 },
        assertTraces: 0,
      },
    },
    "Query.divide": {
      "divide: halve a value": {
        input: { dollars: 10 },
        assertData: { dollars: 5 },
        assertTraces: 0,
      },
    },
    "Query.multiplyRefs": {
      "multiply two source refs: price * quantity": {
        input: { price: 19.99, quantity: 3 },
        assertData: { total: 59.97 },
        assertTraces: 0,
      },
    },
    "Query.compareGte": {
      "comparison >= returns true (age 18)": {
        input: { age: 18 },
        assertData: { eligible: true },
        assertTraces: 0,
      },
      "comparison >= returns false (age 17)": {
        input: { age: 17 },
        assertData: { eligible: false },
        assertTraces: 0,
      },
    },
    "Query.compareGt": {
      "comparison > returns false (age 18)": {
        input: { age: 18 },
        assertData: { over18: false },
        assertTraces: 0,
      },
      "comparison > returns true (age 19)": {
        input: { age: 19 },
        assertData: { over18: true },
        assertTraces: 0,
      },
    },
    "Query.toolExpr": {
      "expression with tool source": {
        input: { api: { price: 10 } },
        assertData: { cents: 1000 },
        assertTraces: 1,
      },
    },
    "Query.chainedExpr": {
      "chained expression: i.dollars * 5 / 10": {
        input: { dollars: 100 },
        assertData: { cents: 50 },
        assertTraces: 0,
      },
    },
    "Query.boolNot": {
      "not prefix: not i.verified — false": {
        input: { age: 25, verified: true, role: "USER" },
        assertData: { requireMFA: false },
        assertTraces: 0,
      },
      "not prefix: not i.verified — true": {
        input: { age: 25, verified: false, role: "USER" },
        assertData: { requireMFA: true },
        assertTraces: 0,
      },
    },
    "Query.parenArith": {
      "(price + discount) * qty: (10 + 5) * 3 = 45": {
        input: { price: 10, discount: 5, qty: 3 },
        assertData: { total: 45 },
        assertTraces: 0,
      },
    },
  },
});

// ── Operator precedence tests (regressionTest) ──────────────────────────────

regressionTest("expressions: operator precedence", {
  bridge: `
    version 1.5

    bridge Query.addMul {
      with input as i
      with output as o

      o.total <- i.base + i.tax * 2
    }

    bridge Query.mulAddMul {
      with input as i
      with output as o

      o.total <- i.price * i.quantity + i.base * 2
    }

    bridge Query.cmpAfterArith {
      with input as i
      with output as o

      o.eligible <- i.base + i.tax * 2 > 100
    }
  `,
  scenarios: {
    "Query.addMul": {
      "precedence: a + b * c executes correctly": {
        input: { base: 100, tax: 10 },
        assertData: { total: 120 },
        assertTraces: 0,
      },
    },
    "Query.mulAddMul": {
      "precedence: a * b + c * d": {
        input: { price: 10, quantity: 3, base: 5 },
        assertData: { total: 40 },
        assertTraces: 0,
      },
    },
    "Query.cmpAfterArith": {
      "precedence: comparison after arithmetic — true": {
        input: { base: 100, tax: 10 },
        assertData: { eligible: true },
        assertTraces: 0,
      },
      "precedence: comparison after arithmetic — false": {
        input: { base: 50, tax: 10 },
        assertData: { eligible: false },
        assertTraces: 0,
      },
    },
  },
});

// ── Safe flag propagation in expressions (regressionTest) ───────────────────

regressionTest("safe flag propagation in expressions", {
  bridge: `
    version 1.5

    bridge Query.safeCompare {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.result <- api?.score > 5 || false
    }

    bridge Query.safeNot {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.result <- not api?.verified || true
    }

    bridge Query.safeCondAndLeft {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.result <- api?.active and i.flag
    }

    bridge Query.safeCompareRight {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.result <- i.a > api?.score || false
    }

    bridge Query.syncSafeOr {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o.result <- api?.score > 5 or false
    }
  `,
  tools: tools,
  scenarios: {
    "Query.safeCompare": {
      "safe flag propagated through expression: api?.value > 5 does not crash": {
        input: { api: { _error: "HTTP 500" } },
        assertData: { result: false },
        allowDowngrade: true,
        assertTraces: 1,
      },
      "api succeeds: score > 5": {
        input: { api: { score: 10 } },
        assertData: { result: true },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.safeNot": {
      "safe flag on not prefix: not api?.verified does not crash": {
        input: { api: { _error: "HTTP 500" } },
        assertData: { result: true },
        allowDowngrade: true,
        assertTraces: 1,
      },
      "not api?.verified — fallback fires when result is false": {
        input: { api: { verified: true } },
        assertData: { result: true },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.safeCondAndLeft": {
      "safe flag in condAnd: api?.active and i.flag does not crash": {
        input: { api: { _error: "HTTP 500" }, flag: true },
        assertData: { result: false },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.safeCompareRight": {
      "safe flag on right operand of comparison: i.a > api?.score does not crash": {
        input: { api: { _error: "HTTP 500" }, a: 10 },
        assertData: { result: false },
        allowDowngrade: true,
        assertTraces: 1,
      },
      "api succeeds: i.a > api.score": {
        input: { api: { score: 5 }, a: 10 },
        assertData: { result: true },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.syncSafeOr": {
      "safe navigation with sync tool: api?.score > 5 or false": {
        input: { api: { _error: "sync failure" } },
        assertData: { result: false },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
  },
});

// ── Tests that cannot be migrated to regressionTest ─────────────────────────
// (compiler generates broken code for and/or without ?., serializer bugs)

forEachEngine(
  "expressions: string comparison and array mapping",
  (run) => {
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
  },
);

forEachEngine(
  "expressions: catch error fallback",
  (run, { engine }) => {
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
  },
);

forEachEngine("boolean logic: and/or end-to-end", (run, { engine }) => {
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
});

forEachEngine(
  "parenthesized boolean expressions: end-to-end",
  (run, { engine }) => {
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
  },
);

forEachEngine(
  "condAnd / condOr with synchronous tools",
  (run, { engine }) => {
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
  },
);

forEachEngine(
  "safe flag on right operand expressions",
  (run, { engine }) => {
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
  },
);
