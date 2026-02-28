import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { createGateway } from "./_gateway.ts";

// ═══════════════════════════════════════════════════════════════════════════
// v2.0 Execution Semantics:
//   • || chains evaluate sequentially (left to right) with short-circuit
//   • Overdefinition uses cost-based ordering (cheap → expensive)
//   • Backup tools are NEVER called when a earlier source returns a truthy value
// ═══════════════════════════════════════════════════════════════════════════

const typeDefs = /* GraphQL */ `
  type Query {
    lookup(q: String!, hint: String): Result
  }
  type Result {
    label: String
    score: Int
  }
`;

// ── Short-circuit: || chains ──────────────────────────────────────────────

describe("|| sequential short-circuit", () => {
  test("primary succeeds → backup is never called", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => { callLog.push("primary"); return { label: "P" }; },
      backup:  async () => { callLog.push("backup");  return { label: "B" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "P");
    assert.deepStrictEqual(callLog, ["primary"], "backup should never be called");
  });

  test("primary returns null → backup is called", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => { callLog.push("primary"); return { label: null }; },
      backup:  async () => { callLog.push("backup");  return { label: "B" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "B");
    assert.deepStrictEqual(callLog, ["primary", "backup"], "backup called after primary returned null");
  });

  test("3-source chain: first truthy wins, later sources skipped", async () => {
    const threeSourceTypes = /* GraphQL */ `
      type Query { lookup(q: String!): Result }
      type Result { label: String }
    `;
    const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with svcC as c
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
c.q <- i.q
o.label <- a.label || b.label || c.label

}`;
    const callLog: string[] = [];
    const tools = {
      svcA: async () => { callLog.push("A"); return { label: null }; },
      svcB: async () => { callLog.push("B"); return { label: "from-B" }; },
      svcC: async () => { callLog.push("C"); return { label: "from-C" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(threeSourceTypes, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "from-B");
    assert.deepStrictEqual(callLog, ["A", "B"], "C should never be called");
  });

  test("|| with literal fallback: both null → literal, no extra calls", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "default"

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => { callLog.push("primary"); return { label: null }; },
      backup:  async () => { callLog.push("backup");  return { label: null }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "default");
    assert.deepStrictEqual(callLog, ["primary", "backup"], "both called, then literal fires");
  });

  test("strict throw exits || chain — backup not called (no catch)", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => { callLog.push("primary"); throw new Error("boom"); },
      backup:  async () => { callLog.push("backup"); return { label: "B" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    // strict source throws → error exits || chain → no catch → GraphQL error
    assert.ok(result.errors?.length, "strict throw → GraphQL error");
    assert.deepStrictEqual(callLog, ["primary"], "backup never called — strict throw exits chain");
  });

  test("|| + catch combined: strict throw → catch fires", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "null-default" catch "error-default"

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => { callLog.push("primary"); throw new Error("down"); },
      backup:  async () => { callLog.push("backup");  throw new Error("also down"); },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "error-default");
    assert.deepStrictEqual(callLog, ["primary"], "strict throw exits || — catch fires immediately");
  });
});

// ── Cost-based resolution: overdefinition ────────────────────────────────

describe("overdefinition: authored order respected", () => {
  test("first wire wins when both are non-null (left-to-right)", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- i.hint

}`;
    const callLog: string[] = [];
    const tools = {
      expensiveApi: async () => { callLog.push("expensiveApi"); return { label: "expensive" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x", hint: "cheap") { label } }`),
    });
    // Authored order: api.label is first → wins
    assert.equal(result.data.lookup.label, "expensive");
    assert.deepStrictEqual(callLog, ["expensiveApi"], "first wire evaluated first");
  });

  test("input is null → falls through to tool call", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- i.hint

}`;
    const callLog: string[] = [];
    const tools = {
      expensiveApi: async () => { callLog.push("expensiveApi"); return { label: "from-api" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // hint is null (not provided) → engine falls through to the API
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "from-api");
    assert.deepStrictEqual(callLog, ["expensiveApi"], "API called when input is null");
  });

  test("overdefinition respects authored order — first wire wins", async () => {
    // The expensive tool wire is written FIRST, so it is evaluated first.
    // Left-to-right semantics mean the tool result wins.
    const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- i.hint

}`;
    const callLog: string[] = [];
    const tools = {
      expensiveApi: async () => { callLog.push("expensiveApi"); return { label: "expensive" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x", hint: "from-input") { label } }`),
    });
    assert.equal(result.data.lookup.label, "expensive");
    assert.deepStrictEqual(callLog, ["expensiveApi"], "first wire wins — authored order matters");
  });

  test("authored order: tool before context — tool wins", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with context as ctx
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- ctx.defaultLabel

}`;
    const callLog: string[] = [];
    const tools = {
      expensiveApi: async () => { callLog.push("api"); return { label: "expensive" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools,
      context: { defaultLabel: "from-context" },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    // api.label is first wire → evaluated first → wins
    assert.equal(result.data.lookup.label, "expensive");
    assert.deepStrictEqual(callLog, ["api"], "authored order: api first, context second");
  });

  test("two tool sources with same cost — file order preserved", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label
o.label <- b.label

}`;
    const callLog: string[] = [];
    const tools = {
      svcA: async () => { callLog.push("A"); return { label: "from-A" }; },
      svcB: async () => { callLog.push("B"); return { label: "from-B" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    // Authored order: A is first in the bridge → wins.
    assert.equal(result.data.lookup.label, "from-A");
    assert.deepStrictEqual(callLog, ["A"], "B never called — A is first, short-circuits");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe("coalesce edge cases", () => {
  test("single source: no sorting or short-circuit needed", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label

}`;
    const tools = {
      myApi: async () => ({ label: "hello" }),
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "hello");
  });

  test("?. with || fallback: error → undefined, null → falls through to literal", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a?.label || b.label || "last-resort"

}`;
    const tools = {
      svcA: async () => { throw new Error("A down"); },
      svcB: async () => ({ label: null }),
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    // A throws but ?. swallows → undefined (falsy), B returns null (falsy) → literal fires
    assert.equal(result.data.lookup.label, "last-resort");
  });

  test("independent targets still resolve concurrently", async () => {
    // label comes from svcA, score comes from svcB — these are different
    // targets and should run in parallel, not sequentially.
    const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label
o.score <- b.score

}`;
    const timeline: { tool: string; event: string; time: number }[] = [];
    const start = Date.now();
    const tools = {
      svcA: async () => {
        timeline.push({ tool: "A", event: "start", time: Date.now() - start });
        await new Promise((r) => setTimeout(r, 50));
        timeline.push({ tool: "A", event: "end", time: Date.now() - start });
        return { label: "A" };
      },
      svcB: async () => {
        timeline.push({ tool: "B", event: "start", time: Date.now() - start });
        await new Promise((r) => setTimeout(r, 50));
        timeline.push({ tool: "B", event: "end", time: Date.now() - start });
        return { score: 42 };
      },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label score } }`) });
    assert.equal(result.data.lookup.label, "A");
    assert.equal(result.data.lookup.score, 42);

    // Both tools should have started before either finished (concurrent)
    const startEvents = timeline.filter((e) => e.event === "start");
    assert.equal(startEvents.length, 2);
    // The gap between A starting and B starting should be < 30ms (concurrent)
    const gap = Math.abs(startEvents[0].time - startEvents[1].time);
    assert.ok(gap < 30, `tools should start concurrently (gap: ${gap}ms)`);
  });
});

