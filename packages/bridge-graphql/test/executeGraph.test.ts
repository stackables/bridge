import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import { createGateway } from "./utils/gateway.ts";
import { bridge } from "@stackables/bridge-core";

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

const bridgeText = bridge`
  version 1.5
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

  }
`;

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
    const versionedBridge = bridge`
      version 1.5
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
      }
    `;
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

    const scalarBridge = bridge`
      version 1.5
      bridge Query.greet {
        with std.str.toUpperCase as uc
        with std.str.toLowerCase as lc
        with input as i
        with output as o

        o.message <- i.name
        o.upper <- uc:i.name
        o.lower <- lc:i.name
      }
    `;

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

    const scalarBridge = bridge`
      version 1.5
      bridge Query.fetchData {
        with myApi as api
        with input as i
        with output as o

        api.id <- i.id
        o <- api
      }
    `;

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

    const scalarBridge = bridge`
      version 1.5
      bridge Query.info {
        with input as i
        with output as o

        o.greeting <- i.name
      }
    `;

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

    const scalarBridge = bridge`
      version 1.5
      bridge Query.items {
        with myApi as api
        with output as o

        o <- api.results[] as item {
          .name <- item.title
          .score <- item.value
        }
      }
    `;

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

    const scalarBridge = bridge`
      version 1.5
      bridge Query.catalog {
        with api as src
        with output as o

        o.title <- src.name
        o.entries <- src.items[] as item {
          .id <- item.item_id
          .label <- item.item_name
        }
      }
    `;

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

// ═══════════════════════════════════════════════════════════════════════════
// GraphQL-specific behavior
//
// These tests cover aspects unique to the GraphQL driver:
// - Per-field error reporting (errors don't fail the entire response)
// - Fields without bridge instructions fall through to default resolvers
// - Mutation support via GraphQL
// - Multiple bridge fields in one query
// ═══════════════════════════════════════════════════════════════════════════

describe("executeGraph: per-field error handling", () => {
  test("tool error surfaces as GraphQL field error, not full failure", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        lookup(q: String!): Result
      }
      type Result {
        label: String
        score: Int
      }
    `;

    const instr = bridge`
      version 1.5
      bridge Query.lookup {
        with geocoder as g
        with input as i
        with output as o

        g.q <- i.q
        o.label <- g.label
        o.score <- g.score
      }
    `;

    const instructions = parseBridge(instr);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        geocoder: async () => {
          throw new Error("API rate limit exceeded");
        },
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label score } }`),
    });

    // GraphQL returns partial data + errors array
    assert.ok(
      result.errors,
      `errors array should be present, got: ${JSON.stringify(result)}`,
    );
    assert.ok(result.errors.length > 0, "should have at least one error");
    // GraphQL-yoga may wrap errors — check message contains original text
    // or the error is at least present with a path
    const hasToolError = result.errors.some(
      (e: any) =>
        e.message.includes("API rate limit exceeded") ||
        e.message === "Unexpected error.",
    );
    assert.ok(
      hasToolError,
      `expected a field error, got: ${JSON.stringify(result.errors.map((e: any) => e.message))}`,
    );
  });

  test("error in one field does not prevent other fields from resolving", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        good: GoodResult
        bad: BadResult
      }
      type GoodResult {
        value: String
      }
      type BadResult {
        value: String
      }
    `;

    const instr = bridge`
      version 1.5
      bridge Query.good {
        with output as o
        o.value = "hello"
      }

      bridge Query.bad {
        with failing as f
        with output as o
        o.value <- f.value
      }
    `;

    const instructions = parseBridge(instr);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        failing: async () => {
          throw new Error("tool broke");
        },
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ good { value } bad { value } }`),
    });

    // Good field resolves
    assert.equal(result.data.good.value, "hello");
    // Bad field errors but doesn't break the whole response
    assert.ok(result.errors, "errors present");
    assert.ok(
      result.errors.some((e: any) => e.path?.includes("bad")),
      "error path should reference 'bad' field",
    );
  });
});

