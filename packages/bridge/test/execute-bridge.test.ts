import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.ts";
import { executeBridge } from "../src/execute-bridge.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  const raw = parseBridge(bridgeText);
  // instructions must survive serioalisation
  const instructions = JSON.parse(JSON.stringify(raw)) as ReturnType<typeof parseBridge>;
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

// ── Alias declarations (alias <source> as <name>) ──────────────────────────

describe("executeBridge: alias declarations", () => {
  test("alias pipe:iter as name — evaluates pipe once per element", async () => {
    let enrichCallCount = 0;
    const bridgeText = `version 1.4
bridge Query.list {
  with api
  with enrich
  with output as o

  o <- api.items[] as it {
    alias enrich:it as resp
    .a <- resp.a
    .b <- resp.b
  }
}`;
    const tools: Record<string, any> = {
      api: async () => ({
        items: [
          { id: 1, name: "x" },
          { id: 2, name: "y" },
        ],
      }),
      enrich: async (input: any) => {
        enrichCallCount++;
        return { a: input.in.id * 10, b: input.in.name.toUpperCase() };
      },
    };

    const { data } = await run(bridgeText, "Query.list", {}, tools);
    assert.deepEqual(data, [
      { a: 10, b: "X" },
      { a: 20, b: "Y" },
    ]);
    // enrich is called once per element (2 items = 2 calls), NOT twice per element
    assert.equal(enrichCallCount, 2);
  });

  test("alias iter.subfield as name — iterator-relative plain ref", async () => {
    const bridgeText = `version 1.4
bridge Query.list {
  with api
  with output as o

  o <- api.items[] as it {
    alias it.nested as n
    .x <- n.a
    .y <- n.b
  }
}`;
    const tools: Record<string, any> = {
      api: async () => ({
        items: [
          { nested: { a: 1, b: 2 } },
          { nested: { a: 3, b: 4 } },
        ],
      }),
    };

    const { data } = await run(bridgeText, "Query.list", {}, tools);
    assert.deepEqual(data, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });

  test("alias tool:iter as name — tool handle ref in array", async () => {
    const bridgeText = `version 1.4
bridge Query.items {
  with api
  with std.upperCase as uc
  with output as o

  o <- api.items[] as it {
    alias uc:it.name as upper
    .label <- upper
    .id <- it.id
  }
}`;
    const tools: Record<string, any> = {
      api: async () => ({
        items: [
          { id: 1, name: "alice" },
          { id: 2, name: "bob" },
        ],
      }),
    };

    const { data } = await run(bridgeText, "Query.items", {}, tools);
    assert.deepEqual(data, [
      { label: "ALICE", id: 1 },
      { label: "BOB", id: 2 },
    ]);
  });

  test("top-level alias pipe:source as name — caches result", async () => {
    let ucCallCount = 0;
    const bridgeText = `version 1.4
bridge Query.test {
  with myUC
  with input as i
  with output as o

  alias myUC:i.name as upper

  o.greeting <- upper
  o.label <- upper
  o.title <- upper
}`;
    const tools: Record<string, any> = {
      myUC: (input: any) => {
        ucCallCount++;
        return input.in.toUpperCase();
      },
    };

    const { data } = await run(bridgeText, "Query.test", { name: "alice" }, tools);
    assert.deepEqual(data, { greeting: "ALICE", label: "ALICE", title: "ALICE" });
    // pipe tool called only once despite 3 reads
    assert.equal(ucCallCount, 1);
  });

  test("top-level alias handle.path as name — simple rename", async () => {
    const bridgeText = `version 1.4
bridge Query.test {
  with myTool as api
  with input as i
  with output as o

  api.q <- i.q
  alias api.result.data as d

  o.name <- d.name
  o.email <- d.email
}`;
    const tools: Record<string, any> = {
      myTool: async () => ({
        result: { data: { name: "Alice", email: "alice@test.com" } },
      }),
    };

    const { data } = await run(bridgeText, "Query.test", { q: "hi" }, tools);
    assert.deepEqual(data, { name: "Alice", email: "alice@test.com" });
  });

  test("top-level alias reused inside array — not re-evaluated per element", async () => {
    let ucCallCount = 0;
    const bridgeText = `version 1.4
bridge Query.products {
  with api
  with myUC
  with output as o
  with input as i

  api.cat <- i.category
  alias myUC:i.category as upperCat

  o <- api.products[] as it {
    alias myUC:it.title as upper
    .name <- upper
    .price <- it.price
    .category <- upperCat
  }
}`;
    const tools: Record<string, any> = {
      api: async () => ({
        products: [
          { title: "Phone", price: 999 },
          { title: "Laptop", price: 1999 },
        ],
      }),
      myUC: (input: any) => {
        ucCallCount++;
        return input.in.toUpperCase();
      },
    };

    const { data } = await run(
      bridgeText,
      "Query.products",
      { category: "electronics" },
      tools,
    );
    assert.deepEqual(data, [
      { name: "PHONE", price: 999, category: "ELECTRONICS" },
      { name: "LAPTOP", price: 1999, category: "ELECTRONICS" },
    ]);
    // 1 call for top-level upperCat + 2 calls for per-element upper = 3 total
    assert.equal(ucCallCount, 3);
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
