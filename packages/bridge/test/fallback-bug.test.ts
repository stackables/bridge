import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { executeBridge } from "../src/index.ts";
import type { Instruction } from "../src/index.ts";

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown> = {},
) {
  const raw = parseBridge(bridgeText);
  const instructions = JSON.parse(JSON.stringify(raw)) as Instruction[];
  return executeBridge({ instructions, operation, input });
}

describe("string interpolation || fallback priority", () => {
  test("template string with || fallback (flat wire)", async () => {
    const bridge = [
      "version 1.5",
      "",
      "bridge Query.test {",
      "  with input as i",
      "  with output as o",
      "",
      '  o.displayName <- "{i.name} ({i.email})" || i.name',
      "}",
    ].join("\n");
    const result = await run(bridge, "Query.test", {
      name: "Alice",
      email: "alice@test.com",
    });
    assert.equal((result.data as any).displayName, "Alice (alice@test.com)");
  });

  test("template string with || fallback inside path scope block", async () => {
    const bridge = [
      "version 1.5",
      "",
      "bridge Query.test {",
      "  with input as i",
      "  with output as o",
      "",
      "  o {",
      '    .displayName <- "{i.name} ({i.email})" || i.name',
      "  }",
      "}",
    ].join("\n");
    const result = await run(bridge, "Query.test", {
      name: "Alice",
      email: "alice@test.com",
    });
    assert.equal((result.data as any).displayName, "Alice (alice@test.com)");
  });

  test("template string with multiple || fallbacks in scope + alias", async () => {
    const bridge = [
      "version 1.5",
      "",
      "bridge Query.test {",
      "  with std.str.toUpperCase as uc",
      "  with input as i",
      "  with output as o",
      "",
      "  o {",
      "    alias uc:i.name as upnam",
      '    .displayName <- "{i.name} ({i.email})" || upnam || "test"',
      "  }",
      "}",
    ].join("\n");
    const result = await run(bridge, "Query.test", {
      name: "Alice",
      email: "alice@test.com",
    });
    assert.equal((result.data as any).displayName, "Alice (alice@test.com)");
  });
});
