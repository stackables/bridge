import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Strict scope rules — tool input wiring restrictions & scope shadowing
//
// Migrated from legacy/strict-scope-rules.test.ts
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("strict scope rules - valid behavior", {
  bridge: `
    version 1.5

    bridge Query.nestedPull {
      with std.httpCall as fetch
      with input as i
      with output as o

      fetch.id <- i.requestId
      o.items <- i.list[] as item {
        .id <- item.id
        .result <- fetch.data
        .sub <- item.list[] as p {
          .more <- item.id
          .value <- p.value
          .result <- fetch.data
        }
      }
    }

    bridge Query.shadow {
      with std.httpCall as whatever
      with input as i
      with output as o

      whatever.id <- i.requestId
      o.toolResult <- whatever.data
      o.items <- i.list[] as whatever {
        .id <- whatever.id
        .data <- whatever.data
        .sub <- whatever.list[] as whatever {
          .id <- whatever.id
          .data <- whatever.data
        }
      }
    }

    bridge Query.nearestScope {
      with std.httpCall as whatever
      with input as i
      with output as o

      whatever.id <- i.requestId
      o.toolResult <- whatever.data
      o.items <- i.list[] as whatever {
        .value <- whatever.id
        .sub <- whatever.list[] as whatever {
          .value <- whatever.id
          .result <- whatever.data
        }
      }
    }
  `,
  tools: {
    "std.httpCall": async (params: { id: string }) => ({
      data: `fetch:${params.id}`,
    }),
  },
  scenarios: {
    "Query.nestedPull": {
      "nested scopes can pull data from visible parent scopes": {
        input: {
          requestId: "req-1",
          list: [
            {
              id: "outer-a",
              list: [{ value: "a-1" }, { value: "a-2" }],
            },
            {
              id: "outer-b",
              list: [{ value: "b-1" }],
            },
          ],
        },
        assertData: {
          items: [
            {
              id: "outer-a",
              result: "fetch:req-1",
              sub: [
                { more: "outer-a", value: "a-1", result: "fetch:req-1" },
                { more: "outer-a", value: "a-2", result: "fetch:req-1" },
              ],
            },
            {
              id: "outer-b",
              result: "fetch:req-1",
              sub: [{ more: "outer-b", value: "b-1", result: "fetch:req-1" }],
            },
          ],
        },
        assertTraces: 1,
      },
      "empty outer list": {
        input: { requestId: "req-1", list: [] },
        assertData: { items: [] },
        // runtime: 0 (pull-based, tool output never consumed); compiled: 1 (eagerly calls bridge-level tools)
        assertTraces: (traces) => assert.ok(traces.length <= 1),
      },
      "empty inner list": {
        input: {
          requestId: "req-1",
          list: [{ id: "a", list: [] }],
        },
        assertData: {
          items: [{ id: "a", result: "fetch:req-1", sub: [] }],
        },
        assertTraces: 1,
      },
    },
    "Query.shadow": {
      "inner scopes shadow outer tool names during execution": {
        input: {
          requestId: "tool-value",
          list: [
            {
              id: "item-a",
              data: "item-a-data",
              list: [{ id: "sub-a1", data: "sub-a1-data" }],
            },
          ],
        },
        assertData: {
          toolResult: "fetch:tool-value",
          items: [
            {
              id: "item-a",
              data: "item-a-data",
              sub: [{ id: "sub-a1", data: "sub-a1-data" }],
            },
          ],
        },
        assertTraces: 1,
      },
      "empty outer list": {
        input: { requestId: "x", list: [] },
        assertData: { toolResult: "fetch:x", items: [] },
        assertTraces: 1,
      },
      "empty inner list": {
        input: {
          requestId: "x",
          list: [{ id: "a", data: "a-data", list: [] }],
        },
        assertData: {
          toolResult: "fetch:x",
          items: [{ id: "a", data: "a-data", sub: [] }],
        },
        assertTraces: 1,
      },
    },
    "Query.nearestScope": {
      "nearest scope binding wins when names overlap repeatedly": {
        input: {
          requestId: "tool-value",
          list: [
            {
              id: "outer-a",
              list: [
                { id: "inner-a1", data: "inner-a1-data" },
                { id: "inner-a2", data: "inner-a2-data" },
              ],
            },
          ],
        },
        assertData: {
          toolResult: "fetch:tool-value",
          items: [
            {
              value: "outer-a",
              sub: [
                { value: "inner-a1", result: "inner-a1-data" },
                { value: "inner-a2", result: "inner-a2-data" },
              ],
            },
          ],
        },
        assertTraces: 1,
      },
      "empty outer list": {
        input: { requestId: "x", list: [] },
        assertData: { toolResult: "fetch:x", items: [] },
        assertTraces: 1,
      },
      "empty inner list": {
        input: {
          requestId: "x",
          list: [{ id: "a", list: [] }],
        },
        assertData: {
          toolResult: "fetch:x",
          items: [{ value: "a", sub: [] }],
        },
        assertTraces: 1,
      },
    },
  },
});
