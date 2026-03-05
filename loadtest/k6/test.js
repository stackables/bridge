/**
 * k6 load test — sequential per-target benchmarking.
 *
 * Each target (handcoded, bridge-standalone, bridge-graphql) is tested
 * one at a time through all VU stages. This ensures the system under test
 * gets 100% of available CPU and memory — no resource contention between
 * services — producing accurate, publishable numbers.
 *
 * Data points are tagged with { target, scenario, stage } for the report.
 *
 * Profiles:
 *   full    — each target sequentially: warmup → 20 → 50 → 100 → 200 VUs (default)
 *   quick   — 10 VUs × 15s, all targets in parallel (CI smoke test)
 *   custom  — user-specified VUS / DURATION
 *
 * Usage:
 *   k6 run test.js                           # full sequential run
 *   k6 run test.js -e PROFILE=quick          # quick smoke
 *   k6 run test.js -e PROFILE=custom -e VUS=200 -e DURATION=60s
 */

import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";

// ── Targets ─────────────────────────────────────────────────────────────

const TARGETS = {
  handcoded: "http://handcoded:3000",
  "bridge-standalone": "http://bridge-standalone:3000",
  "bridge-compiler": "http://bridge-compiler:3000",
  "bridge-graphql": "http://bridge-graphql:3000",
};

const TARGET_KEYS = [
  "handcoded",
  "bridge_standalone",
  "bridge_compiler",
  "bridge_graphql",
];
const TARGET_MAP = {
  handcoded: "handcoded",
  bridge_standalone: "bridge-standalone",
  bridge_compiler: "bridge-compiler",
  bridge_graphql: "bridge-graphql",
};

// ── Custom metrics ──────────────────────────────────────────────────────

const metrics = {};
for (const tk of TARGET_KEYS) {
  for (const sc of ["simple", "array", "complex"]) {
    const key = `${tk}_${sc}`;
    metrics[key] = {
      duration: new Trend(`${key}_duration`, true),
      errors: new Counter(`${key}_errors`),
    };
  }
}

// ── GraphQL queries ─────────────────────────────────────────────────────

const GQL_QUERIES = {
  simple: JSON.stringify({
    query: `{
      simple {
        id firstName lastName email role department building
      }
    }`,
  }),
  array: JSON.stringify({
    query: `{
      arrayMap {
        items { id name category price }
      }
    }`,
  }),
  complex: JSON.stringify({
    query: `{
      complex {
        assignee email department topItem
        entries { entryId variantId quantity warehouse }
      }
    }`,
  }),
};

// ── Request helpers ─────────────────────────────────────────────────────

const REST_PATHS = { simple: "/simple", array: "/array", complex: "/complex" };

function runRest(target, baseUrl, scenario, stage) {
  const res = http.get(`${baseUrl}${REST_PATHS[scenario]}`, {
    tags: { target, scenario, stage },
  });
  const mk = `${target.replace(/-/g, "_")}_${scenario}`;
  metrics[mk].duration.add(res.timings.duration);
  const ok = check(
    res,
    { [`${target}/${scenario} 200`]: (r) => r.status === 200 },
    { target, scenario, stage },
  );
  if (!ok) metrics[mk].errors.add(1);
}

function runGraphQL(target, baseUrl, scenario, stage) {
  const res = http.post(`${baseUrl}/graphql`, GQL_QUERIES[scenario], {
    headers: { "Content-Type": "application/json" },
    tags: { target, scenario, stage },
  });
  const mk = `${target.replace(/-/g, "_")}_${scenario}`;
  metrics[mk].duration.add(res.timings.duration);
  const ok = check(
    res,
    {
      [`${target}/${scenario} 200`]: (r) => r.status === 200,
      [`${target}/${scenario} ok`]: (r) => {
        try {
          return !JSON.parse(r.body).errors;
        } catch {
          return false;
        }
      },
    },
    { target, scenario, stage },
  );
  if (!ok) metrics[mk].errors.add(1);
}

/** Run all 3 scenarios against a single target. */
function hitTarget(targetKey, stage) {
  const target = TARGET_MAP[targetKey];
  const baseUrl = TARGETS[target];
  for (const sc of ["simple", "array", "complex"]) {
    if (target === "bridge-graphql") {
      runGraphQL(target, baseUrl, sc, stage);
    } else {
      runRest(target, baseUrl, sc, stage);
    }
  }
}

// ── Exported per-target functions (used by k6 exec) ─────────────────────

