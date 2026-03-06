import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { createSchema, createYoga } from "graphql-yoga";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import { bridgeTransform } from "../src/index.ts";
import type { Logger } from "@stackables/bridge-core";

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

const bridge = `version 1.5
bridge Query.lookup {
  with geocoder as g
  with input as i
  with output as o

g.q <- i.q
o.label <- g.label

}`;

function createLogCapture(): Logger & {
  debugMessages: string[];
  errorMessages: string[];
} {
  const debugMessages: string[] = [];
  const errorMessages: string[] = [];
  // Structured log calls arrive as (data: object, msg: string) — Pino convention.
  // Flatten to a single searchable string for test assertions.
  const format = (...args: any[]): string =>
    args
      .map((a) => (a && typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
  return {
    debugMessages,
    errorMessages,
    debug: (...args: any[]) => debugMessages.push(format(...args)),
    info: () => {},
    warn: () => {},
    error: (...args: any[]) => errorMessages.push(format(...args)),
  };
}

describe("logging: basics", () => {
  test("logger.debug is called on successful tool call", async () => {
    const instructions = parseBridge(bridge);
    const logger = createLogCapture();
    const geocoder = async () => ({ label: "Berlin, DE" });
    geocoder.bridge = { log: { execution: "debug" as const } };
    const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
      tools: { geocoder },
      logger,
    });
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });
    await executor({ document: parse(`{ lookup(q: "Berlin") { label } }`) });

    assert.ok(
      logger.debugMessages.some(
        (m) => m.includes("geocoder") && m.includes("completed"),
      ),
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
      logger.errorMessages.some(
        (m) => m.includes("geocoder") && m.includes("API down"),
      ),
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
    const result: any = await executor({
      document: parse(`{ lookup(q: "x") { label } }`),
    });
    assert.equal(result.data.lookup.label, "X");
  });

  test("logger.warn is called when accessing a named field on an array result", async () => {
    // Bridge accesses .firstName on items[] (an array) without using array mapping.
    // This should trigger the array-access warning path.
    const arrayBridge = `version 1.5
bridge Query.lookup {
  with listTool as l
  with input as i
  with output as o

l.q <- i.q
o.label <- l.items.firstName

}`;
    const instructions = parseBridge(arrayBridge);
    const warnMessages: string[] = [];
    const logger = {
      ...createLogCapture(),
      warn: (...args: any[]) => warnMessages.push(args.join(" ")),
    };
    const schema = bridgeTransform(createSchema({ typeDefs }), instructions, {
      tools: {
        listTool: async () => ({
          items: [{ firstName: "Alice" }, { firstName: "Bob" }],
        }),
      },
      logger,
    });
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });
    await executor({ document: parse(`{ lookup(q: "x") { label } }`) });

    assert.ok(
      warnMessages.some((m) => m.includes("firstName") && m.includes("array")),
      `expected a warn message about array field access, got: ${JSON.stringify(warnMessages)}`,
    );
  });
});
