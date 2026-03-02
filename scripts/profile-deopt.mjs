#!/usr/bin/env node
/**
 * Deoptimization & Inline Cache Analysis
 *
 * Detects V8 deoptimizations and polymorphic inline caches (ICs) that
 * silently destroy performance. These are the #1 cause of "the code looks
 * fast but isn't" bugs.
 *
 * Usage:
 *   node scripts/profile-deopt.mjs                          # all benchmarks
 *   node scripts/profile-deopt.mjs --filter "flat array"    # filtered
 *   node scripts/profile-deopt.mjs --target my-script.mjs   # custom script
 *
 * Output:
 *   profiles/deopt-<timestamp>.log   — filtered deopt events
 *
 * What to look for:
 *   - "eager" or "soft" deopts: V8 optimised a function then had to bail out
 *   - "lazy" deopts: speculative optimisation failed at runtime
 *   - Polymorphic/megamorphic ICs: object shape changes forcing slow lookups
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
Deoptimization & IC Analysis Script

Options:
  --filter <name>   Only run benchmarks matching this substring
  --target <file>   Profile a custom script instead of bench harness
  --help            Show this help

Output:
  profiles/deopt-<timestamp>.log  — deoptimization events (filtered & annotated)
`);
  process.exit(0);
}

// ── Setup ────────────────────────────────────────────────────────────────────

mkdirSync(PROFILES_DIR, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const scriptToProfile = target ? resolve(target) : BENCH_FILE;

console.log(`\n🔬 Deoptimization & IC Analysis`);
console.log(`   Script: ${scriptToProfile}`);
console.log(`   Filter: ${filter ?? "(all benchmarks)"}`);
console.log();

// ── Run with --trace-deopt and other V8 flags ────────────────────────────────

const nodeArgs = [
  "--experimental-transform-types",
  "--conditions",
  "source",
  // Deoptimization tracing
  "--trace-deopt",
  // Also log when functions get optimised (useful for correlation)
  "--trace-opt",
  scriptToProfile,
];

const env = {
  ...process.env,
  BRIDGE_PROFILE_FILTER: filter ?? "",
};

console.log("Running with V8 trace flags...");

let stdout = "";
let stderr = "";
try {
  stdout = execFileSync("node", nodeArgs, {
    cwd: ROOT,
    env,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (e) {
  stdout = e.stdout ?? "";
  stderr = e.stderr ?? "";
}

// V8 trace output goes to stdout
const allOutput = stdout + "\n" + stderr;
const lines = allOutput.split("\n");

// ── Filter and analyze ───────────────────────────────────────────────────────

function isBridgeCode(line) {
  return (
    line.includes("bridge-core") ||
    line.includes("bridge-compiler") ||
    line.includes("bridge-stdlib") ||
    line.includes("ExecutionTree") ||
    line.includes("resolveWires") ||
    line.includes("pullSingle") ||
    line.includes("materializeShadows") ||
    line.includes("schedule") ||
    line.includes("callTool")
  );
}

// Actual deoptimizations (bad) — these contain "deoptimiz" but NOT "for optimization"
const bridgeDeoptLines = lines.filter((line) => {
  const lower = line.toLowerCase();
  // Actual deopt events contain "deoptimiz" without "for optimization"
  const isDeopt = lower.includes("[deoptimiz") || lower.includes("deopt:");
  // Exclude "marking for optimization" which is good
  const isOptMarking =
    lower.includes("for optimization") || lower.includes("[compiling");
  return isDeopt && !isOptMarking && isBridgeCode(line);
});

// Optimization events (good) — marking/compiling for optimization
const bridgeOptLines = lines.filter((line) => {
  const lower = line.toLowerCase();
  const isOpt = lower.includes("[marking") || lower.includes("[compiling");
  return isOpt && isBridgeCode(line);
});

// Extract unique function names being optimized
const optimizedFns = new Set();
for (const line of bridgeOptLines) {
  const match = line.match(/JSFunction (\w+)/);
  if (match) optimizedFns.add(match[1]);
}

// Extract unique deoptimized functions
const deoptFns = new Set();
for (const line of bridgeDeoptLines) {
  const match = line.match(/JSFunction (\w+)/);
  if (match) deoptFns.add(match[1]);
}

// ── Output report ────────────────────────────────────────────────────────────

const report = [
  `# Deoptimization Report — ${timestamp}`,
  ``,
  `Script: ${scriptToProfile}`,
  `Filter: ${filter ?? "(all)"}`,
  ``,
  `## Summary`,
  ``,
  `Total trace lines:        ${lines.length}`,
  `Bridge deopt events:      ${bridgeDeoptLines.length}`,
  `Bridge optimization events: ${bridgeOptLines.length}`,
  ``,
  `Functions optimized:      ${[...optimizedFns].join(", ") || "(none)"}`,
  `Functions deoptimized:    ${[...deoptFns].join(", ") || "(none)"}`,
  ``,
  `## Deoptimization Events (Bridge code only)`,
  ``,
  ...(bridgeDeoptLines.length > 0
    ? bridgeDeoptLines
    : [
        "(none — no deoptimizations detected in Bridge code. Types are stable.)",
      ]),
  ``,
  `## Optimization Events (Bridge code only)`,
  ``,
  `These are GOOD — V8 is optimizing these functions:`,
  ``,
  ...(bridgeOptLines.length > 0 ? bridgeOptLines.slice(0, 100) : ["(none)"]),
  ``,
  `## Interpretation Guide`,
  ``,
  `### Deoptimization Types (BAD — these hurt performance)`,
  `- "eager deopt": V8 had to bail out immediately — usually a type change`,
  `- "soft deopt": V8 deoptimized but may re-optimize later — watch for repeats`,
  `- "lazy deopt": Speculative optimization failed when the code actually ran`,
  `- Multiple deopts on the same function: the function has unstable types`,
  ``,
  `### Optimization Types (GOOD — these confirm V8 is optimizing)`,
  `- "marking for optimization to MAGLEV": Mid-tier optimizing compiler`,
  `- "marking for optimization to TURBOFAN_JS": Top-tier optimizing compiler`,
  `- "compiling method": V8 is actively compiling optimized code`,
  ``,
  `### What to do`,
  `- If no deopts appear: your hot paths have stable types — this is ideal`,
  `- If deopts appear: check for object shape changes, type mixing, or delete`,
  `- If a function shows MAGLEV but not TURBOFAN: it may have too many code paths`,
  ``,
].join("\n");

const reportPath = join(PROFILES_DIR, `deopt-${timestamp}.log`);
writeFileSync(reportPath, report, "utf-8");

console.log(`\n✅ Deopt report: profiles/deopt-${timestamp}.log`);
console.log(`   Bridge deopt events:      ${bridgeDeoptLines.length}`);
console.log(`   Bridge optimization events: ${bridgeOptLines.length}`);
console.log(
  `   Functions optimized:      ${[...optimizedFns].join(", ") || "(none)"}`,
);

if (bridgeDeoptLines.length === 0) {
  console.log(`\n   ✨ No deoptimizations in Bridge code — types are stable.`);
} else {
  console.log(
    `\n   ⚠️  Found ${bridgeDeoptLines.length} deoptimization(s) in: ${[...deoptFns].join(", ")}`,
  );
  console.log(`   Check the report for details.`);
}

console.log();
