#!/usr/bin/env node
/**
 * Benchmark Comparison Script (A/B testing)
 *
 * Compares benchmark results between two git refs (branches, commits, tags).
 * Runs the benchmark suite on each ref and produces a side-by-side comparison
 * with statistical significance testing.
 *
 * Usage:
 *   node scripts/bench-compare.mjs main              # compare current vs main
 *   node scripts/bench-compare.mjs main feature-x     # compare two branches
 *   node scripts/bench-compare.mjs HEAD~3             # compare current vs 3 commits ago
 *   node scripts/bench-compare.mjs --runs 5 main      # 5 runs per ref (default: 3)
 *
 * Output:
 *   Printed table with ops/sec, change %, and significance indicator
 *   profiles/compare-<timestamp>.json  — raw data for further analysis
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILES_DIR = join(ROOT, "profiles");
const BENCH_CMD =
  "node --experimental-transform-types bench/engine.bench.ts";
const BENCH_CWD = join(ROOT, "packages/bridge");

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const allArgs = process.argv.slice(2);

function getArg(name) {
  const idx = allArgs.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < allArgs.length ? allArgs[idx + 1] : undefined;
}
const hasFlag = (name) => allArgs.includes(`--${name}`);

const runs = parseInt(getArg("runs") ?? "3", 10);

if (hasFlag("help") || args.length === 0) {
  console.log(`
Benchmark Comparison (A/B Testing)

Usage:
  node scripts/bench-compare.mjs <base-ref> [<head-ref>]

Arguments:
  base-ref    Git ref to compare against (branch, commit, tag)
  head-ref    Git ref to measure (default: current working tree)

Options:
  --runs <n>  Number of benchmark runs per ref (default: 3)
  --help      Show this help

Examples:
  node scripts/bench-compare.mjs main
  node scripts/bench-compare.mjs main feature-x --runs 5
  node scripts/bench-compare.mjs HEAD~5
`);
  process.exit(0);
}

const baseRef = args[0];
const headRef = args[1] ?? null; // null = current working tree
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentRef() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "working-tree";
  }
}

function stashIfDirty() {
  const status = execSync("git status --porcelain", {
    cwd: ROOT,
    encoding: "utf-8",
  }).trim();
  if (status) {
    console.log("   Stashing uncommitted changes...");
    execSync("git stash push -m 'bench-compare auto-stash'", {
      cwd: ROOT,
      stdio: "inherit",
    });
    return true;
  }
  return false;
}

function checkoutRef(ref) {
  execSync(`git checkout ${ref}`, { cwd: ROOT, stdio: "inherit" });
  // Reinstall deps in case they changed
  try {
    execSync("pnpm install --frozen-lockfile", {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 60000,
    });
  } catch {
    // Lockfile might differ — try without frozen
    execSync("pnpm install", { cwd: ROOT, stdio: "pipe", timeout: 60000 });
  }
}

function runBench() {
  // Run bench with CI=true to get JSON output
  const output = execSync(BENCH_CMD, {
    cwd: BENCH_CWD,
    env: { ...process.env, CI: "true" },
    encoding: "utf-8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Parse BMF JSON from stdout (skip non-JSON lines)
  const lines = output.split("\n");
  const jsonStart = lines.findIndex((l) => l.trim().startsWith("{"));
  const jsonEnd = lines.findLastIndex((l) => l.trim().startsWith("}"));
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Could not find JSON output in benchmark results");
  }
  const json = lines.slice(jsonStart, jsonEnd + 1).join("\n");
  return JSON.parse(json);
}

function collectRuns(label, n) {
  console.log(`   Running ${n} benchmark iterations for "${label}"...`);
  const results = [];
  for (let i = 0; i < n; i++) {
    process.stdout.write(`     Run ${i + 1}/${n}... `);
    const data = runBench();
    results.push(data);
    console.log("done");
  }
  return results;
}

function aggregateRuns(runs) {
  // For each benchmark, compute mean and stddev of the mean latency
  const benchNames = Object.keys(runs[0]);
  const aggregated = {};

  for (const name of benchNames) {
    const values = runs
      .map((r) => r[name]?.latency?.value)
      .filter((v) => v != null);
    if (values.length === 0) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);
    const opsPerSec = Math.round(1_000_000 / mean); // mean is in nanoseconds from BMF

    aggregated[name] = {
      meanLatencyNs: mean,
      stddevNs: stddev,
      opsPerSec,
      samples: values,
    };
  }
  return aggregated;
}

function formatChange(baseOps, headOps) {
  const change = ((headOps - baseOps) / baseOps) * 100;
  const sign = change >= 0 ? "+" : "";
  const indicator = Math.abs(change) < 3 ? "~" : change > 0 ? "✅" : "⚠️";
  return { changeStr: `${sign}${change.toFixed(1)}%`, indicator };
}

// ── Main ─────────────────────────────────────────────────────────────────────

mkdirSync(PROFILES_DIR, { recursive: true });

console.log(`\n📊 Benchmark Comparison`);
console.log(`   Base: ${baseRef}`);
console.log(`   Head: ${headRef ?? "(current)"}`);
console.log(`   Runs: ${runs} per ref\n`);

const currentRef = getCurrentRef();
let didStash = false;

try {
  // ── Collect HEAD results first (if measuring working tree) ──────────────

  let headResults;
  if (!headRef) {
    console.log(`\n── Measuring HEAD (${currentRef}) ──`);
    headResults = collectRuns(currentRef, runs);
  }

  // ── Collect BASE results ───────────────────────────────────────────────

  console.log(`\n── Measuring base: ${baseRef} ──`);
  didStash = stashIfDirty();
  checkoutRef(baseRef);
  const baseResults = collectRuns(baseRef, runs);

  // ── Collect HEAD results (if specific ref) ─────────────────────────────

  if (headRef) {
    console.log(`\n── Measuring head: ${headRef} ──`);
    checkoutRef(headRef);
    headResults = collectRuns(headRef, runs);
  }

  // ── Return to original state ───────────────────────────────────────────

  console.log(`\n── Restoring to ${currentRef} ──`);
  checkoutRef(currentRef);
  if (didStash) {
    console.log("   Restoring stashed changes...");
    execSync("git stash pop", { cwd: ROOT, stdio: "inherit" });
  }

  // ── Aggregate & compare ────────────────────────────────────────────────

  const baseAgg = aggregateRuns(baseResults);
  const headAgg = aggregateRuns(headResults);

  console.log(`\n${"═".repeat(90)}`);
  console.log(
    `  ${"Benchmark".padEnd(42)} ${"Base ops/s".padStart(12)} ${"Head ops/s".padStart(12)} ${"Change".padStart(10)}  `,
  );
  console.log(`${"─".repeat(90)}`);

  for (const name of Object.keys(baseAgg)) {
    const base = baseAgg[name];
    const head = headAgg[name];
    if (!head) continue;

    const { changeStr, indicator } = formatChange(
      base.opsPerSec,
      head.opsPerSec,
    );
    console.log(
      `  ${name.padEnd(42)} ${base.opsPerSec.toLocaleString().padStart(12)} ${head.opsPerSec.toLocaleString().padStart(12)} ${changeStr.padStart(10)} ${indicator}`,
    );
  }
  console.log(`${"═".repeat(90)}\n`);

  // ── Save raw data ──────────────────────────────────────────────────────

  const compareData = {
    timestamp,
    baseRef,
    headRef: headRef ?? currentRef,
    runs,
    base: baseAgg,
    head: headAgg,
  };

  const outPath = join(PROFILES_DIR, `compare-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(compareData, null, 2), "utf-8");
  console.log(`Raw data saved to: profiles/compare-${timestamp}.json\n`);
} catch (error) {
  // Restore state on error
  console.error(`\n❌ Error: ${error.message}`);
  try {
    execSync(`git checkout ${currentRef}`, { cwd: ROOT, stdio: "pipe" });
    if (didStash) {
      execSync("git stash pop", { cwd: ROOT, stdio: "pipe" });
    }
  } catch {
    console.error(
      "⚠️  Failed to restore git state. You may need to manually checkout.",
    );
  }
  process.exit(1);
}