export function handcoded() {
  hitTarget("handcoded", __ENV.STAGE || "unknown");
}

export function bridge_standalone() {
  hitTarget("bridge_standalone", __ENV.STAGE || "unknown");
}

export function bridge_compiler() {
  hitTarget("bridge_compiler", __ENV.STAGE || "unknown");
}

export function bridge_graphql() {
  hitTarget("bridge_graphql", __ENV.STAGE || "unknown");
}

/** Warmup / quick / custom: all targets in one iteration. */
export function allTargets() {
  const stage = __ENV.STAGE || "unknown";
  for (const tk of TARGET_KEYS) {
    hitTarget(tk, stage);
  }
}

// ── Profile → k6 options ────────────────────────────────────────────────

const PROFILE = __ENV.PROFILE || "full";

function buildOptions() {
  if (PROFILE === "quick") {
    return {
      scenarios: {
        quick: {
          executor: "constant-vus",
          vus: parseInt(__ENV.VUS || "10"),
          duration: __ENV.DURATION || "15s",
          exec: "allTargets",
          env: { STAGE: "quick" },
        },
      },
    };
  }

  if (PROFILE === "custom") {
    const vus = parseInt(__ENV.VUS || "20");
    return {
      scenarios: {
        custom: {
          executor: "constant-vus",
          vus,
          duration: __ENV.DURATION || "30s",
          exec: "allTargets",
          env: { STAGE: `${vus}vu` },
        },
      },
    };
  }

  // ── full profile (sequential) ───────────────────────────────────────
  // Each target is tested one at a time through all VU stages.
  // Only one target receives load at any given moment, so it gets
  // 100% of host CPU/memory — no contention, accurate numbers.
  //
  // Per target: 10s warmup → 30s at 20/50/100/200 VUs = 130s
  // Total:      3 targets × 130s = ~6.5 min (with 2s gaps)
  //
  // Timeline:
  //   ──── handcoded ────────────────────────────────
  //   0-10s       warmup (10 VUs)
  //   12-42s      20 VUs
  //   44-74s      50 VUs
  //   76-106s     100 VUs
  //   108-138s    200 VUs
  //   ──── bridge-standalone ────────────────────────
  //   140-150s    warmup (10 VUs)
  //   152-182s    20 VUs
  //   184-214s    50 VUs
  //   216-246s    100 VUs
  //   248-278s    200 VUs
  //   ──── bridge-graphql ───────────────────────────
  //   280-290s    warmup (10 VUs)
  //   292-322s    20 VUs
  //   324-354s    50 VUs
  //   356-386s    100 VUs
  //   388-418s    200 VUs

  const dur = __ENV.STAGE_DURATION || "30s";
  const warmupDur = "10s";
  const gap = 2; // seconds between phases

  const VU_STAGES = [
    { name: "20vu", vus: 20 },
    { name: "50vu", vus: 50 },
    { name: "100vu", vus: 100 },
    { name: "200vu", vus: 200 },
  ];

  const stageDurSec = parseInt(dur) || 30;
  const warmupDurSec = parseInt(warmupDur) || 10;

  // Time per target: warmup + gap + (N stages × (duration + gap))
  const stagesPerTarget = VU_STAGES.length;
  const timePerTarget =
    warmupDurSec + gap + stagesPerTarget * (stageDurSec + gap);

  const scenarios = {};

  for (let ti = 0; ti < TARGET_KEYS.length; ti++) {
    const tk = TARGET_KEYS[ti];
    const targetOffset = ti * timePerTarget;

    // Warmup for this target
    scenarios[`${tk}_warmup`] = {
      executor: "constant-vus",
      vus: 10,
      duration: warmupDur,
      startTime: `${targetOffset}s`,
      exec: tk,
      env: { STAGE: "warmup" },
    };

    // VU stages for this target
    for (let si = 0; si < VU_STAGES.length; si++) {
      const { name, vus } = VU_STAGES[si];
      const stageOffset =
        targetOffset + warmupDurSec + gap + si * (stageDurSec + gap);

      scenarios[`${tk}_${name}`] = {
        executor: "constant-vus",
        vus,
        duration: dur,
        startTime: `${stageOffset}s`,
        exec: tk,
        env: { STAGE: name },
      };
    }
  }

  return { scenarios };
}

const opts = buildOptions();
opts.thresholds = { http_req_duration: ["p(95)<15000"] };
export const options = opts;

// Default function (used by quick/custom profiles)
export default function () {
  allTargets();
}
