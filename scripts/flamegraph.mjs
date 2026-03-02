#!/usr/bin/env node
/**
 * Flamegraph Script
 *
 * Converts a .cpuprofile into a collapsed-stack format and optionally
 * opens it in speedscope. If speedscope isn't installed, generates a
 * self-contained HTML flamegraph.
 *
 * Usage:
 *   node scripts/flamegraph.mjs                              # generate + open latest
 *   node scripts/flamegraph.mjs profiles/cpu-2026-03-02.cpuprofile  # specific file
 *   node scripts/flamegraph.mjs --generate                   # generate new profile first
 *   node scripts/flamegraph.mjs --filter "flat array 1000" --generate
 *
 * Prerequisites:
 *   npm install -g speedscope   (optional — will use browser fallback)
 */

import { execSync, execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILES_DIR = join(ROOT, "profiles");

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const hasFlag = (name) => args.includes(`--${name}`);
const positional = args.filter((a) => !a.startsWith("--"));

const filter = getArg("filter");
const doGenerate = hasFlag("generate");

if (hasFlag("help")) {
  console.log(`
Flamegraph Script

Usage:
  node scripts/flamegraph.mjs [profile-path] [options]

Arguments:
  profile-path          Path to .cpuprofile file (default: latest in profiles/)

Options:
  --generate            Generate a new CPU profile first
  --filter <name>       Filter benchmarks when generating (used with --generate)
  --help                Show this help

Prerequisites:
  For interactive flamegraphs: npm install -g speedscope
  Fallback: opens .cpuprofile URL for speedscope.app
`);
  process.exit(0);
}

// ── Generate if requested ────────────────────────────────────────────────────

mkdirSync(PROFILES_DIR, { recursive: true });

if (doGenerate) {
  const genArgs = ["scripts/profile-cpu.mjs"];
  if (filter) genArgs.push("--filter", filter);
  console.log(`Generating CPU profile...`);
  execFileSync("node", genArgs, { cwd: ROOT, stdio: "inherit" });
}

// ── Find the profile file ────────────────────────────────────────────────────

let profilePath;

if (positional.length > 0) {
  profilePath = resolve(positional[0]);
} else {
  // Find latest .cpuprofile in profiles/
  const cpuFiles = readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".cpuprofile"))
    .sort()
    .reverse();

  if (cpuFiles.length === 0) {
    console.error("No .cpuprofile files found. Run with --generate first.");
    process.exit(1);
  }
  profilePath = join(PROFILES_DIR, cpuFiles[0]);
}

if (!existsSync(profilePath)) {
  console.error(`File not found: ${profilePath}`);
  process.exit(1);
}

console.log(`\n🔥 Flamegraph`);
console.log(`   Profile: ${profilePath}\n`);

// ── Try speedscope ───────────────────────────────────────────────────────────

let hasSpeedscope = false;
try {
  execSync("which speedscope", { stdio: "pipe" });
  hasSpeedscope = true;
} catch {
  // Not installed
}

if (hasSpeedscope) {
  console.log("Opening in speedscope...");
  try {
    execSync(`speedscope "${profilePath}"`, { stdio: "inherit" });
  } catch {
    console.log("speedscope exited");
  }
} else {
  // Fallback: convert to a format that speedscope.app can read
  console.log(`speedscope not installed locally.`);
  console.log(`\nOptions:`);
  console.log(`  1. Open https://www.speedscope.app and drag & drop:`);
  console.log(`     ${profilePath}`);
  console.log();
  console.log(`  2. Install speedscope globally:`);
  console.log(`     npm install -g speedscope`);
  console.log(`     node scripts/flamegraph.mjs ${profilePath}`);
  console.log();
  console.log(`  3. Open in Chrome DevTools:`);
  console.log(`     Chrome → DevTools → Performance tab → Load profile...`);
  console.log(`     Select: ${profilePath}`);
}

console.log();
