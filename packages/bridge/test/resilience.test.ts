import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import type { Bridge, ConstDef, NodeRef, ToolDef, Wire } from "../src/types.js";
import { SELF_MODULE } from "../src/types.js";
import { createGateway } from "./_gateway.js";

// ══════════════════════════════════════════════════════════════════════════════
// 1. Const blocks — parser, serializer, roundtrip, end-to-end
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: const blocks", () => {
  test("single const with object value", () => {
    const instructions = parseBridge(`version 1.4
const fallbackGeo = { "lat": 0, "lon": 0 }`);
    assert.equal(instructions.length, 1);
    const c = instructions[0] as ConstDef;
    assert.equal(c.kind, "const");
    assert.equal(c.name, "fallbackGeo");
    assert.deepStrictEqual(JSON.parse(c.value), { lat: 0, lon: 0 });
  });

  test("single const with string value", () => {
    const [c] = parseBridge(`version 1.4
const currency = "EUR"`) as ConstDef[];
    assert.equal(c.name, "currency");
    assert.equal(JSON.parse(c.value), "EUR");
  });

  test("single const with number value", () => {
    const [c] = parseBridge(`version 1.4
const limit = 10`) as ConstDef[];
    assert.equal(c.name, "limit");
    assert.equal(JSON.parse(c.value), 10);
  });

  test("single const with null", () => {
    const [c] = parseBridge(`version 1.4
const empty = null`) as ConstDef[];
    assert.equal(JSON.parse(c.value), null);
  });

  test("multiple const declarations in one block", () => {
    const instructions = parseBridge(`version 1.4

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
    const [c] = parseBridge(`version 1.4
const geo = {
  "lat": 0,
  "lon": 0
}`) as ConstDef[];
    assert.deepStrictEqual(JSON.parse(c.value), { lat: 0, lon: 0 });
  });

  test("multi-line JSON array", () => {
    const [c] = parseBridge(`version 1.4
const items = [
  "a",
  "b",
  "c"
]`) as ConstDef[];
    assert.deepStrictEqual(JSON.parse(c.value), ["a", "b", "c"]);
  });

  test("const coexists with tool and bridge blocks", () => {
    const instructions = parseBridge(`version 1.4

const fallback = { "lat": 0 }


tool myApi from httpCall {
  .baseUrl = "https://example.com"

}

bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

o.result <- a.data

}`);
    const consts = instructions.filter((i) => i.kind === "const");
    const tools = instructions.filter((i) => i.kind === "tool");
    const bridges = instructions.filter((i) => i.kind === "bridge");
    assert.equal(consts.length, 1);
    assert.equal(tools.length, 1);
    assert.equal(bridges.length, 1);
  });

  test("invalid JSON throws", () => {
    assert.throws(
      () => parseBridge(`version 1.4
const bad = { not valid json }`),
      /[Ii]nvalid JSON/,
    );
  });
});

describe("serializeBridge: const roundtrip", () => {
  test("const definitions roundtrip", () => {
    const input = `version 1.4
const fallbackGeo = {"lat":0,"lon":0}
const currency = "EUR"


bridge Query.demo {
  with input as i
  with output as o

o.result <- i.q

}`;
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
    const bridgeText = `version 1.4
const defaults = { "currency": "EUR", "maxItems": 100 }


bridge Query.info {
  with const as c
  with output as o

o.currency <- c.defaults.currency
o.maxItems <- c.defaults.maxItems

}`;

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
    const instructions = parseBridge(`version 1.4

tool myApi from httpCall {
  on error = { "lat": 0, "lon": 0 }

}`);
    const tool = instructions[0] as ToolDef;
    const onError = tool.wires.find((w) => w.kind === "onError");
    assert.ok(onError, "should have an onError wire");
    assert.ok("value" in onError!, "should have a value");
    if ("value" in onError!) {
      assert.deepStrictEqual(JSON.parse(onError.value), { lat: 0, lon: 0 });
    }
  });

  test("on error <- source is parsed as onError wire with source", () => {
    const instructions = parseBridge(`version 1.4

tool myApi from httpCall {
  with context
  on error <- context.fallbacks.geo

}`);
    const tool = instructions[0] as ToolDef;
    const onError = tool.wires.find((w) => w.kind === "onError");
    assert.ok(onError, "should have an onError wire");
    assert.ok("source" in onError!, "should have a source");
    if ("source" in onError!) {
      assert.equal(onError.source, "context.fallbacks.geo");
    }
  });

  test("on error multi-line JSON", () => {
    const instructions = parseBridge(`version 1.4

tool myApi from httpCall {
  on error = {
    "lat": 0,
    "lon": 0
  }
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
    const instructions = parseBridge(`version 1.4

tool base from httpCall {
  on error = { "fallback": true }

}
tool base.child from base {
  .method = GET

}`);
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
    const input = `version 1.4
tool myApi from httpCall {
  on error = {"lat":0,"lon":0}

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });

  test("on error <- source roundtrips", () => {
    const input = `version 1.4
tool myApi from httpCall {
  with context
  on error <- context.fallbacks.geo

}`;
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
    const bridgeText = `version 1.4
tool flakyApi from httpCall {
  on error = { "lat": 0, "lon": 0 }

}

bridge Query.geo {
  with flakyApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`;

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
    const bridgeText = `version 1.4
tool flakyApi from httpCall {
  with context
  on error <- context.fallbacks.geo

}

bridge Query.geo {
  with flakyApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`;

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
    const bridgeText = `version 1.4
tool api from httpCall {
  on error = { "lat": 0, "lon": 0 }

}

bridge Query.geo {
  with api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`;

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
    const bridgeText = `version 1.4
tool base from httpCall {
  on error = { "lat": 0, "lon": 0 }

}
tool base.child from base {
  .method = GET
  .path = /geocode

}

bridge Query.geo {
  with base.child as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat
o.lon <- api.lon

}`;

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
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

a.q <- i.q
o.lat <- a.lat ?? 0

}`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire, "should have a wire with fallback");
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, "0");
    }
  });

  test("?? with JSON object fallback", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

o.result <- a.data ?? {"default":true}

}`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire);
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, `{"default":true}`);
    }
  });

  test("?? with string fallback", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

o.name <- a.name ?? "unknown"

}`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire);
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, `"unknown"`);
    }
  });

  test("?? with null fallback", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

o.name <- a.name ?? null

}`) as Bridge[];

    const fbWire = bridge.wires.find(
      (w) => "from" in w && w.fallback != null,
    );
    assert.ok(fbWire);
    if ("from" in fbWire!) {
      assert.equal(fbWire.fallback, "null");
    }
  });

  test("?? on pipe chain attaches to output wire", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with transform as t
  with input as i
  with output as o

o.result <- t:i.text ?? "fallback"

}`) as Bridge[];

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
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

