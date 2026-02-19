import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import type { Bridge, ConstDef, ToolDef } from "../src/types.js";
import { SELF_MODULE } from "../src/types.js";
import { createGateway } from "./_gateway.js";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Const blocks — parser, serializer, roundtrip, end-to-end
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: const blocks", () => {
  test("single const with object value", () => {
    const instructions = parseBridge(`const fallbackGeo = { "lat": 0, "lon": 0 }`);
    assert.equal(instructions.length, 1);
    const c = instructions[0] as ConstDef;
    assert.equal(c.kind, "const");
    assert.equal(c.name, "fallbackGeo");
    assert.deepStrictEqual(JSON.parse(c.value), { lat: 0, lon: 0 });
  });

  test("single const with string value", () => {
    const [c] = parseBridge(`const currency = "EUR"`) as ConstDef[];
    assert.equal(c.name, "currency");
    assert.equal(JSON.parse(c.value), "EUR");
  });

  test("single const with number value", () => {
    const [c] = parseBridge(`const limit = 10`) as ConstDef[];
    assert.equal(c.name, "limit");
    assert.equal(JSON.parse(c.value), 10);
  });

  test("single const with null", () => {
    const [c] = parseBridge(`const empty = null`) as ConstDef[];
    assert.equal(JSON.parse(c.value), null);
  });

  test("multiple const declarations in one block", () => {
    const instructions = parseBridge(`
const fallbackGeo = { "lat": 0, "lon": 0 }
const defaultCurrency = "EUR"
const maxRetries = 3
`);
    assert.equal(instructions.length, 3);
    assert.equal((instructions[0] as ConstDef).name, "fallbackGeo");
    assert.equal((instructions[1] as ConstDef).name, "defaultCurrency");
    assert.equal((instructions[2] as ConstDef).name, "maxRetries");
  });

  test("multi-line JSON object", () => {
    const [c] = parseBridge(`const geo = {
  "lat": 0,
  "lon": 0
}`) as ConstDef[];
    assert.deepStrictEqual(JSON.parse(c.value), { lat: 0, lon: 0 });
  });

  test("multi-line JSON array", () => {
    const [c] = parseBridge(`const items = [
  "a",
  "b",
  "c"
]`) as ConstDef[];
    assert.deepStrictEqual(JSON.parse(c.value), ["a", "b", "c"]);
  });

  test("const coexists with tool and bridge blocks", () => {
    const instructions = parseBridge(`
const fallback = { "lat": 0 }

---

tool myApi httpCall
  baseUrl = "https://example.com"

---

bridge Query.demo
  with myApi as a
  with input as i

result <- a.data
`);
    const consts = instructions.filter((i) => i.kind === "const");
    const tools = instructions.filter((i) => i.kind === "tool");
    const bridges = instructions.filter((i) => i.kind === "bridge");
    assert.equal(consts.length, 1);
    assert.equal(tools.length, 1);
    assert.equal(bridges.length, 1);
  });

  test("invalid JSON throws", () => {
    assert.throws(
      () => parseBridge(`const bad = { not valid json }`),
      /[Ii]nvalid JSON/,
    );
  });
});

describe("serializeBridge: const roundtrip", () => {
  test("const definitions roundtrip", () => {
    const input = `
const fallbackGeo = {"lat":0,"lon":0}
const currency = "EUR"

---

bridge Query.demo
  with input as i

result <- i.q
`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Const in bridge — with const as c, wiring c.value
// ══════════════════════════════════════════════════════════════════════════════

describe("const in bridge: end-to-end", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      info: Info
    }
    type Info {
      currency: String
      maxItems: Int
    }
  `;

  test("bridge can read const values", async () => {
    const bridgeText = `
const defaults = { "currency": "EUR", "maxItems": 100 }

---

bridge Query.info
  with const as c

currency <- c.defaults.currency
maxItems <- c.defaults.maxItems
`;

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {});
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ info { currency maxItems } }`),
    });

    assert.equal(result.data.info.currency, "EUR");
    assert.equal(result.data.info.maxItems, 100);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Tool on error — parser, serializer, roundtrip, end-to-end
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: tool on error", () => {
  test("on error = <json> is parsed as onError wire with value", () => {
    const instructions = parseBridge(`
tool myApi httpCall
  on error = { "lat": 0, "lon": 0 }
`);
    const tool = instructions[0] as ToolDef;
    const onError = tool.wires.find((w) => w.kind === "onError");
    assert.ok(onError, "should have an onError wire");
    assert.ok("value" in onError!, "should have a value");
    if ("value" in onError!) {
      assert.deepStrictEqual(JSON.parse(onError.value), { lat: 0, lon: 0 });
    }
  });

  test("on error <- source is parsed as onError wire with source", () => {
    const instructions = parseBridge(`
tool myApi httpCall
  with context
  on error <- context.fallbacks.geo
`);
    const tool = instructions[0] as ToolDef;
    const onError = tool.wires.find((w) => w.kind === "onError");
    assert.ok(onError, "should have an onError wire");
    assert.ok("source" in onError!, "should have a source");
    if ("source" in onError!) {
      assert.equal(onError.source, "context.fallbacks.geo");
    }
  });

  test("on error multi-line JSON", () => {
    const instructions = parseBridge(`
tool myApi httpCall
  on error = {
    "lat": 0,
    "lon": 0
  }
`);
    const tool = instructions[0] as ToolDef;
    const onError = tool.wires.find((w) => w.kind === "onError");
    assert.ok(onError && "value" in onError);
    if ("value" in onError!) {
      assert.deepStrictEqual(JSON.parse(onError.value), { lat: 0, lon: 0 });
    }
  });

  test("child tool inherits parent on error", () => {
    const instructions = parseBridge(`
tool base httpCall
  on error = { "fallback": true }

tool base.child extends base
  method = GET
`);
    // The engine resolves extends chains at runtime, so we just verify
    // the parent has the on error wire
    const base = instructions.find(
      (i): i is ToolDef => i.kind === "tool" && i.name === "base",
    )!;
    assert.ok(base.wires.some((w) => w.kind === "onError"));
  });
});

