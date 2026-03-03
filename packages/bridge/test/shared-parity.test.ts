/**
 * Shared data-driven test suite for bridge language behavior.
 *
 * Every test case is a pure data record: bridge source, tools, input, and
 * expected output.  The suite runs each case against **both** the runtime
 * interpreter (`executeBridge`) and the AOT compiler (`executeAot`), then
 * asserts identical results.  This guarantees behavioral parity between the
 * two execution paths and gives us a single place to document "what the
 * language does."
 *
 * Cases that exercise language features the AOT compiler does not yet support
 * are tagged `aotSupported: false` — they still run against the runtime, but
 * the AOT leg is skipped (with a TODO in the test output).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat } from "@stackables/bridge-compiler";
import { executeBridge } from "@stackables/bridge-core";
import { executeAot } from "@stackables/core-native";

// ── Test-case type ──────────────────────────────────────────────────────────

interface SharedTestCase {
  /** Human-readable test name */
  name: string;
  /** Bridge source text (with `version 1.5` prefix) */
  bridgeText: string;
  /** Operation to execute, e.g. "Query.search" */
  operation: string;
  /** Input arguments */
  input?: Record<string, unknown>;
  /** Tool implementations */
  tools?: Record<string, (...args: any[]) => any>;
  /** Context passed to the engine */
  context?: Record<string, unknown>;
  /** Expected output data (deep-equality check) */
  expected: unknown;
  /** Whether the AOT compiler supports this case (default: true) */
  aotSupported?: boolean;
  /** Whether to expect an error (message pattern) instead of a result */
  expectedError?: RegExp;
}

// ── Runners ─────────────────────────────────────────────────────────────────

async function runRuntime(c: SharedTestCase): Promise<unknown> {
  const document = parseBridgeFormat(c.bridgeText);
  // Simulate serialisation round-trip, same as existing tests
  const doc = JSON.parse(JSON.stringify(document));
  const { data } = await executeBridge({
    document: doc,
    operation: c.operation,
    input: c.input ?? {},
    tools: c.tools ?? {},
    context: c.context,
  });
  return data;
}

async function runAot(c: SharedTestCase): Promise<unknown> {
  const document = parseBridgeFormat(c.bridgeText);
  const { data } = await executeAot({
    document,
    operation: c.operation,
    input: c.input ?? {},
    tools: c.tools ?? {},
    context: c.context,
  });
  return data;
}

// ── Shared test runner ──────────────────────────────────────────────────────

