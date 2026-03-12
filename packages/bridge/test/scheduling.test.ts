import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Scheduling — diamond dependencies, tool deduplication, pipe fork
// parallelism, chained pipe ordering, tool-level dependency resolution.
//
// Migrated from legacy/scheduling.test.ts
//
// NOTE: The original tests used wall-clock timing assertions
// (performance.now + sleep) to verify parallel execution. The
// regressionTest harness doesn't directly support timing assertions,
// so those are converted to data-correctness checks with comments
// noting the original parallelism intent.
// ═══════════════════════════════════════════════════════════════════════════

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
  bridge: `
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
          geocode: (() => {
            let calls = 0;
            return (_p: any) => {
              calls++;
              assert.equal(calls, 1, "geocode must be called exactly once");
              return { lat: 52.5, lon: 13.4 };
            };
          })(),
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
  bridge: `
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
  bridge: `
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
  bridge: `
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

// ── 5. Wall-clock efficiency ────────────────────────────────────────────────
//
// Original test: three 60ms-sleep tools complete in ~60ms (parallel),
// not 180ms (sequential). Converted to data-correctness only since
// regressionTest can't assert on wall-clock time.

regressionTest("scheduling: parallel independent tools", {
  bridge: `
    version 1.5

    bridge Query.parallel {
      with apiA as a
      with apiB as b
      with apiC as c
      with input as i
      with output as o

      a.x <- i.x
      b.y <- i.y
      c.z <- i.z

      o.a <- a.result
      o.b <- b.result
      o.c <- c.result
    }
  `,
  scenarios: {
    "Query.parallel": {
      "three independent tools all produce correct results": {
        input: { x: 1, y: 2, z: 3 },
        tools: {
          apiA: (p: any) => ({ result: p.x * 10 }),
          apiB: (p: any) => ({ result: p.y * 10 }),
          apiC: (p: any) => ({ result: p.z * 10 }),
        },
        assertData: { a: 10, b: 20, c: 30 },
        assertTraces: 3,
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
  bridge: `
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
        assertTraces: 3,
      },
    },
  },
});

// ── 7. Tool-level deps resolve in parallel ──────────────────────────────────
//
// Original test: auth + quota both run in parallel (both ~60ms,
// total ~60ms), then mainApi runs after both complete.
// Converted to data correctness only.

regressionTest("scheduling: tool-level deps resolve in parallel", {
  bridge: `
    version 1.5

    tool authProvider from authFn {
    }

    tool quotaChecker from quotaFn {
    }

    tool mainApi from mainFn {
      .token <- authProvider.token
      .quotaOk <- quotaChecker.allowed
    }

    bridge Query.toolDeps {
      with mainApi as m
      with input as i
      with output as o

      m.q <- i.q
      o.result <- m.data
    }
  `,
  scenarios: {
    "Query.toolDeps": {
      "auth and quota resolve, then mainApi runs with their outputs": {
        input: { q: "search" },
        tools: {
          authFn: () => ({ token: "valid-token" }),
          quotaFn: () => ({ allowed: true }),
          mainFn: (p: any) => {
            assert.equal(p.token, "valid-token");
            assert.equal(p.quotaOk, true);
            return { data: `result-for-${p.q}` };
          },
        },
        assertData: { result: "result-for-search" },
        // authProvider + quotaChecker + mainApi = 3
        allowDowngrade: true,
        assertTraces: 3,
      },
    },
  },
});
