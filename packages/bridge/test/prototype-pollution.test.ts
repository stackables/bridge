import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { executeBridge } from "../src/index.ts";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";

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
// Prototype pollution guards
// ══════════════════════════════════════════════════════════════════════════════

describe("prototype pollution: setNested guard", () => {
  test("blocks __proto__ via bridge wire input path", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.__proto__ <- i.x
  o.result <- a.safe
}`;
    const tools = {
      api: async () => ({ safe: "ok" }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", { x: "hacked" }, tools),
      /Unsafe assignment key: __proto__/,
    );
  });

  test("blocks constructor via bridge wire input path", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.constructor <- i.x
  o.result <- a.safe
}`;
    const tools = {
      api: async () => ({ safe: "ok" }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", { x: "hacked" }, tools),
      /Unsafe assignment key: constructor/,
    );
  });

  test("blocks prototype via bridge wire input path", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.prototype <- i.x
  o.result <- a.safe
}`;
    const tools = {
      api: async () => ({ safe: "ok" }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", { x: "hacked" }, tools),
      /Unsafe assignment key: prototype/,
    );
  });
});

describe("unsafe property traversal: pullSingle guard", () => {
  test("blocks __proto__ traversal on source ref", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.result <- a.__proto__
}`;
    const tools = {
      api: async () => ({ data: "ok" }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", {}, tools),
      /Unsafe property traversal: __proto__/,
    );
  });

  test("blocks constructor traversal on source ref", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.result <- a.constructor
}`;
    const tools = {
      api: async () => ({ data: "ok" }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", {}, tools),
      /Unsafe property traversal: constructor/,
    );
  });
});

describe("unsafe tool lookup guard", () => {
  test("lookupToolFn blocks __proto__ in dotted tool name", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with foo.__proto__.bar as evil
  with output as o
  o.result <- evil.data
}`;
    const tools = {
      foo: { bar: async () => ({ data: "ok" }) },
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", {}, tools),
      /No tool found/,
    );
  });

  test("lookupToolFn blocks constructor in dotted tool name", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with foo.constructor as evil
  with output as o
  o.result <- evil.data
}`;
    const tools = {
      foo: { safe: async () => ({ data: "ok" }) },
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", {}, tools),
      /No tool found/,
    );
  });

  test("lookupToolFn blocks prototype in dotted tool name", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with foo.prototype as evil
  with output as o
  o.result <- evil.data
}`;
    const tools = {
      foo: { safe: async () => ({ data: "ok" }) },
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", {}, tools),
      /No tool found/,
    );
  });
});
