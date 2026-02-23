import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { executeBridge } from "../src/execute-bridge.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  const instructions = parseBridge(bridgeText);
  return executeBridge({ instructions, operation, input, tools });
}

// ── Object output (per-field wires) ─────────────────────────────────────────

describe("executeBridge: object output", () => {
  const bridgeText = `version 1.4
bridge Query.livingStandard {
  with hereapi.geocode as gc
  with companyX.getLivingStandard as cx
  with input as i
  with toInt as ti
  with output as out

  gc.q <- i.location
  cx.x <- gc.lat
  cx.y <- gc.lon
  ti.value <- cx.lifeExpectancy
  out.lifeExpectancy <- ti.result
}`;

  const tools: Record<string, any> = {
    "hereapi.geocode": async () => ({ lat: 52.53, lon: 13.38 }),
    "companyX.getLivingStandard": async (p: any) => ({
      lifeExpectancy: "81.5",
    }),
    toInt: (p: { value: string }) => ({
      result: Math.round(parseFloat(p.value)),
    }),
  };

  test("chained providers resolve all fields", async () => {
    const { data } = await run(
      bridgeText,
      "Query.livingStandard",
      { location: "Berlin" },
      tools,
    );
    assert.deepEqual(data, { lifeExpectancy: 82 });
  });

  test("tools receive correct chained inputs", async () => {
    let geoParams: any;
    let cxParams: any;
    const spyTools = {
      ...tools,
      "hereapi.geocode": async (p: any) => {
        geoParams = p;
        return { lat: 52.53, lon: 13.38 };
      },
      "companyX.getLivingStandard": async (p: any) => {
        cxParams = p;
        return { lifeExpectancy: "81.5" };
      },
    };
    await run(bridgeText, "Query.livingStandard", { location: "Berlin" }, spyTools);
    assert.equal(geoParams.q, "Berlin");
    assert.equal(cxParams.x, 52.53);
    assert.equal(cxParams.y, 13.38);
  });
});

// ── Whole-object passthrough (root wire: o <- ...) ──────────────────────────

describe("executeBridge: root wire passthrough", () => {
  const bridgeText = `version 1.4
bridge Query.getUser {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.id
  o <- api.user
}`;

  test("root object wire returns entire tool output", async () => {
    const tools = {
      userApi: async (p: any) => ({
        user: { name: "Alice", age: 30, email: "alice@example.com" },
      }),
    };
    const { data } = await run(
      bridgeText,
      "Query.getUser",
      { id: "123" },
      tools,
    );
    assert.deepEqual(data, { name: "Alice", age: 30, email: "alice@example.com" });
  });

  test("tool receives input args", async () => {
    let captured: any;
    const tools = {
      userApi: async (p: any) => {
        captured = p;
        return { user: { name: "Bob" } };
      },
    };
    await run(bridgeText, "Query.getUser", { id: "42" }, tools);
    assert.equal(captured.id, "42");
  });
});

// ── Array output (o <- items[] as x { ... }) ────────────────────────────────

describe("executeBridge: array output", () => {
  const bridgeText = `version 1.4
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

  gc.q <- i.search
  o <- gc.items[] as item {
    .name <- item.title
    .lat  <- item.position.lat
    .lon  <- item.position.lng
  }
}`;

  const tools: Record<string, any> = {
    "hereapi.geocode": async () => ({
      items: [
        { title: "Berlin", position: { lat: 52.53, lng: 13.39 } },
        { title: "Bern", position: { lat: 46.95, lng: 7.45 } },
      ],
    }),
  };

  test("array elements are materialised with renamed fields", async () => {
    const { data } = await run(
      bridgeText,
      "Query.geocode",
      { search: "Ber" },
      tools,
    );
    assert.deepEqual(data, [
      { name: "Berlin", lat: 52.53, lon: 13.39 },
      { name: "Bern", lat: 46.95, lon: 7.45 },
    ]);
  });

  test("empty array returns empty array", async () => {
    const emptyTools = {
      "hereapi.geocode": async () => ({ items: [] }),
    };
    const { data } = await run(
      bridgeText,
      "Query.geocode",
      { search: "zzz" },
      emptyTools,
    );
    assert.deepEqual(data, []);
  });
});

// ── Nested arrays (o <- items[] as x { .sub <- x.things[] as y { ... } }) ──

describe("executeBridge: nested arrays", () => {
  const bridgeText = `version 1.4
bridge Query.searchTrains {
  with transportApi as api
  with input as i
  with output as o

  api.from <- i.from
  api.to <- i.to
  o <- api.connections[] as c {
    .id <- c.id
    .legs <- c.sections[] as s {
      .trainName <- s.name
      .origin.station <- s.departure.station
      .destination.station <- s.arrival.station
    }
  }
}`;

  const tools: Record<string, any> = {
    transportApi: async () => ({
      connections: [
        {
          id: "c1",
          sections: [
            {
              name: "IC 8",
              departure: { station: "Bern" },
              arrival: { station: "Zürich" },
            },
            {
              name: "S3",
              departure: { station: "Zürich" },
              arrival: { station: "Aarau" },
            },
          ],
        },
      ],
    }),
  };

  test("nested array elements are fully materialised", async () => {
    const { data } = await run(
      bridgeText,
      "Query.searchTrains",
      { from: "Bern", to: "Aarau" },
      tools,
    );
    assert.deepEqual(data, [
      {
        id: "c1",
        legs: [
          {
            trainName: "IC 8",
            origin: { station: "Bern" },
            destination: { station: "Zürich" },
          },
          {
            trainName: "S3",
            origin: { station: "Zürich" },
            destination: { station: "Aarau" },
          },
        ],
      },
    ]);
  });
});

// ── Constant wires ──────────────────────────────────────────────────────────

describe("executeBridge: constant wires", () => {
  const bridgeText = `version 1.4
bridge Query.info {
  with input as i
  with output as o

  o.greeting = "hello"
  o.name <- i.name
}`;

  test("constant and input wires coexist", async () => {
    const { data } = await run(bridgeText, "Query.info", { name: "World" });
    assert.deepEqual(data, { greeting: "hello", name: "World" });
  });
});

// ── Tracing ─────────────────────────────────────────────────────────────────

describe("executeBridge: tracing", () => {
  const bridgeText = `version 1.4
bridge Query.echo {
  with myTool as t
  with input as i
  with output as o

  t.x <- i.x
  o.result <- t.y
}`;

  const tools = { myTool: (p: any) => ({ y: p.x * 2 }) };

  test("traces are empty when tracing is off", async () => {
    const { traces } = await executeBridge({
      instructions: parseBridge(bridgeText),
      operation: "Query.echo",
      input: { x: 5 },
      tools,
    });
    assert.equal(traces.length, 0);
  });

  test("traces contain tool calls when tracing is enabled", async () => {
    const { data, traces } = await executeBridge({
      instructions: parseBridge(bridgeText),
      operation: "Query.echo",
      input: { x: 5 },
      tools,
      trace: "full",
    });
    assert.deepEqual(data, { result: 10 });
    assert.ok(traces.length > 0);
    assert.ok(traces.some((t) => t.tool === "myTool"));
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("executeBridge: errors", () => {
  test("invalid operation format throws", async () => {
    await assert.rejects(
      () => run("version 1.4", "badformat", {}),
      /expected "Type\.field"/,
    );
  });

  test("missing bridge definition throws", async () => {
    const bridgeText = `version 1.4
bridge Query.foo {
  with output as o
  o.x = "ok"
}`;
    await assert.rejects(
      () => run(bridgeText, "Query.bar", {}),
      /No bridge definition found/,
    );
  });
});
