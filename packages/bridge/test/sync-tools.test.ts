import type { ToolMetadata } from "@stackables/bridge-types";
import { regressionTest } from "./utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Sync tool flag — enforcement, optimisation, array maps
//
// Migrated from legacy/sync-tools.test.ts
// ═══════════════════════════════════════════════════════════════════════════

// ── Tool helpers ────────────────────────────────────────────────────────────

function doubler(input: { value: number }) {
  return { result: input.value * 2 };
}
doubler.bridge = { sync: true } satisfies ToolMetadata;

function upper(input: { in: string }) {
  return input.in.toUpperCase();
}
upper.bridge = { sync: true } satisfies ToolMetadata;

function badSync(_input: { q: string }) {
  return Promise.resolve({ answer: "!" });
}
badSync.bridge = { sync: true } satisfies ToolMetadata;

async function asyncTool(input: { q: string }) {
  return { answer: input.q + "!" };
}

// ── 1. Enforcement ──────────────────────────────────────────────────────────

regressionTest("sync tool enforcement", {
  bridge: bridge`
    version 1.5
    bridge Query.bad {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      o.answer <- a.answer
    }
  `,
  tools: { api: badSync },
  scenarios: {
    "Query.bad": {
      "throws when sync tool returns a Promise": {
        input: { q: "hello" },
        assertError: /sync.*Promise|Promise.*sync/i,
        assertTraces: (_traces) => {
          // Tool was called but it returned a Promise which is invalid
        },
      },
    },
  },
});

// ── 2. Sync tool execution ──────────────────────────────────────────────────

regressionTest("sync tool execution", {
  bridge: bridge`
    version 1.5

    bridge Query.double {
      with doubler as d
      with input as i
      with output as o

      d.value <- i.n
      o.result <- d.result
    }

    bridge Query.mixed {
      with asyncApi as api
      with doubler as d
      with input as i
      with output as o

      api.q <- i.q
      d.value <- i.n
      o.answer <- api.answer
      o.doubled <- d.result
    }

    bridge Query.chain {
      with upper as u
      with doubler as d
      with input as i
      with output as o

      u.in <- i.name
      d.value <- i.n
      o.name <- u
      o.doubled <- d.result
    }

    bridge Query.normal {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      o.answer <- a.answer
    }
  `,
  tools: { doubler, upper, asyncApi: asyncTool, api: asyncTool },
  scenarios: {
    "Query.double": {
      "sync tool produces correct result": {
        input: { n: 21 },
        assertData: { result: 42 },
        assertTraces: 1,
      },
    },
    "Query.mixed": {
      "sync tool used alongside async tool": {
        input: { q: "hi", n: 5 },
        assertData: { answer: "hi!", doubled: 10 },
        assertTraces: 2,
      },
    },
    "Query.chain": {
      "multiple sync tools in a chain": {
        input: { name: "alice", n: 7 },
        assertData: { name: "ALICE", doubled: 14 },
        assertTraces: 2,
      },
    },
    "Query.normal": {
      "async tool without sync flag works correctly": {
        input: { q: "world" },
        assertData: { answer: "world!" },
        assertTraces: 1,
      },
    },
  },
});

// ── 3. Array map with sync tools ────────────────────────────────────────────

const syncSource = () => ({
  items: [
    { name: "widget", count: 3 },
    { name: "gadget", count: 7 },
  ],
});
(syncSource as any).bridge = { sync: true } satisfies ToolMetadata;

const syncApi = () => ({
  name: "Catalog A",
  items: [
    { item_id: "x1", price: 5 },
    { item_id: "x2", price: 15 },
  ],
});
(syncApi as any).bridge = { sync: true } satisfies ToolMetadata;

const syncDoub = (input: { in: number }) => input.in * 2;
(syncDoub as any).bridge = { sync: true } satisfies ToolMetadata;

const syncEnrichSource = () => ({
  items: [{ item_id: 1 }, { item_id: 2 }, { item_id: 3 }],
});
(syncEnrichSource as any).bridge = { sync: true } satisfies ToolMetadata;

const syncEnrich = (input: any) => ({
  name: `enriched-${input.in.item_id}`,
});
(syncEnrich as any).bridge = { sync: true } satisfies ToolMetadata;

regressionTest("sync array map", {
  bridge: bridge`
    version 1.5

    bridge Query.items {
      with source as src
      with upper as u
      with output as o

      o <- src.items[] as item {
        .label <- u:item.name
        .qty <- item.count
      }
    }

    bridge Query.catalog {
      with api as src
      with doubler as d
      with output as o

      o.title <- src.name
      o.entries <- src.items[] as it {
        .id <- it.item_id
        .doubled <- d:it.price
      }
    }

    bridge Query.enriched {
      with api as src
      with enrich
      with output as o

      o <- src.items[] as it {
        alias e <- enrich:it
        .id <- it.item_id
        .label <- e.name
      }
    }
  `,
  tools: {
    source: syncSource,
    upper,
    api: syncApi,
    doubler: syncDoub,
    enrich: syncEnrich,
  },
  scenarios: {
    "Query.items": {
      "array map with sync pipe tool per element": {
        input: {},
        tools: { source: syncSource, upper },
        assertData: [
          { label: "WIDGET", qty: 3 },
          { label: "GADGET", qty: 7 },
        ],
        assertTraces: 3,
      },
      "empty array source": {
        input: {},
        tools: {
          source: Object.assign(() => ({ items: [] }), {
            bridge: { sync: true },
          }),
          upper,
        },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.catalog": {
      "sub-field array map with sync pipe tool": {
        input: {},
        tools: { api: syncApi, doubler: syncDoub },
        assertData: {
          title: "Catalog A",
          entries: [
            { id: "x1", doubled: 10 },
            { id: "x2", doubled: 30 },
          ],
        },
        assertTraces: 3,
      },
      "empty entries": {
        input: {},
        tools: {
          api: Object.assign(() => ({ name: "Empty", items: [] }), {
            bridge: { sync: true },
          }),
          doubler: syncDoub,
        },
        assertData: { title: "Empty", entries: [] },
        assertTraces: 1,
      },
    },
    "Query.enriched": {
      "array map with alias and sync per-element tool": {
        input: {},
        tools: { api: syncEnrichSource, enrich: syncEnrich },
        assertData: [
          { id: 1, label: "enriched-1" },
          { id: 2, label: "enriched-2" },
          { id: 3, label: "enriched-3" },
        ],
        assertTraces: 4,
      },
      "empty items": {
        input: {},
        tools: {
          api: Object.assign(() => ({ items: [] }), {
            bridge: { sync: true },
          }),
          enrich: syncEnrich,
        },
        assertData: [],
        assertTraces: 1,
      },
    },
  },
});
