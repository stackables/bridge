import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../../src/index.ts";
import type { BatchToolFn, ToolMetadata } from "../../src/index.ts";
import { forEachEngine } from "../utils/dual-run.ts";

forEachEngine("native batched tools", (run, ctx) => {
  test("tool metadata batches loop-scoped calls without userland loaders", async () => {
    const bridge = `version 1.5

bridge Query.users {
  with context as ctx
  with output as o

  o <- ctx.userIds[] as userId {
    with app.fetchUser as user

    user.id <- userId
    .id <- userId
    .name <- user.name
  }
}`;

    let batchCalls = 0;
    let receivedInputs: Array<{ id: string }> | undefined;

    const fetchUser: BatchToolFn<{ id: string }, { name: string }> = async (
      inputs,
    ) => {
      batchCalls++;
      receivedInputs = inputs;
      return inputs.map((input) => ({
        name: `user:${input.id}`,
      }));
    };

    // Batching is opt-in through tool metadata, so bridge authors write
    // ordinary wires and do not need to thread DataLoaders via context.
    fetchUser.bridge = {
      batch: {
        maxBatchSize: 100,
        flush: "microtask",
      },
    } satisfies ToolMetadata;

    const result = await run(
      bridge,
      "Query.users",
      {},
      {
        app: { fetchUser },
      },
      {
        context: {
          userIds: ["u1", "u2", "u3"],
        },
      },
    );

    assert.deepEqual(result.data, [
      { id: "u1", name: "user:u1" },
      { id: "u2", name: "user:u2" },
      { id: "u3", name: "user:u3" },
    ]);

    assert.deepEqual(receivedInputs, [
      { id: "u1" },
      { id: "u2" },
      { id: "u3" },
    ]);
    assert.equal(batchCalls, 1);
  });

  test("batched tools emit one trace and log entry per flushed batch call", async () => {
    const bridge = `version 1.5

bridge Query.users {
  with context as ctx
  with output as o

  o <- ctx.userIds[] as userId {
    with app.fetchUser as user

    user.id <- userId
    .id <- userId
    .name <- user.name
  }
}`;

    const infos: Array<{ tool: string; fn: string; durationMs: number }> = [];

    const fetchUser: BatchToolFn<{ id: string }, { name: string }> = async (
      inputs,
    ) => inputs.map((input) => ({ name: `user:${input.id}` }));

    fetchUser.bridge = {
      batch: true,
      log: { execution: "info" },
    } satisfies ToolMetadata;

    const result = await ctx.executeFn({
      document: parseBridge(bridge),
      operation: "Query.users",
      tools: {
        app: { fetchUser },
      },
      context: {
        userIds: ["u1", "u2", "u3"],
      },
      trace: "full",
      logger: {
        info: (meta: { tool: string; fn: string; durationMs: number }) => {
          infos.push(meta);
        },
      },
    });

    assert.deepEqual(result.data, [
      { id: "u1", name: "user:u1" },
      { id: "u2", name: "user:u2" },
      { id: "u3", name: "user:u3" },
    ]);
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]!.tool, "app.fetchUser");
    assert.deepEqual(result.traces[0]!.input, [
      { id: "u1" },
      { id: "u2" },
      { id: "u3" },
    ]);
    assert.deepEqual(result.traces[0]!.output, [
      { name: "user:u1" },
      { name: "user:u2" },
      { name: "user:u3" },
    ]);
    assert.equal(infos.length, 1);
  });

  test("partial batch failures route failed items through catch fallbacks", async () => {
    const bridge = `version 1.5

bridge Query.users {
  with context as ctx
  with output as o

  o <- ctx.userIds[] as userId {
    with app.fetchUser as user

    user.id <- userId
    .id <- userId
    .name <- user.name catch "missing"
  }
}`;

    let batchCalls = 0;

    const fetchUser: BatchToolFn<{ id: string }, { name: string }> = async (
      inputs,
    ) => {
      batchCalls++;
      return inputs.map((input) =>
        input.id === "u2"
          ? new Error("Not Found")
          : { name: `user:${input.id}` },
      ) as Array<{ name: string } | Error>;
    };

    fetchUser.bridge = {
      batch: true,
    } satisfies ToolMetadata;

    const result = await run(
      bridge,
      "Query.users",
      {},
      {
        app: { fetchUser },
      },
      {
        context: {
          userIds: ["u1", "u2", "u3"],
        },
      },
    );

    assert.equal(batchCalls, 1);
    assert.deepEqual(result.data, [
      { id: "u1", name: "user:u1" },
      { id: "u2", name: "missing" },
      { id: "u3", name: "user:u3" },
    ]);
  });
});
