import assert from "node:assert/strict";
import { test } from "node:test";
import { yoga, savedQuotes } from "./server.js";

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

// ═══════════════════════════════════════════════════════════════════════════
// Weather domain — bridge-powered (reuses Weather.bridge)
// ═══════════════════════════════════════════════════════════════════════════

test("weather query works through composed gateway", async () => {
  const data = await gql(
    `{ getWeatherByCoordinates(lat: "48.8566", lon: "2.3522") { lat lon currentTemp timezone } }`,
  );
  assert.ok(typeof data.getWeatherByCoordinates.currentTemp === "number");
  assert.ok(typeof data.getWeatherByCoordinates.timezone === "string");
});

test("weather by name works through composed gateway", async () => {
  const data = await gql(
    `{ getWeatherByName(cityName: "Berlin") { city currentTemp } }`,
  );
  assert.equal(data.getWeatherByName.city, "Berlin");
  assert.ok(typeof data.getWeatherByName.currentTemp === "number");
});

// ═══════════════════════════════════════════════════════════════════════════
// Quotes domain — bridge-powered (Quotes.bridge)
// ═══════════════════════════════════════════════════════════════════════════

test("randomQuote returns text and author from dummyjson", async () => {
  const data = await gql(`{ randomQuote { text author } }`);
  assert.ok(typeof data.randomQuote.text === "string", "text must be a string");
  assert.ok(data.randomQuote.text.length > 0, "text must not be empty");
  assert.ok(typeof data.randomQuote.author === "string", "author must be a string");
});

// ═══════════════════════════════════════════════════════════════════════════
// Hand-coded mutation — NOT bridge-powered, plain TS resolver
// ═══════════════════════════════════════════════════════════════════════════

test("saveQuote mutation works alongside bridge-powered queries", async () => {
  // Clear any state from previous runs
  savedQuotes.length = 0;

  const data = await gql(
    `mutation { saveQuote(text: "Be yourself", author: "Oscar Wilde") { id text author savedAt } }`,
  );
  assert.equal(data.saveQuote.id, "1");
  assert.equal(data.saveQuote.text, "Be yourself");
  assert.equal(data.saveQuote.author, "Oscar Wilde");
  assert.ok(data.saveQuote.savedAt, "savedAt must be present");

  // Verify in-memory store was updated
  assert.equal(savedQuotes.length, 1);
  assert.equal(savedQuotes[0].text, "Be yourself");
});

test("multiple saveQuote calls increment id", async () => {
  savedQuotes.length = 0;

  await gql(`mutation { saveQuote(text: "A", author: "X") { id } }`);
  const data = await gql(`mutation { saveQuote(text: "B", author: "Y") { id } }`);
  assert.equal(data.saveQuote.id, "2");
  assert.equal(savedQuotes.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-domain — both domains in a single request
// ═══════════════════════════════════════════════════════════════════════════

test("query weather and quote in the same request", async () => {
  const data = await gql(`{
    getWeatherByCoordinates(lat: "52.52", lon: "13.405") { currentTemp }
    randomQuote { text author }
  }`);
  assert.ok(typeof data.getWeatherByCoordinates.currentTemp === "number");
  assert.ok(typeof data.randomQuote.text === "string");
});

test("query and mutation in the same request", async () => {
  savedQuotes.length = 0;

  const data = await gql(`
    mutation {
      saveQuote(text: "Composed!", author: "Bridge") { id text }
    }
  `);
  assert.equal(data.saveQuote.text, "Composed!");
  assert.equal(savedQuotes.length, 1);
});
