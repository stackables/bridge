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
// Dual-engine tests via regressionTest
// ══════════════════════════════════════════════════════════════════════════════

regressionTest("infinite loop protection", {
  bridge: `
    version 1.5

    bridge LoopProtect.items {
      with input as i
      with output as o

      o <- i.list[] as item {
        .name <- item.name
      }
    }

    bridge LoopProtect.loop {
      with test.multitool as a
      with test.multitool as b
      with output as o

      a <- b
      b <- a
      o.val <- a.result
    }

    bridge LoopProtect.chain {
      with test.multitool as a
      with test.multitool as b
      with input as i
      with output as o

      a <- i.a
      b <- a
      o.val <- b.result
    }
  `,
  tools: tools,
  scenarios: {
    "LoopProtect.items": {
      "normal array mapping works within depth limit": {
        input: { list: [{ name: "a" }, { name: "b" }] },
        assertData: [{ name: "a" }, { name: "b" }],
        assertTraces: 0,
      },
    },
    "LoopProtect.loop": {
      "circular A→B→A dependency throws BridgePanicError": {
        input: {},
        assertError: /Circular dependency detected/,
        assertTraces: 0,
      },
    },
    "LoopProtect.chain": {
      "non-circular dependencies work normally": {
        input: { a: { result: "startA" } },
        allowDowngrade: true,
        assertData: { val: "startA" },
        assertTraces: 2,
      },
    },
  },
});
