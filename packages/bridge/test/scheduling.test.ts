import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./_dual-run.ts";

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

const diamondBridge = `version 1.5
bridge Query.dashboard {
  with geo.code as gc
  with weather.get as w
  with census.get as c
  with formatGreeting as fg
  with input as i
  with output as o

# geocode from input
gc.city <- i.city

# weather depends on geocode output
w.lat <- gc.lat
w.lng <- gc.lng

# census ALSO depends on geocode output (same source — must dedup)
c.lat <- gc.lat
c.lng <- gc.lng

# formatGreeting only needs raw input — independent of geocode
o.greeting <- fg:i.city

# output wires
o.temp     <- w.temp
o.humidity <- w.humidity
o.population <- c.population

}`;

function makeDiamondTools() {
  const calls: CallRecord[] = [];
  const elapsed = createTimer();

  const tools: Record<string, any> = {
    "geo.code": async (input: any) => {
      const start = elapsed();
      await sleep(50);
      const end = elapsed();
      calls.push({ name: "geo.code", startMs: start, endMs: end, input });
      return { lat: 52.53, lng: 13.38 };
    },
    "weather.get": async (input: any) => {
      const start = elapsed();
      await sleep(40);
      const end = elapsed();
      calls.push({ name: "weather.get", startMs: start, endMs: end, input });
      return { temp: 22.5, humidity: 65.0 };
    },
    "census.get": async (input: any) => {
      const start = elapsed();
      await sleep(30);
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

  return { tools, calls };
}

forEachEngine("scheduling: diamond dependency dedup + parallelism", (run) => {
  test("geocode is called exactly once despite two consumers", async () => {
    const { tools, calls } = makeDiamondTools();
    await run(diamondBridge, "Query.dashboard", { city: "Berlin" }, tools);
    const geoCalls = calls.filter((c) => c.name === "geo.code");
    assert.equal(geoCalls.length, 1, "geocode must be called exactly once");
  });

  test("weatherApi and censusApi start concurrently after geocode", async () => {
    const { tools, calls } = makeDiamondTools();
    await run(diamondBridge, "Query.dashboard", { city: "Berlin" }, tools);

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
    assert.ok(
      Math.abs(weather.startMs - census.startMs) < 15,
      `weather and census should start near-simultaneously (Δ=${Math.abs(weather.startMs - census.startMs)}ms)`,
    );
  });

  test("all results are correct", async () => {
    const { tools } = makeDiamondTools();
    const { data } = await run(
      diamondBridge,
      "Query.dashboard",
      { city: "Berlin" },
      tools,
    );

    assert.equal(data.temp, 22.5);
    assert.equal(data.humidity, 65.0);
    assert.equal(data.population, 3_748_148);
    assert.equal(data.greeting, "Hello from Berlin!");
  });

  test("formatGreeting does not wait for geocode", async () => {
    const { tools, calls } = makeDiamondTools();
    await run(diamondBridge, "Query.dashboard", { city: "Berlin" }, tools);

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
//   doubled.a <- d:i.a     ← fork 1
//   doubled.b <- d:i.b     ← fork 2 (separate call, same tool fn)

forEachEngine("scheduling: pipe forks run in parallel", (run) => {
  const bridgeText = `version 1.5
tool double from slowDoubler


bridge Query.doubled {
  with double as d
  with input as i
  with output as o

o.a <- d:i.a
o.b <- d:i.b

}`;

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

    const { data } = await run(
      bridgeText,
      "Query.doubled",
      { a: 3, b: 7 },
      tools,
    );

    assert.equal(data.a, 6);
    assert.equal(data.b, 14);

    // Must be exactly 2 calls — no dedup (these are separate forks)
    assert.equal(calls.length, 2, "exactly 2 independent calls");

    // They should start near-simultaneously (parallel, not sequential)
    assert.ok(
      Math.abs(calls[0]!.startMs - calls[1]!.startMs) < 15,
      `forks should start in parallel (Δ=${Math.abs(calls[0]!.startMs - calls[1]!.startMs)}ms)`,
    );
  });
});

// ── Test 3: Chained pipe — sequential but no duplicate calls ─────────────────
//
//   result <- normalize:toUpper:i.text
//
// toUpper must run first, then normalize gets toUpper's output.
// Each tool called exactly once.

forEachEngine("scheduling: chained pipes execute in correct order", (run) => {
  const bridgeText = `version 1.5
bridge Query.processed {
  with input as i
  with toUpper as tu
  with normalize as nm
  with output as o

o.result <- nm:tu:i.text

}`;

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

    const { data } = await run(
      bridgeText,
      "Query.processed",
      { text: " hello  world " },
      tools,
    );

    assert.equal(data.result, "HELLO WORLD");
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

    await run(bridgeText, "Query.processed", { text: "test" }, tools);

    assert.equal(callCounts["toUpper"], 1);
    assert.equal(callCounts["normalize"], 1);
  });
});

// ── Test 4: Shared dependency across pipe + direct wires ─────────────────────
//
// A single tool is consumed both via pipe AND via direct wire by different
// output fields. The tool must be called only once.

forEachEngine(
  "scheduling: shared tool dedup across pipe and direct consumers",
  (run) => {
    const bridgeText = `version 1.5
bridge Query.info {
  with geo.lookup as g
  with toUpper as tu
  with input as i
  with output as o

g.q <- i.city
o.rawName     <- g.name
o.shoutedName <- tu:g.name

}`;

    test("geo.lookup called once despite direct + pipe consumption", async () => {
      const callCounts: Record<string, number> = {};

      const tools: Record<string, any> = {
        "geo.lookup": async (_input: any) => {
          callCounts["geo.lookup"] = (callCounts["geo.lookup"] ?? 0) + 1;
          await sleep(30);
          return { name: "Berlin" };
        },
        toUpper: (input: any) => {
          callCounts["toUpper"] = (callCounts["toUpper"] ?? 0) + 1;
          return String(input.in).toUpperCase();
        },
      };

      const { data } = await run(
        bridgeText,
        "Query.info",
        { city: "Berlin" },
        tools,
      );

      assert.equal(data.rawName, "Berlin");
      assert.equal(data.shoutedName, "BERLIN");
      assert.equal(
        callCounts["geo.lookup"],
        1,
        "geo.lookup must be called once",
      );
      assert.equal(callCounts["toUpper"], 1);
    });
  },
);

// ── Test 5: Wall-clock efficiency — total time approaches parallel optimum ───
//
//             ┌─ slowA (60ms) ─→ a
//   input ──→ ├─ slowB (60ms) ─→ b
//             └─ slowC (60ms) ─→ c
//
// If parallel: ~60ms.  If sequential: ~180ms.  Threshold: <120ms.

forEachEngine(
  "scheduling: independent tools execute with true parallelism",
  (run) => {
    const bridgeText = `version 1.5
bridge Query.trio {
  with svc.a as sa
  with svc.b as sb
  with svc.c as sc
  with input as i
  with output as o

sa.x <- i.x
sb.x <- i.x
sc.x <- i.x
o.a <- sa.result
o.b <- sb.result
o.c <- sc.result

}`;

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

      const start = performance.now();
      const { data } = await run(
        bridgeText,
        "Query.trio",
        { x: "test" },
        tools,
      );
      const wallMs = performance.now() - start;

      assert.equal(data.a, "A:test");
      assert.equal(data.b, "B:test");
      assert.equal(data.c, "C:test");

      assert.ok(
        wallMs < 120,
        `Wall time should be ~60ms (parallel), got ${Math.round(wallMs)}ms — tools may be running sequentially`,
      );
    });
  },
);

