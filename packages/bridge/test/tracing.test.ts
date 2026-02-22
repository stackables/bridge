import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ToolTrace } from "../src/ExecutionTree.js";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tracing / Observability
//
// When `trace: true`, every tool invocation is recorded and returned in
// `extensions.traces` as an ordered array of ToolTrace objects.
// ═══════════════════════════════════════════════════════════════════════════

const typeDefs = /* GraphQL */ `
  type Query {
    lookup(q: String!): Result
    search(q: String!): SearchResult
  }
  type Result {
    label: String
    score: Int
  }
  type SearchResult {
    items: [Item!]!
  }
  type Item {
    name: String
  }
`;

// ── Helper ────────────────────────────────────────────────────────────────

async function execute(
  bridgeText: string,
  query: string,
  tools: Record<string, any>,
): Promise<{ data: any; traces: ToolTrace[] }> {
  const instructions = parseBridge(bridgeText);
  const gateway = createGateway(typeDefs, instructions, {
    tools,
    trace: "full",
  });
  const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
  const result: any = await executor({ document: parse(query) });
  return {
    data: result.data,
    traces: result.extensions?.traces ?? [],
  };
}

// ── Basic tracing ─────────────────────────────────────────────────────────

describe("tracing: basics", () => {
  test("traces are returned when trace is enabled", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;
    const { data, traces } = await execute(
      bridge,
      `{ lookup(q: "Berlin") { label } }`,
      { geocoder: async () => ({ label: "Berlin, DE" }) },
    );

    assert.equal(data.lookup.label, "Berlin, DE");
    assert.equal(traces.length, 1);
    assert.equal(traces[0].tool, "geocoder");
    assert.deepStrictEqual(traces[0].input, { q: "Berlin" });
    assert.deepStrictEqual(traces[0].output, { label: "Berlin, DE" });
    assert.equal(typeof traces[0].durationMs, "number");
    assert.equal(typeof traces[0].startedAt, "number");
    assert.ok(!traces[0].error, "no error field on success");
  });

  test("no traces when tracing is disabled (default)", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;
    const instructions = parseBridge(bridge);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { geocoder: async () => ({ label: "X" }) },
      // trace: "off" (default)
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });

    assert.equal(result.extensions?.traces, undefined, "no traces in extensions");
  });
});

// ── Tool call order ───────────────────────────────────────────────────────

describe("tracing: call order", () => {
  test("traces record sequential order for || chains", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label } }`,
      {
        primary: async () => ({ label: null }),
        backup: async () => ({ label: "B" }),
      },
    );

    assert.equal(traces.length, 2);
    assert.equal(traces[0].tool, "primary");
    assert.equal(traces[1].tool, "backup");
    assert.ok(
      traces[0].startedAt <= traces[1].startedAt,
      "primary started before backup",
    );
  });

  test("traces show short-circuit: backup not called when primary succeeds", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label } }`,
      {
        primary: async () => ({ label: "P" }),
        backup: async () => ({ label: "B" }),
      },
    );

    assert.equal(traces.length, 1, "only primary was called");
    assert.equal(traces[0].tool, "primary");
  });
});

// ── Error tracing ─────────────────────────────────────────────────────────

describe("tracing: errors", () => {
  test("traces capture error message on tool failure", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;
    // The tool throws — the GQL query will error, but traces should still be captured
    const instructions = parseBridge(bridge);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        geocoder: async () => {
          throw new Error("API rate limit exceeded");
        },
      },
      trace: "full",
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });

    // Even on error the traces array should be present
    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    assert.equal(traces.length, 1);
    assert.equal(traces[0].tool, "geocoder");
    assert.equal(traces[0].error, "API rate limit exceeded");
    assert.equal(traces[0].output, undefined);
  });

  test("traces capture both erroring and fallback ?? tool", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with primary as p
  with fallback as f
  with input as i
  with output as o

p.q <- i.q
f.q <- i.q
o.label <- p.label ?? f.label

}`;
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label } }`,
      {
        primary: async () => {
          throw new Error("boom");
        },
        fallback: async () => ({ label: "safe" }),
      },
    );

    assert.equal(traces.length, 2);
    assert.equal(traces[0].tool, "primary");
    assert.ok(traces[0].error, "primary shows error");
    assert.equal(traces[1].tool, "fallback");
    assert.ok(!traces[1].error, "fallback succeeded");
  });
});

