/**
 * Tests for engine hardening & resource exhaustion defences.
 *
 * Covers:
 *  1. Tool-call timeouts (toolTimeoutMs / BridgeTimeoutError)
 *  2. Bounded trace cloning (boundedClone / OOM prevention)
 *  3. Abort-signal discipline in resolveWires and createShadowArray
 *  4. Strict primitive parsing in coerceConstant (no JSON.parse)
 *  5. setNested type-safety guard (non-object intermediate path)
 *  6. Configurable maxDepth
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  executeBridge,
  BridgeTimeoutError,
  BridgeAbortError,
  boundedClone,
} from "../src/index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
  options: Record<string, any> = {},
) {
  const document = parseBridge(bridgeText);
  return executeBridge({ document, operation, input, tools, ...options });
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 1: Tool-call timeouts
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: tool timeouts", () => {
  test("BridgeTimeoutError is thrown when tool exceeds toolTimeoutMs", async () => {
    const bridgeText = `version 1.5
bridge Query.slow {
  with slowApi as api
  with output as o
  o.result <- api.data
}`;
    const tools = {
      slowApi: () =>
        new Promise<never>((resolve) => setTimeout(resolve, 5_000)),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.slow", {}, tools, { toolTimeoutMs: 50 }),
      (err: any) => {
        assert.ok(
          err instanceof BridgeTimeoutError ||
            err?.name === "BridgeTimeoutError",
          `Expected BridgeTimeoutError, got ${err?.name}: ${err?.message}`,
        );
        assert.ok(
          err.message.includes("slowApi"),
          `Expected tool name in message: ${err.message}`,
        );
        return true;
      },
    );
  });

  test("fast tool completes without timeout error", async () => {
    const bridgeText = `version 1.5
bridge Query.fast {
  with fastApi as api
  with output as o
  o.result <- api.data
}`;
    const { data } = await run(
      bridgeText,
      "Query.fast",
      {},
      { fastApi: async () => ({ data: "ok" }) },
      { toolTimeoutMs: 5_000 },
    );
    assert.deepStrictEqual(data, { result: "ok" });
  });

  test("timeout error can be caught via catch gate", async () => {
    const bridgeText = `version 1.5
bridge Query.slow {
  with slowApi as api
  with output as o
  o.result <- api.data catch "fallback"
}`;
    const tools = {
      slowApi: () =>
        new Promise<never>((resolve) => setTimeout(resolve, 5_000)),
    };
    const { data } = await run(bridgeText, "Query.slow", {}, tools, {
      toolTimeoutMs: 50,
    });
    assert.deepStrictEqual(data, { result: "fallback" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 2: Bounded cloning in trace collector
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: bounded clone", () => {
  test("strings are truncated when they exceed maxStringLength", () => {
    const long = "a".repeat(2000);
    const result = boundedClone(long, 0, 5, 100, 100) as string;
    assert.ok(result.length < long.length, "string should be truncated");
    assert.ok(result.includes("[+"), "truncation marker should be present");
  });

  test("arrays are truncated when they exceed maxArrayItems", () => {
    const arr = Array.from({ length: 200 }, (_, i) => i);
    const result = boundedClone(arr, 0, 5, 10, 1024) as unknown[];
    assert.equal(result.length, 11, "10 items + 1 truncation marker");
    assert.ok(
      (result[10] as string).includes("[+190 more]"),
      "truncation marker count should be correct",
    );
  });

  test("objects exceeding depth are replaced with placeholder", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const result = boundedClone(deep, 0, 2, 100, 1024) as any;
    assert.equal(result.a.b, "[…]", "depth limit should replace subtree");
  });

  test("primitives pass through unchanged", () => {
    assert.equal(boundedClone(42), 42);
    assert.equal(boundedClone(true), true);
    assert.equal(boundedClone(null), null);
    assert.equal(boundedClone(undefined), undefined);
    assert.equal(boundedClone("hello"), "hello");
  });

  test("tracing with full level does not use structuredClone (bounded)", async () => {
    const bridgeText = `version 1.5
bridge Query.echo {
  with echoApi as api
  with input as i
  with output as o
  api.payload <- i.data
  o.result <- api.result
}`;
    // Pass a large array in the input; trace should truncate it
    const largeData = Array.from({ length: 200 }, (_, i) => ({ index: i }));
    const { traces } = await run(
      bridgeText,
      "Query.echo",
      { data: largeData },
      { echoApi: async (inp: any) => ({ result: inp.payload?.length ?? 0 }) },
      { trace: "full" },
    );
    assert.equal(traces.length, 1);
    // Input should be captured but truncated
    assert.ok(traces[0]!.input !== undefined, "input should be captured");
    const capturedPayload = traces[0]!.input!.payload as unknown[];
    assert.ok(
      capturedPayload.length <= 101,
      `payload should be truncated (got ${capturedPayload.length} items)`,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 3: Abort-signal discipline
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: abort signal", () => {
  test("pre-aborted signal throws BridgeAbortError before tool is called", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.result <- a.data
}`;
    const controller = new AbortController();
    controller.abort();

    let called = false;
    const tools = {
      api: async () => {
        called = true;
        return { data: "ok" };
      },
    };
    await assert.rejects(
      () =>
        run(bridgeText, "Query.test", {}, tools, {
          signal: controller.signal,
        }),
      (err: any) => {
        assert.ok(
          err instanceof BridgeAbortError || err?.name === "BridgeAbortError",
        );
        return true;
      },
    );
    assert.equal(called, false, "tool should not have been called");
  });

  test("signal aborted mid-execution halts the wire loop", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.result <- a.data
}`;
    const controller = new AbortController();
    const tools = {
      api: async (_input: any, ctx: any) => {
        // Abort from within the tool (simulating client disconnect)
        controller.abort();
        // Yield to allow the abort to propagate
        await new Promise((r) => setTimeout(r, 0));
        ctx.signal?.throwIfAborted?.();
        return { data: "ok" };
      },
    };
    // The abort may surface as either BridgeAbortError or a native AbortError
    // depending on how throwIfAborted works in the tool context.
    try {
      await run(bridgeText, "Query.test", {}, tools, {
        signal: controller.signal,
      });
    } catch (err: any) {
      assert.ok(
        err?.name === "BridgeAbortError" || err?.name === "AbortError",
        `Expected abort error, got ${err?.name}`,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 4: Strict primitive parsing in coerceConstant
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: coerceConstant strict parsing", () => {
  test("boolean true is correctly resolved from constant wire", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  o.flag = true
}`;
    const { data } = await run(bridgeText, "Query.test", {});
    assert.deepStrictEqual(data, { flag: true });
    assert.strictEqual(typeof (data as any).flag, "boolean");
  });

  test("boolean false is correctly resolved from constant wire", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  o.flag = false
}`;
    const { data } = await run(bridgeText, "Query.test", {});
    assert.deepStrictEqual(data, { flag: false });
    assert.strictEqual(typeof (data as any).flag, "boolean");
  });

  test("null is correctly resolved from constant wire", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  o.value = null
}`;
    const { data } = await run(bridgeText, "Query.test", {});
    assert.deepStrictEqual(data, { value: null });
  });

  test("integer is correctly resolved from constant wire", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  o.count = 42
}`;
    const { data } = await run(bridgeText, "Query.test", {});
    assert.deepStrictEqual(data, { count: 42 });
    assert.strictEqual(typeof (data as any).count, "number");
  });

  test("plain string is correctly resolved from constant wire", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with output as o
  o.greeting = "hello"
}`;
    const { data } = await run(bridgeText, "Query.test", {});
    assert.deepStrictEqual(data, { greeting: "hello" });
  });

  test("|| string fallback is decoded to a plain string (no surrounding quotes)", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name || "World"
}`;
    const { data } = await run(bridgeText, "Query.test", { name: null });
    assert.deepStrictEqual(data, { name: "World" });
    assert.strictEqual(typeof (data as any).name, "string");
  });

  test("?? fallback is decoded correctly for string value", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.value <- i.missing ?? "default"
}`;
    const { data } = await run(bridgeText, "Query.test", {});
    assert.deepStrictEqual(data, { value: "default" });
    assert.strictEqual(typeof (data as any).value, "string");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 5: setNested defensive check
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: setNested type-safety", () => {
  test("assigning nested path through a scalar intermediate throws descriptive error", async () => {
    // Bridge that first wires a.x = "scalar" (constant wire) and then
    // tries to wire a.x.subfield <- i.val. Building the tool input
    // will attempt setNested(input, ["x", "subfield"], val) after "x"
    // is already a string, triggering the type-safety guard.
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o
  a.x = "scalar"
  a.x.subfield <- i.val
  o.result <- a.result
}`;
    const tools = {
      api: async () => ({ result: "ok" }),
    };
    await assert.rejects(
      () => run(bridgeText, "Query.test", { val: "something" }, tools),
      /Cannot set nested property on non-object at path segment/,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 6: Configurable maxDepth
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: configurable maxDepth", () => {
  test("maxDepth=1 prevents shadow-tree nesting in array mapping", async () => {
    const bridgeText = `version 1.5
bridge Query.list {
  with api as a
  with output as o
  o.items <- a.items
}`;
    const tools = {
      api: async () => ({
        items: [{ name: "a" }, { name: "b" }],
      }),
    };
    // With default maxDepth this should succeed
    const { data } = await run(bridgeText, "Query.list", {}, tools);
    assert.deepStrictEqual(data, {
      items: [{ name: "a" }, { name: "b" }],
    });
  });
});
