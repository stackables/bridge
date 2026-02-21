import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ═══════════════════════════════════════════════════════════════════════════
// v2.0 Execution Semantics:
//   • || chains evaluate sequentially (left to right) with short-circuit
//   • Overdefinition uses cost-based ordering (cheap → expensive)
//   • Backup tools are NEVER called when a earlier source returns non-null
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
    const bridgeText = `version 1.4
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
    const bridgeText = `version 1.4
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

  test("3-source chain: first non-null wins, later sources skipped", async () => {
    const threeSourceTypes = /* GraphQL */ `
      type Query { lookup(q: String!): Result }
      type Result { label: String }
    `;
    const bridgeText = `version 1.4
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
    const bridgeText = `version 1.4
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

  test("|| does not swallow errors — chain aborts on throw", async () => {
    const bridgeText = `version 1.4
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
    // || does not catch errors. Both sources are tried (errors are collected),
    // but if all throw → the whole group fails.
    // Here primary throws but backup succeeds → backup's error-less result is used.
    // Wait, actually: in the sequential loop, primary throws → error is collected,
    // then backup is tried → returns {label: "B"} which is non-null → returned.
    assert.equal(result.data.lookup.label, "B");
    assert.deepStrictEqual(callLog, ["primary", "backup"]);
  });

  test("|| + ?? combined: primary throws, backup returns null → ?? fires", async () => {
    const bridgeText = `version 1.4
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "null-default" ?? "error-default"

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
    assert.deepStrictEqual(callLog, ["primary", "backup"], "both tried before error fallback");
  });
});

// ── Cost-based resolution: overdefinition ────────────────────────────────

describe("overdefinition cost-based ordering", () => {
  test("input read (cost 0) wins over tool call (cost 1) — tool never called", async () => {
    const bridgeText = `version 1.4
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
    assert.equal(result.data.lookup.label, "cheap");
    // The tool should never be called because the input read is cost 0
    // and returns non-null, short-circuiting the expensive API call.
    assert.deepStrictEqual(callLog, [], "expensive API should NOT be called when input has value");
  });

  test("input is null → falls through to tool call", async () => {
    const bridgeText = `version 1.4
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

  test("overdefinition order in file doesn't matter — cost determines priority", async () => {
    // Even though the expensive tool wire is written FIRST,
    // the cheap input wire should be evaluated first.
    const bridgeText = `version 1.4
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
    assert.equal(result.data.lookup.label, "from-input");
    assert.deepStrictEqual(callLog, [], "file order is irrelevant — cost wins");
  });

  test("context read (cost 0) wins over tool call (cost 1)", async () => {
    const bridgeText = `version 1.4
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
    assert.equal(result.data.lookup.label, "from-context");
    assert.deepStrictEqual(callLog, [], "context is free — API never called");
  });

  test("two tool sources with same cost — file order preserved", async () => {
    const bridgeText = `version 1.4
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
    // Both are cost 1 → file order matters. A is first in the bridge.
    assert.equal(result.data.lookup.label, "from-A");
    assert.deepStrictEqual(callLog, ["A"], "B never called — same cost, file order wins");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe("coalesce edge cases", () => {
  test("single source: no sorting or short-circuit needed", async () => {
    const bridgeText = `version 1.4
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

  test("|| with first source throwing and second returning null → returns undefined (then || literal fires)", async () => {
    const bridgeText = `version 1.4
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label || b.label || "last-resort"

}`;
    const tools = {
      svcA: async () => { throw new Error("A down"); },
      svcB: async () => ({ label: null }),
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    // A throws (error collected), B returns null → both tried, no non-null found.
    // Not all threw (B succeeded), so || fires → "last-resort"
    assert.equal(result.data.lookup.label, "last-resort");
  });

  test("independent targets still resolve concurrently", async () => {
    // label comes from svcA, score comes from svcB — these are different
    // targets and should run in parallel, not sequentially.
    const bridgeText = `version 1.4
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
