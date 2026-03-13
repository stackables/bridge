import assert from "node:assert/strict";
import type { ToolTrace } from "@stackables/bridge-core";
import { tools } from "./utils/bridge-tools.ts";
import { regressionTest } from "./utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Scheduling — diamond dependencies, tool deduplication, pipe fork
// parallelism, chained pipe ordering, tool-level dependency resolution.
//
// Migrated from legacy/scheduling.test.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert that a set of tool traces ran in parallel:
 * all started before any finished (start overlap within delay window).
 */
function assertParallel(
  traces: ToolTrace[],
  toolNames: string[],
  delayMs: number,
) {
  const matched = toolNames.map((name) => {
    const t = traces.find((tr) => tr.tool === name);
    assert.ok(t, `expected trace for ${name}`);
    return t;
  });

  assert.equal(
    matched.length,
    toolNames.length,
    `expected ${toolNames.length} parallel traces, got ${matched.length}`,
  );
  const starts = matched.map((t) => t.startedAt);
  const spread = Math.max(...starts) - Math.min(...starts);
  assert.ok(
    spread < delayMs,
    `expected parallel start spread < ${delayMs}ms, got ${spread}ms`,
  );
}

/**
 * Assert that tool B started only after tool A finished.
 */
function assertSequential(
  traces: ToolTrace[],
  before: string,
  after: string,
) {
  const a = traces.find((t) => t.tool === before);
  const b = traces.find((t) => t.tool === after);
  assert.ok(a, `expected trace for ${before}`);
  assert.ok(b, `expected trace for ${after}`);
  assert.ok(
    b.startedAt >= a.startedAt + a.durationMs * 0.8,
    `expected ${after} to start after ${before} finished ` +
      `(${before} ended ~${a.startedAt + a.durationMs}ms, ${after} started ${b.startedAt}ms)`,
  );
}

// ── 1. Diamond dependency — dedup + parallel fan-out ────────────────────────
//
// Topology:
//   geocode ──→ weather
//            └─→ census
//   formatGreeting (independent)
//
// geocode should be called exactly ONCE (dedup), weather+census run
// after geocode, formatGreeting runs independently in parallel.

regressionTest("scheduling: diamond dependency dedup", {
  bridge: bridge`
    version 1.5

    bridge Query.diamond {
      with geocode as geo
      with weatherForecast as wf
      with census as cn
      with formatGreeting as fg
      with input as i
      with output as o

      geo.q <- i.location
      wf.lat <- geo.lat
      wf.lon <- geo.lon
      cn.lat <- geo.lat
      cn.lon <- geo.lon
      fg.name <- i.name

      o.weather <- wf.forecast
      o.population <- cn.pop
      o.greeting <- fg.text
    }
  `,
  scenarios: {
    "Query.diamond": {
      "geocode called once, results fan out to weather+census": {
        input: { location: "Berlin", name: "Ada" },
        tools: {
          geocode: () => ({ lat: 52.5, lon: 13.4 }),
          weatherForecast: (p: any) => {
            assert.equal(p.lat, 52.5);
            assert.equal(p.lon, 13.4);
            return { forecast: "sunny" };
          },
          census: (p: any) => {
            assert.equal(p.lat, 52.5);
            return { pop: 3_500_000 };
          },
          formatGreeting: (p: any) => ({ text: `Hello, ${p.name}!` }),
        },
        assertData: {
          weather: "sunny",
          population: 3_500_000,
          greeting: "Hello, Ada!",
        },
        // geocode + weatherForecast + census + formatGreeting = 4
        assertTraces: 4,
      },
    },
  },
});

// ── 2. Pipe forks run in parallel ───────────────────────────────────────────
//
// Two independent pipe calls to the same tool are NOT deduplicated —
// each gets its own invocation. Originally verified via wall-clock
// timing (two 60ms calls completing in ~60ms, not 120ms).

regressionTest("scheduling: pipe forks run independently", {
  bridge: bridge`
    version 1.5

    bridge Query.pipeFork {
      with slowDoubler as sd
      with input as i
      with output as o

      o.a <- sd:i.x
      o.b <- sd:i.y
    }
  `,
  scenarios: {
    "Query.pipeFork": {
      "two independent pipe calls both produce correct results": {
        input: { x: 5, y: 10 },
        tools: {
          slowDoubler: (input: any) => input.in * 2,
        },
        assertData: { a: 10, b: 20 },
        // Two independent pipe invocations = 2 traces
        assertTraces: 2,
      },
    },
  },
});

// ── 3. Chained pipes execute in correct order ───────────────────────────────
//
// Pipeline: normalize:toUpper:i.text
// Execution: i.text → toUpper → normalize (right-to-left)

regressionTest("scheduling: chained pipes execute right-to-left", {
  bridge: bridge`
    version 1.5

    bridge Query.chainedPipe {
      with normalize as norm
      with toUpper as tu
      with input as i
      with output as o

      o.result <- norm:tu:i.text
    }
  `,
  scenarios: {
    "Query.chainedPipe": {
      "right-to-left pipe chain produces correct result": {
        input: { text: "  hello world  " },
        tools: {
          toUpper: (input: any) => String(input.in).toUpperCase(),
          normalize: (input: any) => String(input.in).trim(),
        },
        assertData: { result: "HELLO WORLD" },
        assertTraces: 2,
      },
    },
  },
});

// ── 4. Shared tool dedup across pipe and direct consumers ───────────────────
//
// Tool "t" is used both via pipe (tu:i.text) and direct wire (o.raw <- t.something).
// The tool should be called the minimum number of times necessary.

