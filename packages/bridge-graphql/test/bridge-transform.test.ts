import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import {
  bridgeTransform,
  getBridgeTraversalId,
  getBridgeTraces,
  useBridgeTracing,
} from "../src/index.ts";

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

    const v1 = parseBridge(`version 1.5
bridge Query.pick {
  with context as c
  with output as o
  o.value <- c.allowed
  o.secret <- c.secret
}`);
    const v2 = parseBridge(`version 1.5
bridge Query.pick {
  with output as o
  o.value = "v2"
}`);

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
    const instructions = parseBridge(`version 1.5
bridge Query.slow {
  with waitTool as w
  with output as o
  o.value <- w.value
}`);
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

  test("getBridgeTraversalId returns undefined when traversal is absent", () => {
    assert.equal(getBridgeTraversalId(undefined), undefined);
    assert.equal(getBridgeTraversalId({}), undefined);
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

  test("useBridgeTracing adds traversalId into GraphQL extensions", () => {
    const traversalId = "path_deadbeefdeadbeef";
    const plugin = useBridgeTracing();
    const execHooks = plugin.onExecute({
      args: { contextValue: { __bridgeTraversalId: traversalId } },
    } as any);
    let updated: any;

    execHooks?.onExecuteDone?.({
      result: { data: { ok: true } },
      setResult: (r: any) => {
        updated = r;
      },
    });

    assert.equal(updated.extensions.traversalId, traversalId);
  });
});
