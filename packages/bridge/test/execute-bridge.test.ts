import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { executeBridge } from "../src/index.ts";
import {
  checkStdVersion,
  checkHandleVersions,
  collectVersionedHandles,
  getBridgeVersion,
  hasVersionedToolFn,
  mergeBridgeDocuments,
  resolveStd,
} from "../src/index.ts";
import type { BridgeDocument } from "../src/index.ts";
import { BridgeLanguageService } from "../src/index.ts";
import { forEachEngine } from "./_dual-run.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
): Promise<{ data: any; traces: any[] }> {
  const raw = parseBridge(bridgeText);
  // document must survive serialisation
  const document = JSON.parse(JSON.stringify(raw)) as ReturnType<
    typeof parseBridge
  >;
  return executeBridge({
    document,
    operation,
    input,
    tools,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Language behavior tests (run against both engines)
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("executeBridge", (run, ctx) => {
  // ── Object output (per-field wires) ─────────────────────────────────────────

  describe("object output", () => {
    const bridgeText = `version 1.5
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
      "companyX.getLivingStandard": async (_p: any) => ({
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
      await run(
        bridgeText,
        "Query.livingStandard",
        { location: "Berlin" },
        spyTools,
      );
      assert.equal(geoParams.q, "Berlin");
      assert.equal(cxParams.x, 52.53);
      assert.equal(cxParams.y, 13.38);
    });
  });

  // ── Whole-object passthrough (root wire: o <- ...) ──────────────────────────

  describe("root wire passthrough", () => {
    const bridgeText = `version 1.5
bridge Query.getUser {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.id
  o <- api.user
}`;

    test("root object wire returns entire tool output", async () => {
      const tools = {
        userApi: async (_p: any) => ({
          user: { name: "Alice", age: 30, email: "alice@example.com" },
        }),
      };
      const { data } = await run(
        bridgeText,
        "Query.getUser",
        { id: "123" },
        tools,
      );
      assert.deepEqual(data, {
        name: "Alice",
        age: 30,
        email: "alice@example.com",
      });
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

  describe("tool wire expressions", () => {
    const bridgeText = `version 1.5
tool deepseekApi from httpCall {
  with context as ctx
  .headers.Authorization <- ctx.token ? "Bearer {ctx.token}" : ""
  .timeoutMs <- ctx.baseTimeout + 250
}
bridge Query.demo {
  with deepseekApi as api
  with output as o

  o.auth <- api.headers.Authorization
  o.timeoutMs <- api.timeoutMs
}`;

    test("tool defs evaluate ternary and arithmetic inputs", async () => {
      let captured: any;
      const tools = {
        httpCall: async (input: any) => {
          captured = input;
          return input;
        },
      };

      const { data } = await run(bridgeText, "Query.demo", {}, tools, {
        context: { token: "secret", baseTimeout: 750 },
      });

      assert.equal(captured.headers.Authorization, "Bearer secret");
      assert.equal(captured.timeoutMs, 1000);
      assert.deepEqual(data, {
        auth: "Bearer secret",
        timeoutMs: 1000,
      });
    });
  });

  // ── Array output (o <- items[] as x { ... }) ────────────────────────────────

  describe("array output", () => {
    const bridgeText = `version 1.5
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

  // ── Array on a sub-field (o.field <- items[] as x { ... }) ──────────────────

  describe("array mapping on sub-field", () => {
    test("o.field <- src[] as x { .renamed <- x.original } renames fields", async () => {
      const bridgeText = `version 1.5
bridge Query.catalog {
  with api as src
  with output as o

  o.title <- src.name
  o.entries <- src.items[] as item {
    .id <- item.item_id
    .label <- item.item_name
    .cost <- item.unit_price
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.catalog",
        {},
        {
          api: async () => ({
            name: "Catalog A",
            items: [
              { item_id: 1, item_name: "Widget", unit_price: 9.99 },
              { item_id: 2, item_name: "Gadget", unit_price: 14.5 },
            ],
          }),
        },
      );
      assert.deepEqual(data, {
        title: "Catalog A",
        entries: [
          { id: 1, label: "Widget", cost: 9.99 },
          { id: 2, label: "Gadget", cost: 14.5 },
        ],
      });
    });

    test("empty array on sub-field returns empty array", async () => {
      const bridgeText = `version 1.5
bridge Query.listing {
  with api as src
  with output as o

  o.count = 0
  o.items <- src.things[] as t {
    .name <- t.label
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.listing",
        {},
        { api: async () => ({ things: [] }) },
      );
      assert.deepEqual(data, { count: 0, items: [] });
    });

    test("pipe inside array block resolves iterator variable", async () => {
      const bridgeText = `version 1.5
bridge Query.catalog {
  with api as src
  with std.str.toUpperCase as upper
  with output as o

  o.entries <- src.items[] as it {
    .id <- it.id
    .label <- upper:it.name
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.catalog",
        {},
        {
          api: async () => ({
            items: [
              { id: 1, name: "widget" },
              { id: 2, name: "gadget" },
            ],
          }),
        },
      );
      assert.deepEqual(data, {
        entries: [
          { id: 1, label: "WIDGET" },
          { id: 2, label: "GADGET" },
        ],
      });
    });

    test("per-element tool call in sub-field array produces correct results", async () => {
      const bridgeText = `version 1.5
bridge Query.catalog {
  with api as src
  with enrich
  with output as o

  o.title <- src.name ?? "Untitled"
  o.entries <- src.items[] as it {
    alias enrich:it as e
    .id <- it.item_id
    .label <- e.name
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.catalog",
        {},
        {
          api: async () => ({
            name: "Catalog A",
            items: [{ item_id: 1 }, { item_id: 2 }],
          }),
          enrich: (input: any) => ({
            name: `enriched-${input.in.item_id}`,
          }),
        },
      );
      assert.deepEqual(data, {
        title: "Catalog A",
        entries: [
          { id: 1, label: "enriched-1" },
          { id: 2, label: "enriched-2" },
        ],
      });
    });

    test("ternary expression inside array block", async () => {
      const bridgeText = `version 1.5
bridge Query.catalog {
  with api as src
  with output as o

  o.entries <- src.items[] as it {
    .id <- it.id
    .active <- it.status == "active" ? true : false
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.catalog",
        {},
        {
          api: async () => ({
            items: [
              { id: 1, status: "active" },
              { id: 2, status: "inactive" },
            ],
          }),
        },
      );
      assert.deepEqual(data, {
        entries: [
          { id: 1, active: true },
          { id: 2, active: false },
        ],
      });
    });
  });

  // ── Nested object from scope blocks (o.field { .sub <- ... }) ───────────────

  describe("nested object via scope block", () => {
    test("o.field { .sub <- ... } produces nested object", async () => {
      const bridgeText = `version 1.5
bridge Query.weather {
  with weatherApi as w
  with input as i
  with output as o

  w.city <- i.city

  o.decision <- w.temperature > 20 || false catch false
  o.why {
    .temperature <- w.temperature ?? 0.0
    .city <- i.city
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.weather",
        { city: "Berlin" },
        { weatherApi: async () => ({ temperature: 25, feelsLike: 23 }) },
      );
      assert.deepEqual(data, {
        decision: true,
        why: { temperature: 25, city: "Berlin" },
      });
    });

    test("nested scope block with ?? default fills null response", async () => {
      const bridgeText = `version 1.5
bridge Query.forecast {
  with api as a
  with output as o

  o.summary {
    .temp <- a.temp ?? 0
    .wind <- a.wind ?? 0
  }
}`;
      const { data } = await run(
        bridgeText,
        "Query.forecast",
        {},
        {
          api: async () => ({ temp: null, wind: null }),
        },
      );
      assert.deepEqual(data, { summary: { temp: 0, wind: 0 } });
    });
  });

  // ── Nested arrays (o <- items[] as x { .sub <- x.things[] as y { ... } }) ──

  describe("nested arrays", () => {
    const bridgeText = `version 1.5
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

  describe("alias declarations", () => {
    test("alias pipe:iter as name — evaluates pipe once per element", async () => {
      let enrichCallCount = 0;
      const bridgeText = `version 1.5
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
      const bridgeText = `version 1.5
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
          items: [{ nested: { a: 1, b: 2 } }, { nested: { a: 3, b: 4 } }],
        }),
      };

      const { data } = await run(bridgeText, "Query.list", {}, tools);
      assert.deepEqual(data, [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ]);
    });

    test("alias tool:iter as name — tool handle ref in array", async () => {
      const bridgeText = `version 1.5
bridge Query.items {
  with api
  with std.str.toUpperCase as uc
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
      const bridgeText = `version 1.5
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

      const { data } = await run(
        bridgeText,
        "Query.test",
        { name: "alice" },
        tools,
      );
      assert.deepEqual(data, {
        greeting: "ALICE",
        label: "ALICE",
        title: "ALICE",
      });
      // pipe tool called only once despite 3 reads
      assert.equal(ucCallCount, 1);
    });

    test("top-level alias handle.path as name — simple rename", async () => {
      const bridgeText = `version 1.5
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
      const bridgeText = `version 1.5
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

    test("alias with || falsy fallback", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  with input as i

  alias i.nickname || "Guest" as displayName

  o.name <- displayName
}`;
      const { data: d1 } = await run(bridgeText, "Query.test", {
        nickname: "Alice",
      });
      assert.equal(d1.name, "Alice");
      const { data: d2 } = await run(bridgeText, "Query.test", {});
      assert.equal(d2.name, "Guest");
    });

    test("alias with ?? nullish fallback", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  with input as i

  alias i.score ?? 0 as score

  o.score <- score
}`;
      const { data: d1 } = await run(bridgeText, "Query.test", { score: 42 });
      assert.equal(d1.score, 42);
      const { data: d2 } = await run(bridgeText, "Query.test", {});
      assert.equal(d2.score, 0);
    });

    test("alias with catch error boundary", async () => {
      let callCount = 0;
      const bridgeText = `version 1.5
bridge Query.test {
  with riskyApi as api
  with output as o

  alias api.value catch 99 as safeVal

  o.result <- safeVal
}`;
      const tools: Record<string, any> = {
        riskyApi: () => {
          callCount++;
          throw new Error("Service unavailable");
        },
      };
      const { data } = await run(bridgeText, "Query.test", {}, tools);
      assert.equal(data.result, 99);
      assert.equal(callCount, 1);
    });

    test("alias with ?. safe execution", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with riskyApi as api
  with output as o

  alias api?.value as safeVal

  o.result <- safeVal || "fallback"
}`;
      const tools: Record<string, any> = {
        riskyApi: () => {
          throw new Error("Service unavailable");
        },
      };
      const { data } = await run(bridgeText, "Query.test", {}, tools);
      assert.equal(data.result, "fallback");
    });

    test("alias with math expression (+ operator)", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  alias i.price + 10 as bumped

  o.result <- bumped
}`;
      const { data } = await run(bridgeText, "Query.test", { price: 5 });
      assert.equal(data.result, 15);
    });

    test("alias with comparison expression (== operator)", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  alias i.role == "admin" as isAdmin

  o.isAdmin <- isAdmin
}`;
      const { data: d1 } = await run(bridgeText, "Query.test", {
        role: "admin",
      });
      assert.equal(d1.isAdmin, true);
      const { data: d2 } = await run(bridgeText, "Query.test", {
        role: "user",
      });
      assert.equal(d2.isAdmin, false);
    });

    test("alias with parenthesized expression", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  alias (i.a + i.b) * 2 as doubled

  o.result <- doubled
}`;
      const { data } = await run(bridgeText, "Query.test", { a: 3, b: 4 });
      assert.equal(data.result, 14);
    });

    test("alias with string literal source", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with output as o

  alias "hello world" as greeting

  o.result <- greeting
}`;
      const { data } = await run(bridgeText, "Query.test", {});
      assert.equal(data.result, "hello world");
    });

    test("alias with string literal comparison", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  alias "a" == i.val as matchesA

  o.result <- matchesA
}`;
      const { data: d1 } = await run(bridgeText, "Query.test", { val: "a" });
      assert.equal(d1.result, true);
      const { data: d2 } = await run(bridgeText, "Query.test", { val: "b" });
      assert.equal(d2.result, false);
    });

    test("alias with not prefix", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  alias not i.blocked as allowed

  o.allowed <- allowed
}`;
      const { data: d1 } = await run(bridgeText, "Query.test", {
        blocked: false,
      });
      assert.equal(d1.allowed, true);
      const { data: d2 } = await run(bridgeText, "Query.test", {
        blocked: true,
      });
      assert.equal(d2.allowed, false);
    });

    test("alias with ternary expression", async () => {
      const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  alias i.score >= 90 ? "A" : "B" as grade

  o.grade <- grade
}`;
      const { data: d1 } = await run(bridgeText, "Query.test", { score: 95 });
      assert.equal(d1.grade, "A");
      const { data: d2 } = await run(bridgeText, "Query.test", { score: 75 });
      assert.equal(d2.grade, "B");
    });
  });

  // ── Constant wires ──────────────────────────────────────────────────────────

  describe("constant wires", () => {
    const bridgeText = `version 1.5
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

  describe("tracing", () => {
    const bridgeText = `version 1.5
bridge Query.echo {
  with myTool as t
  with input as i
  with output as o

  t.x <- i.x
  o.result <- t.y
}`;

    const tools = { myTool: (p: any) => ({ y: p.x * 2 }) };

    test("traces are empty when tracing is off", async () => {
      const { traces } = await ctx.executeFn({
        document: parseBridge(bridgeText),
        operation: "Query.echo",
        input: { x: 5 },
        tools,
      });
      assert.equal(traces.length, 0);
    });

    test("traces contain tool calls when tracing is enabled", async () => {
      const { data, traces } = await ctx.executeFn({
        document: parseBridge(bridgeText),
        operation: "Query.echo",
        input: { x: 5 },
        tools,
        trace: "full",
      });
      assert.deepEqual(data, { result: 10 });
      assert.ok(traces.length > 0);
      assert.ok(traces.some((t) => t.tool === "myTool"));
    });

    test("internal concat helper does not emit trace entries", async () => {
      const { data, traces } = await ctx.executeFn({
        document: parseBridge(`version 1.5
bridge Query.echo {
  with input as i
  with output as o

  o.result <- "Hello, {i.name}!"
}`),
        operation: "Query.echo",
        input: { name: "World" },
        trace: "full",
      });

      assert.deepEqual(data, { result: "Hello, World!" });
      assert.deepEqual(traces, []);
    });

    test("stream tools emit trace entries when tracing is enabled", async () => {
      async function* httpSSE(input: { q: string }) {
        yield { chunk: `${input.q}-1` };
        yield { chunk: `${input.q}-2` };
      }
      httpSSE.bridge = { stream: true } as const;

      const { data, traces } = await ctx.executeFn({
        document: parseBridge(`version 1.5
bridge Query.echo {
  with httpSSE as s
  with input as i
  with output as o

  s.q <- i.q
  o.items <- s
}`),
        operation: "Query.echo",
        input: { q: "token" },
        tools: { httpSSE },
        trace: "full",
      });

      assert.deepEqual(data, {
        items: [{ chunk: "token-1" }, { chunk: "token-2" }],
      });
      assert.equal(traces.length, 1);
      assert.equal(traces[0]?.tool, "httpSSE");
      assert.deepEqual(traces[0]?.input, { q: "token" });
      assert.deepEqual(traces[0]?.output, [
        { chunk: "token-1" },
        { chunk: "token-2" },
      ]);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  describe("errors", () => {
    test("invalid operation format throws", async () => {
      await assert.rejects(
        () => run("version 1.5", "badformat", {}),
        /expected "Type\.field"/,
      );
    });

    test("missing bridge definition throws", async () => {
      const bridgeText = `version 1.5
bridge Query.foo {
  with output as o
  o.x = "ok"
}`;
      await assert.rejects(
        () => run(bridgeText, "Query.bar", {}),
        /No bridge definition found/,
      );
    });

    test("bridge with no output wires throws descriptive error", async () => {
      const bridgeText = `version 1.5
bridge Query.ping {
  with myTool as m
  with input as i
  with output as o

m.q <- i.q

}`;
      await assert.rejects(
        () =>
          run(
            bridgeText,
            "Query.ping",
            { q: "x" },
            { myTool: async () => ({}) },
          ),
        /no output wires/,
      );
    });
  });
}); // end forEachEngine

// ══════════════════════════════════════════════════════════════════════════════
// Runtime-specific tests (version compatibility, utilities)
// ══════════════════════════════════════════════════════════════════════════════

// ── Version compatibility ───────────────────────────────────────────────────

describe("version compatibility: getBridgeVersion", () => {
  test("extracts version from parsed document", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with output as o
  o.x = "ok"
}`);
    assert.equal(getBridgeVersion(doc), "1.5");
  });

  test("extracts future version 1.7", () => {
    const doc = parseBridge(`version 1.7
bridge Query.test {
  with output as o
  o.x = "ok"
}`);
    assert.equal(getBridgeVersion(doc), "1.7");
  });

  test("returns undefined for empty document", () => {
    assert.equal(getBridgeVersion({ instructions: [] }), undefined);
  });
});

describe("version compatibility: checkStdVersion", () => {
  const doc15 = parseBridge(`version 1.5
bridge Query.test {
  with output as o
  o.x = "ok"
}`);

  const doc17 = parseBridge(`version 1.7
bridge Query.test {
  with output as o
  o.x = "ok"
}`);

  test("bridge 1.5 + std 1.5.0 → OK", () => {
    assert.doesNotThrow(() => checkStdVersion(doc15.version, "1.5.0"));
  });

  test("bridge 1.5 + std 1.5.7 → OK (patch doesn't matter)", () => {
    assert.doesNotThrow(() => checkStdVersion(doc15.version, "1.5.7"));
  });

  test("bridge 1.5 + std 1.7.0 → OK (newer minor is backward compatible)", () => {
    assert.doesNotThrow(() => checkStdVersion(doc15.version, "1.7.0"));
  });

  test("bridge 1.7 + std 1.5.0 → ERROR (std too old)", () => {
    assert.throws(
      () => checkStdVersion(doc17.version, "1.5.0"),
      /requires standard library ≥ 1\.7.*installed.*1\.5\.0/,
    );
  });

  test("bridge 1.7 + std 1.7.0 → OK (exact match)", () => {
    assert.doesNotThrow(() => checkStdVersion(doc17.version, "1.7.0"));
  });

  test("bridge 1.7 + std 1.7.3 → OK (same minor, higher patch)", () => {
    assert.doesNotThrow(() => checkStdVersion(doc17.version, "1.7.3"));
  });

  test("bridge 1.7 + std 1.9.0 → OK (newer minor)", () => {
    assert.doesNotThrow(() => checkStdVersion(doc17.version, "1.9.0"));
  });

  test("bridge 1.7 + std 2.0.0 → ERROR (different major, suggests tools map)", () => {
    assert.throws(
      () => checkStdVersion(doc17.version, "2.0.0"),
      /requires a 1\.x standard library.*tools map/,
    );
  });

  test("no version → no error (graceful)", () => {
    assert.doesNotThrow(() => checkStdVersion(undefined, "1.5.0"));
  });
});

describe("version compatibility: executeBridge integration", () => {
  test("version 1.5 bridge executes normally on current std", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.test {
  with output as o
  o.greeting = "hello"
}`,
      "Query.test",
      {},
    );
    assert.deepStrictEqual(data, { greeting: "hello" });
  });

  test("version 1.7 bridge throws at execution time when std is 1.5", async () => {
    // The current STD_VERSION is "1.5.0", so a version 1.7 bridge should fail
    await assert.rejects(
      () =>
        run(
          `version 1.7
bridge Query.test {
  with output as o
  o.x = "ok"
}`,
          "Query.test",
          {},
        ),
      /requires standard library ≥ 1\.7/,
    );
  });
});

// ── Std resolution via versioned tools keys ─────────────────────────────────

describe("resolveStd: from versioned tools map keys", () => {
  const doc15 = parseBridge(`version 1.5
bridge Query.test {
  with output as o
  o.x = "ok"
}`);

  const bundledStd = { str: { toUpperCase: () => {} } };

  test("returns bundled std when compatible", () => {
    const result = resolveStd(doc15.version, bundledStd, "1.5.0", {});
    assert.equal(result.namespace, bundledStd);
    assert.equal(result.version, "1.5.0");
  });

  test("returns bundled std when minor is higher", () => {
    const result = resolveStd(doc15.version, bundledStd, "1.7.0", {});
    assert.equal(result.namespace, bundledStd);
    assert.equal(result.version, "1.7.0");
  });

  test("finds std@1.5 namespace from tools on major mismatch", () => {
    const oldStd = { str: { toUpperCase: () => "OLD" } };
    const result = resolveStd(doc15.version, bundledStd, "2.0.0", {
      "std@1.5": oldStd,
    });
    assert.equal(result.namespace, oldStd);
    assert.equal(result.version, "1.5.0");
  });

  test("skips std@ keys with incompatible version", () => {
    const oldStd = { str: { toUpperCase: () => "OLD" } };
    assert.throws(
      () =>
        resolveStd(doc15.version, bundledStd, "2.0.0", {
          "std@1.3": oldStd, // too old — bridge needs 1.5
        }),
      /requires a 1\.x standard library/,
    );
  });

  test("throws actionable error when no compatible std found", () => {
    assert.throws(
      () => resolveStd(doc15.version, bundledStd, "2.0.0", {}),
      (err: Error) => {
        assert.ok(err.message.includes("1.x standard library"));
        assert.ok(err.message.includes('"std@1.5"'));
        assert.ok(err.message.includes("tools map"));
        return true;
      },
    );
  });

  test("returns bundled for document without version header", () => {
    const result = resolveStd(undefined, bundledStd, "2.0.0", {});
    assert.equal(result.namespace, bundledStd);
    assert.equal(result.version, "2.0.0");
  });
});

describe("checkStdVersion: error guidance", () => {
  const doc15 = parseBridge(`version 1.5
bridge Query.test {
  with output as o
  o.x = "ok"
}`);

  test("error mentions tools map on major mismatch", () => {
    assert.throws(
      () => checkStdVersion(doc15.version, "2.0.0"),
      (err: Error) => {
        assert.ok(err.message.includes("1.x standard library"));
        assert.ok(err.message.includes("tools map"));
        return true;
      },
    );
  });

  test("error mentions the correct major the bridge needs", () => {
    assert.throws(
      () => checkStdVersion("2.0", "1.5.0"),
      /requires a 2\.x standard library/,
    );
  });
});

describe("versioned namespace keys: executeBridge integration", () => {
  test("versioned std namespace key resolves via handle version tag", async () => {
    // The handle uses @1.5, so the engine looks up "std.str.toUpperCase@1.5"
    // which finds "std@1.5" namespace key and traverses into it.
    const customStd = {
      str: {
        toUpperCase: (input: { in: string }) =>
          input.in?.toUpperCase() + "_CUSTOM_STD",
      },
    };

    const { data } = await run(
      `version 1.5
bridge Query.test {
  with std.str.toUpperCase@1.5 as up
  with output as o
  o.result <- up:o.text
}`,
      "Query.test",
      { text: "hello" },
      { "std@1.5": customStd },
    );
    assert.equal(data.result, "HELLO_CUSTOM_STD");
  });

  test("versioned sub-namespace key satisfies handle", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.test {
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.lower <- lo:o.x
}`,
      "Query.test",
      { x: "HELLO" },
      {
        "std.str@999.1": {
          toLowerCase: (input: { in: string }) =>
            input.in?.toLowerCase() + "_NS",
        },
      },
    );
    assert.equal(data.lower, "hello_NS");
  });

  test("no versioned std key falls back to bundled std", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.test {
  with std.str.toUpperCase as up
  with output as o
  o.result <- up:o.text
}`,
      "Query.test",
      { text: "hello" },
    );
    assert.equal(data.result, "HELLO");
  });

  test("flat versioned key still works alongside namespace keys", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.test {
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.lower <- lo:o.x
}`,
      "Query.test",
      { x: "HELLO" },
      {
        "std.str.toLowerCase@999.1": (input: { in: string }) =>
          input.in?.toLowerCase() + "_FLAT",
      },
    );
    assert.equal(data.lower, "hello_FLAT");
  });
});

describe("hasVersionedToolFn: versioned namespace resolution", () => {
  test("finds flat versioned key", () => {
    const tools = {
      "std.str.toLowerCase@999.1": () => {},
    };
    assert.ok(hasVersionedToolFn(tools, "std.str.toLowerCase", "999.1"));
  });

  test("finds versioned sub-namespace key", () => {
    const tools = {
      "std.str@999.1": { toLowerCase: () => {} },
    };
    assert.ok(hasVersionedToolFn(tools, "std.str.toLowerCase", "999.1"));
  });

  test("finds versioned root namespace key", () => {
    const tools = {
      "std@999.1": { str: { toLowerCase: () => {} } },
    };
    assert.ok(hasVersionedToolFn(tools, "std.str.toLowerCase", "999.1"));
  });

  test("returns false when no versioned key matches", () => {
    const tools = {
      std: { str: { toLowerCase: () => {} } },
    };
    assert.ok(!hasVersionedToolFn(tools, "std.str.toLowerCase", "999.1"));
  });
});

// ── Versioned handle validation ─────────────────────────────────────────────

describe("versioned handles: collectVersionedHandles", () => {
  test("collects @version from bridge handles", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with std.str.toUpperCase as up
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.upper <- up:o.lower
  o.lower <- lo:o.upper
}`);
    const versioned = collectVersionedHandles(doc.instructions);
    assert.equal(versioned.length, 1);
    assert.equal(versioned[0].name, "std.str.toLowerCase");
    assert.equal(versioned[0].version, "999.1");
  });

  test("returns empty for handles without @version", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with std.str.toUpperCase as up
  with output as o
  o.x <- up:o.y
}`);
    const versioned = collectVersionedHandles(doc.instructions);
    assert.equal(versioned.length, 0);
  });

  test("collects multiple versioned handles", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with std.str.toUpperCase@2.0 as up
  with std.str.toLowerCase@3.1 as lo
  with output as o
  o.upper <- up:o.lower
  o.lower <- lo:o.upper
}`);
    const versioned = collectVersionedHandles(doc.instructions);
    assert.equal(versioned.length, 2);
    assert.deepStrictEqual(
      versioned.map((v) => `${v.name}@${v.version}`),
      ["std.str.toUpperCase@2.0", "std.str.toLowerCase@3.1"],
    );
  });
});