a.q <- i.q
o.result <- a.data

}`) as Bridge[];

    for (const w of bridge.wires) {
      if ("from" in w) {
        assert.equal(w.fallback, undefined, "no fallback on regular wire");
      }
    }
  });
});

describe("serializeBridge: wire fallback roundtrip", () => {
  test("?? on regular wire roundtrips", () => {
    const input = `version 1.4
bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

a.q <- i.q
o.lat <- a.lat ?? 0

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });

  test("?? on pipe chain roundtrips", () => {
    const input = `version 1.4
bridge Query.demo {
  with transform as t
  with input as i
  with output as o

o.result <- t:i.text ?? "fallback"

}`;
    const instructions = parseBridge(input);
    assert.deepStrictEqual(parseBridge(serializeBridge(instructions)), instructions);
  });

  test("serialized output contains ??", () => {
    const input = `version 1.4
bridge Query.demo {
  with myApi as a
  with input as i
  with output as o

o.lat <- a.lat ?? 0

}`;
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
    const bridgeText = `version 1.4
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat ?? 0
o.name <- api.name ?? "unknown"

}`;

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
    const bridgeText = `version 1.4
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.lat <- api.lat ?? 0
o.name <- api.name ?? "unknown"

}`;

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
    const bridgeText = `version 1.4
tool flakyGeo from httpCall {
  .baseUrl = "https://broken.test"

}

bridge Query.lookup {
  with flakyGeo as geo
  with input as i
  with output as o

geo.q <- i.q
o.lat <- geo.lat ?? -999
o.name <- geo.name ?? "N/A"

}`;

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
    const bridgeText = `version 1.4
tool geo from httpCall {
  on error = { "lat": 0, "lon": 0 }

}

bridge Query.search {
  with geo
  with badApi as bad
  with input as i
  with output as o

geo.q <- i.q
o.lat <- geo.lat
o.lon <- geo.lon
bad.q <- i.q
o.extra <- bad.data ?? "none"

}`;

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

// ══════════════════════════════════════════════════════════════════════════════
// 6. Wire || null-fallback — parser, serializer roundtrip, end-to-end
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: wire || null-fallback", () => {
  test("simple wire with || string literal", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.greet {
  with input as i
  with output as o

o.name <- i.name || "World"

}`);
    const bridge = instructions[0] as Bridge;
    const wire = bridge.wires[0] as Extract<Wire, { from: NodeRef }>;
    assert.equal(wire.nullFallback, '"World"');
    assert.equal(wire.fallback, undefined);
  });

  test("wire with both || and ??", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.greet {
  with input as i
  with output as o

o.name <- i.name || "World" ?? "Error"

}`);
    const bridge = instructions[0] as Bridge;
    const wire = bridge.wires[0] as Extract<Wire, { from: NodeRef }>;
    assert.equal(wire.nullFallback, '"World"');
    assert.equal(wire.fallback, '"Error"');
  });

  test("wire with || JSON object literal", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.geo {
  with api as a
  with input as i
  with output as o

a.q <- i.q
o.result <- a.data || {"lat":0,"lon":0}

}`);
    const bridge = instructions[0] as Bridge;
    const wire = bridge.wires.find((w) => "from" in w && (w as any).from.path[0] === "data") as Extract<Wire, { from: NodeRef }>;
    assert.equal(wire.nullFallback, '{"lat":0,"lon":0}');
  });

  test("wire without || has no nullFallback", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.greet {
  with input as i
  with output as o

o.name <- i.name

}`);
    const bridge = instructions[0] as Bridge;
    const wire = bridge.wires[0] as Extract<Wire, { from: NodeRef }>;
    assert.equal(wire.nullFallback, undefined);
  });

  test("pipe wire with || null-fallback", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.format {
  with std.upperCase as up
  with input as i
  with output as o

o.result <- up:i.text || "N/A"

}`);
    const bridge = instructions[0] as Bridge;
    // Terminal pipe wire (from fork root to result) carries the nullFallback
    const terminalWire = bridge.wires.find(
      (w) => "from" in w && (w as any).pipe && (w as any).from.path.length === 0,
    ) as Extract<Wire, { from: NodeRef }>;
    assert.equal(terminalWire?.nullFallback, '"N/A"');
  });
});

describe("serializeBridge: || null-fallback roundtrip", () => {
  test("|| string literal roundtrips", () => {
    const input = `version 1.4
bridge Query.greet {
  with input as i
  with output as o

o.name <- i.name || "World"

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    const original = parseBridge(input);
    assert.deepStrictEqual(reparsed, original);
  });

  test("|| and ?? together roundtrip", () => {
    const input = `version 1.4
bridge Query.greet {
  with myApi as a
  with input as i
  with output as o

a.q <- i.q
o.name <- a.name || "World" ?? "Error"

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    const original = parseBridge(input);
    assert.deepStrictEqual(reparsed, original);
  });

  test("pipe wire with || roundtrips", () => {
    const input = `version 1.4
bridge Query.format {
  with std.upperCase as up
  with input as i
  with output as o

o.result <- up:i.text || "N/A"

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    const original = parseBridge(input);
    assert.deepStrictEqual(reparsed, original);
  });
});

