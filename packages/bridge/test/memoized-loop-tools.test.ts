import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Memoized loop-scoped tools — caching, isolation, dedup
//
// Migrated from legacy/memoized-loop-tools.test.ts
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("memoized loop-scoped tools - data correctness", {
  bridge: `
    version 1.5

    bridge Query.singleMemoize {
      with context as ctx
      with output as o

      o <- ctx.catalog[] as cat {
        with std.httpCall as fetchItem memoize

        fetchItem.value <- cat.id
        .item <- fetchItem.data
      }
    }

    bridge Query.dualMemoize {
      with context as ctx
      with output as o

      o <- ctx.catalog1[] as cat {
        with std.httpCall as outer memoize

        outer.value <- cat.id
        .outer <- outer.data
        .inner <- ctx.catalog2[] as item {
          with std.httpCall as fetchItem memoize

          fetchItem.value <- item.id
          .item <- fetchItem.data
        }
      }
    }

    bridge Query.shadowMemoize {
      with context as ctx
      with output as o

      o <- ctx.catalog1[] as cat {
        with std.httpCall as fetch memoize

        fetch.value <- cat.id
        .outer <- fetch.data
        .inner <- ctx.catalog2[] as item {
          with std.httpCall as fetch memoize

          fetch.value <- item.id
          .item <- fetch.data
        }
      }
    }
  `,
  tools: {
    std: {
      httpCall: async (params: { value: string }) => ({
        data: `item:${params.value}`,
      }),
    },
  },
  scenarios: {
    "Query.singleMemoize": {
      "memoized tool produces correct data for duplicated ids": {
        input: {},
        context: {
          catalog: [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "a" }],
        },
        assertData: [
          { item: "item:a" },
          { item: "item:a" },
          { item: "item:b" },
          { item: "item:a" },
        ],
        assertTraces: 2,
      },
      "empty catalog": {
        input: {},
        context: { catalog: [] },
        assertData: [],
        assertTraces: 0,
      },
    },
    "Query.dualMemoize": {
      "each memoized handle keeps its own cache": {
        input: {},
        context: {
          catalog1: [{ id: "same" }, { id: "same" }],
          catalog2: [{ id: "same" }, { id: "same" }],
        },
        assertData: [
          {
            outer: "item:same",
            inner: [{ item: "item:same" }, { item: "item:same" }],
          },
          {
            outer: "item:same",
            inner: [{ item: "item:same" }, { item: "item:same" }],
          },
        ],
        assertTraces: 2,
      },
    },
    "Query.shadowMemoize": {
      "shadowed memoize aliases maintain isolated caches": {
        input: {},
        context: {
          catalog1: [{ id: "collision" }],
          catalog2: [{ id: "collision" }],
        },
        assertData: [
          {
            outer: "item:collision",
            inner: [{ item: "item:collision" }],
          },
        ],
        assertTraces: 2,
      },
    },
  },
});
