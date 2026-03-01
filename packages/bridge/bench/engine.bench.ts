/**
 * Bridge Engine Benchmarks
 *
 * Baseline measurements for execution engine performance.
 * Targets known hot-paths: array iteration (shadow trees),
 * nested arrays, tool chaining, and parsing.
 *
 * Run:   pnpm bench
 * CI:    outputs Bencher-compatible JSON to stdout
 */
import { Bench } from "tinybench";
import {
  parseBridgeFormat as parseBridge,
  executeBridge,
} from "../src/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function doc(bridgeText: string) {
  const raw = parseBridge(bridgeText);
  return JSON.parse(JSON.stringify(raw)) as ReturnType<typeof parseBridge>;
}

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  return executeBridge({ document: doc(bridgeText), operation, input, tools });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Simple chain: input → tool → output (no arrays)
const SIMPLE_CHAIN = `version 1.5
bridge Query.simple {
  with api
  with input as i
  with output as o

  api.q <- i.q
  o.result <- api.answer
}`;

const simpleTools = {
  api: async (p: any) => ({ answer: p.q + "!" }),
};

// Flat array: iterate N items with per-element field wiring
function flatArrayBridge(n: number) {
  return {
    text: `version 1.5
bridge Query.flatArray {
  with api
  with output as o

  o <- api.items[] as it {
    .id <- it.id
    .name <- it.name
    .value <- it.value
  }
}`,
    tools: {
      api: async () => ({
        items: Array.from({ length: n }, (_, i) => ({
          id: i,
          name: `item-${i}`,
          value: i * 10,
        })),
      }),
    },
  };
}

// Nested arrays: outer × inner (shadow tree depth = 2)
function nestedArrayBridge(outer: number, inner: number) {
  return {
    text: `version 1.5
bridge Query.nested {
  with api
  with output as o

  o <- api.connections[] as c {
    .id <- c.id
    .legs <- c.sections[] as s {
      .trainName <- s.name
      .origin <- s.departure
      .destination <- s.arrival
    }
  }
}`,
    tools: {
      api: async () => ({
        connections: Array.from({ length: outer }, (_, i) => ({
          id: `c${i}`,
          sections: Array.from({ length: inner }, (_, j) => ({
            name: `Train-${i}-${j}`,
            departure: `Station-A-${j}`,
            arrival: `Station-B-${j}`,
          })),
        })),
      }),
    },
  };
}

// Array with per-element tool call (alias pipe:iter)
function arrayWithToolPerElement(n: number) {
  return {
    text: `version 1.5
bridge Query.enriched {
  with api
  with enrich
  with output as o

  o <- api.items[] as it {
    alias enrich:it as resp
    .a <- resp.a
    .b <- resp.b
  }
}`,
    tools: {
      api: async () => ({
        items: Array.from({ length: n }, (_, i) => ({
          id: i,
          name: `item-${i}`,
        })),
      }),
      enrich: async (input: any) => ({
        a: input.in.id * 10,
        b: input.in.name.toUpperCase(),
      }),
    },
  };
}

// Multi-handle chained resolution (fan-out)
const CHAINED_MULTI = `version 1.5
bridge Query.chained {
  with svcA
  with svcB
  with svcC
  with input as i
  with output as o

  svcA.q <- i.q
  svcB.x <- svcA.lat
  svcB.y <- svcA.lon
  svcC.id <- svcB.id
  o.name <- svcC.name
  o.score <- svcC.score
  o.lat <- svcA.lat
}`;

const chainedTools = {
  svcA: async () => ({ lat: 52.53, lon: 13.38 }),
  svcB: async () => ({ id: "b-42" }),
  svcC: async () => ({ name: "Berlin", score: 95 }),
};

// ── Large bridge text for parse benchmark ────────────────────────────────────

function largeBridgeText(handleCount: number, wiresPerHandle: number) {
  const handles = Array.from(
    { length: handleCount },
    (_, i) => `  with svc${i}`,
  ).join("\n");
  const wires = Array.from({ length: handleCount }, (_, i) =>
    Array.from(
      { length: wiresPerHandle },
      (_, j) =>
        `  svc${i}.field${j} <- ${i === 0 ? `i.arg${j}` : `svc${i - 1}.out${j}`}`,
    ).join("\n"),
  ).join("\n");
  const outputs = Array.from(
    { length: handleCount },
    (_, i) => `  o.result${i} <- svc${i}.out0`,
  ).join("\n");

  return `version 1.5
bridge Query.large {
  with input as i
${handles}
  with output as o

${wires}
${outputs}
}`;
}

// ── Bench setup ──────────────────────────────────────────────────────────────

