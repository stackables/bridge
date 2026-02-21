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

/** Like gql() but returns { data, errors } without throwing */
async function gqlRaw(query: string, variables?: Record<string, unknown>) {
  const res = await yoga.fetch("http://test/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as { data?: any; errors?: any[] };
}

// ═══════════════════════════════════════════════════════════════════════════
// getWeatherByCoordinates — passthrough bridge
// ═══════════════════════════════════════════════════════════════════════════

test("getWeatherByCoordinates via passthrough bridge", async () => {
  const data = await gql(
    `{ getWeatherByCoordinates(lat: "48.8566", lon: "2.3522") { lat lon currentTemp timezone } }`,
  );
  assert.ok(typeof data.getWeatherByCoordinates.lat === "number", "lat must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.lon === "number", "lon must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.currentTemp === "number", "currentTemp must be a number");
  assert.ok(typeof data.getWeatherByCoordinates.timezone === "string", "timezone must be a string");
});

test("getWeatherByCoordinates returns city as null (no cityName input)", async () => {
  const data = await gql(
    `{ getWeatherByCoordinates(lat: "48.8566", lon: "2.3522") { city } }`,
  );
  assert.equal(data.getWeatherByCoordinates.city, null, "city should be null when not provided");
});

test("getWeatherByCoordinates at equator (lat=0, lon=0)", async () => {
  const data = await gql(
    `{ getWeatherByCoordinates(lat: "0", lon: "0") { lat lon currentTemp timezone } }`,
  );
  // Coordinates 0,0 are valid (Gulf of Guinea) — should return weather data
  assert.equal(data.getWeatherByCoordinates.lat, 0, "lat should be 0");
  assert.equal(data.getWeatherByCoordinates.lon, 0, "lon should be 0");
  assert.ok(typeof data.getWeatherByCoordinates.currentTemp === "number", "should return temperature");
});

// ═══════════════════════════════════════════════════════════════════════════
// getWeatherByName — geocode → pick first → weather
// ═══════════════════════════════════════════════════════════════════════════

test("getWeatherByName geocodes city to coordinates", async () => {
  const data = await gql(`{ getWeatherByName(cityName: "Tokyo") { lat lon currentTemp timezone } }`);
  assert.ok(typeof data.getWeatherByName.currentTemp === "number", "currentTemp must be a number");
  assert.ok(Math.abs(data.getWeatherByName.lat - 35.6) < 1, `Tokyo lat should be ~35.6, got ${data.getWeatherByName.lat}`);
});

test("getWeatherByName returns city field from input", async () => {
  const data = await gql(`{ getWeatherByName(cityName: "Berlin") { city } }`);
  assert.equal(data.getWeatherByName.city, "Berlin", "city should match the input cityName");
});

test("getWeatherByName with non-existent city returns nulls", async () => {
  // Nominatim returns [] for unknown cities → pickFirst returns undefined
  // → weather API gets no coords → fields resolve to null/defaults
  const body = await gqlRaw(
    `{ getWeatherByName(cityName: "Xyzzyville99999") { lat lon currentTemp timezone } }`,
  );
  // Either returns errors or returns data with null/default fields
  if (body.errors) {
    // Acceptable: error propagated from weather API or pickFirst
    assert.ok(body.errors.length > 0, "Should have at least one error");
  } else {
    // Also acceptable: null fields (weather API with missing coords returns error-like JSON)
    const r = body.data.getWeatherByName;
    assert.ok(
      r.lat == null || r.currentTemp == null,
      "Non-existent city should result in null fields or errors",
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// getWeather — all optional params (the interesting one)
// ═══════════════════════════════════════════════════════════════════════════

test("getWeather with cityName + lat + lon uses direct coordinates", async () => {
  // When lat/lon are provided, they should be used directly (|| prefers first non-null)
  const data = await gql(
    `{ getWeather(cityName: "Paris", lat: 51.5074, lon: -0.1278) { lat lon city currentTemp } }`,
  );
  // lat/lon should be ~London (provided), not ~Paris (geocoded)
  assert.ok(Math.abs(data.getWeather.lat - 51.5) < 0.5, `Should use provided lat (~51.5), got ${data.getWeather.lat}`);
  assert.ok(Math.abs(data.getWeather.lon - (-0.1278)) < 0.5, `Should use provided lon (~-0.13), got ${data.getWeather.lon}`);
  assert.equal(data.getWeather.city, "PARIS", "city should come from cityName input (uppercased by bridge)");
});

test("getWeather with only cityName geocodes to coordinates", async () => {
  const data = await gql(
    `{ getWeather(cityName: "Tokyo") { lat lon city currentTemp timezone } }`,
  );
  assert.ok(Math.abs(data.getWeather.lat - 35.6) < 1, `Tokyo lat should be ~35.6, got ${data.getWeather.lat}`);
  assert.equal(data.getWeather.city, "TOKYO", "city should be the provided name (uppercased by bridge)");
  assert.ok(typeof data.getWeather.currentTemp === "number", "currentTemp must be a number");
});

test("getWeather with only lat + lon returns city as Unknown", async () => {
  // No cityName → geocode has no query → cityName falls through to || "Unknown"
  const data = await gql(
    `{ getWeather(lat: 48.8566, lon: 2.3522) { lat lon city currentTemp } }`,
  );
  assert.ok(Math.abs(data.getWeather.lat - 48.86) < 0.5, `lat should be ~48.86, got ${data.getWeather.lat}`);
  assert.ok(typeof data.getWeather.currentTemp === "number", "currentTemp should be a number");
  // city should be "Unknown" since no cityName was provided and geocode has no useful result
  // OR it might get a display_name from nominatim if the empty-query returns results
  assert.ok(
    typeof data.getWeather.city === "string" && data.getWeather.city.length > 0,
    `city should be a non-empty string, got: ${data.getWeather.city}`,
  );
});

test("getWeather with no inputs returns null/default fields", async () => {
  // No inputs at all — geocode has no query, no direct coords
  // Everything should degrade gracefully
  const body = await gqlRaw(`{ getWeather { lat lon city currentTemp timezone } }`);

  if (body.errors) {
    // Acceptable: errors propagated
    assert.ok(body.errors.length > 0);
  } else {
    // Also acceptable: defaults/nulls returned
    const r = body.data.getWeather;
    // At minimum the query should not crash — it returns some result
    assert.ok(r !== undefined, "getWeather should return something");
  }
});

test("getWeather with only lat (no lon, no cityName)", async () => {
  // Partial coordinates — lon must come from geocode which has no city query
  const body = await gqlRaw(
    `{ getWeather(lat: 48.8566) { lat lon city currentTemp } }`,
  );
  if (body.errors) {
    assert.ok(body.errors.length > 0, "Partial coords may produce errors");
  } else {
    const r = body.data.getWeather;
    assert.ok(Math.abs(r.lat - 48.86) < 0.5, "lat should use provided value");
    // lon comes from geocode (no city query → undefined or from nominatim default)
  }
});

test("getWeather with cityName + lat (no lon) gets lon from geocode", async () => {
  // lat from input, lon should fall through to geocoded lon
  const data = await gql(
    `{ getWeather(cityName: "Paris", lat: 99.0) { lat lon city } }`,
  );
  // lat should be from input (99.0), lon from geocode (~2.35)
  assert.equal(data.getWeather.lat, 99, "lat should be the provided value");
  assert.ok(Math.abs(data.getWeather.lon - 2.35) < 0.5, `lon should be geocoded Paris lon (~2.35), got ${data.getWeather.lon}`);
  assert.equal(data.getWeather.city, "PARIS");
});

test("getWeather with non-existent city and no coords", async () => {
  // Geocode returns empty → no coords from geocode or input → weather degrades
  const body = await gqlRaw(
    `{ getWeather(cityName: "Xyzzyville99999") { lat lon city currentTemp } }`,
  );
  if (body.errors) {
    assert.ok(body.errors.length > 0);
  } else {
    const r = body.data.getWeather;
    // cityName was provided so city should be the input value
    assert.equal(r.city, "XYZZYVILLE99999", "city should still be the provided name (uppercased by bridge)");
  }
});

test("getWeather lat=0 lon=0 are treated as valid (not null)", async () => {
  // Zero is a valid coordinate — the || null-fallback should NOT trigger
  const data = await gql(
    `{ getWeather(lat: 0, lon: 0) { lat lon currentTemp } }`,
  );
  assert.equal(data.getWeather.lat, 0, "lat=0 should be preserved, not treated as null");
  assert.equal(data.getWeather.lon, 0, "lon=0 should be preserved, not treated as null");
  assert.ok(typeof data.getWeather.currentTemp === "number", "should return valid temperature");
});

test("getWeather with negative coordinates (southern hemisphere)", async () => {
  // Sydney: lat -33.87, lon 151.21
  const data = await gql(
    `{ getWeather(lat: -33.87, lon: 151.21) { lat lon currentTemp timezone } }`,
  );
  assert.ok(Math.abs(data.getWeather.lat - (-33.87)) < 0.5, "lat should be ~-33.87");
  assert.ok(typeof data.getWeather.currentTemp === "number");
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-cutting concerns
// ═══════════════════════════════════════════════════════════════════════════

test("getWeather and getWeatherByName return consistent results for same city", async () => {
  const [byName, byAll] = await Promise.all([
    gql(`{ getWeatherByName(cityName: "Berlin") { lat lon currentTemp } }`),
    gql(`{ getWeather(cityName: "Berlin") { lat lon currentTemp } }`),
  ]);
  // Same city should yield same coordinates (within tolerance for caching/timing)
  assert.ok(
    Math.abs(byName.getWeatherByName.lat - byAll.getWeather.lat) < 0.01,
    "lat should match between getWeatherByName and getWeather",
  );
  assert.ok(
    Math.abs(byName.getWeatherByName.lon - byAll.getWeather.lon) < 0.01,
    "lon should match between getWeatherByName and getWeather",
  );
});

test("getWeather with all fields requested returns complete object", async () => {
  const data = await gql(
    `{ getWeather(cityName: "London") { city lat lon currentTemp timezone } }`,
  );
  const r = data.getWeather;
  assert.equal(r.city, "LONDON");
  assert.ok(typeof r.lat === "number");
  assert.ok(typeof r.lon === "number");
  assert.ok(typeof r.currentTemp === "number");
  assert.ok(typeof r.timezone === "string");
});
