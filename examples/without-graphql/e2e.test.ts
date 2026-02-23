/**
 * E2E tests for the without-graphql CLI.
 *
 * These tests spawn the cli.ts process and assert on its JSON output.
 * Real HTTP calls are made to public APIs — keep assertions structural
 * (type / presence) rather than pinning exact values.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));

function runCli(bridgeFile: string, input: Record<string, unknown>): unknown {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--conditions", "development",
      join(dir, "cli.ts"),
      join(dir, bridgeFile),
      JSON.stringify(input),
    ],
    { encoding: "utf8", timeout: 30_000 },
  );

  if (result.error) throw result.error;

  assert.equal(
    result.status,
    0,
    `CLI exited ${result.status}.\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
  );

  return JSON.parse(result.stdout);
}

// ─── weather.bridge ────────────────────────────────────────────────────────

test("weather bridge returns all expected fields for a known city", () => {
  const data = runCli("weather.bridge", { city: "Berlin" }) as Record<string, unknown>;

  assert.equal(data.city, "Berlin", "city should echo the input");
  assert.equal(typeof data.lat, "string", "lat should be a string");
  assert.equal(typeof data.lon, "string", "lon should be a string");
  assert.equal(typeof data.temperature, "number", "temperature should be a number");
  assert.equal(typeof data.timezone, "string", "timezone should be a string");
  assert.equal(typeof data.unit, "string", "unit should be a string");

  // Sanity-check latitude is roughly in the right range for Berlin
  const lat = parseFloat(data.lat as string);
  assert.ok(lat > 50 && lat < 54, `Berlin lat should be ~52, got ${lat}`);
});

test("weather bridge works for a different city", () => {
  const data = runCli("weather.bridge", { city: "Tokyo" }) as Record<string, unknown>;

  assert.equal(data.city, "Tokyo");
  assert.equal(typeof data.temperature, "number");

  const lat = parseFloat(data.lat as string);
  assert.ok(lat > 33 && lat < 37, `Tokyo lat should be ~35.7, got ${lat}`);
});

// ─── sbb.bridge ────────────────────────────────────────────────────────────

test("sbb bridge returns an array of connections with expected structure", () => {
  const data = runCli("sbb.bridge", { from: "Bern", to: "Zürich" }) as unknown[];

  assert.ok(Array.isArray(data), "result should be an array");

  // The transport API may return no connections depending on time / availability.
  // When results are present, verify the full structure.
  if (data.length === 0) return;

  const first = data[0] as Record<string, unknown>;
  assert.equal(typeof first.id, "string", "connection.id should be a string");
  assert.equal(first.provider, "SBB", 'provider should be "SBB"');
  assert.equal(typeof first.departureTime, "string", "departureTime should be a string");
  assert.equal(typeof first.arrivalTime, "string", "arrivalTime should be a string");
  assert.equal(typeof first.transfers, "number", "transfers should be a number");
  assert.ok(Array.isArray(first.legs), "legs should be an array");

  if ((first.legs as unknown[]).length === 0) return;

  // Verify leg structure
  const leg = (first.legs as Record<string, unknown>[])[0]!;
  assert.equal(typeof leg.trainName, "string", "leg.trainName should be a string");
  assert.ok(leg.origin != null, "leg.origin should be present");
  assert.ok(leg.destination != null, "leg.destination should be present");

  const origin = leg.origin as Record<string, unknown>;
  assert.ok(
    (origin.station as Record<string, unknown>)?.name != null,
    "leg.origin.station.name should be present",
  );
});