describe("versioned handles: checkHandleVersions", () => {
  const doc = parseBridge(`version 1.5
bridge Query.test {
  with std.str.toUpperCase as up
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.upper <- up:o.lower
  o.lower <- lo:o.upper
}`);

  test("throws when versioned std tool exceeds bundled std version", () => {
    const tools = {
      std: { str: { toUpperCase: (x: any) => x, toLowerCase: (x: any) => x } },
    };
    assert.throws(
      () => checkHandleVersions(doc.instructions, tools, "1.5.0"),
      /std\.str\.toLowerCase@999\.1.*requires standard library/,
    );
  });

  test("passes when versioned tool key is explicitly provided", () => {
    const tools = {
      std: { str: { toUpperCase: (x: any) => x, toLowerCase: (x: any) => x } },
      "std.str.toLowerCase@999.1": (x: any) => x,
    };
    assert.doesNotThrow(() =>
      checkHandleVersions(doc.instructions, tools, "1.5.0"),
    );
  });

  test("passes when std version satisfies the requested version", () => {
    const tools = {
      std: { str: { toUpperCase: (x: any) => x, toLowerCase: (x: any) => x } },
    };
    // If std were at version 999.1.0, the check should pass
    assert.doesNotThrow(() =>
      checkHandleVersions(doc.instructions, tools, "999.1.0"),
    );
  });

  test("throws for non-std versioned tool without explicit provider", () => {
    const instrWithCustom = parseBridge(`version 1.5
bridge Query.test {
  with myApi.getData@2.0 as api
  with output as o
  o.x <- api.value
}`);
    assert.throws(
      () => checkHandleVersions(instrWithCustom.instructions, {}, "1.5.0"),
      /myApi\.getData@2\.0.*not available.*Provide/,
    );
  });

  test("passes for non-std versioned tool with explicit provider", () => {
    const instrWithCustom = parseBridge(`version 1.5
bridge Query.test {
  with myApi.getData@2.0 as api
  with output as o
  o.x <- api.value
}`);
    const tools = { "myApi.getData@2.0": () => ({ value: 42 }) };
    assert.doesNotThrow(() =>
      checkHandleVersions(instrWithCustom.instructions, tools, "1.5.0"),
    );
  });

  test("no versioned handles → no error", () => {
    const instrPlain = parseBridge(`version 1.5
bridge Query.test {
  with output as o
  o.x = "ok"
}`);
    assert.doesNotThrow(() =>
      checkHandleVersions(instrPlain.instructions, {}, "1.5.0"),
    );
  });
});

