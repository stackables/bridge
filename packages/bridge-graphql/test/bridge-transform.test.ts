import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { buildSchema, execute, parse } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import {
  bridgeTransform,
  getBridgeTraces,
  useBridgeTracing,
} from "../src/index.ts";
import { bridge } from "@stackables/bridge-core";

describe("bridgeTransform coverage branches", () => {
  test("supports contextMapper with per-request document selection", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        pick: PickResult
      }
      type PickResult {
        value: String
        secret: String
      }
    `;

    const v1 = parseBridge(bridge`
      version 1.5
      bridge Query.pick {
        with context as c
        with output as o
        o.value <- c.allowed
        o.secret <- c.secret
      }
    `);
    const v2 = parseBridge(bridge`
      version 1.5
      bridge Query.pick {
        with output as o
        o.value = "v2"
      }
    `);

    const rawSchema = createSchema({ typeDefs });
    const schema = bridgeTransform(
      rawSchema,
      (ctx) => (ctx.version === "v2" ? v2 : v1),
      {
        contextMapper: (ctx) => ({ allowed: ctx.allowed }),
      },
    );
    const yoga = createYoga({
      schema,
      graphqlEndpoint: "*",
      context: () => ({ allowed: "mapped", secret: "hidden", version: "v1" }),
    });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });

    const result: any = await executor({
      document: parse(`{ pick { value secret } }`),
    });
    assert.equal(result.data.pick.value, "mapped");
    assert.equal(result.data.pick.secret, null);
  });

  test("applies toolTimeoutMs and maxDepth options to root execution tree", async () => {
    const typeDefs = /* GraphQL */ `
      type Query {
        slow: SlowResult
      }
      type SlowResult {
        value: String
      }
    `;
    const instructions = parseBridge(bridge`
      version 1.5
      bridge Query.slow {
        with waitTool as w
        with output as o
        o.value <- w.value
      }
    `);
    const rawSchema = createSchema({ typeDefs });
    const schema = bridgeTransform(rawSchema, instructions, {
      tools: {
        waitTool: async () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ value: "ok" }), 30),
          ),
      },
      toolTimeoutMs: 1,
      maxDepth: 3,
    });
    const yoga = createYoga({ schema, graphqlEndpoint: "*" });
    const executor = buildHTTPExecutor({ fetch: yoga.fetch as any });
    const result: any = await executor({
      document: parse(`{ slow { value } }`),
    });
    assert.ok(result.errors?.length > 0, JSON.stringify(result));
  });
});

describe("bridge tracing helpers", () => {
  test("getBridgeTraces returns empty array when tracer is absent", () => {
    assert.deepEqual(getBridgeTraces(undefined), []);
    assert.deepEqual(getBridgeTraces({}), []);
  });

  test("useBridgeTracing adds traces into GraphQL extensions", () => {
    const traces = [{ tool: "a", fn: "a", startedAt: 1, durationMs: 1 }];
    const plugin = useBridgeTracing();
    const execHooks = plugin.onExecute({
      args: { contextValue: { __bridgeTracer: { traces } } },
    } as any);
    let updated: any;

    execHooks?.onExecuteDone?.({
      result: { data: { ok: true } },
      setResult: (r: any) => {
        updated = r;
      },
    });

    assert.deepEqual(updated.extensions.traces, traces);
  });
});

describe("bridgeTransform: error surfacing", () => {
  test("surfaces formatted runtime errors through GraphQL", async () => {
    const bridgeText = bridge`
      version 1.5

      bridge Query.greet {
        with std.str.toUpperCase as uc memoize
        with std.str.toLowerCase as lc
        with input as i
        with output as o

        o.message <- i.empty.array.error
        o.upper <- uc:i.name
        o.lower <- lc:i.name
      }
    `;

    const schema = buildSchema(/* GraphQL */ `
      type Query {
        greet(name: String!): Greeting
      }

      type Greeting {
        message: String
        upper: String
        lower: String
      }
    `);

    const transformed = bridgeTransform(
      schema,
      parseBridge(bridgeText, {
        filename: "playground.bridge",
      }),
    );

    const result = await execute({
      schema: transformed,
      document: parse(`{ greet(name: "Ada") { message upper lower } }`),
      contextValue: {},
    });

    assert.ok(result.errors?.length, "expected GraphQL errors");
    const message = result.errors?.[0]?.message ?? "";
    assert.match(
      message,
      /Bridge Execution Error: Cannot read properties of undefined \(reading '(array|error)'\)/,
    );
    assert.match(message, /playground\.bridge:9:16/);
    assert.match(message, /o\.message <- i\.empty\.array\.error/);
  });
});
