import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import type { Wire } from "../src/index.ts";
import { assertDeepStrictEqualIgnoringLoc } from "./parse-test-utils.ts";
import { createGateway } from "./_gateway.ts";

// ═══════════════════════════════════════════════════════════════════════════
// v2.0 Execution Semantics:
//   • || chains evaluate sequentially (left to right) with short-circuit
//   • Overdefinition uses cost-based ordering (zero-cost/already-resolved → expensive)
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
      primary: async () => {
        callLog.push("primary");
        return { label: "P" };
      },
      backup: async () => {
        callLog.push("backup");
        return { label: "B" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "P");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary"],
      "backup should never be called",
    );
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
      primary: async () => {
        callLog.push("primary");
        return { label: null };
      },
      backup: async () => {
        callLog.push("backup");
        return { label: "B" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "B");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary", "backup"],
      "backup called after primary returned null",
    );
  });

  test("3-source chain: first truthy wins, later sources skipped", async () => {
    const threeSourceTypes = /* GraphQL */ `
      type Query {
        lookup(q: String!): Result
      }
      type Result {
        label: String
      }
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
      svcA: async () => {
        callLog.push("A");
        return { label: null };
      },
      svcB: async () => {
        callLog.push("B");
        return { label: "from-B" };
      },
      svcC: async () => {
        callLog.push("C");
        return { label: "from-C" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(threeSourceTypes, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "from-B");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["A", "B"],
      "C should never be called",
    );
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
      primary: async () => {
        callLog.push("primary");
        return { label: null };
      },
      backup: async () => {
        callLog.push("backup");
        return { label: null };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "default");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary", "backup"],
      "both called, then literal fires",
    );
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
      primary: async () => {
        callLog.push("primary");
        throw new Error("boom");
      },
      backup: async () => {
        callLog.push("backup");
        return { label: "B" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    // strict source throws → error exits || chain → no catch → GraphQL error
    assert.ok(result.errors?.length, "strict throw → GraphQL error");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary"],
      "backup never called — strict throw exits chain",
    );
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
      primary: async () => {
        callLog.push("primary");
        throw new Error("down");
      },
      backup: async () => {
        callLog.push("backup");
        throw new Error("also down");
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "error-default");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary"],
      "strict throw exits || — catch fires immediately",
    );
  });
});

// ── Cost-based resolution: overdefinition ────────────────────────────────

describe("overdefinition: cost-based prioritization", () => {
  test("input beats tool even when tool wire is authored first", async () => {
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
      expensiveApi: async () => {
        callLog.push("expensiveApi");
        return { label: "expensive" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x", hint: "cheap") { label } }`),
    });
    assert.equal(result.data.lookup.label, "cheap");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      [],
      "zero-cost input should short-circuit before the API is called",
    );
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
      expensiveApi: async () => {
        callLog.push("expensiveApi");
        return { label: "from-api" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // hint is null (not provided) → engine falls through to the API
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "from-api");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["expensiveApi"],
      "API should run only when zero-cost sources are nullish",
    );
  });

  test("context beats tool even when tool wire is authored first", async () => {
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
      expensiveApi: async () => {
        callLog.push("expensiveApi");
        return { label: "expensive" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, {
      tools,
      context: { defaultLabel: "from-context" },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "from-context");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      [],
      "zero-cost context should short-circuit before the API is called",
    );
  });

  test("resolved alias beats tool even when tool wire is authored first", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

alias i.hint as cached
api.q <- i.q
o.label <- api.label
o.label <- cached

}`;
    const callLog: string[] = [];
    const tools = {
      expensiveApi: async () => {
        callLog.push("api");
        return { label: "expensive" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x", hint: "cached") { label } }`),
    });
    assert.equal(result.data.lookup.label, "cached");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      [],
      "resolved aliases should be treated like zero-cost values",
    );
  });

  test("two tool sources with same cost preserve authored order as tie-break", async () => {
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
      svcA: async () => {
        callLog.push("A");
        return { label: "from-A" };
      },
      svcB: async () => {
        callLog.push("B");
        return { label: "from-B" };
      },
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "from-A");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["A"],
      "same-cost tool sources should still use authored order as a tie-break",
    );
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
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
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
      svcA: async () => {
        throw new Error("A down");
      },
      svcB: async () => ({ label: null }),
    };
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
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
    const doc = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, doc, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label score } }`),
    });
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
): Promise<{ data: any; traces: any[] }> {
  const raw = parseBridge(bridgeText);
  const document = JSON.parse(JSON.stringify(raw)) as ReturnType<
    typeof parseBridge
  >;
  return executeBridge({ document, operation, input, tools });
}

describe("?. safe execution modifier", () => {
  test("parser detects ?. and sets safe flag on wire", () => {
    const doc = parseBridge(`version 1.5