describe("versioned handles: executeBridge integration", () => {
  test("fails early when @version handle cannot be satisfied", async () => {
    await assert.rejects(
      () =>
        run(
          `version 1.5
bridge Query.test {
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.lower <- lo:o.x
}`,
          "Query.test",
          { x: "HELLO" },
        ),
      /std\.str\.toLowerCase@999\.1/,
    );
  });

  test("uses versioned tool when explicitly injected", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.test {
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.lower <- lo:o.x
}`,
      "Query.test",
      { x: "HELLO" },
      {
        // Provide a custom toLowerCase@999.1 that appends a marker
        "std.str.toLowerCase@999.1": (input: { in: string }) => {
          return input.in?.toLowerCase() + "_v999";
        },
      },
    );
    assert.equal(data.lower, "hello_v999");
  });

  test("unversioned handle uses bundled std, versioned uses injected", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.test {
  with std.str.toUpperCase as up
  with std.str.toLowerCase@999.1 as lo
  with input as i
  with output as o
  o.upper <- up:i.text
  o.lower <- lo:i.text
}`,
      "Query.test",
      { text: "Hello" },
      {
        "std.str.toLowerCase@999.1": (input: { in: string }) => {
          return input.in?.toLowerCase() + "_custom";
        },
      },
    );
    assert.equal(data.upper, "HELLO"); // bundled std
    assert.equal(data.lower, "hello_custom"); // injected versioned
  });
});

