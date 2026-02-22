import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { createSchema, createYoga } from "graphql-yoga";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { bridgeTransform } from "../src/bridge-transform.js";
import type { Logger } from "../src/ExecutionTree.js";

// ═══════════════════════════════════════════════════════════════════════════
// Logging
//
// When a `logger` is passed to bridgeTransform, the engine routes all
// engine-level log events through it (tool completions, tool errors, array
// access warnings) instead of writing to console.
// ═══════════════════════════════════════════════════════════════════════════

const typeDefs = /* GraphQL */ `
  type Query {
    lookup(q: String!): Result
  }
  type Result {
    label: String
  }
`;

const bridge = `version 1.4
bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;

function createLogCapture(): Logger & { debugMessages: string[]; errorMessages: string[] } {
  const debugMessages: string[] = [];
  const errorMessages: string[] = [];
  return {
    debugMessages,
    errorMessages,
    debug: (...args: any[]) => debugMessages.push(args.join(" ")),
    info: () => {},
    warn: () => {},
    error: (...args: any[]) => errorMessages.push(args.join(" ")),
  };
}

describe("logging: basics", () => {
  test("logger.debug is called on successful tool call", async () => {
    const instructions = parseBridge(bridge);
    const logger = createLogCapture();
    const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
      tools: { geocoder: async () => ({ label: "Berlin, DE" }) },
      logger,
    });
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });
    await executor({ document: parse(`{ lookup(q: "Berlin") { label } }`) });

    assert.ok(
      logger.debugMessages.some((m) => m.includes("geocoder") && m.includes("completed")),
      `expected a debug message for geocoder completion, got: ${JSON.stringify(logger.debugMessages)}`,
    );
    assert.equal(logger.errorMessages.length, 0, "no errors on success");
  });

  test("logger.error is called when a tool throws", async () => {
    const instructions = parseBridge(bridge);
    const logger = createLogCapture();
    const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
      tools: {
        geocoder: async () => {
          throw new Error("API down");
        },
      },
      logger,
    });
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });
    await executor({ document: parse(`{ lookup(q: "x") { label } }`) });

    assert.ok(
      logger.errorMessages.some((m) => m.includes("geocoder") && m.includes("API down")),
      `expected an error message mentioning geocoder and "API down", got: ${JSON.stringify(logger.errorMessages)}`,
    );
  });

  test("no output when no logger is provided (default noop)", async () => {
    // Just checks that not providing a logger doesn't throw
    const instructions = parseBridge(bridge);
    const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
      tools: { geocoder: async () => ({ label: "X" }) },
      // no logger
    });
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });
    const result: any = await executor({ document: parse(`{ lookup(q: "x") { label } }`) });
    assert.equal(result.data.lookup.label, "X");
  });
});