// ── Multi-tool traces ─────────────────────────────────────────────────────

describe("tracing: multi-tool", () => {
  test("multiple independent tools are all traced", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with alpha as a
  with beta as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label
o.score <- b.score

}`;
    const { data, traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label score } }`,
      {
        alpha: async () => ({ label: "A" }),
        beta: async () => ({ score: 42 }),
      },
    );

    assert.equal(data.lookup.label, "A");
    assert.equal(data.lookup.score, 42);
    assert.equal(traces.length, 2);
    const toolNames = traces.map((t: ToolTrace) => t.tool).sort();
    assert.deepStrictEqual(toolNames, ["alpha", "beta"]);
  });

  test("trace inputs reflect bridge wire resolution", async () => {
    const bridge = `version 1.4

const limits = { "limit": 5 }

bridge Query.lookup {
  with geocoder as g
  with const as c
  with input as i
  with output as o

g.limit <- c.limits.limit
g.q <- i.q
o.label <- g.label

}`;
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "Berlin") { label } }`,
      { geocoder: async (input: any) => ({ label: input.q }) },
    );

    assert.equal(traces.length, 1);
    assert.equal(traces[0].input.q, "Berlin");
    assert.equal(traces[0].input.limit, 5);
  });
});

// ── Tool-dep tracing ──────────────────────────────────────────────────────

describe("tracing: tool-dep (tool blocks)", () => {
  test("tool block calls are traced with fn name", async () => {
    const bridge = `version 1.4
tool geocoder from httpCall {
  .baseUrl = "https://api.example.com"
  .method = "GET"
  .path = "/geocode"

}

bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;
    const mockHttpCall = async (input: any) => ({
      label: `resolved-${input.q}`,
    });

    const { data, traces } = await execute(
      bridge,
      `{ lookup(q: "Berlin") { label } }`,
      { httpCall: mockHttpCall },
    );

    assert.equal(data.lookup.label, "resolved-Berlin");
    assert.equal(traces.length, 1);
    assert.equal(traces[0].tool, "geocoder");
    assert.equal(traces[0].fn, "httpCall");
    // Input should include tool-def wires (baseUrl, method, path) merged
    // with bridge wires (q)
    assert.equal(traces[0].input.q, "Berlin");
    assert.equal(traces[0].input.baseUrl, "https://api.example.com");
  });
});

// ── Timing ────────────────────────────────────────────────────────────────

describe("tracing: timing", () => {
  test("durationMs reflects actual tool execution time", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with slow as s
  with input as i
  with output as o

s.q <- i.q
o.label <- s.label

}`;
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label } }`,
      {
        slow: async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { label: "done" };
        },
      },
    );

    assert.equal(traces.length, 1);
    assert.ok(
      traces[0].durationMs >= 30,
      `expected ≥30ms, got ${traces[0].durationMs}ms`,
    );
  });

  test("startedAt values are monotonically ordered", async () => {
    const bridge = `version 1.4
bridge Query.lookup {
  with first as f
  with second as s
  with input as i
  with output as o

f.q <- i.q
s.q <- i.q
o.label <- f.label || s.label

}`;
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label } }`,
      {
        first: async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { label: null };
        },
        second: async () => ({ label: "ok" }),
      },
    );

    assert.equal(traces.length, 2);
    assert.ok(
      traces[0].startedAt < traces[1].startedAt,
      "second tool started after first",
    );
  });
});

// ── Trace levels ──────────────────────────────────────────────────────────

describe("tracing: levels", () => {
  const bridge = `version 1.4
bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;

  test("basic level omits input and output", async () => {
    const instructions = parseBridge(bridge);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { geocoder: async () => ({ label: "X" }) },
      trace: "basic",
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ lookup(q: "Berlin") { label } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    assert.equal(traces.length, 1);
    assert.equal(traces[0].tool, "geocoder");
    assert.equal(traces[0].fn, "geocoder");
    assert.equal(traces[0].input, undefined, "basic level should not include input");
    assert.equal(traces[0].output, undefined, "basic level should not include output");
    assert.equal(typeof traces[0].durationMs, "number");
    assert.equal(typeof traces[0].startedAt, "number");
  });

  test("basic level still includes error string", async () => {
    const instructions = parseBridge(bridge);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        geocoder: async () => {
          throw new Error("boom");
        },
      },
      trace: "basic",
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    assert.equal(traces.length, 1);
    assert.equal(traces[0].error, "boom", "basic level should include error");
    assert.equal(traces[0].input, undefined, "no input even on error");
  });

  test("full level includes input and output", async () => {
    const instructions = parseBridge(bridge);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { geocoder: async () => ({ label: "Y" }) },
      trace: "full",
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ lookup(q: "Berlin") { label } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    assert.equal(traces.length, 1);
    assert.deepStrictEqual(traces[0].input, { q: "Berlin" });
    assert.deepStrictEqual(traces[0].output, { label: "Y" });
  });

  test("true is equivalent to full", async () => {
    const { traces } = await execute(
      bridge,
      `{ lookup(q: "x") { label } }`,
      { geocoder: async () => ({ label: "Z" }) },
    );

    assert.equal(traces.length, 1);
    assert.ok(traces[0].input !== undefined, "true → full → includes input");
    assert.ok(traces[0].output !== undefined, "true → full → includes output");
  });
});

// ── Weather-style whole-object wire diagnostic ────────────────────────────
//
// Replicates the Weather.bridge structure to verify which tools get called
// and why — specifically the `o <- w` whole-object wire that eagerly
// resolves the entire define block regardless of which GQL fields are
// requested.

