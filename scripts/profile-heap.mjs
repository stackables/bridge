#!/usr/bin/env node
/**
 * Heap / Memory Profiling Script
 *
 * Generates V8 heap profiles and GC analysis to find memory-related
 * performance issues: excessive allocations, GC pressure, memory leaks.
 *
 * Usage:
 *   node scripts/profile-heap.mjs                          # all benchmarks
 *   node scripts/profile-heap.mjs --filter "flat array"    # filtered
 *   node scripts/profile-heap.mjs --gc                     # include GC trace
 *
 * Output:
 *   profiles/heap-<timestamp>.heapprofile  — V8 heap profile (Chrome DevTools)
 *   profiles/gc-<timestamp>.log            — GC event log (with --gc)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
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
const doGC = hasFlag("gc");

if (hasFlag("help")) {
  console.log(`
Heap / Memory Profiling Script

Options:
  --filter <name>   Only run benchmarks matching this substring
  --target <file>   Profile a custom script instead of bench harness
  --gc              Also capture GC trace output
  --help            Show this help

Output:
  profiles/heap-<timestamp>.heapprofile  — load in Chrome DevTools Memory tab
  profiles/gc-<timestamp>.log            — GC event log (with --gc)
`);
  process.exit(0);
}

// ── Setup ────────────────────────────────────────────────────────────────────

mkdirSync(PROFILES_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const profileName = `heap-${timestamp}`;
const scriptToProfile = target ? resolve(target) : BENCH_FILE;

console.log(`\n🔬 Heap Profiling`);
console.log(`   Script: ${scriptToProfile}`);
console.log(`   Filter: ${filter ?? "(all benchmarks)"}`);
console.log(`   GC trace: ${doGC ? "yes" : "no"}`);
console.log();

// ── Heap profile ─────────────────────────────────────────────────────────────

const nodeArgs = [
  "--experimental-transform-types",
  "--conditions",
  "source",
  "--heap-prof",
  "--heap-prof-dir",
  PROFILES_DIR,
  "--heap-prof-name",
  `${profileName}.heapprofile`,
  "--heap-prof-interval",
  "256", // sample every 256 bytes (more detail)
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
    console.error("Heap profiling failed:", e.message);
    process.exit(1);
  }
}

// Find the output file
const heapFiles = readdirSync(PROFILES_DIR).filter(
  (f) =>
    f.includes(profileName) ||
    (f.endsWith(".heapprofile") && f.includes(timestamp)),
);

if (heapFiles.length > 0) {
  console.log(`\n✅ Heap profile: profiles/${heapFiles[0]}`);
  console.log(`   Open in: Chrome DevTools → Memory → Load profile`);
} else {
  console.log(`\n⚠️  Heap profile file not found.`);
}

// ── GC trace ─────────────────────────────────────────────────────────────────

if (doGC) {
  console.log(`\nCapturing GC trace...`);

  const gcArgs = [
    "--experimental-transform-types",
    "--conditions",
    "source",
    "--expose-gc",
    "--trace-gc",
    "--trace-gc-verbose",
    scriptToProfile,
  ];

  let gcOutput = "";
  try {
    gcOutput = execFileSync("node", gcArgs, {
      cwd: ROOT,
      env,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    gcOutput = (e.stdout ?? "") + "\n" + (e.stderr ?? "");
  }

  // Filter GC-relevant lines
  const lines = gcOutput.split("\n");
  const gcLines = lines.filter(
    (l) =>
      l.includes("[GC") ||
      l.includes("Scavenge") ||
      l.includes("Mark-Compact") ||
      l.includes("Minor") ||
      l.includes("Major") ||
      l.includes("pause"),
  );

  // Parse GC stats
  let scavenges = 0;
  let markCompacts = 0;
  let totalPauseMs = 0;

  for (const line of gcLines) {
    if (line.includes("Scavenge")) scavenges++;
    if (line.includes("Mark-Compact") || line.includes("Mark-sweep"))
      markCompacts++;
    const pauseMatch = line.match(/(\d+\.?\d*)\s*(?:ms|\/\s*(\d+\.?\d*))/);
    if (pauseMatch) {
      totalPauseMs += parseFloat(pauseMatch[1]);
    }
  }

  const gcReport = [
    `# GC Analysis Report — ${timestamp}`,
    ``,
    `## Summary`,
    ``,
    `Scavenge (young gen) events: ${scavenges}`,
    `Mark-Compact (old gen) events: ${markCompacts}`,
    `Total GC events: ${gcLines.length}`,
    ``,
    `## Raw GC Events`,
    ``,
    ...gcLines,
    ``,
  ].join("\n");

  const gcPath = join(PROFILES_DIR, `gc-${timestamp}.log`);
  writeFileSync(gcPath, gcReport, "utf-8");
  console.log(`✅ GC trace: profiles/gc-${timestamp}.log`);
  console.log(`   Scavenges: ${scavenges}, Mark-Compacts: ${markCompacts}`);
}

console.log();
