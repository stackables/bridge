import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

// ══════════════════════════════════════════════════════════════════════════════
// Circular dependency detection
// ══════════════════════════════════════════════════════════════════════════════

regressionTest("circular dependency detection", {
  bridge: bridge`
    version 1.5
    bridge Query.loop {
      with test.multitool as a
      with test.multitool as b
      with output as o

      a <- b
      b <- a
      o.val <- a.result
    }
  `,
  tools: tools,
  scenarios: {
    "Query.loop": {
      "circular A→B→A dependency throws BridgePanicError": {
        input: {},
        assertError: (err: any) => {
          assert.equal(err.name, "BridgePanicError");
          assert.match(err.message, /Circular dependency detected/);
        },
        assertTraces: 0,
      },
    },
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// Regression tests (data-driven)
// ══════════════════════════════════════════════════════════════════════════════

regressionTest("infinite loop protection: array mapping", {
  bridge: bridge`
    version 1.5

    bridge ArrayMap.basic {
      with input as i
      with output as o

      o <- i.list[] as item {
        .name <- item.name
      }
    }
  `,
  scenarios: {
    "ArrayMap.basic": {
      "normal array mapping works within depth limit": {
        input: { list: [{ name: "a" }, { name: "b" }] },
        assertData: [{ name: "a" }, { name: "b" }],
        assertTraces: 0,
      },
      "empty array produces empty output": {
        input: { list: [] },
        assertData: [],
        assertTraces: 0,
      },
    },
  },
});

regressionTest("infinite loop protection: non-circular chain", {
  bridge: bridge`
    version 1.5

    bridge Chain.normal {
      with test.multitool as a
      with test.multitool as b
      with input as i
      with output as o

      a.x <- i.value
      b.x <- a.x
      o.val <- b.x
    }
  `,
  tools: tools,
  scenarios: {
    "Chain.normal": {
      "non-circular dependencies work normally": {
        input: { value: "start" },
        assertData: { val: "start" },
        assertTraces: 2,
      },
    },
  },
});
