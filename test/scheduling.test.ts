import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Millisecond timer relative to test start */
function createTimer() {
  const start = performance.now();
  return () => Math.round((performance.now() - start) * 100) / 100;
}

type CallRecord = {
  name: string;
  startMs: number;
  endMs: number;
  input: Record<string, any>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test 1: Diamond dependency — dedup + parallel fan-out ────────────────────
//
// Topology:
//
//   input ──→ geocode ──┬──→ weatherApi ──→ temp, humidity
//                       └──→ censusApi  ──→ population
//   input ──→ formatGreeting ──→ greeting
//
// Expectations:
//   • geocode called exactly ONCE (dedup across weather + census)
//   • weatherApi and censusApi start in parallel after geocode resolves
//   • formatGreeting runs independently, doesn't wait for geocode
//   • Total wall time ≈ max(geocode + max(weather, census), formatGreeting)

describe("scheduling: diamond dependency dedup + parallelism", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      dashboard(city: String!): Dashboard
    }
    type Dashboard {
      temp: Float
      humidity: Float
      population: Int
      greeting: String
    }
  `;

  const bridgeText = `
bridge Query.dashboard
  with geo.code as gc
  with weather.get as w
  with census.get as c
  with formatGreeting as fg
  with input as i

# geocode from input
gc.city <- i.city

# weather depends on geocode output
w.lat <- gc.lat
w.lng <- gc.lng

# census ALSO depends on geocode output (same source — must dedup)
c.lat <- gc.lat
c.lng <- gc.lng

# formatGreeting only needs raw input — independent of geocode
greeting <- fg|i.city

# output wires
temp     <- w.temp
humidity <- w.humidity
population <- c.population
`;

  function makeExecutorWithLog() {
    const calls: CallRecord[] = [];
    const elapsed = createTimer();

    const tools: Record<string, any> = {
      "geo.code": async (input: any) => {
        const start = elapsed();
        await sleep(50); // simulate network
        const end = elapsed();
        calls.push({ name: "geo.code", startMs: start, endMs: end, input });
        return { lat: 52.53, lng: 13.38 };
      },
      "weather.get": async (input: any) => {
        const start = elapsed();
        await sleep(40); // simulate network
        const end = elapsed();
        calls.push({ name: "weather.get", startMs: start, endMs: end, input });
        return { temp: 22.5, humidity: 65.0 };
      },
      "census.get": async (input: any) => {
        const start = elapsed();
        await sleep(30); // simulate network
        const end = elapsed();
        calls.push({ name: "census.get", startMs: start, endMs: end, input });
        return { population: 3_748_148 };
      },
      formatGreeting: (input: { in: string }) => {
        const start = elapsed();
        calls.push({
          name: "formatGreeting",
          startMs: start,
          endMs: start,
          input,
        });
        return `Hello from ${input.in}!`;
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    return { executor, calls };
  }

  test("geocode is called exactly once despite two consumers", async () => {
    const { executor, calls } = makeExecutorWithLog();
    await executor({
      document: parse(
        `{ dashboard(city: "Berlin") { temp humidity population greeting } }`,
      ),
    });
    const geoCalls = calls.filter((c) => c.name === "geo.code");
    assert.equal(geoCalls.length, 1, "geocode must be called exactly once");
  });

  test("weatherApi and censusApi start concurrently after geocode", async () => {
    const { executor, calls } = makeExecutorWithLog();
    await executor({
      document: parse(
        `{ dashboard(city: "Berlin") { temp humidity population } }`,
      ),
    });

    const geo = calls.find((c) => c.name === "geo.code")!;
    const weather = calls.find((c) => c.name === "weather.get")!;
    const census = calls.find((c) => c.name === "census.get")!;

    // Both must start AFTER geocode finishes
    assert.ok(
      weather.startMs >= geo.endMs - 1,
      `weather must start after geocode ends (weather.start=${weather.startMs}, geo.end=${geo.endMs})`,
    );
    assert.ok(
      census.startMs >= geo.endMs - 1,
      `census must start after geocode ends (census.start=${census.startMs}, geo.end=${geo.endMs})`,
    );

    // Both must start BEFORE the other finishes ⟹ running in parallel
    // (weather takes 40ms, census takes 30ms — if sequential, one would start
    // after the other's endMs)
    assert.ok(
      Math.abs(weather.startMs - census.startMs) < 15,
      `weather and census should start near-simultaneously (Δ=${Math.abs(weather.startMs - census.startMs)}ms)`,
    );
  });

  test("all results are correct", async () => {
    const { executor } = makeExecutorWithLog();
    const result: any = await executor({
      document: parse(
        `{ dashboard(city: "Berlin") { temp humidity population greeting } }`,
      ),
    });

    assert.equal(result.data.dashboard.temp, 22.5);
    assert.equal(result.data.dashboard.humidity, 65.0);
    assert.equal(result.data.dashboard.population, 3_748_148);
    assert.equal(result.data.dashboard.greeting, "Hello from Berlin!");
  });

  test("formatGreeting does not wait for geocode", async () => {
    const { executor, calls } = makeExecutorWithLog();
    await executor({
      document: parse(
        `{ dashboard(city: "Berlin") { temp population greeting } }`,
      ),
    });

    const geo = calls.find((c) => c.name === "geo.code")!;
    const fg = calls.find((c) => c.name === "formatGreeting")!;

    // formatGreeting should start before geocode finishes (it's independent)
    assert.ok(
      fg.startMs < geo.endMs,
      `formatGreeting should not wait for geocode (fg.start=${fg.startMs}, geo.end=${geo.endMs})`,
    );
  });
});

// ── Test 2: Pipe forking — independent parallel invocations ──────────────────
//
// Two pipe uses of the same handle should produce two independent, parallel
// tool calls — not sequential and not deduplicated.
//
// Bridge:
//   doubled.a <- d|i.a     ← fork 1
//   doubled.b <- d|i.b     ← fork 2 (separate call, same tool fn)

describe("scheduling: pipe forks run in parallel", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      doubled(a: Float!, b: Float!): Doubled
    }
    type Doubled {
      a: Float
      b: Float
    }
  `;

  const bridgeText = `
extend slowDoubler as double

---

bridge Query.doubled
  with double as d
  with input as i

doubled.a <- d|i.a
doubled.b <- d|i.b
`;

  test("both pipe forks run in parallel, not sequentially", async () => {
    const calls: CallRecord[] = [];
    const elapsed = createTimer();

    const tools: Record<string, any> = {
      slowDoubler: async (input: any) => {
        const start = elapsed();
        await sleep(40);
        const end = elapsed();
        calls.push({ name: "slowDoubler", startMs: start, endMs: end, input });
        return input.in * 2;
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ doubled(a: 3, b: 7) { a b } }`),
    });

    assert.equal(result.data.doubled.a, 6);
    assert.equal(result.data.doubled.b, 14);

    // Must be exactly 2 calls — no dedup (these are separate forks)
    assert.equal(calls.length, 2, "exactly 2 independent calls");

    // They should start near-simultaneously (parallel, not sequential)
    assert.ok(
      Math.abs(calls[0].startMs - calls[1].startMs) < 15,
      `forks should start in parallel (Δ=${Math.abs(calls[0].startMs - calls[1].startMs)}ms)`,
    );
  });
});

// ── Test 3: Chained pipe — sequential but no duplicate calls ─────────────────
//
//   result <- normalize|toUpper|i.text
//
// toUpper must run first, then normalize gets toUpper's output.
// Each tool called exactly once.

describe("scheduling: chained pipes execute in correct order", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      processed(text: String!): ProcessedResult
    }
    type ProcessedResult {
      result: String
    }
  `;

  const bridgeText = `
bridge Query.processed
  with input as i
  with toUpper as tu
  with normalize as nm

result <- nm|tu|i.text
`;

  test("chain executes right-to-left: source → toUpper → normalize", async () => {
    const callOrder: string[] = [];

    const tools: Record<string, any> = {
      toUpper: async (input: any) => {
        await sleep(20);
        callOrder.push("toUpper");
        return String(input.in).toUpperCase();
      },
      normalize: async (input: any) => {
        await sleep(20);
        callOrder.push("normalize");
        return String(input.in).trim().replace(/\s+/g, " ");
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ processed(text: " hello  world ") { result } }`),
    });

    assert.equal(result.data.processed.result, "HELLO WORLD");
    assert.deepStrictEqual(callOrder, ["toUpper", "normalize"]);
  });

  test("each stage called exactly once", async () => {
    const callCounts: Record<string, number> = {};

    const tools: Record<string, any> = {
      toUpper: async (input: any) => {
        callCounts["toUpper"] = (callCounts["toUpper"] ?? 0) + 1;
        return String(input.in).toUpperCase();
      },
      normalize: async (input: any) => {
        callCounts["normalize"] = (callCounts["normalize"] ?? 0) + 1;
        return String(input.in).trim().replace(/\s+/g, " ");
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(`{ processed(text: "test") { result } }`),
    });

    assert.equal(callCounts["toUpper"], 1);
    assert.equal(callCounts["normalize"], 1);
  });
});

// ── Test 4: Shared dependency across pipe + direct wires ─────────────────────
//
// A single tool is consumed both via pipe AND via direct wire by different
// output fields. The tool must be called only once.

describe("scheduling: shared tool dedup across pipe and direct consumers", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      info(city: String!): CityInfo
    }
    type CityInfo {
      rawName: String
      shoutedName: String
    }
  `;

  const bridgeText = `
bridge Query.info
  with geo.lookup as g
  with toUpper as tu
  with input as i

g.q <- i.city
rawName     <- g.name
shoutedName <- tu|g.name
`;

  test("geo.lookup called once despite direct + pipe consumption", async () => {
    const callCounts: Record<string, number> = {};

    const tools: Record<string, any> = {
      "geo.lookup": async (input: any) => {
        callCounts["geo.lookup"] = (callCounts["geo.lookup"] ?? 0) + 1;
        await sleep(30);
        return { name: "Berlin" };
      },
      toUpper: (input: any) => {
        callCounts["toUpper"] = (callCounts["toUpper"] ?? 0) + 1;
        return String(input.in).toUpperCase();
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ info(city: "Berlin") { rawName shoutedName } }`),
    });

    assert.equal(result.data.info.rawName, "Berlin");
    assert.equal(result.data.info.shoutedName, "BERLIN");
    assert.equal(callCounts["geo.lookup"], 1, "geo.lookup must be called once");
    assert.equal(callCounts["toUpper"], 1);
  });
});

// ── Test 5: Wall-clock efficiency — total time approaches parallel optimum ───
//
//             ┌─ slowA (60ms) ─→ a
//   input ──→ ├─ slowB (60ms) ─→ b
//             └─ slowC (60ms) ─→ c
//
// If parallel: ~60ms.  If sequential: ~180ms.  Threshold: <100ms.

describe("scheduling: independent tools execute with true parallelism", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      trio(x: String!): Trio
    }
    type Trio {
      a: String
      b: String
      c: String
    }
  `;

  const bridgeText = `
bridge Query.trio
  with svc.a as sa
  with svc.b as sb
  with svc.c as sc
  with input as i

sa.x <- i.x
sb.x <- i.x
sc.x <- i.x
a <- sa.result
b <- sb.result
c <- sc.result
`;

  test("three 60ms tools complete in ≈60ms, not 180ms", async () => {
    const tools: Record<string, any> = {
      "svc.a": async (input: any) => {
        await sleep(60);
        return { result: `A:${input.x}` };
      },
      "svc.b": async (input: any) => {
        await sleep(60);
        return { result: `B:${input.x}` };
      },
      "svc.c": async (input: any) => {
        await sleep(60);
        return { result: `C:${input.x}` };
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const start = performance.now();
    const result: any = await executor({
      document: parse(`{ trio(x: "test") { a b c } }`),
    });
    const wallMs = performance.now() - start;

    assert.equal(result.data.trio.a, "A:test");
    assert.equal(result.data.trio.b, "B:test");
    assert.equal(result.data.trio.c, "C:test");

    assert.ok(
      wallMs < 120,
      `Wall time should be ~60ms (parallel), got ${Math.round(wallMs)}ms — tools may be running sequentially`,
    );
  });
});

// ── Test 6: Tool-level deps resolve in parallel ─────────────────────────────
//
// A ToolDef can depend on multiple other tools via `with`:
//   tool mainApi httpCall
//     with authService as auth
//     with quotaService as quota
//     headers.Authorization <- auth.access_token
//     headers.X-Quota <- quota.token
//
// Both deps are independent — they MUST resolve in parallel inside
// resolveToolWires, not sequentially.

describe("scheduling: tool-level deps resolve in parallel", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      secure(id: String!): SecureData
    }
    type SecureData {
      value: String
    }
  `;

  const bridgeText = `
extend httpCall as authService
  with context
  baseUrl = "https://auth.test"
  method = POST
  path = /token
  body.clientId <- context.auth.clientId

extend httpCall as quotaService
  with context
  baseUrl = "https://quota.test"
  method = GET
  path = /check
  headers.key <- context.quota.apiKey

extend httpCall as mainApi
  with authService as auth
  with quotaService as quota
  baseUrl = "https://api.test"
  headers.Authorization <- auth.access_token
  headers.X-Quota <- quota.token

extend mainApi as mainApi.getData
  method = GET
  path = /data

---

bridge Query.secure
  with mainApi.getData as m
  with input as i

m.id <- i.id
value <- m.payload
`;

  test("two independent tool deps (auth + quota) resolve in parallel, not sequentially", async () => {
    const calls: CallRecord[] = [];
    const elapsed = createTimer();

    const httpCall = async (input: any) => {
      const start = elapsed();
      if (input.path === "/token") {
        await sleep(50);
        const end = elapsed();
        calls.push({ name: "auth", startMs: start, endMs: end, input });
        return { access_token: "tok_abc" };
      }
      if (input.path === "/check") {
        await sleep(50);
        const end = elapsed();
        calls.push({ name: "quota", startMs: start, endMs: end, input });
        return { token: "qt_xyz" };
      }
      const end = elapsed();
      calls.push({ name: "main", startMs: start, endMs: end, input });
      return { payload: "secret" };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      context: { auth: { clientId: "c1" }, quota: { apiKey: "k1" } },
      tools: { httpCall },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const start = performance.now();
    const result: any = await executor({
      document: parse(`{ secure(id: "x") { value } }`),
    });
    const wallMs = performance.now() - start;

    assert.equal(result.data.secure.value, "secret");

    const auth = calls.find((c) => c.name === "auth")!;
    const quota = calls.find((c) => c.name === "quota")!;

    // Both deps should start near-simultaneously (parallel)
    assert.ok(
      Math.abs(auth.startMs - quota.startMs) < 15,
      `auth and quota should start in parallel (Δ=${Math.abs(auth.startMs - quota.startMs)}ms)`,
    );

    // Wall time: auth+quota in parallel (~50ms) + main (~0ms) ≈ 50-80ms
    // If sequential: auth(50) + quota(50) + main = ~100ms+
    assert.ok(
      wallMs < 100,
      `Wall time should be ~50ms (parallel deps), got ${Math.round(wallMs)}ms — deps may be resolving sequentially`,
    );
  });
});
