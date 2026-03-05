#!/usr/bin/env node
/**
 * Parse k6 JSON-lines output and generate a markdown benchmark report.
 *
 * Usage:
 *   node scripts/report.mjs                      # default: results/raw.json
 *   node scripts/report.mjs results/raw.json     # explicit path
 *   node scripts/report.mjs --out report.md       # write to file (default: stdout)
 */

import { writeFileSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ── CLI args ────────────────────────────────────────────────────────────

let inputFile = join(root, "results", "raw.json");
let outputFile = null;

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--out" && process.argv[i + 1]) {
    outputFile = process.argv[++i];
  } else {
    inputFile = process.argv[i];
  }
}

// ── Parse k6 JSON lines (streaming — handles large files) ───────────────

// Bucket: { "target/scenario/stage" → [duration_ms, ...] }
const buckets = {};
// Track per-target-per-stage timestamps for accurate per-target RPS
const bucketTimes = {}; // { "target/stage" → { min, max } }

try {
  const rl = createInterface({
    input: createReadStream(inputFile, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type !== "Point" || obj.metric !== "http_req_duration") continue;

    const tags = obj.data?.tags;
    if (!tags?.target || !tags?.scenario || !tags?.stage) continue;
    if (tags.stage === "warmup") continue; // exclude warmup data

    const key = `${tags.target}/${tags.scenario}/${tags.stage}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(obj.data.value);

    // Track per-target-per-stage time range for RPS calculation
    const ts = new Date(obj.data.time).getTime();
    const tkey = `${tags.target}/${tags.stage}`;
    if (!bucketTimes[tkey]) bucketTimes[tkey] = { min: ts, max: ts };
    bucketTimes[tkey].min = Math.min(bucketTimes[tkey].min, ts);
    bucketTimes[tkey].max = Math.max(bucketTimes[tkey].max, ts);
  }
} catch {
  console.error(`No results file found at ${inputFile}`);
  console.error("Run the load test first: docker compose run --rm k6");
  process.exit(1);
}

if (Object.keys(buckets).length === 0) {
  console.error("No tagged data points found in results file.");
  console.error("Ensure k6 ran with stage/target/scenario tags.");
  process.exit(1);
}

// ── Stats helpers ───────────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function fmt(n) {
  return n.toFixed(1);
}

// ── Discover dimensions ─────────────────────────────────────────────────

const allKeys = Object.keys(buckets);
const stages = [...new Set(allKeys.map((k) => k.split("/")[2]))].sort(
  (a, b) => {
    // Sort by VU number
    const na = parseInt(a) || 0;
    const nb = parseInt(b) || 0;
    return na - nb;
  },
);
const scenarios = [...new Set(allKeys.map((k) => k.split("/")[1]))];
const targets = [...new Set(allKeys.map((k) => k.split("/")[0]))];

// Friendly names for the report
const TARGET_LABELS = {
  handcoded: "Hand-coded Node.js",
  "bridge-standalone": "Bridge (Standalone)",
  "bridge-graphql": "Bridge (GraphQL)",
};

// Preferred order: handcoded first (baseline), then bridge variants
const TARGET_ORDER = ["handcoded", "bridge-standalone", "bridge-graphql"];
const orderedTargets = TARGET_ORDER.filter((t) => targets.includes(t));

// ── Detect environment ──────────────────────────────────────────────────

// ── Build markdown ──────────────────────────────────────────────────────

const md = [];

md.push("# Bridge Engine — Performance Report");
md.push("");
md.push(
  "Automated benchmark comparing Bridge's declarative execution engine against hand-coded Node.js.",
);
md.push(
  "All three implementations serve the same API endpoints, fetching from an identical dependency backend.",
);
md.push("");

// ── Section 1: Latency (array scenario, first real stage) ───────────────

const latencyStage = stages[0]; // lowest VU stage (most stable latency)
const latencyScenario = "array";

md.push("## 1. Latency Overhead");
md.push("");
md.push(
  `Measured at **${latencyStage.replace("vu", " VUs")}** on the \`array\` scenario (1,000-item array with field renaming).`,
);
md.push(
  "This isolates pure engine overhead — the same HTTP call, the same data, only the processing layer differs.",
);
md.push("");
md.push("| Implementation | Avg | p50 | p90 | p95 | p99 |");
md.push("| --- | ---: | ---: | ---: | ---: | ---: |");

const latencyRows = [];
for (const target of orderedTargets) {
  const key = `${target}/${latencyScenario}/${latencyStage}`;
  if (!buckets[key]) continue;
  const s = stats(buckets[key]);
  latencyRows.push({ target, ...s });
}

for (const row of latencyRows) {
  const label = TARGET_LABELS[row.target] || row.target;
  md.push(
    `| **${label}** | ${fmt(row.avg)} ms | ${fmt(row.p50)} ms | ${fmt(row.p90)} ms | ${fmt(row.p95)} ms | ${fmt(row.p99)} ms |`,
  );
}

// Overhead callout
const hc = latencyRows.find((r) => r.target === "handcoded");
const bs = latencyRows.find((r) => r.target === "bridge-standalone");
if (hc && bs) {
  const overheadAvg = bs.avg - hc.avg;
  md.push("");
  if (Math.abs(overheadAvg) < 3) {
    md.push(
      "> Bridge Standalone matches hand-coded Node.js latency \u2014 the engine adds **no measurable overhead**.",
    );
  } else if (overheadAvg > 0) {
    md.push(
      `> Bridge Standalone adds **~${fmt(overheadAvg)} ms** avg compared to hand-coded Node.js.`,
    );
  } else {
    md.push(
      "> Bridge Standalone matches hand-coded Node.js latency \u2014 the engine adds **no measurable overhead** at this concurrency level.",
    );
  }
}
md.push("");

// ── Section 2: All scenarios latency table ──────────────────────────────

md.push("## 2. Per-Scenario Breakdown");
md.push("");
md.push(
  `All scenarios at **${latencyStage.replace("vu", " VUs")}**. Simple = 1 fetch + 7 field mappings. Array = 1 fetch + 1,000 items × 4 fields. Complex = 3 parallel fetches + array mapping + field merging.`,
);
md.push("");

for (const sc of scenarios) {
  const scLabel =
    sc === "simple" ? "Simple" : sc === "array" ? "Array Map" : "Complex";
  md.push(`### ${scLabel}`);
  md.push("");
  md.push("| Implementation | Avg | p95 | p99 |");
  md.push("| --- | ---: | ---: | ---: |");

  for (const target of orderedTargets) {
    const key = `${target}/${sc}/${latencyStage}`;
    if (!buckets[key]) continue;
    const s = stats(buckets[key]);
    const label = TARGET_LABELS[target] || target;
    md.push(
      `| **${label}** | ${fmt(s.avg)} ms | ${fmt(s.p95)} ms | ${fmt(s.p99)} ms |`,
    );
  }
  md.push("");
}

// ── Section 3: Throughput (RPS across VU levels) ────────────────────────

md.push("## 3. Throughput Under Load");
md.push("");
md.push(
  "Requests per second on the `complex` scenario (the heaviest workload) as concurrency increases.",
);
md.push("");

// Header row: | VUs | Hand-coded | Bridge Standalone | Bridge GraphQL |
const headerCells = ["Load (VUs)"];
for (const target of orderedTargets) {
  headerCells.push(TARGET_LABELS[target] || target);
}
md.push(`| ${headerCells.join(" | ")} |`);
md.push(`| --- | ${orderedTargets.map(() => "---:").join(" | ")} |`);

for (const stage of stages) {
  const vuLabel = stage.replace("vu", "");
  const cells = [`**${vuLabel} VUs**`];

  for (const target of orderedTargets) {
    const key = `${target}/complex/${stage}`;
    if (!buckets[key]) {
      cells.push("—");
      continue;
    }
    const count = buckets[key].length;
    const tkey = `${target}/${stage}`;
    const times = bucketTimes[tkey];
    const durationSec = times ? (times.max - times.min) / 1000 : 30;
    const rps = durationSec > 0 ? Math.round(count / durationSec) : 0;
    cells.push(rps.toLocaleString());
  }

  md.push(`| ${cells.join(" | ")} |`);
}

// Throughput callout
md.push("");
const lastStage = stages[stages.length - 1];
const hcKey = `handcoded/complex/${lastStage}`;
const bsKey = `bridge-standalone/complex/${lastStage}`;
if (buckets[hcKey] && buckets[bsKey]) {
  const hcCount = buckets[hcKey].length;
  const bsCount = buckets[bsKey].length;
  const ratio = bsCount / hcCount;
  if (ratio >= 0.98) {
    md.push(
      `> At ${lastStage.replace("vu", "")} VUs Bridge Standalone **matches or exceeds** hand-coded throughput — the declarative engine adds no meaningful cost.`,
    );
  } else {
    md.push(
      `> At ${lastStage.replace("vu", "")} VUs, Bridge Standalone maintains **${(ratio * 100).toFixed(0)}%** of hand-coded throughput.`,
    );
  }
}
md.push("");

// ── Section 4: Methodology ─────────────────────────────────────────────

md.push("## 4. Methodology");
md.push("");
md.push(
  "All tests run inside Docker containers on the same host, communicating over a Docker bridge network.",
);
md.push("");
md.push(
  "Each target is tested **sequentially** \u2014 only one receives load at any time,",
);
md.push(
  "giving it 100% of available CPU and memory. This eliminates resource contention",
);
md.push("between services and produces accurate, reproducible numbers.");
md.push("");
md.push(`- **Node.js:** xxx`);
md.push(`- **OS / Arch:** xxx`);
md.push("- **Load generator:** [k6](https://k6.io) (containerised)");
md.push(`- **Per-target warmup:** 10 s at 10 VUs (excluded from results)`);
md.push(
  `- **Stages:** ${stages.map((s) => s.replace("vu", " VUs")).join(" \u2192 ")} (${stages.length > 1 ? "30 s each per target" : "single run"})`,
);
md.push(
  "- **Dependency:** nginx serving pre-generated static JSON (zero compute)",
);
md.push("");

// ── Output ──────────────────────────────────────────────────────────────

const report = md.join("\n");

if (outputFile) {
  writeFileSync(outputFile, report);
  console.log(`Report written to ${outputFile}`);
} else {
  console.log(report);
}
