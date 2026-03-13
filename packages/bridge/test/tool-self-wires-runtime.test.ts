import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";

regressionTest("tool self-wire runtime", {
  bridge: `
    version 1.5

    const apiUrl = "https://example.com"
    const one = 1
    const base = 10
    const age = 21
    const city = "Berlin"
    const flag = true

    tool constants from test.multitool {
      .greeting = "hello"
      .count = 42
    }

    tool constPull from test.multitool {
      with const
      .url <- const.apiUrl
    }

    tool addExpr from test.multitool {
      with const
      .limit <- const.one + 1
    }

    tool mulExpr from test.multitool {
      with const
      .scaled <- const.base * 5
    }

    tool compareExpr from test.multitool {
      with const
      .eligible <- const.age >= 18
    }

    tool interpolation from test.multitool {
      with const
      .query <- "city={const.city}"
    }

    tool ternaryTool from test.multitool {
      with const
      .method <- const.flag ? "POST" : "GET"
    }

    tool coalesceTool from test.multitool {
      with context
      .timeout <- context.settings.timeout ?? "5000"
    }

    tool geo from test.multitool {
      with const
      .baseUrl = "https://nominatim.openstreetmap.org"
      .path = "/search"
      .format = "json"
      .limit <- const.one + 1
    }

    bridge Query.constants {
      with constants as t
      with output as o

      o.greeting <- t.greeting
      o.count <- t.count
    }

    bridge Query.constPull {
      with constPull as t
      with output as o

      o.url <- t.url
    }

    bridge Query.addExpr {
      with addExpr as t
      with output as o

      o.limit <- t.limit
    }

    bridge Query.mulExpr {
      with mulExpr as t
      with output as o

      o.scaled <- t.scaled
    }

    bridge Query.compareExpr {
      with compareExpr as t
      with output as o

      o.eligible <- t.eligible
    }

    bridge Query.interpolation {
      with interpolation as t
      with output as o

      o.query <- t.query
    }

    bridge Query.ternary {
      with ternaryTool as t
      with output as o

      o.method <- t.method
    }

    bridge Query.coalesce {
      with coalesceTool as t
      with output as o

      o.timeout <- t.timeout
    }

    bridge Query.integration {
      with geo
      with input as i
      with output as o

      geo.q <- i.city
      o.result <- geo
    }
  `,
  tools: tools,
  scenarios: {
    "Query.constants": {
      "constant self-wires pass values to tool": {
        input: {},
        assertData: { greeting: "hello", count: 42 },
        assertTraces: 1,
      },
    },
    "Query.constPull": {
      "pull from const handle passes value to tool": {
        input: {},
        assertData: { url: "https://example.com" },
        assertTraces: 1,
      },
    },
    "Query.addExpr": {
      "expression chain: const + literal produces computed value": {
        input: {},
        assertData: { limit: 2 },
        assertTraces: 1,
      },
    },
    "Query.mulExpr": {
      "expression chain: const * literal produces computed value": {
        input: {},
        assertData: { scaled: 50 },
        assertTraces: 1,
      },
    },
    "Query.compareExpr": {
      "expression chain: comparison operator": {
        input: {},
        assertData: { eligible: true },
        assertTraces: 1,
      },
    },
    "Query.interpolation": {
      "string interpolation in tool self-wire": {
        input: {},
        assertData: { query: "city=Berlin" },
        assertTraces: 1,
      },
    },
    "Query.ternary": {
      "ternary with literal branches": {
        input: {},
        assertData: { method: "POST" },
        assertTraces: 1,
      },
    },
    "Query.coalesce": {
      "nullish coalesce with fallback value": {
        input: {},
        context: { settings: {} },
        assertData: { timeout: "5000" },
        assertTraces: 1,
      },
    },
    "Query.integration": {
      "httpCall-style tool with const + expression": {
        input: { city: "Zurich" },
        assertData: {
          result: {
            baseUrl: "https://nominatim.openstreetmap.org",
            path: "/search",
            format: "json",
            limit: 2,
            q: "Zurich",
          },
        },
        assertTraces: 1,
      },
    },
  },
});