// ── ?. Safe execution modifier ────────────────────────────────────────────

import { executeBridge } from "../src/index.ts";
import { serializeBridge } from "../src/index.ts";

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  const raw = parseBridge(bridgeText);
  const instructions = JSON.parse(JSON.stringify(raw)) as ReturnType<
    typeof parseBridge
  >;
  return executeBridge({ instructions, operation, input, tools });
}

describe("?. safe execution modifier", () => {
  test("parser detects ?. and sets safe flag on wire", () => {
    const instructions = parseBridge(`version 1.5
bridge Query.lookup {
  with api.fetch as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`);
    const bridge = instructions.find((i) => i.kind === "bridge")!;
    const safePull = bridge.wires.find(
      (w) => "from" in w && "safe" in w && w.safe,
    );
    assert.ok(safePull, "has a wire with safe: true");
  });

  test("?. swallows tool error and returns undefined", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with failing.api as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`,
      "Query.lookup",
      { q: "test" },
      {
        "failing.api": async () => {
          throw new Error("HTTP 500");
        },
      },
    );
    assert.equal(data.label, undefined);
  });

  test("?. with || fallback: error returns undefined then || kicks in", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with failing.api as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label || "fallback"
}`,
      "Query.lookup",
      { q: "test" },
      {
        "failing.api": async () => {
          throw new Error("HTTP 500");
        },
      },
    );
    assert.equal(data.label, "fallback");
  });

  test("?. passes through value when tool succeeds", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with good.api as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`,
      "Query.lookup",
      { q: "test" },
      {
        "good.api": async () => ({ label: "Hello" }),
      },
    );
    assert.equal(data.label, "Hello");
  });

  test("safe execution round-trips through serializer", () => {
    const src = `version 1.5

bridge Query.lookup {
  with api.fetch as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label catch "default"

}`;
    const instructions = parseBridge(src);
    const serialized = serializeBridge(instructions);
    assert.ok(serialized.includes("?."), "serialized contains ?.");
    assert.ok(serialized.includes("catch"), "serialized contains catch");
    // Re-parse round-trips
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.find((i) => i.kind === "bridge")!;
    const safePull = bridge.wires.find(
      (w) => "from" in w && "safe" in w && w.safe,
    );
    assert.ok(safePull, "round-tripped wire has safe: true");
  });
});
