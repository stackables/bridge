#!/usr/bin/env node
/**
 * V8 Tick Profiling Script
 *
 * Uses Node's --prof flag to generate V8 tick-processor output.
 * This gives the most detailed view into where CPU time is spent,
 * including V8 internals (GC, IC misses, deopts, compilation).
 *
 * Usage:
 *   node scripts/profile-v8-ticks.mjs                         # all benchmarks
 *   node scripts/profile-v8-ticks.mjs --filter "flat array"   # filtered
 *
 * Output:
 *   profiles/v8-ticks-<timestamp>.log    (raw tick log)
 *   profiles/v8-ticks-<timestamp>.txt    (processed summary)
 *
 * The processed output shows:
 *   - Statistical profiling: % time in JS, C++, GC, etc.
 *   - Top functions by self-time (bottom-up view)
 *   - Full call tree (top-down view)
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILES_DIR = join(ROOT, "profiles");
const BENCH_FILE = join(ROOT, "packages/bridge/bench/engine.bench.ts");

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const hasFlag = (name) => args.includes(`--${name}`);

const filter = getArg("filter");
const target = getArg("target");

if (hasFlag("help")) {
  console.log(`
V8 Tick Profiling Script

Options:
  --filter <name>   Only run benchmarks matching this substring
  --target <file>   Profile a custom script instead of bench harness
  --help            Show this help

Output:
  profiles/v8-ticks-<timestamp>.txt  — processed tick profile
`);
  process.exit(0);
}

// ── Setup ────────────────────────────────────────────────────────────────────

mkdirSync(PROFILES_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const scriptToProfile = target ? resolve(target) : BENCH_FILE;

console.log(`\n🔬 V8 Tick Profiling`);
console.log(`   Script: ${scriptToProfile}`);
console.log(`   Filter: ${filter ?? "(all benchmarks)"}`);
console.log();

// ── Run with --prof ──────────────────────────────────────────────────────────

const nodeArgs = [
  "--experimental-transform-types",
  "--conditions",
  "source",
  "--prof",
  scriptToProfile,
];

const env = {
  ...process.env,
  BRIDGE_PROFILE_FILTER: filter ?? "",
};

try {
  execFileSync("node", nodeArgs, {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
} catch (e) {
  if (e.status > 1) {
    console.error("Profiling failed:", e.message);
    process.exit(1);
  }
}

// ── Find and process the isolate log ─────────────────────────────────────────

const isolateLogs = readdirSync(ROOT)
  .filter((f) => f.startsWith("isolate-") && f.endsWith(".log"))
  .map((f) => ({
    name: f,
    mtime: readFileSync(join(ROOT, f)).length, // use as tiebreaker
  }))
  .sort((a, b) => b.mtime - a.mtime);

if (isolateLogs.length === 0) {
  console.error("❌ No isolate-*.log file found. --prof may have failed.");
  process.exit(1);
}

const isolateLog = isolateLogs[0].name;
const rawLogPath = join(PROFILES_DIR, `v8-ticks-${timestamp}.log`);
const processedPath = join(PROFILES_DIR, `v8-ticks-${timestamp}.txt`);

// Move the raw log
renameSync(join(ROOT, isolateLog), rawLogPath);

// Clean up any other isolate logs from this run
for (const log of isolateLogs.slice(1)) {
  try {
    unlinkSync(join(ROOT, log.name));
  } catch {
    // ignore
  }
}

// Process with --prof-process
console.log(`Processing tick data...`);
try {
  const processed = execFileSync("node", ["--prof-process", rawLogPath], {
    encoding: "utf-8",
  });
  writeFileSync(processedPath, processed, "utf-8");
  console.log(`\n✅ Processed profile: profiles/v8-ticks-${timestamp}.txt`);
  console.log(`   Raw tick log:      profiles/v8-ticks-${timestamp}.log`);

  // Print executive summary (top 20 lines of the "Bottom up" section)
  const lines = processed.split("\n");
  const bottomUpIdx = lines.findIndex((l) =>
    l.includes("[Bottom up (heavy) profile]"),
  );
  if (bottomUpIdx !== -1) {
    console.log(`\n── Top Functions (Bottom-Up) ──\n`);
    const summary = lines.slice(bottomUpIdx + 1, bottomUpIdx + 25);
    for (const line of summary) {
      console.log(`  ${line}`);
    }
    console.log(`\n  ... (see full output in ${processedPath})`);
  }
} catch (e) {
  console.error("Failed to process tick log:", e.message);
  console.log(`Raw log saved at: ${rawLogPath}`);
}

console.log();