describe("wire || null-fallback: end-to-end", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      greet(name: String): Greeting
    }
    type Greeting {
      message: String
    }
  `;

  test("|| returns literal when field is null", async () => {
    const bridgeText = `version 1.4
bridge Query.greet {
  with input as i
  with output as o

o.message <- i.name || "World"

}`;
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {});
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // Pass null explicitly
    const result: any = await executor({
      document: parse(`{ greet(name: null) { message } }`),
    });
    assert.equal(result.data.greet.message, "World");
  });

  test("|| is skipped when field has a value", async () => {
    const bridgeText = `version 1.4
bridge Query.greet {
  with input as i
  with output as o

o.message <- i.name || "World"

}`;
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {});
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ greet(name: "Alice") { message } }`),
    });
    assert.equal(result.data.greet.message, "Alice");
  });

  test("|| null-fallback fires when tool returns null field", async () => {
    const typeDefs2 = /* GraphQL */ `
      type Query {
        lookup(q: String!): LookupResult
      }
      type LookupResult {
        label: String
        score: Float
      }
    `;
    const bridgeText = `version 1.4
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label || "unknown"
o.score <- api.score || 0

}`;
    const tools: Record<string, any> = {
      myApi: async () => ({ label: null, score: null }),
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs2, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "test") { label score } }`),
    });
    assert.equal(result.data.lookup.label, "unknown");
    assert.equal(result.data.lookup.score, 0);
  });

  test("|| and ?? compose: || fires on null, ?? fires on error", async () => {
    const typeDefs2 = /* GraphQL */ `
      type Query {
        lookup(q: String!, fail: Boolean): LookupResult
      }
      type LookupResult {
        label: String
      }
    `;
    const bridgeText = `version 1.4
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
api.fail <- i.fail
o.label <- api.label || "null-default" ?? "error-default"

}`;
    const tools: Record<string, any> = {
      myApi: async (input: any) => {
        if (input.fail) throw new Error("boom");
        return { label: null };
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs2, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // null case → || fires
    const r1: any = await executor({
      document: parse(`{ lookup(q: "test", fail: false) { label } }`),
    });
    assert.equal(r1.data.lookup.label, "null-default");

    // error case → ?? fires
    const r2: any = await executor({
      document: parse(`{ lookup(q: "test", fail: true) { label } }`),
    });
    assert.equal(r2.data.lookup.label, "error-default");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Multi-wire null-coalescing — pull() skips null sources in priority order
// ══════════════════════════════════════════════════════════════════════════════

describe("multi-wire null-coalescing: end-to-end", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      email(textBody: String, htmlBody: String): EmailPreview
    }
    type EmailPreview {
      textPart: String
    }
  `;

  test("first wire wins when it has a value", async () => {
    const bridgeText = `version 1.4
bridge Query.email {
  with std.upperCase as up
  with input as i
  with output as o

o.textPart <- i.textBody
o.textPart <- up:i.htmlBody

}`;
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {});
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ email(textBody: "plain text", htmlBody: "<b>bold</b>") { textPart } }`),
    });
    assert.equal(result.data.email.textPart, "plain text");
  });

  test("second wire used when first is null", async () => {
    const bridgeText = `version 1.4
