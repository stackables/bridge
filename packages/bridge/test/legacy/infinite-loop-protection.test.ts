import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  ExecutionTree,
  BridgePanicError,
  MAX_EXECUTION_DEPTH,
} from "../../src/index.ts";
import { forEachEngine } from "../utils/dual-run.ts";

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
// Dual-engine tests
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("infinite loop protection", (run, _ctx) => {
  test("normal array mapping works within depth limit", async () => {
    const bridgeText = `version 1.5
bridge Query.items {
  with input as i
  with output as o

  o <- i.list[] as item {
    .name <- item.name
  }
}`;
    const result = await run(bridgeText, "Query.items", {
      list: [{ name: "a" }, { name: "b" }],
    });
    assert.deepStrictEqual(result.data, [{ name: "a" }, { name: "b" }]);
  });

  test("circular A→B→A dependency throws BridgePanicError", async () => {
    const bridgeText = `version 1.5
bridge Query.loop {
  with toolA as a
  with toolB as b
  with output as o
  a.x <- b.result
  b.x <- a.result
  o.val <- a.result
}`;
    const tools = {
      toolA: async (input: any) => ({ result: input.x }),
      toolB: async (input: any) => ({ result: input.x }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.loop", {}, tools),
      (err: any) => {
        assert.equal(err.name, "BridgePanicError");
        assert.match(err.message, /Circular dependency detected/);
        return true;
      },
    );
  });

  test("non-circular dependencies work normally", async () => {
    const bridgeText = `version 1.5
bridge Query.chain {
  with toolA as a
  with toolB as b
  with input as i
  with output as o
  a.x <- i.value
  b.x <- a.result
  o.val <- b.result
}`;
    const tools = {
      toolA: async (input: any) => ({ result: input.x + "A" }),
      toolB: async (input: any) => ({ result: input.x + "B" }),
    };
    const result = await run(
      bridgeText,
      "Query.chain",
      { value: "start" },
      tools,
    );
    assert.deepStrictEqual(result.data, { val: "startAB" });
  });
});
