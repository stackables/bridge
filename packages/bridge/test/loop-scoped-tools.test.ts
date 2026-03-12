import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Loop-scoped tools — declaring tools inside array loops
//
// Migrated from legacy/loop-scoped-tools.test.ts
// ═══════════════════════════════════════════════════════════════════════════

const httpTool = {
  std: {
    httpCall: async (params: { value: string }) => ({
      data: `tool:${params.value}`,
    }),
  },
};

regressionTest("loop scoped tools - valid behavior", {
  bridge: `
    version 1.5

    bridge Query.simple {
      with context as ctx
      with output as o

      o <- ctx.catalog[] as cat {
        with std.httpCall as http

        http.value <- cat.val
        .val <- http.data
      }
    }

    bridge Query.nested {
      with context as ctx
      with output as o

      o <- ctx.catalog[] as cat {
        with std.httpCall as http

        http.value <- cat.val
        .outer <- http.data
        .children <- cat.children[] as child {
          with std.httpCall as http

          http.value <- child.val
          .inner <- http.data
        }
      }
    }

    bridge Query.shadow {
      with context as ctx
      with output as o
      with std.httpCall as http

      http.value <- ctx.prefix
      o <- ctx.catalog[] as cat {
        with std.httpCall as http

        http.value <- cat.val
        .outer <- http.data
        .children <- cat.children[] as child {
          with std.httpCall as http

          http.value <- child.val
          .inner <- http.data
        }
      }
    }
  `,
  tools: httpTool,
  scenarios: {
    "Query.simple": {
      "tools can be declared and called inside array loops": {
        input: {},
        context: { catalog: [{ val: "a" }, { val: "b" }] },
        assertData: [{ val: "tool:a" }, { val: "tool:b" }],
        assertTraces: 2,
      },
      "empty catalog": {
        input: {},
        context: { catalog: [] },
        assertData: [],
        assertTraces: 0,
      },
    },
    "Query.nested": {
      "nested loops can introduce their own writable tool handles": {
        input: {},
        context: {
          catalog: [
            {
              val: "outer-a",
              children: [{ val: "inner-a1" }, { val: "inner-a2" }],
            },
          ],
        },
        assertData: [
          {
            outer: "tool:outer-a",
            children: [{ inner: "tool:inner-a1" }, { inner: "tool:inner-a2" }],
          },
        ],
        assertTraces: 3,
      },
    },
    "Query.shadow": {
      "inner loop-scoped tools shadow outer and bridge level handles": {
        input: {},
        context: {
          prefix: "bridge-level",
          catalog: [
            {
              val: "outer-a",
              children: [{ val: "inner-a1" }],
            },
          ],
        },
        assertData: [
          {
            outer: "tool:outer-a",
            children: [{ inner: "tool:inner-a1" }],
          },
        ],
        assertTraces: 3,
      },
    },
  },
});
