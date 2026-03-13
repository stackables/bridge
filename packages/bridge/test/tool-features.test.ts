import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Tool features — extends chains, context pull, tool-to-tool dependencies,
// pipe operator (basic, forked, named input), pipe with ToolDef params.
//
// Migrated from legacy/tool-features.test.ts
//
// NOTE: Parser-only / serializer round-trip tests have been moved to
// packages/bridge-parser/test/pipe-parser.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Missing tool ─────────────────────────────────────────────────────────

regressionTest("tool features: missing tool", {
  bridge: `
    version 1.5

    bridge Query.missing {
      with nonExistentTool as nt
      with input as i
      with output as o

      nt.q <- i.q
      o.result <- nt.data
    }
  `,
  scenarios: {
    "Query.missing": {
      "throws when tool is not registered": {
        input: { q: "hello" },
        assertError: /nonExistentTool/,
        assertTraces: 0,
      },
    },
  },
});

// ── 2. Extends chain ────────────────────────────────────────────────────────

regressionTest("tool features: extends chain", {
  bridge: `
    version 1.5

    tool parentTool from baseFn {
      .mode = "parent"
      .timeout = 5000
    }

    tool childTool from parentTool {
      .mode = "child"
    }

    bridge Query.extendsInherit {
      with childTool as ct
      with output as o

      o <- ct
    }

    bridge Query.extendsOverride {
      with childTool as ct
      with output as o

      ct.mode = "bridge-override"
      o <- ct
    }
  `,
  scenarios: {
    "Query.extendsInherit": {
      "child inherits parent wires": {
        input: {},
        tools: {
          baseFn: (p: any) => ({
            mode: p.mode,
            timeout: p.timeout,
          }),
        },
        assertData: { mode: "child", timeout: 5000 },
        assertTraces: 1,
      },
    },
    "Query.extendsOverride": {
      "bridge wire overrides child wire": {
        input: {},
        tools: {
          baseFn: (p: any) => ({
            mode: p.mode,
            timeout: p.timeout,
          }),
        },
        assertData: { mode: "bridge-override", timeout: 5000 },
        assertTraces: 1,
      },
    },
  },
});

// ── 3. Context pull ─────────────────────────────────────────────────────────

regressionTest("tool features: context pull", {
  bridge: `
    version 1.5

    tool authApi from apiImpl {
      with context
      .headers.Authorization <- context.token
    }

    bridge Query.contextPull {
      with authApi as api
      with input as i
      with output as o

      api.q <- i.q
      o.result <- api.data
    }
  `,
  scenarios: {
    "Query.contextPull": {
      "context values pulled into tool headers": {
        input: { q: "test" },
        tools: {
          apiImpl: (p: any) => {
            assert.equal(p.headers.Authorization, "Bearer secret");
            return { data: p.q };
          },
        },
        context: { token: "Bearer secret" },
        assertData: { result: "test" },
        assertTraces: 1,
      },
    },
  },
});

// ── 4. Tool-to-tool dependency ──────────────────────────────────────────────

regressionTest("tool features: tool-to-tool dependency", {
  bridge: `
    version 1.5

    tool authProvider from authFn {
    }

    tool mainApi from mainFn {
      with authProvider
      .token <- authProvider.token
    }

    bridge Query.toolDep {
      with mainApi as m
      with input as i
      with output as o

      m.q <- i.q
      o.status <- m.status
    }

    tool authWithError from authFn {
      on error = {"token":"fallback-token"}
    }

    tool mainApiWithFallback from mainFn {
      with authWithError
      .token <- authWithError.token
    }

    bridge Query.toolDepFallback {
      with mainApiWithFallback as m
      with input as i
      with output as o

      m.q <- i.q
      o.status <- m.status
    }
  `,
  scenarios: {
    "Query.toolDep": {
      "auth tool runs before main, token injected": {
        input: { q: "test" },
        tools: {
          authFn: () => ({ token: "valid-token" }),
          mainFn: (p: any) => ({
            status: `token=${p.token}`,
          }),
        },
        assertData: { status: "token=valid-token" },
        // authProvider + mainApi = 2 tool calls
        assertTraces: 2,
      },
    },
    "Query.toolDepFallback": {
      "tool-to-tool on error fallback provides fallback token": {
        input: { q: "test" },
        tools: {
          authFn: () => {
            throw new Error("auth down");
          },
          mainFn: (p: any) => ({
            status: `token=${p.token}`,
          }),
        },
        assertData: { status: "token=fallback-token" },
        allowDowngrade: true,
        assertTraces: 2,
      },
    },
  },
});