// ── Language service diagnostics for @version ───────────────────────────────

describe("versioned handles: language service diagnostics", () => {
  test("warns when @version exceeds bundled std version", () => {
    const svc = new BridgeLanguageService();
    svc.update(`version 1.5
bridge Query.test {
  with std.str.toLowerCase@999.1 as lo
  with output as o
  o.lower <- lo:o.x
}`);
    const diags = svc.getDiagnostics();
    const versionDiag = diags.find((d) => d.message.includes("999.1"));
    assert.ok(versionDiag, "expected a diagnostic for @999.1");
    assert.equal(versionDiag!.severity, "warning");
    assert.ok(versionDiag!.message.includes("exceeds bundled std"));
    assert.ok(
      versionDiag!.message.includes("Provide this tool version at runtime"),
    );
  });

  test("no warning when @version is within bundled std range", () => {
    const svc = new BridgeLanguageService();
    svc.update(`version 1.5
bridge Query.test {
  with std.str.toLowerCase@1.3 as lo
  with output as o
  o.lower <- lo:o.x
}`);
    const diags = svc.getDiagnostics();
    const versionDiag = diags.find((d) => d.message.includes("1.3"));
    assert.equal(versionDiag, undefined, "no version warning expected");
  });

  test("no warning for non-std versioned handles", () => {
    const svc = new BridgeLanguageService();
    svc.update(`version 1.5
bridge Query.test {
  with myApi.getData@2.0 as api
  with output as o
  o.x <- api.value
}`);
    const diags = svc.getDiagnostics();
    const versionDiag = diags.find((d) =>
      d.message.includes("exceeds bundled"),
    );
    assert.equal(
      versionDiag,
      undefined,
      "non-std tools should not trigger std version warning",
    );
  });
});

