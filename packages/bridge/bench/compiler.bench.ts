/**
 * Compiler vs Runtime Benchmarks
 *
 * Side-by-side comparison of the AOT compiler (`@stackables/bridge-compiler`)
 * against the runtime interpreter (`@stackables/bridge-core`).
 *
 * Both paths execute the same bridge documents with the same tools and input,
 * measuring throughput after compile-once / parse-once setup.
 *
 * Run:   node --experimental-transform-types --conditions source bench/compiler.bench.ts
 */
import { Bench } from "tinybench";
import {
  parseBridgeFormat as parseBridge,
  executeBridge as executeRuntime,
} from "../src/index.ts";
import { executeBridge as executeCompiled } from "@stackables/bridge-compiler";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse and deep-clone to match what the runtime engine expects. */
function doc(bridgeText: string) {
  const raw = parseBridge(bridgeText);
  return JSON.parse(JSON.stringify(raw)) as ReturnType<typeof parseBridge>;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// 1. Passthrough — absolute baseline (no tools)
const PASSTHROUGH = `version 1.5
bridge Query.passthrough {
  with input as i
  with output as o

  o.id <- i.id
  o.name <- i.name
}`;

// 2. Simple chain: input → 1 tool → output
const SIMPLE_CHAIN = `version 1.5
bridge Query.simple {
  with api
  with input as i
  with output as o

  api.q <- i.q
  o.result <- api.answer
}`;

const simpleTools = {
  api: (p: any) => ({ answer: p.q + "!" }),
};

// 3. Chained 3-tool fan-out
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
  svcA: () => ({ lat: 52.53, lon: 13.38 }),
  svcB: () => ({ id: "b-42" }),
  svcC: () => ({ name: "Berlin", score: 95 }),
};

// 4. Flat array mapping — various sizes
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
      api: () => ({
        items: Array.from({ length: n }, (_, i) => ({
          id: i,
          name: `item-${i}`,
          value: i * 10,
        })),
      }),
    },
  };
}

// 5. Nested array mapping
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
      api: () => ({
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

// 6. Array with per-element tool call
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
      api: () => ({
        items: Array.from({ length: n }, (_, i) => ({
          id: i,
          name: `item-${i}`,
        })),
      }),
      enrich: (input: any) => ({
        a: input.in.id * 10,
        b: input.in.name.toUpperCase(),
      }),
    },
  };
}

// 7. Short-circuit (overdefinition bypass)
const SHORT_CIRCUIT = `version 1.5
bridge Query.shortCircuit {
  with expensiveApi
  with input as i
  with output as o

  o.val <- i.cached
  o.val <- expensiveApi.data
}`;

// 8. Fallback chains — nullish + falsy
const FALLBACK_CHAIN = `version 1.5
bridge Query.fallback {
  with primary
  with backup
  with input as i
  with output as o

  o.name <- primary.name ?? backup.name
  o.label <- primary.label || "default"
  o.score <- primary.score ?? 0
}`;

const fallbackTools = {
  primary: () => ({ name: null, label: "", score: null }),
  backup: () => ({ name: "fallback-name" }),
};

// 9. ToolDef with extends chain
const TOOLDEF_CHAIN = `version 1.5
tool baseApi from std.httpCall {
  .method = "GET"
  .baseUrl = "https://api.example.com"
}

tool userApi from baseApi {
  .path = "/users"
}

bridge Query.users {
  with userApi as api
  with input as i
  with output as o

  api.filter <- i.filter
  o <- api
}`;

const toolDefTools = {
  "std.httpCall": (input: any) => ({
    users: [{ id: 1 }],
    method: input.method,
    path: input.path,
  }),
};

// 10. Math expressions (internal tool inlining)
const EXPRESSIONS = `version 1.5
bridge Query.calc {
  with input as i
  with output as o

  o.total <- i.price * i.qty
  o.isAdult <- i.age >= 18
  o.label <- i.first + " " + i.last
}`;

// ── Bench setup ──────────────────────────────────────────────────────────────

const bench = new Bench({
  warmupTime: 1000,
  warmupIterations: 10,
  time: 3000,
});

// ── Helper: add paired benchmarks ────────────────────────────────────────────

function addPair(
  name: string,
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  const d = doc(bridgeText);

  bench.add(`runtime: ${name}`, async () => {
    await executeRuntime({ document: d, operation, input, tools });
  });

  bench.add(`compiled: ${name}`, async () => {
    await executeCompiled({ document: d, operation, input, tools });
  });
}

