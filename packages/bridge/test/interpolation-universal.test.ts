import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.ts";
import { executeBridge } from "../src/execute-bridge.ts";

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown> = {},
) {
  const raw = parseBridge(bridgeText);
  const instructions = JSON.parse(JSON.stringify(raw));
  return executeBridge({ instructions, operation, input });
}

describe("universal interpolation: fallback (||)", () => {
  test("template string in || fallback alternative", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.displayName <- i.email || "{i.name} ({i.email})"
}`;
    const { data } = await run(bridge, "Query.test", {
      name: "Alice",
      email: "alice@test.com",
    });
    assert.equal((data as any).displayName, "alice@test.com");
  });

  test("template string fallback triggers when primary is null", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.label <- i.nickname || "{i.first} {i.last}"
}`;
    const { data } = await run(bridge, "Query.test", {
      nickname: null,
      first: "Jane",
      last: "Doe",
    });
    assert.equal((data as any).label, "Jane Doe");
  });

  test("template string in || fallback inside array mapping", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as it {
    .label <- it.customLabel || "{it.name} (#{it.id})"
  }
}`;
    const { data } = await run(bridge, "Query.test", {
      items: [
        { id: "1", name: "Widget", customLabel: null },
        { id: "2", name: "Gadget", customLabel: "Custom" },
      ],
    });
    assert.deepEqual(data, [
      { label: "Widget (#1)" },
      { label: "Custom" },
    ]);
  });
});

describe("universal interpolation: ternary (? :)", () => {
  test("template string in ternary then-branch", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.greeting <- i.isVip ? "Welcome VIP {i.name}!" : "Hello {i.name}"
}`;
    const { data } = await run(bridge, "Query.test", {
      isVip: true,
      name: "Alice",
    });
    assert.equal((data as any).greeting, "Welcome VIP Alice!");
  });

  test("template string in ternary else-branch", async () => {
    const bridge = `version 1.4
bridge Query.test {
  with input as i
  with output as o

  o.greeting <- i.isVip ? "Welcome VIP {i.name}!" : "Hello {i.name}"
}`;
    const { data } = await run(bridge, "Query.test", {
      isVip: false,
      name: "Bob",
    });
    assert.equal((data as any).greeting, "Hello Bob");
  });
});
