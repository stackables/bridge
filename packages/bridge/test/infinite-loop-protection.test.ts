import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  ExecutionTree,
  BridgePanicError,
  MAX_EXECUTION_DEPTH,
} from "../src/index.ts";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { forEachEngine } from "./utils/dual-run.ts";

// ══════════════════════════════════════════════════════════════════════════════
// Runtime-only: ExecutionTree depth ceiling
// ══════════════════════════════════════════════════════════════════════════════

describe("depth ceiling", () => {
  test("shadow() beyond MAX_EXECUTION_DEPTH throws BridgePanicError", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.x <- i.x
}`);
    const document = JSON.parse(JSON.stringify(doc));
    const trunk = { module: "__self__", type: "Query", field: "test" };
    let tree = new ExecutionTree(trunk, document);

    for (let i = 0; i < MAX_EXECUTION_DEPTH; i++) {
      tree = tree.shadow();
    }

    assert.throws(
      () => tree.shadow(),
      (err: any) => {
        assert.ok(err instanceof BridgePanicError);
        assert.match(err.message, /Maximum execution depth exceeded/);
        return true;
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Circular dependency detection — cannot use regressionTest (error + no output)
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("circular dependency detection", (run) => {
  test("circular A→B→A dependency throws BridgePanicError", async () => {
    const bridgeText = `version 1.5
bridge Query.loop {
  with test.multitool as a
  with test.multitool as b
  with output as o

  a <- b
  b <- a
  o.val <- a.result
}`;
    await assert.rejects(
      () => run(bridgeText, "Query.loop", {}, tools),
      (err: any) => {
        assert.equal(err.name, "BridgePanicError");
        assert.match(err.message, /Circular dependency detected/);
        return true;
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Regression tests (data-driven)
// ══════════════════════════════════════════════════════════════════════════════

regressionTest("infinite loop protection: array mapping", {
  bridge: `
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
  bridge: `
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
