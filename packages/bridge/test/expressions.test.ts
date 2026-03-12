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
      "safe flag propagated through expression: api?.value > 5 does not crash":
        {
          input: { api: { _error: "HTTP 500" } },
          assertData: { result: false },
          assertTraces: 1,
        },
      "api succeeds: score > 5": {
        input: { api: { score: 10 } },
        assertData: { result: true },
        assertTraces: 1,
      },
    },
    "Query.safeNot": {
      "safe flag on not prefix: not api?.verified does not crash": {
        input: { api: { _error: "HTTP 500" } },
        assertData: { result: true },
        assertTraces: 1,
      },
      "not api?.verified — fallback fires when result is false": {
        input: { api: { verified: true } },
        assertData: { result: true },
        assertTraces: 1,
      },
    },
    "Query.safeCondAndLeft": {
      "safe flag in condAnd: api?.active and i.flag does not crash": {
        input: { api: { _error: "HTTP 500" }, flag: true },
        assertData: { result: false },
        assertTraces: 1,
      },
    },
    "Query.safeCompareRight": {
      "safe flag on right operand of comparison: i.a > api?.score does not crash":
        {
          input: { api: { _error: "HTTP 500" }, a: 10 },
          assertData: { result: false },
          assertTraces: 1,
        },
      "api succeeds: i.a > api.score": {
        input: { api: { score: 5 }, a: 10 },
        assertData: { result: true },
        assertTraces: 1,
      },
    },
    "Query.syncSafeOr": {
      "safe navigation with sync tool: api?.score > 5 or false": {
        input: { api: { _error: "sync failure" } },
        assertData: { result: false },
        assertTraces: 1,
      },
    },
  },
});

// ── String comparison and array mapping ─────────────────────────────────────

regressionTest("expressions: string comparison and array mapping", {
  bridge: `
    version 1.5

    bridge Query.check {
      with input as i
      with output as o

      o.isActive <- i.status == "active"
    }

    bridge Query.products {
      with pricing.list as api
      with output as o

      o <- api.items[] as item {
        .name <- item.name
        .cents <- item.price * 100
      }
    }
  `,
  tools: {
    "pricing.list": async () => ({
      items: [
        { name: "Widget", price: 9.99 },
        { name: "Gadget", price: 24.5 },
      ],
    }),
  },
  scenarios: {
    "Query.check": {
      "comparison == with string returns true": {
        input: { status: "active" },
        assertData: { isActive: true },
        assertTraces: 0,
      },
      "comparison == with string returns false": {
        input: { status: "inactive" },
        assertData: { isActive: false },
        assertTraces: 0,
      },
    },
    "Query.products": {
      "expression in array mapping": {
        input: {},
        assertData: [
          { name: "Widget", cents: 999 },
          { name: "Gadget", cents: 2450 },
        ],
        assertTraces: 1,
      },
      "empty items array": {
        input: {},
        tools: {
          "pricing.list": async () => ({ items: [] }),
        },
        assertData: [],
        assertTraces: 1,
      },
    },
  },
});

// ── Catch error fallback ────────────────────────────────────────────────────