const bench = new Bench({
  warmupIterations: 5,
  time: 2000,
});

// --- Parsing ---

const largeText = largeBridgeText(20, 5);

bench.add("parse: simple bridge", () => {
  parseBridge(SIMPLE_CHAIN);
});

bench.add("parse: large bridge (20 handles × 5 wires)", () => {
  parseBridge(largeText);
});

// --- Execution: absolute baseline ---

const PASSTHROUGH = `version 1.5
bridge Query.passthrough {
  with input as i
  with output as o

  o.id <- i.id
  o.name <- i.name
}`;

const passthroughDoc = doc(PASSTHROUGH);

bench.add("exec: absolute baseline (passthrough, no tools)", async () => {
  await executeBridge({
    document: passthroughDoc,
    operation: "Query.passthrough",
    input: { id: "123", name: "Alice" },
  });
});

// --- Execution: short-circuit (overdefinition bypass) ---

const SHORT_CIRCUIT = `version 1.5
bridge Query.shortCircuit {
  with expensiveApi
  with input as i
  with output as o

  o.val <- i.cached
  o.val <- expensiveApi.data
}`;

const shortCircuitDoc = doc(SHORT_CIRCUIT);

bench.add("exec: short-circuit (overdefinition bypass)", async () => {
  await executeBridge({
    document: shortCircuitDoc,
    operation: "Query.shortCircuit",
    input: { cached: "instant_data" },
    tools: {
      expensiveApi: async () => {
        throw new Error("Should not be called!");
      },
    },
  });
});

// --- Execution: simple ---

const simpleDoc = doc(SIMPLE_CHAIN);

bench.add("exec: simple chain (1 tool)", async () => {
  await executeBridge({
    document: simpleDoc,
    operation: "Query.simple",
    input: { q: "hello" },
    tools: simpleTools,
  });
});

// --- Execution: chained multi-handle ---

const chainedDoc = doc(CHAINED_MULTI);

bench.add("exec: chained 3-tool fan-out", async () => {
  await executeBridge({
    document: chainedDoc,
    operation: "Query.chained",
    input: { q: "test" },
    tools: chainedTools,
  });
});

// --- Execution: flat arrays ---

for (const size of [10, 100, 1000]) {
  const fixture = flatArrayBridge(size);
  const d = doc(fixture.text);

  bench.add(`exec: flat array ${size} items`, async () => {
    await executeBridge({
      document: d,
      operation: "Query.flatArray",
      input: {},
      tools: fixture.tools,
    });
  });
}

// --- Execution: nested arrays ---

for (const [outer, inner] of [
  [5, 5],
  [10, 10],
  [20, 10],
] as const) {
  const fixture = nestedArrayBridge(outer, inner);
  const d = doc(fixture.text);

  bench.add(`exec: nested array ${outer}×${inner}`, async () => {
    await executeBridge({
      document: d,
      operation: "Query.nested",
      input: {},
      tools: fixture.tools,
    });
  });
}

// --- Execution: array with per-element tool ---

for (const size of [10, 100]) {
  const fixture = arrayWithToolPerElement(size);
  const d = doc(fixture.text);

  bench.add(`exec: array + tool-per-element ${size}`, async () => {
    await executeBridge({
      document: d,
      operation: "Query.enriched",
      input: {},
      tools: fixture.tools,
    });
  });
}

// ── Run & output ─────────────────────────────────────────────────────────────

await bench.run();

const isCI = process.env.CI === "true";

if (isCI) {
  // Bencher BMF (Benchmark Metrics Format) JSON output
  // https://bencher.dev/docs/reference/bencher-metric-format/
  const bmf: Record<
    string,
    { latency: { value: number; lower_value: number; upper_value: number } }
  > = {};

  for (const task of bench.tasks) {
    if (!task.result || task.result.state !== "completed") continue;
    const { mean, min, p75 } = task.result.latency;
    bmf[task.name] = {
      latency: {
        value: mean,
        lower_value: min,
        upper_value: p75,
      },
    };
  }

  console.log(JSON.stringify(bmf, null, 2));
} else {
  // Human-readable table for local dev
  console.table(
    bench.tasks.map((task) => {
      if (!task.result || task.result.state !== "completed")
        return { Name: task.name, "ops/sec": "FAILED" };
      const { mean, p75, p99, samplesCount } = task.result.latency;
      const hz = task.result.throughput.mean;
      return {
        Name: task.name,
        "ops/sec": Math.round(hz).toLocaleString(),
        "avg (ms)": mean.toFixed(3),
        "p75 (ms)": p75.toFixed(3),
        "p99 (ms)": p99.toFixed(3),
        samples: samplesCount,
      };
    }),
  );
}