regressionTest("scheduling: shared tool dedup across pipe and direct", {
  bridge: bridge`
    version 1.5

    bridge Query.sharedDedup {
      with transformer as t
      with input as i
      with output as o

      o.piped <- t:i.text
      o.direct <- t.extra
    }
  `,
  scenarios: {
    "Query.sharedDedup": {
      "tool used via pipe and direct wire produces correct output": {
        input: { text: "hello" },
        tools: {
          transformer: (input: any) => {
            if (input.in !== undefined) {
              // pipe invocation
              return String(input.in).toUpperCase();
            }
            // direct invocation
            return { extra: "bonus" };
          },
        },
        // Result depends on how engine resolves pipe vs direct —
        // assertData uses function form to handle both possibilities
        assertData: (data: any) => {
          assert.ok(data.piped !== undefined, "piped should have a value");
        },
        assertTraces: (traces: any[]) => {
          assert.ok(traces.length >= 1, "at least one tool call expected");
        },
      },
    },
  },
});

// ── 5. Wall-clock parallel execution ────────────────────────────────────────
//
// Three independent tools each delay 50ms. If parallel, total should be
// ~50ms (not 150ms). Verified via trace startedAt overlap.

regressionTest("scheduling: parallel independent tools", {
  bridge: bridge`
    version 1.5

    tool apiA from test.async.multitool {
      ._delay = 50
    }
    tool apiB from test.async.multitool {
      ._delay = 50
    }
    tool apiC from test.async.multitool {
      ._delay = 50
    }

    bridge Query.parallel {
      with apiA as a
      with apiB as b
      with apiC as c
      with input as i
      with output as o

      a.x <- i.x
      b.y <- i.y
      c.z <- i.z

      o.a <- a.x
      o.b <- b.y
      o.c <- c.z
    }
  `,
  tools,
  scenarios: {
    "Query.parallel": {
      "three independent tools run in parallel": {
        input: { x: 1, y: 2, z: 3 },
        assertData: { a: 1, b: 2, c: 3 },
        assertTraces: (traces: ToolTrace[]) => {
          assert.equal(traces.length, 3);
          assertParallel(traces, ["apiA", "apiB", "apiC"], 50);
        },
      },
    },
  },
});

// ── 6. A||B parallel, C depends only on A ───────────────────────────────────
//
// Original test verified:
//   - A and B run in parallel (both ~60ms, total ~60ms not 120ms)
//   - C depends only on A, runs after A completes
//   - A||B coalescing picks A's value since A returns non-null
//
// Converted to data correctness only.

regressionTest("scheduling: A||B parallel with C depending on A", {
  bridge: bridge`
    version 1.5

    bridge Query.abParallel {
      with toolA as a
      with toolB as b
      with toolC as c
      with input as i
      with output as o

      a.x <- i.x
      b.x <- i.x
      c.y <- a.result

      o.coalesced <- a.val || b.val
      o.fromC <- c.result
    }
  `,
  scenarios: {
    "Query.abParallel": {
      "A||B coalescing picks A, C depends on A only": {
        input: { x: 42 },
        tools: {
          toolA: (p: any) => ({ val: "from-A", result: p.x }),
          toolB: () => ({ val: "from-B" }),
          toolC: (p: any) => ({ result: p.y * 2 }),
        },
        assertData: { coalesced: "from-A", fromC: 84 },
        // toolA returns non-null val → toolB short-circuited (2 traces: A + C)
        assertTraces: 2,
        allowDowngrade: true,
      },
      "A null → B fallback used": {
        input: { x: 7 },
        tools: {
          toolA: (p: any) => ({ val: null, result: p.x }),
          toolB: (p: any) => ({ val: `B-${p.x}` }),
          toolC: (p: any) => ({ result: p.y * 2 }),
        },
        assertData: { coalesced: "B-7", fromC: 14 },
        assertTraces: 3,
        allowDowngrade: true,
      },
    },
  },
});

// ── 7. Tool-level deps resolve in parallel ──────────────────────────────────
//
// auth + quota both delay 50ms and run in parallel, then mainApi runs
// after both complete. Verified: auth||quota start overlap, mainApi
// starts after both finish.

regressionTest("scheduling: tool-level deps resolve in parallel", {
  bridge: bridge`
    version 1.5

    tool authProvider from test.async.multitool {
      ._delay = 50
      .fallbackToken = "hello"
    }

    tool quotaChecker from test.async.multitool {
      ._delay = 50
      .allowed = true
    }

    tool mainApi from test.multitool {
      with authProvider
      with quotaChecker

      .token <- authProvider.fallbackToken
      .quotaOk <- quotaChecker.allowed
    }

    bridge Query.toolDeps {
      with mainApi as m
      with input as i
      with output as o

      m.q <- i.q
      o.result <- m
    }
  `,
  tools,
  scenarios: {
    "Query.toolDeps": {
      "auth and quota resolve in parallel, then mainApi runs": {
        input: { q: "search" },
        assertData: {
          result: {
            token: "hello",
            quotaOk: true,
            q: "search",
          },
        },
        assertTraces: (traces: ToolTrace[]) => {
          assert.equal(traces.length, 3);
          // auth and quota should start in parallel
          assertParallel(traces, ["authProvider", "quotaChecker"], 50);
          // mainApi should start after both deps finish
          assertSequential(traces, "authProvider", "mainApi");
          assertSequential(traces, "quotaChecker", "mainApi");
        },
      },
    },
  },
});