describe("tracing: weather-style diagnostic", () => {
  const weatherTypeDefs = /* GraphQL */ `
    type Query {
      getWeather(cityName: String, lat: Float, lon: Float): WeatherReport
    }
    type WeatherReport {
      city: String
      lat: Float
      lon: Float
      currentTemp: Float
      timezone: String
    }
  `;

  // Mirrors Weather.bridge: define + bridge + tool blocks
  const weatherBridge = `version 1.4

tool geo from httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .method = "GET"
  .path = "/search"
}

tool weather from httpCall {
  .baseUrl = "https://api.open-meteo.com/v1"
  .method = "GET"
  .path = "/forecast"
}

tool first from std.pickFirst

define weatherByCoordinates {
  with weather as w
  with input as i
  with output as o

  w.latitude  <- i.lat
  w.longitude <- i.lon
  w.current_weather = true

  o.lat         <- i.lat
  o.lon         <- i.lon
  o.currentTemp <- w.current_weather.temperature ?? 0.0
  o.timezone    <- w.timezone ?? "UTC"
  o.city        <- i.cityName
}

bridge Query.getWeather {
  with geo as g
  with weatherByCoordinates as w
  with first as f
  with input as i
  with output as o
  with std.upperCase as upper

  g.q <- i.cityName
  g.format = "json"

  f.in <- g

  w.lat  <- i.lat || f.lat
  w.lon <- i.lon || f.lon
  w.cityName <- upper:i.cityName || f.display_name || "Unknown"

  o <- w
}`;

  function createWeatherGateway() {
    const callLog: string[] = [];
    const tools = {
      httpCall: async (input: any) => {
        if (input.baseUrl.includes("nominatim")) {
          callLog.push("geo");
          // Nominatim returns an array; empty for no-query
          return input.q ? [{ lat: 52.52, lon: 13.405, display_name: "Berlin" }] : [];
        }
        if (input.baseUrl.includes("open-meteo")) {
          callLog.push("weather");
          return {
            current_weather: { temperature: 18.5 },
            timezone: "Europe/Berlin",
          };
        }
        return {};
      },
    };

    const instructions = parseBridge(weatherBridge);
    const gateway = createGateway(weatherTypeDefs, instructions, {
      tools,
      trace: "full",
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    return { executor, callLog };
  }

  test("{ getWeather { city } } with no inputs: lazy define skips weather", async () => {
    // With lazy define resolution, `o <- w` defers field-by-field.
    // Only `city` is requested → only the define's city wire fires.
    // The city wire reads __define_in.cityName, resolved lazily:
    //   w.cityName <- upper:i.cityName || f.display_name || "Unknown"
    // No cityName input → upper:null → falls through to f.display_name
    // → geo is called (to get display_name via geocode fallback).
    // weather is NEVER called — no output field depends on it.
    const { executor, callLog } = createWeatherGateway();

    const result: any = await executor({
      document: parse(`{ getWeather { city } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    const toolNames = traces.map((t: ToolTrace) => t.tool);

    // geo is called: cityName is null → upper(null) → null →
    // falls through to f.display_name → needs geo
    assert.ok(toolNames.includes("geo"), "geo called (cityName null, needs f.display_name)");

    // weather is NOT called: lazy resolution only resolves the city wire,
    // which doesn't depend on the weather tool
    assert.ok(!toolNames.includes("weather"), "weather NOT called (lazy define skips it)");

    assert.equal(result.data.getWeather.city, "Unknown");
  });

  test("{ getWeather(cityName: \"Berlin\") { city } } no geo needed", async () => {
    const { executor, callLog } = createWeatherGateway();

    const result: any = await executor({
      document: parse(`{ getWeather(cityName: "Berlin") { city } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    const toolNames = traces.map((t: ToolTrace) => t.tool);

    // Lazy define input: only __define_in.cityName wire fires.
    // upper:i.cityName → "BERLIN" (non-null) → short-circuits.
    // geo is NOT called: lat/lon wires never fire, cityName doesn't
    // fall through to f.display_name.
    assert.ok(!toolNames.includes("geo"), "geo NOT called (cityName short-circuits)");

    // weather NOT called: only city was requested
    assert.ok(!toolNames.includes("weather"), "weather NOT called (lazy define)");

    assert.equal(result.data.getWeather.city, "BERLIN");
  });

  test("{ getWeather(lat: 52.52, lon: 13.4, cityName: \"Berlin\") { city } } no tools called", async () => {
    const { executor, callLog } = createWeatherGateway();

    const result: any = await executor({
      document: parse(`{ getWeather(lat: 52.52, lon: 13.4, cityName: "Berlin") { city } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    const toolNames = traces.map((t: ToolTrace) => t.tool);

    // All inputs provided → all || chains short-circuit on input values
    // → geo is NOT called (no fallback needed)
    // → weather is NOT called (only city was requested, lazy define)
    assert.ok(!toolNames.includes("geo"), "geo NOT called (all inputs short-circuit)");
    assert.ok(!toolNames.includes("weather"), "weather NOT called (lazy define)");
    assert.deepStrictEqual(callLog, [], "no tool calls at all");

    assert.equal(result.data.getWeather.city, "BERLIN");
  });

  test("{ getWeather { city currentTemp } } weather called only when needed", async () => {
    // When currentTemp IS requested, the define's currentTemp wire fires,
    // which pulls from the weather tool.
    const { executor, callLog } = createWeatherGateway();

    const result: any = await executor({
      document: parse(`{ getWeather(cityName: "Berlin") { city currentTemp } }`),
    });

    const traces: ToolTrace[] = result.extensions?.traces ?? [];
    const toolNames = traces.map((t: ToolTrace) => t.tool);

    assert.ok(toolNames.includes("weather"), "weather called for currentTemp");
    assert.equal(result.data.getWeather.city, "BERLIN");
    assert.equal(typeof result.data.getWeather.currentTemp, "number");
  });
});
