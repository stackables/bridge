import assert from "node:assert/strict";
import { test } from "node:test";
import { yoga } from "./server.js";

async function gql(query: string, variables?: Record<string, unknown>) {
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

test("getWeatherByCoordinates via passthrough bridge", async () => {
  const data = await gql(
    `{ getWeatherByCoordinates(lat: "48.8566", lon: "2.3522") { lat lon currentTemp timezone } }`,
  );
  assert.ok(typeof data.getWeatherByCoordinates.lat === "number", "lat must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.lon === "number", "lon must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.currentTemp === "number", "currentTemp must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.timezone === "string", "timezone must be a string");
});

test("getWeatherByName geocodes city to coordinates", async () => {
  const data = await gql(`{ getWeatherByName(cityName: "Tokyo") { lat lon currentTemp timezone } }`);
  assert.ok(typeof data.getWeatherByName.currentTemp === "number", "currentTemp must be a number");
  assert.ok(Math.abs(data.getWeatherByName.lat - 35.6) < 1, `Tokyo lat should be ~35.6, got ${data.getWeatherByName.lat}`);
});
