/**
 * End-to-end tests for the bundled examples.
 *
 * Imports the yoga instance directly from each example's server.ts —
 * no HTTP server started, no port needed, no teardown required.
 * yoga.fetch() injects requests directly into the handler.
 *
 * The weather-api tests hit real external APIs (Nominatim, Open-Meteo).
 * Run with:  pnpm e2e
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { yoga as builtinToolsYoga } from "../../../examples/builtin-tools/server.js";
import { yoga as weatherYoga } from "../../../examples/weather-api/server.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type YogaInstance = typeof weatherYoga;

async function gql(
  yoga: YogaInstance,
  query: string,
  variables?: Record<string, unknown>,
) {
  const res = await yoga.fetch("http://test/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: any; errors?: any[] };
  if (body.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors, null, 2)}`);
  }
  return body.data;
}

// ── Built-in Tools ────────────────────────────────────────────────────────────

test("builtin-tools: format returns upper and lower case", async () => {
  const data = await gql(builtinToolsYoga, `{ format(text: "Hello World") { original upper lower } }`);
  assert.equal(data.format.original, "Hello World");
  assert.equal(data.format.upper, "HELLO WORLD");
  assert.equal(data.format.lower, "hello world");
});

test("builtin-tools: findEmployee finds by department", async () => {
  const data = await gql(builtinToolsYoga, `{ findEmployee(department: "Marketing") { id name department } }`);
  assert.equal(data.findEmployee.name, "Bob");
  assert.equal(data.findEmployee.department, "Marketing");
});

// ── Weather API ───────────────────────────────────────────────────────────────

test("weather-api: getWeatherByCoordinates via passthrough bridge", async () => {
  const data = await gql(
    weatherYoga,
    `{ getWeatherByCoordinates(lat: "48.8566", lon: "2.3522") { lat lon currentTemp timezone } }`,
  );
  assert.ok(typeof data.getWeatherByCoordinates.lat === "number", "lat must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.lon === "number", "lon must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.currentTemp === "number", "currentTemp must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.timezone === "string", "timezone must be a string");
});

test("weather-api: getWeatherByName geocodes city to coordinates", async () => {
  const data = await gql(
    weatherYoga,
    `{ getWeatherByName(cityName: "Tokyo") { lat lon currentTemp timezone } }`,
  );
  assert.ok(typeof data.getWeatherByName.currentTemp === "number", "currentTemp must be a number");
  assert.ok(Math.abs(data.getWeatherByName.lat - 35.6) < 1, `Tokyo lat should be ~35.6, got ${data.getWeatherByName.lat}`);
});