// ── mergeBridgeDocuments ────────────────────────────────────────────────────

describe("mergeBridgeDocuments", () => {
  test("empty input returns empty document", () => {
    const merged = mergeBridgeDocuments();
    assert.deepStrictEqual(merged, { instructions: [] });
  });

  test("single document is returned as-is", () => {
    const doc: BridgeDocument = {
      version: "1.5",
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "hello",
          handles: [],
          wires: [],
        },
      ],
    };
    const merged = mergeBridgeDocuments(doc);
    assert.strictEqual(merged, doc); // identity — no copy
  });

  test("instructions are concatenated in order", () => {
    const a: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "a",
          handles: [],
          wires: [],
        },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "b",
          handles: [],
          wires: [],
        },
      ],
    };
    const merged = mergeBridgeDocuments(a, b);
    assert.equal(merged.instructions.length, 2);
    assert.equal((merged.instructions[0] as any).field, "a");
    assert.equal((merged.instructions[1] as any).field, "b");
  });

  test("version is undefined when no document declares one", () => {
    const a: BridgeDocument = { instructions: [] };
    const b: BridgeDocument = { instructions: [] };
    assert.strictEqual(mergeBridgeDocuments(a, b).version, undefined);
  });

  test("version is picked from the only document that has one", () => {
    const a: BridgeDocument = { version: "1.3", instructions: [] };
    const b: BridgeDocument = { instructions: [] };
    assert.strictEqual(mergeBridgeDocuments(a, b).version, "1.3");
    assert.strictEqual(mergeBridgeDocuments(b, a).version, "1.3");
  });

  test("highest minor version wins when majors match", () => {
    const a: BridgeDocument = { version: "1.3", instructions: [] };
    const b: BridgeDocument = { version: "1.7", instructions: [] };
    const c: BridgeDocument = { version: "1.5", instructions: [] };
    assert.strictEqual(mergeBridgeDocuments(a, b, c).version, "1.7");
  });

  test("highest patch version wins when major.minor match", () => {
    const a: BridgeDocument = { version: "1.5.1", instructions: [] };
    const b: BridgeDocument = { version: "1.5.3", instructions: [] };
    const c: BridgeDocument = { version: "1.5.2", instructions: [] };
    assert.strictEqual(mergeBridgeDocuments(a, b, c).version, "1.5.3");
  });

  test("throws on different major versions", () => {
    const a: BridgeDocument = { version: "1.5", instructions: [] };
    const b: BridgeDocument = { version: "2.0", instructions: [] };
    assert.throws(
      () => mergeBridgeDocuments(a, b),
      /different major versions.*1\.5.*2\.0/,
    );
  });

  test("throws on duplicate bridge definition", () => {
    const a: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "weather",
          handles: [],
          wires: [],
        },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "weather",
          handles: [],
          wires: [],
        },
      ],
    };
    assert.throws(
      () => mergeBridgeDocuments(a, b),
      /Merge conflict.*bridge 'Query\.weather'/,
    );
  });

  test("throws on duplicate const definition", () => {
    const a: BridgeDocument = {
      instructions: [{ kind: "const", name: "API_TIMEOUT", value: "5000" }],
    };
    const b: BridgeDocument = {
      instructions: [{ kind: "const", name: "API_TIMEOUT", value: "10000" }],
    };
    assert.throws(
      () => mergeBridgeDocuments(a, b),
      /Merge conflict.*const 'API_TIMEOUT'/,
    );
  });

  test("throws on duplicate tool definition", () => {
    const a: BridgeDocument = {
      instructions: [
        { kind: "tool", name: "myHttp", fn: "std.http", deps: [], wires: [] },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        { kind: "tool", name: "myHttp", fn: "std.fetch", deps: [], wires: [] },
      ],
    };
    assert.throws(
      () => mergeBridgeDocuments(a, b),
      /Merge conflict.*tool 'myHttp'/,
    );
  });

  test("throws on duplicate define definition", () => {
    const a: BridgeDocument = {
      instructions: [
        { kind: "define", name: "secureProfile", handles: [], wires: [] },
      ],
    };
    const b: BridgeDocument = {
      instructions: [
        { kind: "define", name: "secureProfile", handles: [], wires: [] },
      ],
    };
    assert.throws(
      () => mergeBridgeDocuments(a, b),
      /Merge conflict.*define 'secureProfile'/,
    );
  });

  test("different kinds with same name do not collide", () => {
    const a: BridgeDocument = {
      instructions: [{ kind: "const", name: "myHttp", value: '"url"' }],
    };
    const b: BridgeDocument = {
      instructions: [
        { kind: "tool", name: "myHttp", fn: "std.http", deps: [], wires: [] },
      ],
    };
    // const:myHttp vs tool:myHttp — different namespaces, no collision
    const merged = mergeBridgeDocuments(a, b);
    assert.equal(merged.instructions.length, 2);
  });

  test("works end-to-end with parsed documents", async () => {
    const docA = parseBridge(`version 1.5
bridge Query.weather {
  with input as i
  with output as o
  o.city <- i.city
}`);
    const docB = parseBridge(`version 1.5
bridge Query.quote {
  with input as i
  with output as o
  o.text <- i.text
}`);
    const merged = mergeBridgeDocuments(docA, docB);
    assert.equal(merged.version, "1.5");

    const { data: weatherData } = await executeBridge<any>({
      document: merged,
      operation: "Query.weather",
      input: { city: "Berlin" },
    });
    assert.equal(weatherData.city, "Berlin");

    const { data: quoteData } = await executeBridge<any>({
      document: merged,
      operation: "Query.quote",
      input: { text: "hello" },
    });
    assert.equal(quoteData.text, "hello");
  });
});
