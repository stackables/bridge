import assert from "node:assert/strict";
import { describe } from "node:test";
import type { BatchToolFn, ToolMetadata } from "../src/index.ts";
import { regressionTest, type LogEntry } from "./utils/regression.ts";

// ── Shared batch tool: echoes {name: "user:<id>"} ──────────────────────────

const fetchUser: BatchToolFn<{ id: string }, { name: string }> = async (
  inputs,
) => inputs.map((input) => ({ name: `user:${input.id}` }));

fetchUser.bridge = {
  batch: { maxBatchSize: 100, flush: "microtask" },
} satisfies ToolMetadata;

// ── Same tool with info-level execution logging ─────────────────────────────

const fetchUserLogged: BatchToolFn<{ id: string }, { name: string }> = async (
  inputs,
) => inputs.map((input) => ({ name: `user:${input.id}` }));

fetchUserLogged.bridge = {
  batch: true,
  log: { execution: "info" },
} satisfies ToolMetadata;

// ── Same tool but returns Error for id "u2" ─────────────────────────────────

const fetchUserPartial: BatchToolFn<{ id: string }, { name: string }> = async (
  inputs,
) =>
  inputs.map((input) =>
    input.id === "u2" ? new Error("Not Found") : { name: `user:${input.id}` },
  ) as Array<{ name: string } | Error>;

fetchUserPartial.bridge = { batch: true } satisfies ToolMetadata;

// ── Bridge source shared by all three tests ─────────────────────────────────

const bridgeSource = `
  version 1.5

  bridge Query.users {
    with context as ctx
    with output as o

    o <- ctx.userIds[] as userId {
      with app.fetchUser as user

      user.id <- userId
      .id <- userId
      .name <- user.name
    }
  }
`;

const bridgeSourceWithCatch = `
  version 1.5

  bridge Query.users {
    with context as ctx
    with output as o

    o <- ctx.userIds[] as userId {
      with app.fetchUser as user

      user.id <- userId
      .id <- userId
      .name <- user.name catch "missing"
    }
  }
`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe("native batched tools", () => {
  regressionTest(
    "tool metadata batches loop-scoped calls without userland loaders",
    {
      bridge: bridgeSource,
      tools: { app: { fetchUser } },
      scenarios: {
        "Query.users": {
          "batches all loop items into a single call": {
            input: {},
            context: { userIds: ["u1", "u2", "u3"] },
            assertData: [
              { id: "u1", name: "user:u1" },
              { id: "u2", name: "user:u2" },
              { id: "u3", name: "user:u3" },
            ],
            assertTraces: 1,
          },
          "empty array produces empty output": {
            input: {},
            context: { userIds: [] },
            assertData: [],
            assertTraces: 0,
          },
        },
      },
    },
  );

  regressionTest(
    "batched tools emit one trace and log entry per flushed batch call",
    {
      bridge: bridgeSource,
      tools: { app: { fetchUser: fetchUserLogged } },
      scenarios: {
        "Query.users": {
          "single trace with batched input/output": {
            input: {},
            context: { userIds: ["u1", "u2", "u3"] },
            assertData: [
              { id: "u1", name: "user:u1" },
              { id: "u2", name: "user:u2" },
              { id: "u3", name: "user:u3" },
            ],
            assertTraces: (traces) => {
              assert.equal(traces.length, 1);
              assert.equal(traces[0]!.tool, "app.fetchUser");
              assert.deepEqual(traces[0]!.input, [
                { id: "u1" },
                { id: "u2" },
                { id: "u3" },
              ]);
              assert.deepEqual(traces[0]!.output, [
                { name: "user:u1" },
                { name: "user:u2" },
                { name: "user:u3" },
              ]);
            },
            assertLogs: (logs: LogEntry[]) => {
              const infos = logs.filter((l) => l.level === "info");
              assert.ok(
                infos.length >= 1,
                `expected at least 1 info log, got ${infos.length}`,
              );
            },
          },
          "empty array produces empty output": {
            input: {},
            context: { userIds: [] },
            assertData: [],
            assertTraces: 0,
          },
        },
      },
    },
  );

  regressionTest(
    "partial batch failures route failed items through catch fallbacks",
    {
      bridge: bridgeSourceWithCatch,
      tools: { app: { fetchUser: fetchUserPartial } },
      scenarios: {
        "Query.users": {
          "error item falls back to catch value": {
            input: {},
            context: { userIds: ["u1", "u2", "u3"] },
            assertData: [
              { id: "u1", name: "user:u1" },
              { id: "u2", name: "missing" },
              { id: "u3", name: "user:u3" },
            ],
            assertTraces: 1,
          },
          "empty array produces empty output": {
            input: {},
            context: { userIds: [] },
            assertData: [],
            assertTraces: 0,
          },
        },
      },
    },
  );
});
