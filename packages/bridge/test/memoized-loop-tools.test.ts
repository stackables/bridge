import { regressionTest } from "./utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Memoized loop-scoped tools — caching, isolation, dedup
//
// Migrated from legacy/memoized-loop-tools.test.ts, legacy/define-loop-tools.test.ts
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("memoized loop-scoped tools - data correctness", {
  bridge: bridge`
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
      "empty outer catalog": {
        input: {},
        context: { catalog1: [], catalog2: [{ id: "x" }] },
        assertData: [],
        assertTraces: 0,
      },
      "empty inner catalog": {
        input: {},
        context: { catalog1: [{ id: "x" }], catalog2: [] },
        assertData: [{ outer: "item:x", inner: [] }],
        assertTraces: 1,
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
      "empty outer catalog": {
        input: {},
        context: { catalog1: [], catalog2: [{ id: "x" }] },
        assertData: [],
        assertTraces: 0,
      },
      "empty inner catalog": {
        input: {},
        context: { catalog1: [{ id: "x" }], catalog2: [] },
        assertData: [{ outer: "item:x", inner: [] }],
        assertTraces: 1,
      },
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Define blocks with memoized tools inside loops
//
// Migrated from legacy/define-loop-tools.test.ts
// (parser error test moved to bridge-parser/test/bridge-format.test.ts)
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("define blocks with memoized tools in loops", {
  bridge: bridge`
    version 1.5

    define formatProfile {
      with input as i
      with output as o
      with std.httpCall as fetch memoize

      fetch.value <- i.userId
      o.data <- fetch.data
    }

    bridge Query.processCatalog {
      with context as ctx
      with output as o

      o <- ctx.catalog[] as cat {
        with formatProfile as profile

        profile.userId <- cat.id
        .item <- profile.data
      }
    }
  `,
  tools: {
    std: {
      httpCall: async (params: { value: string }) => ({
        data: `profile:${params.value}`,
      }),
    },
  },
  scenarios: {
    "Query.processCatalog": {
      "memoized tool inside define block deduplicates across loop elements": {
        input: {},
        context: {
          catalog: [{ id: "user-1" }, { id: "user-2" }, { id: "user-1" }],
        },
        assertData: [
          { item: "profile:user-1" },
          { item: "profile:user-2" },
          { item: "profile:user-1" },
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
  },
});