// ── 5. Pipe operator (basic) ────────────────────────────────────────────────

regressionTest("tool features: pipe operator", {
  bridge: `
    version 1.5

    bridge Query.pipeBasic {
      with toUpper as tu
      with input as i
      with output as o

      o.loud <- tu:i.text
    }
  `,
  scenarios: {
    "Query.pipeBasic": {
      "pipes source through tool and maps result to output": {
        input: { text: "hello world" },
        tools: {
          toUpper: (input: any) => String(input.in).toUpperCase(),
        },
        assertData: { loud: "HELLO WORLD" },
        assertTraces: 1,
      },
    },
  },
});

// ── 6. Pipe with extra tool params ──────────────────────────────────────────

regressionTest("tool features: pipe with extra ToolDef params", {
  bridge: `
    version 1.5

    tool convertToEur from currencyConverter {
      .currency = EUR
    }

    bridge Query.pipeTooldefDefault {
      with convertToEur
      with input as i
      with output as o

      o.priceEur <- convertToEur:i.amount
    }

    bridge Query.pipeTooldefOverride {
      with convertToEur
      with input as i
      with output as o

      convertToEur.currency <- i.currency
      o.priceAny <- convertToEur:i.amount
    }
  `,
  scenarios: {
    "Query.pipeTooldefDefault": {
      "default currency from tool definition is used": {
        input: { amount: 500 },
        tools: {
          currencyConverter: (input: any) => {
            const rates: Record<string, number> = { EUR: 100, GBP: 90 };
            return input.in / (rates[input.currency] ?? 100);
          },
        },
        assertData: { priceEur: 5 },
        assertTraces: 1,
      },
    },
    "Query.pipeTooldefOverride": {
      "currency override from input takes precedence": {
        input: { amount: 450, currency: "GBP" },
        tools: {
          currencyConverter: (input: any) => {
            const rates: Record<string, number> = { EUR: 100, GBP: 90 };
            return input.in / (rates[input.currency] ?? 100);
          },
        },
        assertData: { priceAny: 5 },
        assertTraces: 1,
        allowDowngrade: true,
      },
    },
  },
});

// ── 7. Pipe forking ─────────────────────────────────────────────────────────

regressionTest("tool features: pipe forking", {
  bridge: `
    version 1.5

    tool double from doubler

    bridge Query.doubled {
      with double as d
      with input as i
      with output as o

      o.a <- d:i.a
      o.b <- d:i.b
    }
  `,
  scenarios: {
    "Query.doubled": {
      "each pipe use is an independent call — both outputs are doubled": {
        input: { a: 3, b: 7 },
        tools: {
          doubler: (input: any) => input.in * 2,
        },
        assertData: { a: 6, b: 14 },
        assertTraces: 2,
      },
    },
  },
});

// ── 8. Named pipe input field ───────────────────────────────────────────────

regressionTest("tool features: named pipe input field", {
  bridge: `
    version 1.5

    tool divide from divider

    bridge Query.namedPipe {
      with divide as dv
      with input as i
      with output as o

      o.converted <- dv.dividend:i.amount
      dv.divisor <- i.rate
    }
  `,
  scenarios: {
    "Query.namedPipe": {
      "named input field routes value to correct parameter": {
        input: { amount: 450, rate: 90 },
        tools: {
          divider: (input: any) => input.dividend / input.divisor,
        },
        assertData: { converted: 5 },
        assertTraces: 1,
        allowDowngrade: true,
      },
    },
  },
});