// ── Test 6: A||B then C depends on A ─────────────────────────────────────────
//
// Topology:
//
//   input ──→ A (50ms) ──→ C (needs A.value)
//   input ──→ B (80ms)
//
// A and B should start in parallel.
// C should start after A finishes but NOT wait for B.
// Total wall time ≈ max(A + C, B) ≈ 80ms, not A + B + C = 160ms.

forEachEngine(
  "scheduling: A||B parallel, C depends only on A (not B)",
  (run, ctx) => {
    const bridgeText = `version 1.5
bridge Query.mixed {
  with toolA as a
  with toolB as b
  with toolC as c
  with input as i
  with output as o

a.x <- i.x
b.x <- i.x
c.y <- a.value
o.fromA <- a.value
o.fromB <- b.value
o.fromC <- c.result

}`;

    test("A and B start together, C starts after A (not after B)", async () => {
      const calls: CallRecord[] = [];
      const elapsed = createTimer();

      const tools: Record<string, any> = {
        toolA: async (input: any) => {
          const start = elapsed();
          await sleep(50);
          const end = elapsed();
          calls.push({ name: "A", startMs: start, endMs: end, input });
          return { value: `A:${input.x}` };
        },
        toolB: async (input: any) => {
          const start = elapsed();
          await sleep(80);
          const end = elapsed();
          calls.push({ name: "B", startMs: start, endMs: end, input });
          return { value: `B:${input.x}` };
        },
        toolC: async (input: any) => {
          const start = elapsed();
          await sleep(30);
          const end = elapsed();
          calls.push({ name: "C", startMs: start, endMs: end, input });
          return { result: `C:${input.y}` };
        },
      };

      const start = performance.now();
      const { data } = await run(bridgeText, "Query.mixed", { x: "go" }, tools);
      const wallMs = performance.now() - start;

      // Correctness
      assert.equal(data.fromA, "A:go");
      assert.equal(data.fromB, "B:go");
      assert.equal(data.fromC, "C:A:go");

      const callA = calls.find((c) => c.name === "A")!;
      const callB = calls.find((c) => c.name === "B")!;
      const callC = calls.find((c) => c.name === "C")!;

      // A and B should start near-simultaneously (both independent of each other)
      assert.ok(
        Math.abs(callA.startMs - callB.startMs) < 15,
        `A and B should start in parallel (Δ=${Math.abs(callA.startMs - callB.startMs)}ms)`,
      );

      // C should start after A finishes
      assert.ok(
        callC.startMs >= callA.endMs - 1,
        `C must start after A ends (C.start=${callC.startMs}, A.end=${callA.endMs})`,
      );

      // The runtime engine resolves C as soon as A finishes (optimal):
      //   wall time ≈ max(A+C, B) = max(80, 80) = 80ms
      // The compiled engine uses Promise.all layers, so C waits for the
      // entire first layer (A + B) before starting:
      //   wall time ≈ max(A, B) + C = 80 + 30 = 110ms
      // Both are significantly better than full sequential: A+B+C = 160ms.
      if (ctx.engine === "runtime") {
        assert.ok(
          callC.startMs < callB.endMs,
          `[runtime] C should start before B finishes (C.start=${callC.startMs}, B.end=${callB.endMs})`,
        );
        assert.ok(
          wallMs < 110,
          `[runtime] Wall time should be ~80ms, got ${Math.round(wallMs)}ms`,
        );
      } else {
        assert.ok(
          wallMs < 140,
          `[compiled] Wall time should be ~110ms (layer-based), got ${Math.round(wallMs)}ms`,
        );
      }
    });
  },
);

