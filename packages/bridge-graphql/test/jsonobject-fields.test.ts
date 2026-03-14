/**
 * Tests for JSONObject and [JSONObject] field handling in bridgeTransform.
 *
 * When a field is typed as JSONObject (scalar) in the schema, the bridge
 * engine must eagerly materialise its output instead of deferring to
 * sub-field resolvers. This applies to both:
 *   - `legs: JSONObject`   — single object passthrough
 *   - `legs: [JSONObject]` — array of objects passthrough
 */
import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import { createGateway } from "./utils/gateway.ts";
import { bridge } from "@stackables/bridge-core";

describe("bridgeTransform: JSONObject field passthrough", () => {
  test("legs: JSONObject — single object passthrough via wire", async () => {
    const typeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        trip(id: Int): TripResult
      }
      type TripResult {
        id: Int
        legs: JSONObject
      }
    `;

    const bridgeText = bridge`
      version 1.5
      bridge Query.trip {
        with input as i
        with api as a
        with output as o

        a.id <- i.id

        o.id <- a.id
        o.legs <- a.legs
      }
    `;

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        api: async (p: any) => ({
          id: p.id,
          legs: { duration: "2h", distance: 150 },
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ trip(id: 42) { id legs } }`),
    });

    assert.deepStrictEqual(result.data.trip, {
      id: 42,
      legs: { duration: "2h", distance: 150 },
    });
  });

  test("legs: [JSONObject] — array of objects passthrough via wire", async () => {
    const typeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        trip(id: Int): TripResult2
      }
      type TripResult2 {
        id: Int
        legs: [JSONObject]
      }
    `;

    const bridgeText = bridge`
      version 1.5
      bridge Query.trip {
        with input as i
        with api as a
        with output as o

        a.id <- i.id

        o.id <- a.id
        o.legs <- a.legs
      }
    `;

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        api: async (p: any) => ({
          id: p.id,
          legs: [{ name: "L1" }, { name: "L2" }],
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ trip(id: 42) { id legs } }`),
    });

    assert.deepStrictEqual(result.data.trip, {
      id: 42,
      legs: [{ name: "L1" }, { name: "L2" }],
    });
  });

  test("legs: JSONObject — structured output (not passthrough)", async () => {
    const typeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        trip(id: Int): TripResult3
      }
      type TripResult3 {
        id: Int
        legs: JSONObject
      }
    `;

    const bridgeText = bridge`
      version 1.5
      bridge Query.trip {
        with input as i
        with api as a
        with output as o

        a.id <- i.id

        o.id <- a.id
        o.legs {
          .duration <- a.duration
          .distance <- a.distance
        }
      }
    `;

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        api: async (p: any) => ({
          id: p.id,
          duration: "2h",
          distance: 150,
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ trip(id: 42) { id legs } }`),
    });

    assert.deepStrictEqual(result.data.trip, {
      id: 42,
      legs: { duration: "2h", distance: 150 },
    });
  });

  test("legs: [JSONObject] — array passthrough in array-mapped output", async () => {
    const typeDefs = /* GraphQL */ `
      scalar JSONObject
      type Query {
        search(from: String, to: String): [SearchResult]
      }
      type SearchResult {
        id: Int
        provider: String
        price: Int
        legs: [JSONObject]
      }
    `;

    const bridgeText = bridge`
      version 1.5
      bridge Query.search {
        with input as i
        with api as a
        with output as o

        a.from <- i.from
        a.to <- i.to

        o <- a.items[] as item {
          .id <- item.id
          .provider <- item.provider
          .price <- item.price
          .legs <- item.legs
        }
      }
    `;

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        api: async () => ({
          items: [
            { id: 1, provider: "X", price: 50, legs: [{ name: "L1" }] },
            { id: 2, provider: "Y", price: 80, legs: [{ name: "L2" }] },
          ],
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });
    const result: any = await executor({
      document: parse(`{ search(from: "A", to: "B") { id legs } }`),
    });

    assert.deepStrictEqual(result.data.search, [
      { id: 1, legs: [{ name: "L1" }] },
      { id: 2, legs: [{ name: "L2" }] },
    ]);
  });
});