regressionTest("expressions: catch error fallback", {
  bridge: `
    version 1.5

    bridge Query.convert {
      with pricing.lookup as api
      with input as i
      with output as o

      api.id <- i.dollars
      o.cents <- api.price * 100 catch -1
    }
  `,
  tools: {
    "pricing.lookup": async () => {
      throw new Error("service unavailable");
    },
  },
  scenarios: {
    "Query.convert": {
      "expression with catch error fallback: api.price * 100 catch -1": {
        input: { dollars: 5 },
        assertData: { cents: -1 },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
  },
});

// ── Boolean logic: and/or ───────────────────────────────────────────────────

regressionTest("boolean logic: and/or end-to-end", {
  bridge: `
    version 1.5

    bridge Query.andExpr {
      with input as i
      with output as o

      o.approved <- i.age > 18 and i.verified
    }

    bridge Query.orExpr {
      with input as i
      with output as o

      o.approved <- i.age > 18 and i.verified or i.role == "ADMIN"
    }
  `,
  scenarios: {
    "Query.andExpr": {
      "and expression: age > 18 and verified — true": {
        input: { age: 25, verified: true, role: "USER" },
        assertData: { approved: true },
        assertTraces: 0,
      },
      "and expression: age > 18 and verified — false (age too low)": {
        input: { age: 15, verified: true, role: "USER" },
        assertData: { approved: false },
        assertTraces: 0,
      },
    },
    "Query.orExpr": {
      "or expression: approved or role == ADMIN": {
        input: { age: 15, verified: false, role: "ADMIN" },
        assertData: { approved: true },
        assertTraces: 0,
      },
    },
  },
});

// ── Parenthesized boolean expressions ───────────────────────────────────────

regressionTest("parenthesized boolean expressions: end-to-end", {
  bridge: `
    version 1.5

    bridge Query.aOrBandC {
      with input as i
      with output as o

      o.result <- i.a or (i.b and i.c)
    }

    bridge Query.aOrBandC2 {
      with input as i
      with output as o

      o.result <- (i.a or i.b) and i.c
    }

    bridge Query.notParen {
      with input as i
      with output as o

      o.result <- not (i.a and i.b)
    }
  `,
  scenarios: {
    "Query.aOrBandC": {
      "A or (B and C): true or (false and false) = true": {
        input: { a: true, b: false, c: false },
        assertData: { result: true },
        assertTraces: 0,
      },
      "A or (B and C): false or (true and true) = true": {
        input: { a: false, b: true, c: true },
        assertData: { result: true },
        assertTraces: 0,
      },
    },
    "Query.aOrBandC2": {
      "(A or B) and C: (true or false) and false = false": {
        input: { a: true, b: false, c: false },
        assertData: { result: false },
        assertTraces: 0,
      },
    },
    "Query.notParen": {
      "not (A and B): not (true and false) = true": {
        input: { a: true, b: false },
        assertData: { result: true },
        assertTraces: 0,
      },
    },
  },
});

// ── condAnd / condOr with synchronous tools ─────────────────────────────────

regressionTest("condAnd / condOr with synchronous tools", {
  bridge: `
    version 1.5

    bridge Query.syncAnd {
      with api
      with input as i
      with output as o

      api.x <- i.x
      o.result <- api.score > 5 and api.active
    }

    bridge Query.syncOr {
      with api
      with input as i
      with output as o

      api.x <- i.x
      o.result <- api.score > 100 or api.active
    }

    bridge Query.syncAndShort {
      with api
      with input as i
      with output as o

      api.x <- i.x
      o.result <- api.score > 100 and api.active
    }
  `,
  tools: {
    api: () => ({ score: 10, active: true }),
  },
  scenarios: {
    "Query.syncAnd": {
      "and expression with sync tools resolves correctly": {
        input: { x: 1 },
        assertData: { result: true },
        assertTraces: 1,
      },
    },
    "Query.syncOr": {
      "or expression with sync tools resolves correctly": {
        input: { x: 1 },
        assertData: { result: true },
        assertTraces: 1,
      },
    },
    "Query.syncAndShort": {
      "and short-circuits: false and sync-tool is false": {
        input: { x: 1 },
        assertData: { result: false },
        assertTraces: 1,
      },
    },
  },
});

// ── Safe flag on right operand expressions ──────────────────────────────────

regressionTest("safe flag on right operand expressions", {
  bridge: `
    version 1.5

    bridge Query.safeRightAnd {
      with input as i
      with failingApi as api
      with output as o

      api.in <- i.value
      o.result <- i.flag and api?.active
    }

    bridge Query.safeRightOr {
      with input as i
      with failingApi as api
      with output as o

      api.in <- i.value
      o.result <- i.flag or api?.fallback
    }
  `,
  tools: {
    failingApi: async () => {
      throw new Error("HTTP 500");
    },
  },
  scenarios: {
    "Query.safeRightAnd": {
      "safe flag on right operand: i.flag and api?.active does not crash": {
        input: { value: "test", flag: true },
        assertData: { result: false },
        assertTraces: 1,
      },
    },
    "Query.safeRightOr": {
      "safe flag on right operand of or: i.flag or api?.fallback does not crash":
        {
          input: { value: "test", flag: false },
          assertData: { result: false },
          assertTraces: 1,
        },
    },
  },
});