// ── Test 7: Tool-level deps resolve in parallel ─────────────────────────────
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

forEachEngine("scheduling: tool-level deps resolve in parallel", (run, ctx) => {
  const bridgeText = `version 1.5
tool authService from httpCall {
  with context
  .baseUrl = "https://auth.test"
  .method = POST
  .path = /token
  .body.clientId <- context.auth.clientId

}
tool quotaService from httpCall {
  with context
  .baseUrl = "https://quota.test"
  .method = GET
  .path = /check
  .headers.key <- context.quota.apiKey

}
tool mainApi from httpCall {
  with authService as auth
  with quotaService as quota
  .baseUrl = "https://api.test"
  .headers.Authorization <- auth.access_token
  .headers.X-Quota <- quota.token

}
tool mainApi.getData from mainApi {
  .method = GET
  .path = /data

}

bridge Query.secure {
  with mainApi.getData as m
  with input as i
  with output as o

m.id <- i.id
o.value <- m.payload

}`;

  test("two independent tool deps (auth + quota) resolve in parallel, not sequentially", async (_t) => {
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

    const start = performance.now();
    const { data } = await run(
      bridgeText,
      "Query.secure",
      { id: "x" },
      { httpCall },
      { context: { auth: { clientId: "c1" }, quota: { apiKey: "k1" } } },
    );
    const wallMs = performance.now() - start;

    assert.equal(data.value, "secret");

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
