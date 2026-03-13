import assert from "node:assert/strict";
import type { ToolTrace } from "@stackables/bridge-core";
import { tools } from "../utils/bridge-tools.ts";
import { regressionTest, type AssertContext } from "../utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Trace ToolDef name consistency across engines
//
// When a ToolDef is declared as `tool apiA from test.multitool { ... }`,
// traces must record:
//   tool: "apiA"            (the ToolDef name)
//   fn:   "test.multitool"  (the underlying function)
//
// Previously the compiled engine lost the ToolDef name and used the fn name
// for both fields. This test validates that traces are identical across all
// engines — same fields, same values, same shape.
// ═══════════════════════════════════════════════════════════════════════════

function assertTraceShape(traces: ToolTrace[]) {
  for (const t of traces) {
    assert.ok(typeof t.tool === "string" && t.tool.length > 0, "tool field must be a non-empty string");
    assert.ok(typeof t.fn === "string" && t.fn.length > 0, "fn field must be a non-empty string");
    assert.ok(typeof t.durationMs === "number" && t.durationMs >= 0, "durationMs must be non-negative");
    assert.ok(typeof t.startedAt === "number" && t.startedAt >= 0, "startedAt must be non-negative");
    // full trace level → input + output present on success
    assert.ok("input" in t, "input field must be present at full trace level");
    assert.ok("output" in t || "error" in t, "output or error must be present");
  }
}

// ── 1. ToolDef-backed tool: tool vs fn fields ───────────────────────────────

regressionTest("trace: ToolDef name preserved in trace", {
  bridge: `
    version 1.5

    tool apiA from test.multitool {
      .extra = "hello"
    }

    bridge Query.toolDefTrace {
      with apiA as a
      with input as i
      with output as o

      a.x <- i.x
      o.result <- a
    }
  `,
  tools,
  scenarios: {
    "Query.toolDefTrace": {
      "trace records ToolDef name, not fn name": {
        input: { x: 42 },
        assertData: { result: { extra: "hello", x: 42 } },
        assertTraces: (traces: ToolTrace[], ctx: AssertContext) => {
          assert.equal(traces.length, 1);
          assertTraceShape(traces);
          const t = traces[0]!;
          assert.equal(t.tool, "apiA", `[${ctx.engine}] tool field should be ToolDef name "apiA"`);
          assert.equal(t.fn, "test.multitool", `[${ctx.engine}] fn field should be underlying function "test.multitool"`);
        },
      },
    },
  },
});

// ── 2. Multiple ToolDefs from same function are distinguishable ─────────────

regressionTest("trace: multiple ToolDefs from same fn are distinguishable", {
  bridge: `
    version 1.5

    tool alpha from test.multitool {
      .tag = "A"
    }
    tool beta from test.multitool {
      .tag = "B"
    }

    bridge Query.multiToolDef {
      with alpha as a
      with beta as b
      with input as i
      with output as o

      a.x <- i.x
      b.y <- i.y

      o.fromA <- a
      o.fromB <- b
    }
  `,
  tools,
  scenarios: {
    "Query.multiToolDef": {
      "each ToolDef has its own name in traces": {
        input: { x: 1, y: 2 },
        assertData: {
          fromA: { tag: "A", x: 1 },
          fromB: { tag: "B", y: 2 },
        },
        assertTraces: (traces: ToolTrace[], ctx: AssertContext) => {
          assert.equal(traces.length, 2);
          assertTraceShape(traces);
          const alphaTrace = traces.find((t) => t.tool === "alpha");
          const betaTrace = traces.find((t) => t.tool === "beta");
          assert.ok(alphaTrace, `[${ctx.engine}] expected trace with tool="alpha"`);
          assert.ok(betaTrace, `[${ctx.engine}] expected trace with tool="beta"`);
          assert.equal(alphaTrace.fn, "test.multitool", `[${ctx.engine}] alpha.fn`);
          assert.equal(betaTrace.fn, "test.multitool", `[${ctx.engine}] beta.fn`);
        },
      },
    },
  },
});