// ── Benchmark pairs ──────────────────────────────────────────────────────────

// Passthrough
addPair("passthrough (no tools)", PASSTHROUGH, "Query.passthrough", {
  id: "123",
  name: "Alice",
});

// Simple chain
addPair(
  "simple chain (1 tool)",
  SIMPLE_CHAIN,
  "Query.simple",
  { q: "hello" },
  simpleTools,
);

// Chained 3-tool fan-out
addPair(
  "3-tool fan-out",
  CHAINED_MULTI,
  "Query.chained",
  { q: "test" },
  chainedTools,
);

// Short-circuit (overdefinition bypass)
addPair(
  "short-circuit (overdefinition)",
  SHORT_CIRCUIT,
  "Query.shortCircuit",
  { cached: "already-here" },
  { expensiveApi: () => ({ data: "expensive" }) },
);

// Fallback chains
addPair(
  "fallback chains (??/||)",
  FALLBACK_CHAIN,
  "Query.fallback",
  {},
  fallbackTools,
);

// ToolDef with extends
addPair(
  "toolDef extends chain",
  TOOLDEF_CHAIN,
  "Query.users",
  { filter: "active" },
  toolDefTools,
);

// Expressions (inlined internal tools)
addPair("math expressions", EXPRESSIONS, "Query.calc", {
  price: 10,
  qty: 5,
  age: 25,
  first: "Alice",
  last: "Smith",
});

// Flat arrays
for (const size of [10, 100, 1000]) {
  const fixture = flatArrayBridge(size);
  addPair(
    `flat array ${size}`,
    fixture.text,
    "Query.flatArray",
    {},
    fixture.tools,
  );
}

// Nested arrays
for (const [outer, inner] of [
  [5, 5],
  [10, 10],
  [20, 10],
] as const) {
  const fixture = nestedArrayBridge(outer, inner);
  addPair(
    `nested array ${outer}x${inner}`,
    fixture.text,
    "Query.nested",
    {},
    fixture.tools,
  );
}

// Array + per-element tool
for (const size of [10, 100]) {
  const fixture = arrayWithToolPerElement(size);
  addPair(
    `array + tool-per-element ${size}`,
    fixture.text,
    "Query.enriched",
    {},
    fixture.tools,
  );
}

// ── Run & output ─────────────────────────────────────────────────────────────

await bench.run();

// Group results into pairs and display comparison table
interface PairResult {
  name: string;
  runtimeOps: number;
  compiledOps: number;
  speedup: string;
  runtimeAvg: string;
  compiledAvg: string;
}

const pairs: PairResult[] = [];
const tasks = bench.tasks;

for (let i = 0; i < tasks.length; i += 2) {
  const rtTask = tasks[i]!;
  const aotTask = tasks[i + 1]!;

  if (
    !rtTask.result ||
    rtTask.result.state !== "completed" ||
    !aotTask.result ||
    aotTask.result.state !== "completed"
  ) {
    continue;
  }

  const rtHz = rtTask.result.throughput.mean;
  const aotHz = aotTask.result.throughput.mean;
  const rtAvg = rtTask.result.latency.mean;
  const aotAvg = aotTask.result.latency.mean;

  const name = rtTask.name.replace("runtime: ", "");

  pairs.push({
    name,
    runtimeOps: Math.round(rtHz),
    compiledOps: Math.round(aotHz),
    speedup: `${(aotHz / rtHz).toFixed(1)}×`,
    runtimeAvg: `${rtAvg.toFixed(4)}ms`,
    compiledAvg: `${aotAvg.toFixed(4)}ms`,
  });
}

console.log("\n=== Runtime vs Compiler Comparison ===\n");
console.table(pairs);

// Summary stats
const speedups = pairs.map((p) => parseFloat(p.speedup));
const minSpeedup = Math.min(...speedups);
const maxSpeedup = Math.max(...speedups);
const avgSpeedup = speedups.reduce((a, b) => a + b, 0) / speedups.length;
const medianSpeedup = speedups.sort((a, b) => a - b)[
  Math.floor(speedups.length / 2)
]!;

console.log(`\nSpeedup summary:`);
console.log(`  Min:    ${minSpeedup.toFixed(1)}×`);
console.log(`  Max:    ${maxSpeedup.toFixed(1)}×`);
console.log(`  Avg:    ${avgSpeedup.toFixed(1)}×`);
console.log(`  Median: ${medianSpeedup.toFixed(1)}×`);