describe("serializeBridge: tool on error roundtrip", () => {
  test("on error = <json> roundtrips", () => {
    const input = `
tool myApi httpCall
  on error = {"lat":0,"lon":0}
`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });

  test("on error <- source roundtrips", () => {
    const input = `
tool myApi httpCall
  with context
  on error <- context.fallbacks.geo
`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });
});

describe("tool on error: end-to-end", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      geo(q: String!): Geo
    }
    type Geo {
      lat: Float
      lon: Float
    }
  `;

  test("on error = <json> returns fallback when tool throws", async () => {
    const bridgeText = `
tool flakyApi httpCall
  on error = { "lat": 0, "lon": 0 }

---

bridge Query.geo
  with flakyApi as api
  with input as i

api.q <- i.q
lat <- api.lat
lon <- api.lon
`;

    const tools: Record<string, any> = {
      httpCall: async () => { throw new Error("Service unavailable"); },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ geo(q: "Berlin") { lat lon } }`),
    });

    assert.equal(result.data.geo.lat, 0);
    assert.equal(result.data.geo.lon, 0);
  });

  test("on error <- context returns context fallback when tool throws", async () => {
    const bridgeText = `
tool flakyApi httpCall
  with context
  on error <- context.fallbacks.geo

---

bridge Query.geo
  with flakyApi as api
  with input as i

api.q <- i.q
lat <- api.lat
lon <- api.lon
`;

    const tools: Record<string, any> = {
      httpCall: async () => { throw new Error("Service unavailable"); },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools,
      context: { fallbacks: { geo: { lat: 52.52, lon: 13.4 } } },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ geo(q: "Berlin") { lat lon } }`),
    });

    assert.equal(result.data.geo.lat, 52.52);
    assert.equal(result.data.geo.lon, 13.4);
  });

  test("on error is NOT used when tool succeeds", async () => {
    const bridgeText = `
tool api httpCall
  on error = { "lat": 0, "lon": 0 }

---

bridge Query.geo
  with api
  with input as i

api.q <- i.q
lat <- api.lat
lon <- api.lon
`;

    const tools: Record<string, any> = {
      httpCall: async () => ({ lat: 52.52, lon: 13.4 }),
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ geo(q: "Berlin") { lat lon } }`),
    });

    assert.equal(result.data.geo.lat, 52.52);
    assert.equal(result.data.geo.lon, 13.4);
  });

  test("child inherits parent on error through extends chain", async () => {
    const bridgeText = `
tool base httpCall
  on error = { "lat": 0, "lon": 0 }

tool base.child extends base
  method = GET
  path = /geocode

---

bridge Query.geo
  with base.child as api
  with input as i

api.q <- i.q
lat <- api.lat
lon <- api.lon
`;

    const tools: Record<string, any> = {
      httpCall: async () => { throw new Error("timeout"); },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ geo(q: "Berlin") { lat lon } }`),
    });

    assert.equal(result.data.geo.lat, 0);
    assert.equal(result.data.geo.lon, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Wire fallback (??) — parser, serializer, roundtrip, end-to-end
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: wire fallback (??)", () => {
  test("?? adds fallback to pull wire", () => {
    const [bridge] = parseBridge(`
bridge Query.demo
  with myApi as a
  with input as i

a.q <- i.q
lat <- a.lat ?? 0
`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire, "should have a wire with fallback");
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, "0");
    }
  });

  test("?? with JSON object fallback", () => {
    const [bridge] = parseBridge(`
bridge Query.demo
  with myApi as a
  with input as i

result <- a.data ?? {"default":true}
`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire);
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, `{"default":true}`);
    }
  });

  test("?? with string fallback", () => {
    const [bridge] = parseBridge(`
bridge Query.demo
  with myApi as a
  with input as i

name <- a.name ?? "unknown"
`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire);
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, `"unknown"`);
    }
  });

  test("?? with null fallback", () => {
    const [bridge] = parseBridge(`
bridge Query.demo
  with myApi as a
  with input as i

name <- a.name ?? null
`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire);
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, "null");
    }
  });

  test("?? on pipe chain attaches to output wire", () => {
    const [bridge] = parseBridge(`
bridge Query.demo
  with transform as t
  with input as i

result <- t|i.text ?? "fallback"
`) as Bridge[];

    // The output wire (pipe=true, from fork root → target) should have the fallback
    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire, "should have pipe output wire with fallback");
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, `"fallback"`);
    }
  });

  test("wires without ?? have no fallback property", () => {
    const [bridge] = parseBridge(`
bridge Query.demo
  with myApi as a
  with input as i

a.q <- i.q
result <- a.data
`) as Bridge[];

    for (const w of bridge.wires) {
      if ("from" in w) {
        assert.equal(w.fallback, undefined, "no fallback on regular wire");
      }
    }
  });
});

describe("serializeBridge: wire fallback roundtrip", () => {
  test("?? on regular wire roundtrips", () => {
    const input = `
bridge Query.demo
  with myApi as a
  with input as i

a.q <- i.q
lat <- a.lat ?? 0
`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });

  test("?? on pipe chain roundtrips", () => {
    const input = `
bridge Query.demo
  with transform as t
  with input as i

result <- t|i.text ?? "fallback"
`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });

  test("serialized output contains ??", () => {
    const input = `
bridge Query.demo
  with myApi as a
  with input as i

lat <- a.lat ?? 0
`;
    const output = serializeBridge(parseBridge(input));
    assert.ok(output.includes("??"), "serialized output should contain ??");
  });
});

describe("wire fallback: end-to-end", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      lookup(q: String!): LookupResult
    }
    type LookupResult {
      lat: Float
      name: String
    }
  `;

  test("?? returns fallback when entire chain fails", async () => {
    const bridgeText = `
bridge Query.lookup
  with myApi as api
  with input as i

api.q <- i.q
lat <- api.lat ?? 0
name <- api.name ?? "unknown"
`;

    const tools: Record<string, any> = {
      myApi: async () => { throw new Error("down"); },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "test") { lat name } }`),
    });

    assert.equal(result.data.lookup.lat, 0);
    assert.equal(result.data.lookup.name, "unknown");
  });

  test("?? is NOT used when source succeeds", async () => {
    const bridgeText = `
bridge Query.lookup
  with myApi as api
  with input as i

api.q <- i.q
lat <- api.lat ?? 0
name <- api.name ?? "unknown"
`;

    const tools: Record<string, any> = {
      myApi: async () => ({ lat: 52.52, name: "Berlin" }),
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "test") { lat name } }`),
    });

    assert.equal(result.data.lookup.lat, 52.52);
    assert.equal(result.data.lookup.name, "Berlin");
  });

  test("?? catches chain failure (dep tool fails)", async () => {
    const bridgeText = `
tool flakyGeo httpCall
  baseUrl = "https://broken.test"

---

bridge Query.lookup
  with flakyGeo as geo
  with input as i

geo.q <- i.q
lat <- geo.lat ?? -999
name <- geo.name ?? "N/A"
`;

    const tools: Record<string, any> = {
      httpCall: async () => { throw new Error("network"); },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "test") { lat name } }`),
    });

    assert.equal(result.data.lookup.lat, -999);
    assert.equal(result.data.lookup.name, "N/A");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Combined: on error + ?? + const together
// ══════════════════════════════════════════════════════════════════════════════

describe("combined: on error + ?? + const", () => {
  test("on error provides tool fallback, ?? provides wire fallback as last resort", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        search(q: String!): SearchResult
      }
      type SearchResult {
        lat: Float
        lon: Float
        extra: String
      }
    `;

    // Tool has on error, so lat/lon come from there.
    // 'extra' has no tool fallback but has wire ??
    const bridgeText = `
tool geo httpCall
  on error = { "lat": 0, "lon": 0 }

---

bridge Query.search
  with geo
  with badApi as bad
  with input as i

geo.q <- i.q
lat <- geo.lat
lon <- geo.lon
bad.q <- i.q
extra <- bad.data ?? "none"
`;

    const tools: Record<string, any> = {
      httpCall: async () => { throw new Error("down"); },
      badApi: async () => { throw new Error("also down"); },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "test") { lat lon extra } }`),
    });

    // geo tool's on error kicks in
    assert.equal(result.data.search.lat, 0);
    assert.equal(result.data.search.lon, 0);
    // badApi has no on error, but wire ?? catches
    assert.equal(result.data.search.extra, "none");
  });
});