bridge Query.lookup {
  with api.fetch as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
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

  test("?. with chained || literals short-circuits at first truthy literal", async () => {
    const doc = parseBridge(`version 1.5
const lorem = {
  "ipsum":"dolor sit amet",
  "consetetur":8.9
}

bridge Query.lookup {
  with const
  with output as o

  o.label <- const.lorem.ipsums?.kala || "A" || "B"
}`);
    const gateway = createGateway(typeDefs, doc, { tools: {} });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "A");
  });

  test("mixed || and ?? remains left-to-right with first truthy || winner", async () => {
    const doc = parseBridge(`version 1.5
const lorem = {
  "ipsum": "dolor sit amet",
  "consetetur": 8.9
}

bridge Query.lookup {
  with const
  with output as o

  o.label <- const.lorem.kala || const.lorem.ipsums?.mees || "B" ?? "C"
}`);
    const gateway = createGateway(typeDefs, doc, { tools: {} });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "B");
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
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("?."), "serialized contains ?.");
    assert.ok(serialized.includes("catch"), "serialized contains catch");
    // Re-parse round-trips
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.instructions.find((i) => i.kind === "bridge")!;
    const safePull = bridge.wires.find(
      (w) => "from" in w && "safe" in w && w.safe,
    );
    assert.ok(safePull, "round-tripped wire has safe: true");
  });
});

// ── Mixed || and ?? chains ──────────────────────────────────────────────────

describe("mixed || and ?? chains", () => {
  test("A ?? B || C — nullish gate then falsy gate", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

  p.q <- i.q
  b.q <- i.q
  o.label <- p.label ?? b.label || "fallback"
}`,
      "Query.lookup",
      { q: "test" },
      {
        primary: async () => ({ label: null }),
        backup: async () => ({ label: "" }),
      },
    );
    // p.label is null → ?? gate opens → b.label is "" (non-nullish, gate closes)
    // b.label is "" → || gate opens → "fallback"
    assert.equal(data.label, "fallback");
  });

  test("A || B ?? C — falsy gate then nullish gate", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

  p.q <- i.q
  b.q <- i.q
  o.label <- p.label || b.label ?? "default"
}`,
      "Query.lookup",
      { q: "test" },
      {
        primary: async () => ({ label: "" }),
        backup: async () => ({ label: null }),
      },
    );
    // p.label is "" → || gate opens → b.label is null (still falsy)
    // b.label is null → ?? gate opens → "default"
    assert.equal(data.label, "default");
  });

  test("A ?? B || C ?? D — four-item mixed chain", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with a as a
  with b as b
  with c as c
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  c.q <- i.q
  o.label <- a.label ?? b.label || c.label ?? "last"
}`,
      "Query.lookup",
      { q: "test" },
      {
        a: async () => ({ label: null }),
        b: async () => ({ label: 0 }),
        c: async () => ({ label: null }),
      },
    );
    // a.label null → ?? opens → b.label is 0 (non-nullish, ?? closes)
    // 0 is falsy → || opens → c.label is null (still falsy)
    // null → ?? opens → "last"
    assert.equal(data.label, "last");
  });

  test("mixed chain short-circuits when value becomes truthy", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  o.label <- a.label ?? b.label || "unused"
}`,
      "Query.lookup",
      { q: "test" },
      {
        a: async () => ({ label: null }),
        b: async () => ({ label: "found" }),
      },
    );
    // a.label null → ?? opens → b.label is "found" (truthy)
    // "found" is truthy → || gate closed → "unused" skipped
    assert.equal(data.label, "found");
  });

  test("mixed chain round-trips through serializer", () => {
    const src = `version 1.5

bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  o.label <- a.label ?? b.label || "fallback"

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, doc);
  });

  test("?? then || with literals round-trips", () => {
    const src = `version 1.5

bridge Query.lookup {
  with input as i
  with output as o

  o.label <- i.label ?? "nullish-default" || "falsy-default"

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, doc);
  });

  test("parser produces correct fallbacks array for mixed chain", () => {
    const doc = parseBridge(`version 1.5

bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  o.label <- a.label ?? b.label || "default"
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const wire = bridge.wires.find(
      (w) => "from" in w && (w as any).to.path[0] === "label" && !("pipe" in w),
    ) as Extract<Wire, { from: any }>;
    assert.ok(wire.fallbacks, "wire should have fallbacks");
    assert.equal(wire.fallbacks!.length, 2);
    assert.equal(wire.fallbacks![0].type, "nullish");
    assert.ok(wire.fallbacks![0].ref, "first fallback should be a ref");
    assert.equal(wire.fallbacks![1].type, "falsy");
    assert.equal(wire.fallbacks![1].value, '"default"');
  });
});
