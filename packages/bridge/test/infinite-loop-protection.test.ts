import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  executeBridge,
  parseBridgeFormat as parseBridge,
  ExecutionTree,
  BridgePanicError,
  MAX_EXECUTION_DEPTH,
} from "../src/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
) {
  const raw = parseBridge(bridgeText);
  const document = JSON.parse(JSON.stringify(raw)) as ReturnType<
    typeof parseBridge
  >;
  return executeBridge({ document, operation, input, tools });
}

// ══════════════════════════════════════════════════════════════════════════════
// Depth ceiling — prevents infinite shadow tree nesting
// ══════════════════════════════════════════════════════════════════════════════

describe("depth ceiling", () => {
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
    // Normal array mapping should succeed
    assert.deepStrictEqual(result.data, [{ name: "a" }, { name: "b" }]);
  });

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

    // Chain shadow trees to MAX_EXECUTION_DEPTH — should succeed
    for (let i = 0; i < MAX_EXECUTION_DEPTH; i++) {
      tree = tree.shadow();
    }

    // One more shadow must throw
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
// Cycle detection — prevents circular dependency deadlocks
// ══════════════════════════════════════════════════════════════════════════════

describe("cycle detection", () => {
  test("circular A→B→A dependency throws BridgePanicError", async () => {
    // Tool A wires its input from tool B, and tool B wires from tool A
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
    const result = await run(bridgeText, "Query.chain", { value: "start" }, tools);
    assert.deepStrictEqual(result.data, { val: "startAB" });
  });
});