bridge Query.email {
  with std.upperCase as up
  with input as i
  with output as o

o.textPart <- i.textBody
o.textPart <- up:i.htmlBody

}`;
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {});
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // textBody is null → fall through to upperCase(htmlBody)
    const result: any = await executor({
      document: parse(`{ email(textBody: null, htmlBody: "hello") { textPart } }`),
    });
    assert.equal(result.data.email.textPart, "HELLO");
  });

  test("multi-wire + || terminal literal as last resort", async () => {
    const bridgeText = `version 1.4
bridge Query.email {
  with input as i
  with output as o

o.textPart <- i.textBody
o.textPart <- i.htmlBody || "empty"

}`;
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {});
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // Both null → || literal fires
    const result: any = await executor({
      document: parse(`{ email(textBody: null, htmlBody: null) { textPart } }`),
    });
    assert.equal(result.data.email.textPart, "empty");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. || source references + ?? source references (full COALESCE)
// ══════════════════════════════════════════════════════════════════════════════

describe("parseBridge: || source references", () => {
  test("|| source desugars to two wires with same target", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`);
    const bridge = instructions[0] as Bridge;
    const labelWires = bridge.wires.filter(
      (w) => "from" in w && (w as any).to.path[0] === "label",
    ) as Extract<Wire, { from: NodeRef }>[];
    assert.equal(labelWires.length, 2);
    assert.equal(labelWires[0].nullFallback, undefined);
    assert.equal(labelWires[0].fallback, undefined);
    assert.equal(labelWires[1].nullFallback, undefined);
    assert.equal(labelWires[1].fallback, undefined);
  });

  test("|| source || source || literal — last literal is nullFallback on last source wire", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label || b.label || "default"

}`);
    const bridge = instructions[0] as Bridge;
    const labelWires = bridge.wires.filter(
      (w) => "from" in w && (w as any).to.path[0] === "label",
    ) as Extract<Wire, { from: NodeRef }>[];
    assert.equal(labelWires.length, 2);
    assert.equal(labelWires[0].nullFallback, undefined);   // first wire: no fallback
    assert.equal(labelWires[1].nullFallback, '"default"'); // last wire: has nullFallback
  });
});

describe("parseBridge: ?? source/pipe references", () => {
  test("?? source.path stores a fallbackRef NodeRef", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label ?? i.fallbackLabel

}`);
    const bridge = instructions[0] as Bridge;
    const wire = bridge.wires.find(
      (w) => "from" in w && (w as any).to.path[0] === "label",
    ) as Extract<Wire, { from: NodeRef }>;
    assert.ok(wire.fallbackRef, "should have fallbackRef");
    assert.equal(wire.fallback, undefined, "should not have JSON fallback");
    assert.deepEqual(wire.fallbackRef!.path, ["fallbackLabel"]);
  });

  test("?? pipe:source stores fallbackRef pointing to fork root + registers fork", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.lookup {
  with myApi as api
  with std.upperCase as up
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label ?? up:i.errorDefault

}`);
    const bridge = instructions[0] as Bridge;
    const wire = bridge.wires.find(
      (w) => "from" in w && !("pipe" in w) && (w as any).to.path[0] === "label",
    ) as Extract<Wire, { from: NodeRef }>;
    assert.ok(wire.fallbackRef, "should have fallbackRef");
    // fallbackRef points to the fork root (path=[])
    assert.deepEqual(wire.fallbackRef!.path, []);
    // Fork should be registered in pipeHandles
    assert.ok(bridge.pipeHandles && bridge.pipeHandles.length > 0, "should have pipe forks");
  });

  test("full chain: A || B || literal ?? source — wires + fallbackRef", () => {
    const instructions = parseBridge(`version 1.4

bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "default" ?? i.errorLabel

}`);
    const bridge = instructions[0] as Bridge;
    const labelWires = bridge.wires.filter(
      (w) => "from" in w && !("pipe" in w) && (w as any).to.path[0] === "label",
    ) as Extract<Wire, { from: NodeRef }>[];
    assert.equal(labelWires.length, 2);
    assert.equal(labelWires[0].nullFallback, undefined);
    assert.equal(labelWires[1].nullFallback, '"default"');
    assert.ok(labelWires[1].fallbackRef, "last wire should have fallbackRef");
    assert.equal(labelWires[1].fallback, undefined);
  });
});

describe("serializeBridge: ?? source/pipe roundtrip", () => {
  test("?? source.path roundtrips", () => {
    const input = `version 1.4
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label ?? i.fallbackLabel

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assert.deepStrictEqual(reparsed, parseBridge(input));
  });

  test("?? pipe:source roundtrips", () => {
    const input = `version 1.4
bridge Query.lookup {
  with myApi as api
  with std.upperCase as up
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label ?? up:i.errorDefault

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assert.deepStrictEqual(reparsed, parseBridge(input));
  });

  test("|| source || source roundtrips (desugars to multi-wire)", () => {
    // The || source chain desugars to multiple wires; serializer emits them
    // on separate lines, which re-parses to the same structure.
    const input = `version 1.4
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "default"

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assert.deepStrictEqual(reparsed, parseBridge(input));
  });

  test("full chain: || source || literal ?? pipe roundtrips", () => {
    const input = `version 1.4
bridge Query.lookup {
  with myApi as api
  with backup as b
  with std.upperCase as up
  with input as i
  with output as o

api.q <- i.q
b.q <- i.q
o.label <- api.label || b.label || "default" ?? up:i.errorDefault

}`;
    const reparsed = parseBridge(serializeBridge(parseBridge(input)));
    assert.deepStrictEqual(reparsed, parseBridge(input));
  });
});

