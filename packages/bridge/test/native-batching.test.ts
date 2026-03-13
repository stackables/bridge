import assert from "node:assert/strict";
import { regressionTest, type LogEntry } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

regressionTest("native batching: loop-scoped calls", {
  bridge: bridge`
    version 1.5

    bridge Query.users {
      with context as ctx
      with output as o

      o <- ctx.userIds[] as userId {
        with test.batch.multitool as user

        user.id <- userId.id
        user.name <- userId.name

        .id <- userId.id
        .name <- user.name
      }
    }
  `,
  tools,
  scenarios: {
    "Query.users": {
      "batches all loop items into a single call": {
        input: {},
        context: {
          userIds: [
            { id: "u1", name: "user:u1" },
            { id: "u2", name: "user:u2" },
            { id: "u3", name: "user:u3" },
          ],
        },
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
});

regressionTest("native batching: traces and logs", {
  bridge: bridge`
    version 1.5

    bridge Query.users {
      with context as ctx
      with output as o

      o <- ctx.userIds[] as userId {
        with test.batch.multitool as user

        user.id <- userId.id
        user.name <- userId.name

        .id <- userId.id
        .name <- user.name
      }
    }
  `,
  tools,
  scenarios: {
    "Query.users": {
      "single trace with batched input/output": {
        input: {},
        context: {
          userIds: [
            { id: "u1", name: "user:u1" },
            { id: "u2", name: "user:u2" },
            { id: "u3", name: "user:u3" },
          ],
        },
        assertData: [
          { id: "u1", name: "user:u1" },
          { id: "u2", name: "user:u2" },
          { id: "u3", name: "user:u3" },
        ],
        assertTraces: (traces) => {
          assert.equal(traces.length, 1);
          assert.equal(traces[0]!.tool, "test.batch.multitool");
          assert.deepEqual(traces[0]!.input, [
            { id: "u1", name: "user:u1" },
            { id: "u2", name: "user:u2" },
            { id: "u3", name: "user:u3" },
          ]);
          assert.deepEqual(traces[0]!.output, [
            { id: "u1", name: "user:u1" },
            { id: "u2", name: "user:u2" },
            { id: "u3", name: "user:u3" },
          ]);
        },
        assertLogs: (logs: LogEntry[]) => {
          const infos = logs.filter((entry) => entry.level === "info");
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
});

regressionTest("native batching: partial failures with catch", {
  bridge: bridge`
    version 1.5

    bridge Query.users {
      with context as ctx
      with output as o

      o <- ctx.userIds[] as userId {
        with test.batch.multitool as user

        user.id <- userId.id
        user.name <- userId.name
        user._error <- userId._error

        .id <- userId.id
        .name <- user.name catch "missing"
      }
    }
  `,
  tools,
  scenarios: {
    "Query.users": {
      "error item falls back to catch value": {
        input: {},
        context: {
          userIds: [
            { id: "u1", name: "user:u1" },
            { id: "u2", name: "user:u2", _error: "Not Found" },
            { id: "u3", name: "user:u3" },
          ],
        },
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
});
