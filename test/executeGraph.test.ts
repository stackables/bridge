import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

const typeDefs = /* GraphQL */ `
  type Query {
    geocode(search: String!, limit: Int): GeocodeResult
  }
  type GeocodeResult {
    search: String
    results: [GeocodeItem!]!
  }
  type GeocodeItem {
    name: String
    lat: Float
    lon: Float
  }
`;

const bridgeText = `
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

o.search <- i.search
gc.q <- i.search
gc.limit <- i.limit
o.results <- gc.items[] {
  .name <- .title
  .lat  <- .position.lat
  .lon  <- .position.lng
}

}`;

const cache: Record<string, any> = {
  "Berlin|10": {
    items: [
      {
        title: "Invalidenstraße 117, 10115 Berlin, Deutschland",
        position: { lat: 52.53041, lng: 13.38527 },
      },
    ],
  },
  "Tallinn|2": {
    items: [
      {
        title: "Invalidenstraße 117, 10115 Berlin, Deutschland",
        position: { lat: 52.53041, lng: 13.38527 },
      },
      {
        title: "Tallinn",
        position: { lat: 59.437, lng: 24.7536 },
      },
    ],
  },
};

const tools = {
  "hereapi.geocode": async (params: { q: string; limit?: string }) => {
    const key = `${params.q}|${params.limit ?? ""}`;
    const resp = cache[key];
    if (resp) return resp;
    throw new Error(`Not found: ${key}`);
  },
};

function makeExecutor() {
  const instructions = parseBridge(bridgeText);
  const gateway = createGateway(typeDefs, instructions, { tools });
  return buildHTTPExecutor({ fetch: gateway.fetch as any });
}

describe("executeGraph", () => {
  test("passthrough: search echoed from input", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ geocode(search: "Berlin", limit: 10) { search } }`),
    });
    assert.equal(result.data.geocode.search, "Berlin");
  });

  test("rename: provider field mapped to output field", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(
        `{ geocode(search: "Berlin", limit: 10) { results { name } } }`,
      ),
    });
    assert.equal(
      result.data.geocode.results[0].name,
      "Invalidenstraße 117, 10115 Berlin, Deutschland",
    );
  });

  test("nested drill: position.lat mapped to lat", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(
        `{ geocode(search: "Berlin", limit: 10) { results { lat lon } } }`,
      ),
    });
    assert.equal(result.data.geocode.results[0].lat, 52.53041);
    assert.equal(result.data.geocode.results[0].lon, 13.38527);
  });

  test("multiple array items returned", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(
        `{ geocode(search: "Tallinn", limit: 2) { results { name lat } } }`,
      ),
    });
    assert.equal(result.data.geocode.results.length, 2);
    assert.equal(result.data.geocode.results[1].lat, 59.437);
  });

  test("full response shape", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(
        `{ geocode(search: "Berlin", limit: 10) { search results { name lat lon } } }`,
      ),
    });
    assert.equal(result.data.geocode.search, "Berlin");
    assert.equal(result.data.geocode.results.length, 1);
    assert.deepStrictEqual(result.data.geocode.results[0], {
      name: "Invalidenstraße 117, 10115 Berlin, Deutschland",
      lat: 52.53041,
      lon: 13.38527,
    });
  });
});
