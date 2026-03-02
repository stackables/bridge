import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { createGateway } from "./_gateway.ts";

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

const bridgeText = `version 1.5
bridge Query.geocode {
  with hereapi.geocode as gc
  with input as i
  with output as o

o.search <- i.search
gc.q <- i.search
gc.limit <- i.limit
o.results <- gc.items[] as item {
  .name <- item.title
  .lat  <- item.position.lat
  .lon  <- item.position.lng
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

  test("versioned handle resolves and executes normally", async () => {
    const versionedBridge = `version 1.5
bridge Query.geocode {
  with hereapi.geocode@2.1 as gc
  with input as i
  with output as o

  o.search <- i.search
  gc.q <- i.search
  gc.limit <- i.limit
  o.results <- gc.items[] as item {
    .name <- item.title
    .lat  <- item.position.lat
    .lon  <- item.position.lng
  }
}`;
    const instructions = parseBridge(versionedBridge);
    // Provide the versioned tool key to satisfy @2.1, plus the base tool
    const versionedTools = {
      ...tools,
      "hereapi.geocode@2.1": tools["hereapi.geocode"],
    };
    const gateway = createGateway(typeDefs, instructions, {
      tools: versionedTools,
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(
        `{ geocode(search: "Berlin", limit: 10) { search results { name lat lon } } }`,
      ),
    });
    assert.equal(result.data.geocode.search, "Berlin");
    assert.deepStrictEqual(result.data.geocode.results[0], {
      name: "Invalidenstraße 117, 10115 Berlin, Deutschland",
      lat: 52.53041,
      lon: 13.38527,
    });
  });
});

describe("executeGraph: scalar return types (JSONObject / JSON)", () => {
  test("JSONObject field returns materialised object, not ExecutionTree", async () => {
    const scalarTypeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        greet(name: String!): JSONObject
      }
    `;

    const scalarBridge = `version 1.5
bridge Query.greet {
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o.message <- i.name
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`;

    const instructions = parseBridge(scalarBridge);
    const gateway = createGateway(scalarTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ greet(name: "Hello Bridge") }`),
    });

    assert.deepStrictEqual(result.data.greet, {
      message: "Hello Bridge",
      upper: "HELLO BRIDGE",
      lower: "hello bridge",
    });
  });

  test("JSON scalar with passthrough root wire returns resolved value", async () => {
    const scalarTypeDefs = /* GraphQL */ `
      scalar JSON
      type Query {
        fetchData(id: String!): JSON
      }
    `;

    const scalarBridge = `version 1.5
bridge Query.fetchData {
  with myApi as api
  with input as i
  with output as o

  api.id <- i.id
  o <- api
}`;

    const instructions = parseBridge(scalarBridge);
    const gateway = createGateway(scalarTypeDefs, instructions, {
      tools: {
        myApi: async (params: { id: string }) => ({
          id: params.id,
          value: 42,
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ fetchData(id: "abc") }`),
    });

    assert.deepStrictEqual(result.data.fetchData, {
      id: "abc",
      value: 42,
    });
  });

  test("JSONObject! (non-null wrapped scalar) returns materialised object", async () => {
    const scalarTypeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        info(name: String!): JSONObject!
      }
    `;

    const scalarBridge = `version 1.5
bridge Query.info {
  with input as i
  with output as o

  o.greeting <- i.name
}`;

    const instructions = parseBridge(scalarBridge);
    const gateway = createGateway(scalarTypeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ info(name: "World") }`),
    });

    assert.deepStrictEqual(result.data.info, {
      greeting: "World",
    });
  });

  test("[JSON!] array of scalars returns materialised objects", async () => {
    const scalarTypeDefs = /* GraphQL */ `
      scalar JSON
      type Query {
        items: [JSON!]!
      }
    `;

    const scalarBridge = `version 1.5
bridge Query.items {
  with myApi as api
  with output as o

  o <- api.results[] as item {
    .name <- item.title
    .score <- item.value
  }
}`;

    const instructions = parseBridge(scalarBridge);
    const gateway = createGateway(scalarTypeDefs, instructions, {
      tools: {
        myApi: async () => ({
          results: [
            { title: "Alpha", value: 10 },
            { title: "Beta", value: 20 },
          ],
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ items }`),
    });

    assert.deepStrictEqual(result.data.items, [
      { name: "Alpha", score: 10 },
      { name: "Beta", score: 20 },
    ]);
  });

  test("JSONObject with sub-field array mapping renames element fields", async () => {
    const scalarTypeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        catalog: JSONObject
      }
    `;

    const scalarBridge = `version 1.5
bridge Query.catalog {
  with api as src
  with output as o

  o.title <- src.name
  o.entries <- src.items[] as item {
    .id <- item.item_id
    .label <- item.item_name
  }
}`;

    const instructions = parseBridge(scalarBridge);
    const gateway = createGateway(scalarTypeDefs, instructions, {
      tools: {
        api: async () => ({
          name: "My Catalog",
          items: [
            { item_id: 1, item_name: "Widget" },
            { item_id: 2, item_name: "Gadget" },
          ],
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ catalog }`),
    });

    assert.deepStrictEqual(result.data.catalog, {
      title: "My Catalog",
      entries: [
        { id: 1, label: "Widget" },
        { id: 2, label: "Gadget" },
      ],
    });
  });
});