// ── 3. Plain tool (no ToolDef) — tool and fn are identical ──────────────────

regressionTest("trace: plain tool has matching tool and fn fields", {
  bridge: `
    version 1.5

    bridge Query.plainTool {
      with test.multitool as t
      with input as i
      with output as o

      t.x <- i.x
      o.result <- t
    }
  `,
  tools,
  scenarios: {
    "Query.plainTool": {
      "tool and fn are both the tool name": {
        input: { x: 99 },
        assertData: { result: { x: 99 } },
        assertTraces: (traces: ToolTrace[], ctx: AssertContext) => {
          assert.equal(traces.length, 1);
          assertTraceShape(traces);
          const t = traces[0]!;
          assert.equal(t.tool, "test.multitool", `[${ctx.engine}] tool field`);
          assert.equal(t.fn, "test.multitool", `[${ctx.engine}] fn field`);
        },
      },
    },
  },
});

// ── 4. ToolDef used in define block ─────────────────────────────────────────

regressionTest("trace: ToolDef in define block preserves name", {
  bridge: `
    version 1.5

    tool enricher from test.multitool {
      .source = "define"
    }

    define enrich {
      with enricher as e
      with input as i
      with output as o

      e.val <- i.val
      o.enriched <- e
    }

    bridge Query.defineTrace {
      with enrich as en
      with input as i
      with output as o

      en.val <- i.val
      o.result <- en.enriched
    }
  `,
  tools,
  scenarios: {
    "Query.defineTrace": {
      "ToolDef name survives define inlining": {
        input: { val: "test" },
        assertData: { result: { source: "define", val: "test" } },
        assertTraces: (traces: ToolTrace[], ctx: AssertContext) => {
          assert.equal(traces.length, 1);
          assertTraceShape(traces);
          const t = traces[0]!;
          assert.equal(t.tool, "enricher", `[${ctx.engine}] tool field should be "enricher"`);
          assert.equal(t.fn, "test.multitool", `[${ctx.engine}] fn field should be "test.multitool"`);
        },
      },
    },
  },
});

// ── 5. Same tool referenced from two define blocks ──────────────────────────

regressionTest("trace: same tool in two defines produces correct names", {
  bridge: `
    version 1.5

    tool fetcher from test.multitool {
      .origin = "shared"
    }

    define blockA {
      with fetcher as f
      with input as i
      with output as o

      f.from <- "A"
      f.x <- i.x
      o.a <- f
    }

    define blockB {
      with fetcher as f
      with input as i
      with output as o

      f.from <- "B"
      f.y <- i.y
      o.b <- f
    }

    bridge Query.twoDefines {
      with blockA as ba
      with blockB as bb
      with input as i
      with output as o

      ba.x <- i.x
      bb.y <- i.y

      o.fromA <- ba.a
      o.fromB <- bb.b
    }
  `,
  tools,
  scenarios: {
    "Query.twoDefines": {
      "both invocations traced as the ToolDef name": {
        input: { x: 1, y: 2 },
        assertData: {
          fromA: { origin: "shared", from: "A", x: 1 },
          fromB: { origin: "shared", from: "B", y: 2 },
        },
        assertTraces: (traces: ToolTrace[], ctx: AssertContext) => {
          assert.equal(traces.length, 2);
          assertTraceShape(traces);
          // Both traces should have tool="fetcher"
          assert.ok(
            traces.every((t) => t.tool === "fetcher"),
            `[${ctx.engine}] all traces should have tool="fetcher", got: ${traces.map((t) => t.tool).join(", ")}`,
          );
          assert.ok(
            traces.every((t) => t.fn === "test.multitool"),
            `[${ctx.engine}] all traces should have fn="test.multitool"`,
          );
        },
      },
    },
  },
});
