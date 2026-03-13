#!/usr/bin/env node
/**
 * Focused Profiling Target
 *
 * Runs a single benchmark scenario repeatedly for profiling.
 * Unlike the bench harness (which uses tinybench's measurement loop),
 * this script gives the profiler a clean, uninterrupted workload.
 *
 * Usage — always invoked via a profiling wrapper:
 *   node scripts/profile-cpu.mjs --target scripts/profile-target.mjs --filter "flat array 1000"
 *
 * Or directly (useful for manual --cpu-prof / --prof):
 *   BRIDGE_PROFILE_FILTER="flat array 1000" BRIDGE_PROFILE_ITERATIONS=5000 \
 *     node --experimental-transform-types --cpu-prof scripts/profile-target.mjs
 *
 * Environment variables:
 *   BRIDGE_PROFILE_FILTER      Substring match for scenario name (default: first scenario)
 *   BRIDGE_PROFILE_ITERATIONS  Number of iterations (default: 5000)
 */
// Must be run with: --experimental-transform-types
// Import from the umbrella package's source entry point directly.
import {
  parseBridgeFormat as parseBridge,
  executeBridge,
} from "../packages/bridge/src/index.ts";

// ── Scenarios ────────────────────────────────────────────────────────────────
// Each scenario is a self-contained { name, setup(), run() } object.
// `setup()` returns pre-parsed documents and tools.
// `run()` is the hot loop body — should be as tight as possible.

function doc(bridgeText) {
  const raw = parseBridge(bridgeText);
  return JSON.parse(JSON.stringify(raw));
}