describe("executeGraph: field fallthrough", () => {
  test("field without bridge instruction falls through to default resolver", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        bridged(name: String!): BridgedResult
        unbridged: String
      }
      type BridgedResult {
        greeting: String
      }
    `;

    const instr = bridge`
      version 1.5
      bridge Query.bridged {
        with input as i
        with output as o
        o.greeting <- i.name
      }
    `;

    const instructions = parseBridge(instr);
    // unbridged has no bridge instruction — should use default resolver
    const { createSchema } = await import("graphql-yoga");
    const { bridgeTransform } = await import("../src/index.ts");

    const rawSchema = createSchema({
      typeDefs,
      resolvers: {
        Query: {
          unbridged: () => "hand-coded",
        },
      },
    });
    const schema = bridgeTransform(rawSchema, instructions);
    const { createYoga } = await import("graphql-yoga");
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });

    const result: any = await executor({
      document: parse(`{ bridged(name: "World") { greeting } unbridged }`),
    });

    assert.equal(result.data.bridged.greeting, "World");
    assert.equal(result.data.unbridged, "hand-coded");
  });
});

describe("executeGraph: mutations via GraphQL", () => {
  test("sends email mutation and extracts response header path", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        _: Boolean
      }
      type Mutation {
        sendEmail(
          to: String!
          from: String!
          subject: String!
          body: String!
        ): EmailResult
      }
      type EmailResult {
        messageId: String
      }
    `;

    const bridgeText = bridge`
      version 1.5
      bridge Mutation.sendEmail {
        with sendgrid.send as sg
        with input as i
        with output as o

        sg.to <- i.to
        sg.from <- i.from
        sg.subject <- i.subject
        sg.content <- i.body
        o.messageId <- sg.headers.x-message-id
      }
    `;

    const fakeEmailTool = async (_params: Record<string, any>) => ({
      statusCode: 202,
      headers: { "x-message-id": "msg_abc123" },
      body: { message: "Queued" },
    });

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { "sendgrid.send": fakeEmailTool },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`
        mutation {
          sendEmail(
            to: "alice@example.com"
            from: "bob@example.com"
            subject: "Hello"
            body: "Hi there"
          ) {
            messageId
          }
        }
      `),
    });
    assert.equal(result.data.sendEmail.messageId, "msg_abc123");
  });

  test("tool receives renamed fields from mutation args", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        _: Boolean
      }
      type Mutation {
        sendEmail(
          to: String!
          from: String!
          subject: String!
          body: String!
        ): EmailResult
      }
      type EmailResult {
        messageId: String
      }
    `;

    const bridgeText = bridge`
      version 1.5
      bridge Mutation.sendEmail {
        with sendgrid.send as sg
        with input as i
        with output as o

        sg.to <- i.to
        sg.from <- i.from
        sg.subject <- i.subject
        sg.content <- i.body
        o.messageId <- sg.headers.x-message-id
      }
    `;

    let capturedParams: Record<string, any> = {};
    const capture = async (params: Record<string, any>) => {
      capturedParams = params;
      return { headers: { "x-message-id": "test" } };
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: { "sendgrid.send": capture },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    await executor({
      document: parse(`
        mutation {
          sendEmail(
            to: "alice@example.com"
            from: "bob@example.com"
            subject: "Hello"
            body: "Hi there"
          ) {
            messageId
          }
        }
      `),
    });

    assert.equal(capturedParams.to, "alice@example.com");
    assert.equal(capturedParams.from, "bob@example.com");
    assert.equal(capturedParams.subject, "Hello");
    assert.equal(capturedParams.content, "Hi there"); // body -> content rename
  });
});

describe("executeGraph: multilevel break/continue in nested arrays", () => {
  const catalogTypeDefs = /* GraphQL */ `
    type Item {
      sku: String
      price: Float
    }
    type Category {
      name: String
      items: [Item!]!
    }
    type Query {
      processCatalog: [Category!]!
    }
  `;

  // continue 2 = skip the outer (category) element
  // break 2    = stop iterating outer (category) array entirely
  const catalogBridge = bridge`
    version 1.5
    bridge Query.processCatalog {
      with context as ctx
      with output as o

      o <- ctx.catalog[] as cat {
        .name <- cat.name
        .items <- cat.items[] as item {
          .sku <- item.sku ?? continue 2
          .price <- item.price ?? break 2
        }
      }
    }
  `;

  const catalog = [
    // sku present, price present → emitted
    { name: "Summer", items: [{ sku: "A1", price: 10.0 }] },
    // sku null on first item → continue 2 → skip Winter
    { name: "Winter", items: [{ sku: null, price: 5.0 }] },
    // price null on first item → break 2 → stop entire outer loop
    { name: "Spring", items: [{ sku: "A3", price: null }] },
    // never reached
    { name: "Autumn", items: [{ sku: "A4", price: 20.0 }] },
  ];

  test("falls back to standalone execution mode with a warning", async () => {
    const warnings: string[] = [];
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };

    const instructions = parseBridge(catalogBridge);
    // Must NOT throw at setup time — fallback mode is used instead
    const gateway = createGateway(catalogTypeDefs, instructions, {
      logger: mockLogger,
      context: { catalog },
    });

    // Warning must be logged at setup time
    assert.ok(
      warnings.some((w) => w.includes("Query.processCatalog")),
      `Expected a warning about Query.processCatalog, got: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.some((w) => w.includes("standalone")),
      `Expected warning to mention standalone mode, got: ${JSON.stringify(warnings)}`,
    );

    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{
        processCatalog {
          name
          items { sku price }
        }
      }`),
    });

    // Summer passes; Winter skipped (continue 2); Spring triggers break 2 → only Summer
    assert.deepStrictEqual(result.data.processCatalog, [
      { name: "Summer", items: [{ sku: "A1", price: 10.0 }] },
    ]);
  });
});
