import assert from "node:assert/strict";
import { describe, test } from "node:test";

// ══════════════════════════════════════════════════════════════════════════════
// Prototype pollution guards
//
// These tests verify that the runtime and compiler reject unsafe property
// names (__proto__, constructor, prototype) in wire assignments, source
// traversals, and tool lookups.
//
// Note: Bridges with unsafe property names have known serializer round-trip
// issues (the serializer traverses __proto__/constructor on wire paths),
// so these tests cannot be expressed as regressionTests.
// ══════════════════════════════════════════════════════════════════════════════

import { parseBridgeFormat as parseBridge } from "../../src/index.ts";
import { executeBridge as executeRuntime } from "@stackables/bridge-core";
import { executeBridge as executeCompiled } from "@stackables/bridge-compiler";

type ExecuteFn = typeof executeRuntime;
const engines: { name: string; execute: ExecuteFn }[] = [
  { name: "runtime", execute: executeRuntime as ExecuteFn },
  { name: "compiled", execute: executeCompiled as ExecuteFn },
];

function runBridge(
  execute: ExecuteFn,
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  toolsMap: Record<string, any> = {},
) {
  const raw = parseBridge(bridgeText);
  const document = JSON.parse(JSON.stringify(raw));
  return execute({ document, operation, input, tools: toolsMap } as any);
}

for (const { name, execute } of engines) {
  describe(`[${name}] prototype pollution`, () => {
    describe("setNested guard", () => {
      test("blocks __proto__ via bridge wire input path", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.__proto__ <- i.x
  o.result <- a.safe
}`,
              "Query.test",
              { x: "hacked" },
              { api: async () => ({ safe: "ok" }) },
            ),
          /Unsafe assignment key: __proto__/,
        );
      });

      test("blocks constructor via bridge wire input path", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.constructor <- i.x
  o.result <- a.safe
}`,
              "Query.test",
              { x: "hacked" },
              { api: async () => ({ safe: "ok" }) },
            ),
          /Unsafe assignment key: constructor/,
        );
      });

      test("blocks prototype via bridge wire input path", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.prototype <- i.x
  o.result <- a.safe
}`,
              "Query.test",
              { x: "hacked" },
              { api: async () => ({ safe: "ok" }) },
            ),
          /Unsafe assignment key: prototype/,
        );
      });
    });

    describe("pullSingle guard", () => {
      test("blocks __proto__ traversal on source ref", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.result <- a.__proto__
}`,
              "Query.test",
              {},
              { api: async () => ({ data: "ok" }) },
            ),
          /Unsafe property traversal: __proto__/,
        );
      });

      test("blocks constructor traversal on source ref", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.result <- a.constructor
}`,
              "Query.test",
              {},
              { api: async () => ({ data: "ok" }) },
            ),
          /Unsafe property traversal: constructor/,
        );
      });
    });

    describe("tool lookup guard", () => {
      test("blocks __proto__ in dotted tool name", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with foo.__proto__.bar as evil
  with output as o
  o.result <- evil.data
}`,
              "Query.test",
              {},
              { foo: { bar: async () => ({ data: "ok" }) } },
            ),
          /No tool found/,
        );
      });

      test("blocks constructor in dotted tool name", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with foo.constructor as evil
  with output as o
  o.result <- evil.data
}`,
              "Query.test",
              {},
              { foo: { safe: async () => ({ data: "ok" }) } },
            ),
          /No tool found/,
        );
      });

      test("blocks prototype in dotted tool name", async () => {
        await assert.rejects(
          () =>
            runBridge(
              execute,
              `version 1.5
bridge Query.test {
  with foo.prototype as evil
  with output as o
  o.result <- evil.data
}`,
              "Query.test",
              {},
              { foo: { safe: async () => ({ data: "ok" }) } },
            ),
          /No tool found/,
        );
      });
    });
  });
}