const SCENARIOS = [
  {
    name: "flat array 10",
    setup() {
      const d = doc(`version 1.5
bridge Query.flatArray {
  with api
  with output as o

  o <- api.items[] as it {
    .id <- it.id
    .name <- it.name
    .value <- it.value
  }
}`);
      const tools = {
        api: async () => ({
          items: Array.from({ length: 10 }, (_, i) => ({
            id: i,
            name: `item-${i}`,
            value: i * 10,
          })),
        }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.flatArray",
        input: {},
        tools,
      });
    },
  },
  {
    name: "flat array 100",
    setup() {
      const d = doc(`version 1.5
bridge Query.flatArray {
  with api
  with output as o

  o <- api.items[] as it {
    .id <- it.id
    .name <- it.name
    .value <- it.value
  }
}`);
      const tools = {
        api: async () => ({
          items: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            name: `item-${i}`,
            value: i * 10,
          })),
        }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.flatArray",
        input: {},
        tools,
      });
    },
  },
  {
    name: "flat array 1000",
    setup() {
      const d = doc(`version 1.5
bridge Query.flatArray {
  with api
  with output as o

  o <- api.items[] as it {
    .id <- it.id
    .name <- it.name
    .value <- it.value
  }
}`);
      const tools = {
        api: async () => ({
          items: Array.from({ length: 1000 }, (_, i) => ({
            id: i,
            name: `item-${i}`,
            value: i * 10,
          })),
        }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.flatArray",
        input: {},
        tools,
      });
    },
  },
  {
    name: "nested array 10x10",
    setup() {
      const d = doc(`version 1.5
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
}`);
      const tools = {
        api: async () => ({
          connections: Array.from({ length: 10 }, (_, i) => ({
            id: `c${i}`,
            sections: Array.from({ length: 10 }, (_, j) => ({
              name: `Train-${i}-${j}`,
              departure: `Station-A-${j}`,
              arrival: `Station-B-${j}`,
            })),
          })),
        }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.nested",
        input: {},
        tools,
      });
    },
  },
  {
    name: "simple chain",
    setup() {
      const d = doc(`version 1.5
bridge Query.simple {
  with api
  with input as i
  with output as o

  api.q <- i.q
  o.result <- api.answer
}`);
      const tools = {
        api: async (p) => ({ answer: p.q + "!" }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.simple",
        input: { q: "hello" },
        tools,
      });
    },
  },
  {
    name: "chained 3-tool fan-out",
    setup() {
      const d = doc(`version 1.5
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
}`);
      const tools = {
        svcA: async () => ({ lat: 52.53, lon: 13.38 }),
        svcB: async () => ({ id: "b-42" }),
        svcC: async () => ({ name: "Berlin", score: 95 }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.chained",
        input: { q: "test" },
        tools,
      });
    },
  },
  {
    name: "tool-per-element 100",
    setup() {
      const d = doc(`version 1.5
bridge Query.enriched {
  with api
  with enrich
  with output as o

  o <- api.items[] as it {
    alias enrich:it as resp
    .a <- resp.a
    .b <- resp.b
  }
}`);
      const tools = {
        api: async () => ({
          items: Array.from({ length: 100 }, (_, i) => ({
            id: i,
            name: `item-${i}`,
          })),
        }),
        enrich: async (input) => ({
          a: input.in.id * 10,
          b: input.in.name.toUpperCase(),
        }),
      };
      return { d, tools };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.enriched",
        input: {},
        tools,
      });
    },
  },
  {
    name: "passthrough",
    setup() {
      const d = doc(`version 1.5
bridge Query.passthrough {
  with input as i
  with output as o

  o.id <- i.id
  o.name <- i.name
}`);
      return { d, tools: {} };
    },
    async run({ d, tools }) {
      await executeBridge({
        document: d,
        operation: "Query.passthrough",
        input: { id: "123", name: "Alice" },
        tools,
      });
    },
  },
  {
    name: "parse large",
    setup() {
      const handles = Array.from(
        { length: 20 },
        (_, i) => `  with svc${i}`,
      ).join("\n");
      const wires = Array.from({ length: 20 }, (_, i) =>
        Array.from(
          { length: 5 },
          (_, j) =>
            `  svc${i}.field${j} <- ${i === 0 ? `i.arg${j}` : `svc${i - 1}.out${j}`}`,
        ).join("\n"),
      ).join("\n");
      const outputs = Array.from(
        { length: 20 },
        (_, i) => `  o.result${i} <- svc${i}.out0`,
      ).join("\n");
      const text = `version 1.5\nbridge Query.large {\n  with input as i\n${handles}\n  with output as o\n\n${wires}\n${outputs}\n}`;
      return { text };
    },
    run({ text }) {
      parseBridge(text);
    },
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

const filterStr = process.env.BRIDGE_PROFILE_FILTER || "";
const iterations = parseInt(
  process.env.BRIDGE_PROFILE_ITERATIONS || "5000",
  10,
);

// Find matching scenario
let scenario = SCENARIOS.find((s) =>
  filterStr ? s.name.includes(filterStr) : true,
);

if (!scenario) {
  console.error(`No scenario matching "${filterStr}"`);
  console.error(
    `Available scenarios: ${SCENARIOS.map((s) => s.name).join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `\n🎯 Profiling: "${scenario.name}" × ${iterations.toLocaleString()} iterations\n`,
);

const ctx = scenario.setup();

// Warmup: run 500 iterations to let V8 optimize
const warmup = Math.min(500, Math.floor(iterations / 10));
console.log(`   Warming up (${warmup} iterations)...`);
for (let i = 0; i < warmup; i++) {
  await scenario.run(ctx);
}

// Measured run
console.log(`   Profiling (${iterations.toLocaleString()} iterations)...`);
const start = performance.now();

for (let i = 0; i < iterations; i++) {
  await scenario.run(ctx);
}

const elapsed = performance.now() - start;
const opsPerSec = Math.round((iterations / elapsed) * 1000);

console.log(`\n   Done in ${elapsed.toFixed(1)}ms`);
console.log(`   ${opsPerSec.toLocaleString()} ops/sec`);
console.log(`   ${(elapsed / iterations).toFixed(4)}ms avg per iteration`);
console.log();