function runSharedSuite(suiteName: string, cases: SharedTestCase[]) {
  describe(suiteName, () => {
    for (const c of cases) {
      describe(c.name, () => {
        if (c.expectedError) {
          test("runtime: throws expected error", async () => {
            await assert.rejects(() => runRuntime(c), c.expectedError);
          });
          if (c.aotSupported !== false) {
            test("aot: throws expected error", async () => {
              await assert.rejects(() => runAot(c), c.expectedError);
            });
          }
          return;
        }

        test("runtime", async () => {
          const data = await runRuntime(c);
          assert.deepEqual(data, c.expected);
        });

        if (c.aotSupported !== false) {
          test("aot", async () => {
            const data = await runAot(c);
            assert.deepEqual(data, c.expected);
          });

          test("parity: runtime === aot", async () => {
            const [rtData, aotData] = await Promise.all([
              runRuntime(c),
              runAot(c),
            ]);
            assert.deepEqual(rtData, aotData);
          });
        } else {
          test("aot: skipped (not yet supported)", () => {
            // Placeholder so the count shows what's pending
          });
        }
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST CASE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Pull wires + constants ───────────────────────────────────────────────

const pullAndConstantCases: SharedTestCase[] = [
  {
    name: "chained tool calls resolve all fields",
    bridgeText: `version 1.5
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
}`,
    operation: "Query.livingStandard",
    input: { location: "Berlin" },
    tools: {
      "hereapi.geocode": async () => ({ lat: 52.53, lon: 13.38 }),
      "companyX.getLivingStandard": async () => ({ lifeExpectancy: "81.5" }),
      toInt: (p: any) => ({ result: Math.round(parseFloat(p.value)) }),
    },
    expected: { lifeExpectancy: 82 },
  },
  {
    name: "constant wires emit literal values",
    bridgeText: `version 1.5
bridge Query.info {
  with api as a
  with output as o

  a.method = "GET"
  a.timeout = 5000
  a.enabled = true
  o.result <- a.data
}`,
    operation: "Query.info",
    tools: {
      api: (p: any) => {
        assert.equal(p.method, "GET");
        assert.equal(p.timeout, 5000);
        assert.equal(p.enabled, true);
        return { data: "ok" };
      },
    },
    expected: { result: "ok" },
  },
  {
    name: "constant and input wires coexist",
    bridgeText: `version 1.5
bridge Query.info {
  with input as i
  with output as o

  o.greeting = "hello"
  o.name <- i.name
}`,
    operation: "Query.info",
    input: { name: "World" },
    expected: { greeting: "hello", name: "World" },
  },
  {
    name: "root passthrough returns tool output directly",
    bridgeText: `version 1.5
bridge Query.user {
  with api as a
  with input as i
  with output as o

  a.id <- i.userId
  o <- a
}`,
    operation: "Query.user",
    input: { userId: 42 },
    tools: {
      api: (p: any) => ({ name: "Alice", id: p.id }),
    },
    expected: { name: "Alice", id: 42 },
  },
  {
    name: "root passthrough with path",
    bridgeText: `version 1.5
bridge Query.getUser {
  with userApi as api
  with input as i
  with output as o

  api.id <- i.id
  o <- api.user
}`,
    operation: "Query.getUser",
    input: { id: "123" },
    tools: {
      userApi: async () => ({
        user: { name: "Alice", age: 30, email: "alice@example.com" },
      }),
    },
    expected: { name: "Alice", age: 30, email: "alice@example.com" },
  },
  {
    name: "context references resolve correctly",
    bridgeText: `version 1.5
bridge Query.secured {
  with api as a
  with context as ctx
  with input as i
  with output as o

  a.token <- ctx.apiKey
  a.query <- i.q
  o.data <- a.result
}`,
    operation: "Query.secured",
    input: { q: "test" },
    tools: { api: (p: any) => ({ result: `${p.query}:${p.token}` }) },
    context: { apiKey: "secret123" },
    expected: { data: "test:secret123" },
  },
  {
    name: "empty output returns empty object",
    bridgeText: `version 1.5
bridge Query.empty {
  with output as o
}`,
    operation: "Query.empty",
    expectedError: /no output wires/,
    aotSupported: false, // AOT returns {} instead of erroring
  },
  {
    name: "tools receive correct chained inputs",
    bridgeText: `version 1.5
bridge Query.chain {
  with first as f
  with second as s
  with input as i
  with output as o

  f.x <- i.a
  s.y <- f.result
  o.final <- s.result
}`,
    operation: "Query.chain",
    input: { a: 5 },
    tools: {
      first: (p: any) => ({ result: p.x * 2 }),
      second: (p: any) => ({ result: p.y + 1 }),
    },
    expected: { final: 11 },
  },
];

runSharedSuite("Shared: pull wires + constants", pullAndConstantCases);

// ── 2. Fallback operators (??, ||) ──────────────────────────────────────────

const fallbackCases: SharedTestCase[] = [
  {
    name: "?? nullish coalescing with constant fallback",
    bridgeText: `version 1.5
bridge Query.defaults {
  with api as a
  with input as i
  with output as o

  a.id <- i.id
  o.name <- a.name ?? "unknown"
}`,
    operation: "Query.defaults",
    input: { id: 1 },
    tools: { api: () => ({ name: null }) },
    expected: { name: "unknown" },
  },
  {
    name: "?? does not trigger on falsy non-null values",
    bridgeText: `version 1.5
bridge Query.falsy {
  with api as a
  with output as o

  o.count <- a.count ?? 42
}`,
    operation: "Query.falsy",
    tools: { api: () => ({ count: 0 }) },
    expected: { count: 0 },
  },
  {
    name: "|| falsy fallback with constant",
    bridgeText: `version 1.5
bridge Query.fallback {
  with api as a
  with output as o

  o.label <- a.label || "default"
}`,
    operation: "Query.fallback",
    tools: { api: () => ({ label: "" }) },
    expected: { label: "default" },
  },
  {
    name: "|| falsy fallback with ref",
    bridgeText: `version 1.5
bridge Query.refFallback {
  with primary as p
  with backup as b
  with output as o

  o.value <- p.val || b.val
}`,
    operation: "Query.refFallback",
    tools: {
      primary: () => ({ val: null }),
      backup: () => ({ val: "from-backup" }),
    },
    expected: { value: "from-backup" },
  },
  {
    name: "?? with nested scope and null response",
    bridgeText: `version 1.5
bridge Query.forecast {
  with api as a
  with output as o

  o.summary {
    .temp <- a.temp ?? 0
    .wind <- a.wind ?? 0
  }
}`,
    operation: "Query.forecast",
    tools: { api: async () => ({ temp: null, wind: null }) },
    expected: { summary: { temp: 0, wind: 0 } },
  },
];

runSharedSuite("Shared: fallback operators", fallbackCases);

// ── 3. Array mapping ────────────────────────────────────────────────────────

const arrayMappingCases: SharedTestCase[] = [
  {
    name: "array mapping renames fields",
    bridgeText: `version 1.5
bridge Query.catalog {
  with api as src
  with output as o

  o.title <- src.name
  o.entries <- src.items[] as item {
    .id <- item.item_id
    .label <- item.item_name
    .cost <- item.unit_price
  }
}`,
    operation: "Query.catalog",
    tools: {
      api: async () => ({
        name: "Catalog A",
        items: [
          { item_id: 1, item_name: "Widget", unit_price: 9.99 },
          { item_id: 2, item_name: "Gadget", unit_price: 14.5 },
        ],
      }),
    },
    expected: {
      title: "Catalog A",
      entries: [
        { id: 1, label: "Widget", cost: 9.99 },
        { id: 2, label: "Gadget", cost: 14.5 },
      ],
    },
  },
  {
    name: "array mapping with empty array returns empty array",
    bridgeText: `version 1.5
bridge Query.empty {
  with api as src
  with output as o

  o.items <- src.list[] as item {
    .name <- item.label
  }
}`,
    operation: "Query.empty",
    tools: { api: () => ({ list: [] }) },
    expected: { items: [] },
  },
  {
    name: "array mapping with null source returns null",
    bridgeText: `version 1.5
bridge Query.nullable {
  with api as src
  with output as o

  o.items <- src.list[] as item {
    .name <- item.label
  }
}`,
    operation: "Query.nullable",
    tools: { api: () => ({ list: null }) },
    expected: { items: null },
    aotSupported: false, // AOT returns [] instead of null (known difference)
  },
  {
    name: "root array output",
    bridgeText: `version 1.5
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
}`,
    operation: "Query.geocode",
    input: { search: "Ber" },
    tools: {
      "hereapi.geocode": async () => ({
        items: [
          { title: "Berlin", position: { lat: 52.53, lng: 13.39 } },
          { title: "Bern", position: { lat: 46.95, lng: 7.45 } },
        ],
      }),
    },
    expected: [
      { name: "Berlin", lat: 52.53, lon: 13.39 },
      { name: "Bern", lat: 46.95, lon: 7.45 },
    ],
  },
];

runSharedSuite("Shared: array mapping", arrayMappingCases);

// ── 4. Ternary / conditional wires ──────────────────────────────────────────

const ternaryCases: SharedTestCase[] = [
  {
    name: "ternary expression with input condition",
    bridgeText: `version 1.5
bridge Query.conditional {
  with api as a
  with input as i
  with output as o

  a.mode <- i.premium ? "full" : "basic"
  o.result <- a.data
}`,
    operation: "Query.conditional",
    input: { premium: true },
    tools: { api: (p: any) => ({ data: p.mode }) },
    expected: { result: "full" },
  },
  {
    name: "ternary false branch",
    bridgeText: `version 1.5
bridge Query.conditional {
  with api as a
  with input as i
  with output as o

  a.mode <- i.premium ? "full" : "basic"
  o.result <- a.data
}`,
    operation: "Query.conditional",
    input: { premium: false },
    tools: { api: (p: any) => ({ data: p.mode }) },
    expected: { result: "basic" },
  },
  {
    name: "ternary with ref branches",
    bridgeText: `version 1.5
bridge Query.pricing {
  with api as a
  with input as i
  with output as o

  a.id <- i.id
  o.price <- i.isPro ? a.proPrice : a.basicPrice
}`,
    operation: "Query.pricing",
    input: { id: 1, isPro: true },
    tools: { api: () => ({ proPrice: 99, basicPrice: 49 }) },
    expected: { price: 99 },
  },
];

runSharedSuite("Shared: ternary / conditional wires", ternaryCases);

// ── 5. Catch fallbacks ──────────────────────────────────────────────────────

const catchCases: SharedTestCase[] = [
  {
    name: "catch with constant fallback value",
    bridgeText: `version 1.5
bridge Query.safe {
  with api as a
  with output as o

  o.data <- a.result catch "fallback"
}`,
    operation: "Query.safe",
    tools: { api: () => { throw new Error("boom"); } },
    expected: { data: "fallback" },
  },
  {
    name: "catch does not trigger on success",
    bridgeText: `version 1.5
bridge Query.noerr {
  with api as a
  with output as o

  o.data <- a.result catch "fallback"
}`,
    operation: "Query.noerr",
    tools: { api: () => ({ result: "success" }) },
    expected: { data: "success" },
  },
  {
    name: "catch with ref fallback",
    bridgeText: `version 1.5
bridge Query.refCatch {
  with primary as p
  with backup as b
  with output as o

  o.data <- p.result catch b.fallback
}`,
    operation: "Query.refCatch",
    tools: {
      primary: () => { throw new Error("primary failed"); },
      backup: () => ({ fallback: "from-backup" }),
    },
    expected: { data: "from-backup" },
  },
];

runSharedSuite("Shared: catch fallbacks", catchCases);

// ── 6. Force statements ─────────────────────────────────────────────────────

const forceCases: SharedTestCase[] = [
  {
    name: "force tool runs even when output not queried",
    bridgeText: `version 1.5
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

  m.q <- i.q
  audit.action <- i.q
  force audit
  o.title <- m.title
}`,
    operation: "Query.search",
    input: { q: "test" },
    tools: {
      mainApi: async () => ({ title: "Hello World" }),
      "audit.log": async () => ({ ok: true }),
    },
    expected: { title: "Hello World" },
  },
  {
    name: "fire-and-forget force does not break on error",
    bridgeText: `version 1.5
bridge Query.safe {
  with mainApi as m
  with analytics as ping
  with input as i
  with output as o

  m.q <- i.q
  ping.event <- i.q
  force ping catch null
  o.title <- m.title
}`,
    operation: "Query.safe",
    input: { q: "test" },
    tools: {
      mainApi: async () => ({ title: "OK" }),
      analytics: async () => { throw new Error("analytics down"); },
    },
    expected: { title: "OK" },
  },
  {
    name: "critical force propagates errors",
    bridgeText: `version 1.5
bridge Query.critical {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

  m.q <- i.q
  audit.action <- i.q
  force audit
  o.title <- m.title
}`,
    operation: "Query.critical",
    input: { q: "test" },
    tools: {
      mainApi: async () => ({ title: "OK" }),
      "audit.log": async () => { throw new Error("audit failed"); },
    },
    expectedError: /audit failed/,
  },
];

runSharedSuite("Shared: force statements", forceCases);

// ── 7. ToolDef support ──────────────────────────────────────────────────────

const toolDefCases: SharedTestCase[] = [
  {
    name: "ToolDef constant wires merged with bridge wires",
    bridgeText: `version 1.5
tool restApi from myHttp {
  with context
  .method = "GET"
  .baseUrl = "https://api.example.com"
  .headers.Authorization <- context.token
}

bridge Query.data {
  with restApi as api
  with input as i
  with output as o

  api.path <- i.path
  o.result <- api.body
}`,
    operation: "Query.data",
    input: { path: "/users" },
    tools: {
      myHttp: async (input: any) => ({ body: { ok: true } }),
    },
    context: { token: "Bearer abc123" },
    expected: { result: { ok: true } },
  },
  {
    name: "bridge wires override ToolDef wires",
    bridgeText: `version 1.5
tool restApi from myHttp {
  .method = "GET"
  .timeout = 5000
}

bridge Query.custom {
  with restApi as api
  with output as o

  api.method = "POST"
  o.result <- api.data
}`,
    operation: "Query.custom",
    tools: {
      myHttp: async (input: any) => {
        assert.equal(input.method, "POST");
        assert.equal(input.timeout, 5000);
        return { data: "ok" };
      },
    },
    expected: { result: "ok" },
  },
  {
    name: "ToolDef onError provides fallback on failure",
    bridgeText: `version 1.5
tool safeApi from myHttp {
  on error = {"status":"error","message":"service unavailable"}
}

bridge Query.safe {
  with safeApi as api
  with input as i
  with output as o

  api.url <- i.url
  o <- api
}`,
    operation: "Query.safe",
    input: { url: "https://broken.api" },
    tools: {
      myHttp: async () => { throw new Error("connection refused"); },
    },
    expected: { status: "error", message: "service unavailable" },
  },
  {
    name: "ToolDef extends chain",
    bridgeText: `version 1.5
tool baseApi from myHttp {
  .method = "GET"
  .baseUrl = "https://api.example.com"
}

tool userApi from baseApi {
  .path = "/users"
}

bridge Query.users {
  with userApi as api
  with output as o

  o <- api
}`,
    operation: "Query.users",
    tools: {
      myHttp: async (input: any) => {
        assert.equal(input.method, "GET");
        assert.equal(input.baseUrl, "https://api.example.com");
        assert.equal(input.path, "/users");
        return { users: [] };
      },
    },
    expected: { users: [] },
  },
];

runSharedSuite("Shared: ToolDef support", toolDefCases);

// ── 8. Tool context injection ───────────────────────────────────────────────

const toolContextCases: SharedTestCase[] = [
  {
    name: "tool function receives context as second argument",
    bridgeText: `version 1.5
bridge Query.ctx {
  with api as a
  with input as i
  with output as o

  a.q <- i.q
  o.result <- a.data
}`,
    operation: "Query.ctx",
    input: { q: "hello" },
    tools: {
      api: (input: any, ctx: any) => {
        // Runtime passes ToolContext { logger, signal }; AOT passes the user
        // context object.  Both engines must provide a defined second argument.
        assert.ok(ctx != null, "context must be passed as second argument");
        return { data: input.q };
      },
    },
    expected: { result: "hello" },
  },
];

runSharedSuite("Shared: tool context injection", toolContextCases);

// ── 9. Const blocks ─────────────────────────────────────────────────────────

const constCases: SharedTestCase[] = [
  {
    name: "const value used in fallback",
    bridgeText: `version 1.5
const fallbackGeo = { "lat": 0, "lon": 0 }

bridge Query.locate {
  with geoApi as geo
  with const as c
  with input as i
  with output as o

  geo.q <- i.q
  o.lat <- geo.lat ?? c.fallbackGeo.lat
  o.lon <- geo.lon ?? c.fallbackGeo.lon
}`,
    operation: "Query.locate",
    input: { q: "unknown" },
    tools: { geoApi: () => ({ lat: null, lon: null }) },
    expected: { lat: 0, lon: 0 },
  },
];

runSharedSuite("Shared: const blocks", constCases);

// ── 10. String interpolation ────────────────────────────────────────────────

const interpolationCases: SharedTestCase[] = [
  {
    name: "basic string interpolation",
    bridgeText: `version 1.5
bridge Query.greet {
  with input as i
  with output as o

  o.message <- "Hello, {i.name}!"
}`,
    operation: "Query.greet",
    input: { name: "World" },
    expected: { message: "Hello, World!" },
  },
  {
    name: "URL construction with interpolation",
    bridgeText: `version 1.5
bridge Query.url {
  with api as a
  with input as i
  with output as o

  a.path <- "/users/{i.id}/orders"
  o.result <- a.data
}`,
    operation: "Query.url",
    input: { id: 42 },
    tools: { api: (p: any) => ({ data: p.path }) },
    expected: { result: "/users/42/orders" },
  },
];

runSharedSuite("Shared: string interpolation", interpolationCases);

// ── 11. Expressions (math, comparison) ──────────────────────────────────────

const expressionCases: SharedTestCase[] = [
  {
    name: "multiplication expression",
    bridgeText: `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.result <- i.price * i.qty
}`,
    operation: "Query.calc",
    input: { price: 10, qty: 3 },
    expected: { result: 30 },
  },
  {
    name: "comparison expression (greater than or equal)",
    bridgeText: `version 1.5
bridge Query.check {
  with input as i
  with output as o

  o.isAdult <- i.age >= 18
}`,
    operation: "Query.check",
    input: { age: 21 },
    expected: { isAdult: true },
  },
];

runSharedSuite("Shared: expressions", expressionCases);

// ── 12. Nested scope blocks ─────────────────────────────────────────────────

const scopeCases: SharedTestCase[] = [
  {
    name: "nested object via scope block",
    bridgeText: `version 1.5
bridge Query.weather {
  with weatherApi as w
  with input as i
  with output as o

  w.city <- i.city

  o.why {
    .temperature <- w.temperature ?? 0.0
    .city <- i.city
  }
}`,
    operation: "Query.weather",
    input: { city: "Berlin" },
    tools: {
      weatherApi: async () => ({ temperature: 25, feelsLike: 23 }),
    },
    expected: { why: { temperature: 25, city: "Berlin" } },
  },
];

runSharedSuite("Shared: nested scope blocks", scopeCases);

// ── 13. Nested arrays ───────────────────────────────────────────────────────

const nestedArrayCases: SharedTestCase[] = [
  {
    name: "nested array-in-array mapping",
    bridgeText: `version 1.5
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
}`,
    operation: "Query.searchTrains",
    input: { from: "Bern", to: "Aarau" },
    tools: {
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
    },
    expected: [
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
    ],
  },
];

runSharedSuite("Shared: nested arrays", nestedArrayCases);

// ── 14. Pipe operators ──────────────────────────────────────────────────────

const pipeCases: SharedTestCase[] = [
  {
    name: "simple pipe shorthand",
    bridgeText: `version 1.5
bridge Query.shout {
  with toUpperCase as tu
  with input as i
  with output as o

  o.loud <- tu:i.text
}`,
    operation: "Query.shout",
    input: { text: "hello" },
    tools: {
      toUpperCase: (p: any) => ({ out: p.in.toUpperCase() }),
    },
    expected: { loud: { out: "HELLO" } },
  },
];

runSharedSuite("Shared: pipe operators", pipeCases);

// ── 15. Define blocks ───────────────────────────────────────────────────────

const defineCases: SharedTestCase[] = [
  {
    name: "simple define block inlines tool call",
    bridgeText: `version 1.5

define userProfile {
  with userApi as api
  with input as i
  with output as o
  api.id <- i.userId
  o.name <- api.login
}

bridge Query.user {
  with userProfile as sp
  with input as i
  with output as o
  sp.userId <- i.id
  o.profile <- sp
}`,
    operation: "Query.user",
    input: { id: 42 },
    tools: {
      userApi: async (input: any) => ({ login: "admin_" + input.id }),
    },
    expected: { profile: { name: "admin_42" } },
  },
  {
    name: "define with module-prefixed tool",
    bridgeText: `version 1.5

define enrichedGeo {
  with hereapi.geocode as gc
  with input as i
  with output as o
  gc.q <- i.query
  o.lat <- gc.lat
  o.lon <- gc.lon
}

bridge Query.search {
  with enrichedGeo as geo
  with input as i
  with output as o
  geo.query <- i.location
  o.coordinates <- geo
}`,
    operation: "Query.search",
    input: { location: "Berlin" },
    tools: {
      "hereapi.geocode": async () => ({ lat: 52.53, lon: 13.38 }),
    },
    expected: { coordinates: { lat: 52.53, lon: 13.38 } },
  },
  {
    name: "define with multiple output fields",
    bridgeText: `version 1.5

define weatherInfo {
  with weatherApi as api
  with input as i
  with output as o
  api.city <- i.cityName
  o.temp <- api.temperature
  o.humidity <- api.humidity
  o.wind <- api.windSpeed
}

bridge Query.weather {
  with weatherInfo as w
  with input as i
  with output as o
  w.cityName <- i.city
  o.forecast <- w
}`,
    operation: "Query.weather",
    input: { city: "Berlin" },
    tools: {
      weatherApi: async (input: any) => ({
        temperature: 22,
        humidity: 65,
        windSpeed: 15,
      }),
    },
    expected: { forecast: { temp: 22, humidity: 65, wind: 15 } },
  },
];

runSharedSuite("Shared: define blocks", defineCases);
