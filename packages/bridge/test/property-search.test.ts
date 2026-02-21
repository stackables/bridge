import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { createGateway } from "./_gateway.js";

const typeDefs = /* GraphQL */ `
  type Query {
    propertySearch(location: String!, budget: Int): PropertySearchResult
    propertyComments(location: String!): [String!]!
  }
  type PropertySearchResult {
    location: String
    topPick: Property
    listings: [Property!]!
  }
  type Property {
    address: String
    price: Float
    bedrooms: Int
    city: String
  }
`;

const bridgeFile = readFileSync(
  new URL("./property-search.bridge", import.meta.url),
  "utf-8",
);

const propertyTools: Record<string, any> = {
  "hereapi.geocode": async (_params: any) => ({
    items: [
      {
        title: "Berlin",
        position: { lat: 52.53, lng: 13.38 },
      },
    ],
  }),
  "zillow.search": async (_params: any) => ({
    properties: [
      {
        streetAddress: "123 Main St",
        priceInCents: 35000000,
        beds: 3,
        location: { city: "Berlin" },
      },
      {
        streetAddress: "456 Oak Ave",
        priceInCents: 42000000,
        beds: 4,
        location: { city: "Berlin" },
      },
    ],
  }),
  "reviews.getByLocation": async (_params: any) => ({
    comments: [
      { text: "Great neighborhood", rating: 5 },
      { text: "Quiet area", rating: 4 },
    ],
  }),
  centsToUsd: (params: { cents: number }) => ({ dollars: params.cents / 100 }),
  pluckText: (params: { in: any[] }) => params.in.map((item: any) => item.text),
};

function makeExecutor() {
  const instructions = parseBridge(bridgeFile);
  const gateway = createGateway(typeDefs, instructions, {
    tools: propertyTools,
  });
  return buildHTTPExecutor({ fetch: gateway.fetch as any });
}

describe("property search (.bridge file)", () => {
  test("passthrough: location echoed", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ propertySearch(location: "Berlin") { location } }`),
    });
    assert.equal(result.data.propertySearch.location, "Berlin");
  });

  test("topPick: chained geocode → zillow → tool", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{
                propertySearch(location: "Berlin") {
                    topPick { address price bedrooms city }
                }
            }`),
    });
    const topPick = result.data.propertySearch.topPick;
    assert.equal(topPick.address, "123 Main St");
    assert.equal(topPick.price, 350000); // 35000000 / 100
    assert.equal(topPick.bedrooms, 3);
    assert.equal(topPick.city, "Berlin");
  });

  test("listings: array mapping with per-element rename", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{
                propertySearch(location: "Berlin") {
                    listings { address price bedrooms city }
                }
            }`),
    });
    const listings = result.data.propertySearch.listings;
    assert.equal(listings.length, 2);
    assert.equal(listings[0].address, "123 Main St");
    assert.equal(listings[0].price, 35000000); // raw value, no tool on listings
    assert.equal(listings[1].address, "456 Oak Ave");
    assert.equal(listings[1].bedrooms, 4);
    assert.equal(listings[1].city, "Berlin");
  });

  test("propertyComments: chained tools + pluckText tool", async () => {
    const executor = makeExecutor();
    const result: any = await executor({
      document: parse(`{ propertyComments(location: "Berlin") }`),
    });
    assert.deepStrictEqual(result.data.propertyComments, [
      "Great neighborhood",
      "Quiet area",
    ]);
  });

  test("zillow receives chained geocode coordinates", async () => {
    let zillowParams: Record<string, any> = {};
    const spy = async (params: any) => {
      zillowParams = params;
      return propertyTools["zillow.search"](params);
    };

    const instructions = parseBridge(bridgeFile);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { ...propertyTools, "zillow.search": spy },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(
        `{ propertySearch(location: "Berlin") { topPick { address } } }`,
      ),
    });

    assert.equal(zillowParams.latitude, 52.53);
    assert.equal(zillowParams.longitude, 13.38);
  });
});
