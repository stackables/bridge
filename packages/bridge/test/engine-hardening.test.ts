import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { executeBridge } from "../src/index.ts";
import {
  BridgeTimeoutError,
  BridgeAbortError,
  boundedClone,
  TraceCollector,
  coerceConstant,
  setNested,
} from "../src/index.ts";

// ══════════════════════════════════════════════════════════════════════════════
// Step 1: Tool timeout
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: tool timeout", () => {
  const bridgeText = `version 1.5
bridge Query.test {
  with slow as s
  with input as i
  with output as o

  s.q <- i.q
  o.result <- s.data
}`;

  test("tool that resolves within timeout succeeds", async () => {
    const tools = {
      slow: async () => ({ data: "ok" }),
    };
    const doc = parseBridge(bridgeText);
    const { data } = await executeBridge({
      document: doc,
      operation: "Query.test",
      input: { q: "x" },
      tools,
      toolTimeoutMs: 5000,
    });
    assert.deepStrictEqual(data, { result: "ok" });
  });

  test("tool that hangs throws BridgeTimeoutError", async () => {
    const tools = {
      slow: () =>
        new Promise(() => {
          /* never resolves */
        }),
    };
    const doc = parseBridge(bridgeText);
    await assert.rejects(
      () =>
        executeBridge({
          document: doc,
          operation: "Query.test",
          input: { q: "x" },
          tools,
          toolTimeoutMs: 50, // 50ms timeout
        }),
      (err: any) => {
        assert.ok(err instanceof BridgeTimeoutError);
        assert.ok(err.message.includes("slow"));
        assert.ok(err.message.includes("50ms"));
        return true;
      },
    );
  });

  test("timeout disabled when toolTimeoutMs is 0", async () => {
    const tools = {
      slow: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { data: "ok" };
      },
    };
    const doc = parseBridge(bridgeText);
    const { data } = await executeBridge({
      document: doc,
      operation: "Query.test",
      input: { q: "x" },
      tools,
      toolTimeoutMs: 0,
    });
    assert.deepStrictEqual(data, { result: "ok" });
  });

  test("BridgeTimeoutError is catchable by error boundaries", async () => {
    const bridgeTextCatch = `version 1.5
bridge Query.test {
  with slow as s
  with input as i
  with output as o

  s.q <- i.q
  o.result <- s.data catch "fallback"
}`;
    const tools = {
      slow: () => new Promise(() => {}),
    };
    const doc = parseBridge(bridgeTextCatch);
    const { data } = await executeBridge({
      document: doc,
      operation: "Query.test",
      input: { q: "x" },
      tools,
      toolTimeoutMs: 50,
    });
    assert.deepStrictEqual(data, { result: "fallback" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 2: Bounded clone for traces
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: bounded clone", () => {
  test("truncates long strings", () => {
    const longStr = "x".repeat(2000);
    const result = boundedClone(longStr, 100, 1024, 5) as string;
    assert.ok(result.length < 2000);
    assert.ok(result.includes("2000 chars"));
  });

  test("truncates large arrays", () => {
    const bigArray = Array.from({ length: 200 }, (_, i) => i);
    const result = boundedClone(bigArray, 10, 1024, 5) as any[];
    assert.equal(result.length, 11); // 10 items + truncation marker
    assert.ok((result[10] as string).includes("200 items"));
  });

  test("limits depth", () => {
    const deep = { a: { b: { c: "ok" } } };
    const result = boundedClone(deep, 100, 1024, 2) as any;
    assert.equal(result.a.b, "[depth limit]");
  });

  test("passes through primitives", () => {
    assert.equal(boundedClone(42), 42);
    assert.equal(boundedClone(true), true);
    assert.equal(boundedClone(null), null);
    assert.equal(boundedClone(undefined), undefined);
  });

  test("TraceCollector entry uses bounded clone for full level", () => {
    const tracer = new TraceCollector("full", {
      maxArrayItems: 5,
      maxStringLength: 10,
      cloneDepth: 2,
    });
    const entry = tracer.entry({
      tool: "test",
      fn: "fn",
      startedAt: 0,
      durationMs: 1,
      input: { data: "x".repeat(100) },
    });
    assert.ok(entry.input);
    assert.ok((entry.input!.data as string).length < 100);
  });

  test("handles NaN/negative parameters gracefully", () => {
    // Should not throw RangeError — parameters are clamped internally
    const result = boundedClone([1, 2, 3], NaN, NaN, NaN) as any[];
    assert.ok(Array.isArray(result));
    // Negative depth clamps to 0, so arrays hit the depth limit immediately
    const result2 = boundedClone([1, 2, 3], -1, -1, -1);
    assert.equal(result2, "[depth limit]");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 3: Abort discipline
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: abort discipline", () => {
  test("aborting mid-execution halts subsequent tool calls", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with first as f
  with second as s
  with input as i
  with output as o

  f.q <- i.q
  s.q <- f.result
  o.result <- s.data
}`;
    const ac = new AbortController();
    let secondCalled = false;
    const tools = {
      first: async () => {
        ac.abort();
        await new Promise((r) => setTimeout(r, 5));
        return { result: "step1" };
      },
      second: async () => {
        secondCalled = true;
        return { data: "step2" };
      },
    };
    const doc = parseBridge(bridgeText);
    await assert.rejects(
      () =>
        executeBridge({
          document: doc,
          operation: "Query.test",
          input: { q: "x" },
          tools,
          signal: ac.signal,
        }),
      (err: any) => {
        assert.ok(
          err instanceof BridgeAbortError ||
            err.name === "BridgeAbortError" ||
            err.name === "AbortError",
        );
        return true;
      },
    );
    assert.equal(secondCalled, false, "second tool should not have been called");
  });

  test("pre-aborted signal throws immediately", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with api as a
  with input as i
  with output as o

  a.q <- i.q
  o.result <- a.data
}`;
    const ac = new AbortController();
    ac.abort(); // pre-abort
    const tools = {
      api: async () => ({ data: "should not run" }),
    };
    const doc = parseBridge(bridgeText);
    await assert.rejects(
      () =>
        executeBridge({
          document: doc,
          operation: "Query.test",
          input: { q: "x" },
          tools,
          signal: ac.signal,
        }),
      /abort/i,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 4: Strict coerceConstant (no JSON.parse)
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: strict coerceConstant", () => {
  test("coerces true", () => {
    assert.strictEqual(coerceConstant("true"), true);
  });

  test("coerces false", () => {
    assert.strictEqual(coerceConstant("false"), false);
  });

  test("coerces null", () => {
    assert.strictEqual(coerceConstant("null"), null);
  });

  test("coerces integers", () => {
    assert.strictEqual(coerceConstant("42"), 42);
    assert.strictEqual(coerceConstant("-7"), -7);
    assert.strictEqual(coerceConstant("0"), 0);
  });

  test("coerces floats", () => {
    assert.strictEqual(coerceConstant("3.14"), 3.14);
  });

  test("returns plain strings as-is", () => {
    assert.strictEqual(coerceConstant("hello"), "hello");
    assert.strictEqual(coerceConstant("/search"), "/search");
  });

  test("JSON-encoded strings are decoded", () => {
    assert.strictEqual(coerceConstant('"hello"'), "hello");
    assert.strictEqual(coerceConstant('"with \\"quotes\\""'), 'with "quotes"');
  });

  test("trailing backslash in JSON string is preserved", () => {
    // '"trailing\' — backslash as last char before closing quote
    assert.strictEqual(coerceConstant('"trailing\\\\"'), "trailing\\");
  });

  test("invalid unicode escape is preserved as literal", () => {
    // '"\uZZZZ"' — not valid hex digits
    assert.strictEqual(coerceConstant('"\\uZZZZ"'), "\\uZZZZ");
  });

  test("JSON objects are returned as raw string (no parse)", () => {
    const raw = '{"key":"value"}';
    const result = coerceConstant(raw);
    assert.strictEqual(result, raw);
  });

  test("JSON arrays are returned as raw string (no parse)", () => {
    const raw = "[1,2,3]";
    const result = coerceConstant(raw);
    assert.strictEqual(result, raw);
  });

  test("empty string stays as empty string", () => {
    assert.strictEqual(coerceConstant(""), "");
  });

  test("non-string input is returned as-is", () => {
    assert.strictEqual(coerceConstant(42 as any), 42);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 5: setNested primitive guard
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: setNested primitive guard", () => {
  test("throws when trying to set nested on a string", () => {
    const obj: any = { name: "hello" };
    assert.throws(
      () => setNested(obj, ["name", "inner"], "value"),
      /Cannot set nested property: value at "name" is not an object/,
    );
  });

  test("throws when trying to set nested on a number", () => {
    const obj: any = { count: 42 };
    assert.throws(
      () => setNested(obj, ["count", "sub"], "value"),
      /Cannot set nested property: value at "count" is not an object/,
    );
  });

  test("normal nested assignment still works", () => {
    const obj: any = {};
    setNested(obj, ["a", "b", "c"], "deep");
    assert.equal(obj.a.b.c, "deep");
  });

  test("array creation via digit key still works", () => {
    const obj: any = {};
    setNested(obj, ["items", "0"], "first");
    assert.ok(Array.isArray(obj.items));
    assert.equal(obj.items[0], "first");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Step 6: Configurable maxDepth
// ══════════════════════════════════════════════════════════════════════════════

describe("engine hardening: configurable maxDepth", () => {
  test("custom maxDepth is respected", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.result <- i.q
}`;
    const doc = parseBridge(bridgeText);
    // Should work with default maxDepth
    const { data } = await executeBridge({
      document: doc,
      operation: "Query.test",
      input: { q: "ok" },
      maxDepth: 5,
    });
    assert.deepStrictEqual(data, { result: "ok" });
  });

  test("low maxDepth causes BridgePanicError on deep nesting", async () => {
    // Array mapping creates shadow trees via shadow(), incrementing depth.
    // With maxDepth: 0, the shadow for the array element (depth 1) exceeds the limit.
    const bridgeText = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o <- i.items[] as el {
    .val <- el.v
  }
}`;
    const doc = parseBridge(bridgeText);
    await assert.rejects(
      () =>
        executeBridge({
          document: doc,
          operation: "Query.test",
          input: { items: [{ v: 1 }] },
          maxDepth: 0,
        }),
      (err: any) => {
        assert.ok(
          err.message.includes("Maximum execution depth exceeded"),
          `Expected depth error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
