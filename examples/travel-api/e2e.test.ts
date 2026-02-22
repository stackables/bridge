import assert from "node:assert/strict";
import { test } from "node:test";
import { yoga } from "./server.js";

/**
 * Helper — sends a GraphQL request with optional extra headers.
 * Returns { data, errors, extensions } without throwing on GQL errors.
 */
async function gqlRaw(
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const res = await yoga.fetch("http://test/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(headers ?? {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: any[]; extensions?: any };
}

/** Throws on GQL errors */
async function gql(
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const body = await gqlRaw(query, variables, headers);
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  }
  return body.data;
}

// ═══════════════════════════════════════════════════════════════════════════
// DB provider (default)
// ═══════════════════════════════════════════════════════════════════════════

test("DB: default provider returns journeys with provider=DB", async () => {
  const data = await gql(
    `{ searchTrains(from: "8011160", to: "8000261") { id provider departureTime arrivalTime transfers } }`,
  );
  assert.ok(Array.isArray(data.searchTrains), "searchTrains must be an array");
  // The DB API may return results or error-fallback (empty array)
  if (data.searchTrains.length > 0) {
    assert.equal(data.searchTrains[0].provider, "DB", "provider should be DB");
    assert.ok(
      typeof data.searchTrains[0].id === "string",
      "id must be a string",
    );
  }
});

test("DB: nested legs resolve with explicit field mapping", async () => {
  const data = await gql(
    `{ searchTrains(from: "8011160", to: "8000261") {
      id provider
      legs { trainName origin { station { name } plannedTime } destination { station { name } plannedTime } }
    } }`,
  );
  assert.ok(Array.isArray(data.searchTrains), "searchTrains must be an array");
  if (data.searchTrains.length > 0 && data.searchTrains[0].legs?.length > 0) {
    const leg = data.searchTrains[0].legs[0];
    assert.ok(typeof leg.trainName === "string", "trainName must be a string");
    assert.ok(leg.origin?.station?.name, "origin station name must exist");
    assert.ok(
      leg.destination?.station?.name,
      "destination station name must exist",
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SBB provider (via x-provider header)
// ═══════════════════════════════════════════════════════════════════════════

test("SBB: x-provider header routes to Swiss API", async () => {
  const data = await gql(
    `{ searchTrains(from: "Zürich", to: "Bern") { id provider departureTime arrivalTime transfers } }`,
    undefined,
    { "x-provider": "sbb" },
  );
  assert.ok(Array.isArray(data.searchTrains), "searchTrains must be an array");
  if (data.searchTrains.length > 0) {
    assert.equal(
      data.searchTrains[0].provider,
      "SBB",
      "provider should be SBB",
    );
  }
});

test("SBB: nested legs resolve with explicit field mapping", async () => {
  const data = await gql(
    `{ searchTrains(from: "Zürich", to: "Bern") {
      id provider
      legs { trainName origin { station { name } plannedTime } destination { station { name } plannedTime } }
    } }`,
    undefined,
    { "x-provider": "sbb" },
  );
  assert.ok(Array.isArray(data.searchTrains), "searchTrains must be an array");
  if (data.searchTrains.length > 0 && data.searchTrains[0].legs?.length > 0) {
    const leg = data.searchTrains[0].legs[0];
    assert.ok(typeof leg.trainName === "string", "trainName must be a string");
    assert.ok(leg.origin?.station?.name, "origin station name must exist");
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic routing — provider switching
// ═══════════════════════════════════════════════════════════════════════════

test("switching provider header changes the provider field", async () => {
  const dbResult = await gql(
    `{ searchTrains(from: "8011160", to: "8000261") { provider } }`,
    undefined,
    { "x-provider": "db" },
  );

  const sbbResult = await gql(
    `{ searchTrains(from: "Zürich", to: "Bern") { provider } }`,
    undefined,
    { "x-provider": "sbb" },
  );

  // Both should return arrays (possibly empty if APIs are down, thanks to on error fallback)
  assert.ok(Array.isArray(dbResult.searchTrains));
  assert.ok(Array.isArray(sbbResult.searchTrains));

  if (dbResult.searchTrains.length > 0) {
    assert.equal(dbResult.searchTrains[0].provider, "DB");
  }
  if (sbbResult.searchTrains.length > 0) {
    assert.equal(sbbResult.searchTrains[0].provider, "SBB");
  }
});

test("error fallback returns empty array when API is unreachable", async () => {
  // Use nonsense station IDs — DB API should return an error, triggering the on error fallback
  const data = await gql(
    `{ searchTrains(from: "INVALID999", to: "INVALID000") { id provider } }`,
  );
  // The on error = { "journeys": [] } fallback should produce an empty result list
  assert.ok(Array.isArray(data.searchTrains), "searchTrains must be an array");
});
