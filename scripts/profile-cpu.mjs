#!/usr/bin/env node
/**
 * CPU Profiling Script
 *
 * Generates a V8 CPU profile (.cpuprofile) from the bench harness or a
 * custom profiling target. The output can be loaded in:
 *   - Chrome DevTools → Performance tab → Load profile
 *   - VS Code → "JavaScript Profiler" extension
 *   - speedscope (https://www.speedscope.app — drag & drop)
 *
 * Usage:
 *   node scripts/profile-cpu.mjs                     # profile all benchmarks
 *   node scripts/profile-cpu.mjs --filter "flat array 1000"  # single benchmark
 *   node scripts/profile-cpu.mjs --iterations 5000   # override iteration count
 *   node scripts/profile-cpu.mjs --target scripts/profile-target.mjs  # custom script
 *
 * Output:
 *   profiles/cpu-<timestamp>.cpuprofile
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
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
const iterations = getArg("iterations") ?? "10000";
const target = getArg("target");
const interval = getArg("interval") ?? "100"; // microseconds (default 1000 is too coarse)

if (hasFlag("help")) {
  console.log(`
CPU Profiling Script

Options:
  --filter <name>      Only run benchmarks matching this substring
  --iterations <n>     Number of iterations for focused profiling (default: 10000)
  --target <file>      Profile a custom script instead of the bench harness
  --interval <µs>      Sampling interval in microseconds (default: 100)
  --help               Show this help

Examples:
  node scripts/profile-cpu.mjs
  node scripts/profile-cpu.mjs --filter "flat array 1000" --iterations 50000
  node scripts/profile-cpu.mjs --target scripts/profile-target.mjs
`);
  process.exit(0);
}

// ── Setup ────────────────────────────────────────────────────────────────────

mkdirSync(PROFILES_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const profileName = `cpu-${timestamp}`;

const scriptToProfile = target ? resolve(target) : BENCH_FILE;

// ── Build command ────────────────────────────────────────────────────────────

const nodeArgs = [
  "--experimental-transform-types",
  "--conditions",
  "source",
  "--cpu-prof",
  "--cpu-prof-dir",
  PROFILES_DIR,
  "--cpu-prof-name",
  `${profileName}.cpuprofile`,
  "--cpu-prof-interval",
  interval,
  scriptToProfile,
];

// Pass filter/iterations to the script via env
const env = {
  ...process.env,
  BRIDGE_PROFILE_FILTER: filter ?? "",
  BRIDGE_PROFILE_ITERATIONS: iterations,
};

console.log(`\n🔬 CPU Profiling`);
console.log(`   Script:     ${scriptToProfile}`);
console.log(`   Filter:     ${filter ?? "(all benchmarks)"}`);
console.log(`   Interval:   ${interval}µs`);
console.log(`   Output dir: ${PROFILES_DIR}`);
console.log();

try {
  execFileSync("node", nodeArgs, {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
} catch (e) {
  // Non-zero exit is OK — the profile is still written
  if (e.status > 1) {
    console.error("Profiling failed:", e.message);
    process.exit(1);
  }
}

// ── Find output ──────────────────────────────────────────────────────────────

const files = readdirSync(PROFILES_DIR).filter(
  (f) => f.includes(profileName) && f.endsWith(".cpuprofile"),
);

if (files.length === 0) {
  // Node sometimes uses a different name format — find the newest .cpuprofile
  const allProfiles = readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".cpuprofile"))
    .sort()
    .reverse();
  if (allProfiles.length > 0) {
    console.log(`\n✅ CPU profile written to: profiles/${allProfiles[0]}`);
  } else {
    console.error("\n❌ No .cpuprofile file found. Check for errors above.");
    process.exit(1);
  }
} else {
  console.log(`\n✅ CPU profile written to: profiles/${files[0]}`);
}

console.log(`\nTo analyze:`);
console.log(`  1. Chrome DevTools → Performance → Load profile`);
console.log(
  `  2. VS Code → Install "JavaScript Profiler" extension → load file`,
);
console.log(
  `  3. https://www.speedscope.app → drag & drop the .cpuprofile file`,
);
console.log();