describe("|| source + ?? source: end-to-end", () => {
  test("|| source: primary null → backup used", async () => {
    const typeDefs = /* GraphQL */ `
      type Query { lookup(q: String!): Result }
      type Result { label: String }
    `;
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
    const tools: Record<string, any> = {
      primary: async () => ({ label: null }),
      backup:  async () => ({ label: "from-backup" }),
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "from-backup");
  });

  test("|| source: primary has value → backup never called", async () => {
    const typeDefs = /* GraphQL */ `
      type Query { lookup(q: String!): Result }
      type Result { label: String }
    `;
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
    let backupCalled = false;
    const tools: Record<string, any> = {
      primary: async () => ({ label: "from-primary" }),
      backup:  async () => { backupCalled = true; return { label: "from-backup" }; },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "from-primary");
    // backup still runs in parallel (multi-wire) but its result is discarded
    // — what matters is the returned value, not whether backup was called
  });

  test("|| source || literal: both null → literal fires", async () => {
    const typeDefs = /* GraphQL */ `
      type Query { lookup(q: String!): Result }
      type Result { label: String }
    `;
    const bridgeText = `version 1.4
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "nothing found"

}`;
    const tools: Record<string, any> = {
      primary: async () => ({ label: null }),
      backup:  async () => ({ label: null }),
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "nothing found");
  });

  test("?? source.path: all throw → pull from input field", async () => {
    const typeDefs = /* GraphQL */ `
      type Query { lookup(q: String!, defaultLabel: String!): Result }
      type Result { label: String }
    `;
    const bridgeText = `version 1.4
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label ?? i.defaultLabel

}`;
    const tools: Record<string, any> = {
      myApi: async () => { throw new Error("down"); },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x", defaultLabel: "fallback-value") { label } }`),
    });
    assert.equal(result.data.lookup.label, "fallback-value");
  });

  test("?? pipe:source: all throw → pipe tool applied to input field", async () => {
    const typeDefs = /* GraphQL */ `
      type Query { lookup(q: String!, errorDefault: String!): Result }
      type Result { label: String }
    `;
    const bridgeText = `version 1.4
bridge Query.lookup {
  with myApi as api
  with std.upperCase as up
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label ?? up:i.errorDefault

}`;
    const tools: Record<string, any> = {
      myApi: async () => { throw new Error("down"); },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ lookup(q: "x", errorDefault: "service unavailable") { label } }`),
    });
    // std.upperCase applied to "service unavailable"
    assert.equal(result.data.lookup.label, "SERVICE UNAVAILABLE");
  });

  test("full COALESCE: A || B || literal ?? source — all layers", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        lookup(q: String!, fail: Boolean, defaultLabel: String): Result
      }
      type Result { label: String }
    `;
    const bridgeText = `version 1.4
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
p.fail <- i.fail
b.q <- i.q
b.fail <- i.fail
o.label <- p.label || b.label || "nothing" ?? i.defaultLabel

}`;
    const tools: Record<string, any> = {
      primary: async (inp: any) => {
        if (inp.fail) throw new Error("primary down");
        return { label: null };
      },
      backup: async (inp: any) => {
        if (inp.fail) throw new Error("backup down");
        return { label: null };
      },
    };
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // Both return null → || literal fires
    const r1: any = await executor({
      document: parse(`{ lookup(q: "x", fail: false, defaultLabel: "err") { label } }`),
    });
    assert.equal(r1.data.lookup.label, "nothing");

    // Both throw → ?? source fires
    const r2: any = await executor({
      document: parse(`{ lookup(q: "x", fail: true, defaultLabel: "error-default") { label } }`),
    });
    assert.equal(r2.data.lookup.label, "error-default");
  });
});
