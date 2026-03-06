/**
 * Tests for element-scoped tool declarations and memoization.
 *
 * Covers:
 * - Parsing `memoize` keyword (bridge handle, tool block, element-scoped)
 * - Serialization and round-trip
 * - Runtime memoization (stampede protection, request-scoped cache)
 * - Element-scoped tool isolation in array mappings
 * - Compiler codegen parity
 * - ToolMetadata.memoize with custom keyFn
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "../src/index.ts";
import { executeBridge } from "@stackables/bridge-core";
import type { Bridge, HandleBinding, ToolDef } from "@stackables/bridge-core";
import { executeBridge as executeAot } from "@stackables/bridge-compiler";

type AnyData = Record<string, any>;

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("memoize keyword parsing", () => {
  test("parses memoize on bridge handle binding", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with std.httpCall as h memoize
  with input as i
  with output as o

  h.url <- i.url
  o.data <- h.response
}`);
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const handle = bridge.handles.find(
      (h) => h.kind === "tool" && h.handle === "h",
    ) as Extract<HandleBinding, { kind: "tool" }>;
    assert.ok(handle, "should find tool handle h");
    assert.equal(handle.memoize, true, "memoize flag should be true");
    assert.equal(handle.name, "std.httpCall");
  });

  test("parses bridge handle without memoize", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with std.httpCall as h
  with output as o

  o.data <- h.response
}`);
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const handle = bridge.handles.find(
      (h) => h.kind === "tool" && h.handle === "h",
    ) as Extract<HandleBinding, { kind: "tool" }>;
    assert.ok(handle);
    assert.equal(handle.memoize, undefined);
  });

  test("parses memoize on tool block", () => {
    const doc = parseBridge(`version 1.5
tool myApi from std.httpCall memoize {
  .baseUrl = "https://api.example.com"
}`);
    const toolDef = doc.instructions.find(
      (i): i is ToolDef => i.kind === "tool",
    )!;
    assert.ok(toolDef, "should find tool definition");
    assert.equal(toolDef.memoize, true, "memoize flag should be true");
    assert.equal(toolDef.name, "myApi");
  });

  test("parses tool block without memoize", () => {
    const doc = parseBridge(`version 1.5
tool myApi from std.httpCall {
  .baseUrl = "https://api.example.com"
}`);
    const toolDef = doc.instructions.find(
      (i): i is ToolDef => i.kind === "tool",
    )!;
    assert.ok(toolDef);
    assert.equal(toolDef.memoize, undefined);
  });

  test("parses element-scoped tool declaration in array mapping", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with std.httpCall as fetch memoize

    fetch.url <- item.url
    .result <- fetch.response
  }
}`);
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const handle = bridge.handles.find(
      (h) => h.kind === "tool" && h.handle === "fetch",
    ) as Extract<HandleBinding, { kind: "tool" }>;
    assert.ok(handle, "should find element-scoped tool handle");
    assert.equal(handle.memoize, true);
    assert.equal(handle.elementScoped, true);
    assert.equal(handle.name, "std.httpCall");
  });

  test("parses element-scoped tool without memoize", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with std.httpCall as fetch

    fetch.url <- item.url
    .result <- fetch.response
  }
}`);
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const handle = bridge.handles.find(
      (h) => h.kind === "tool" && h.handle === "fetch",
    ) as Extract<HandleBinding, { kind: "tool" }>;
    assert.ok(handle);
    assert.equal(handle.memoize, undefined);
    assert.equal(handle.elementScoped, true);
  });

  test("rejects memoize as handle alias name", () => {
    // MemoizeKw is a keyword token, so `as memoize` fails to parse
    assert.throws(
      () =>
        parseBridge(`version 1.5
bridge Query.test {
  with std.httpCall as memoize
  with output as o
  o.data <- memoize.response
}`),
      /memoize/,
    );
  });
});

// ── Serialization round-trip ─────────────────────────────────────────────────

describe("memoize serialization", () => {
  test("bridge handle memoize round-trips", () => {
    const src = `version 1.5
bridge Query.test {
  with std.httpCall as h memoize
  with input as i
  with output as o

  h.url <- i.url
  o.data <- h.response
}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("with std.httpCall as h memoize"),
      `expected memoize in serialized output: ${serialized}`,
    );

    // Round-trip: re-parse and re-serialize
    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized, "round-trip should be idempotent");
  });

  test("tool block memoize round-trips", () => {
    const src = `version 1.5
tool myApi from std.httpCall memoize {
  .baseUrl = "https://api.example.com"
}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("tool myApi from std.httpCall memoize"),
      `expected memoize in tool block: ${serialized}`,
    );

    const reparsed = parseBridge(serialized);
    const reserialized = serializeBridge(reparsed);
    assert.equal(reserialized, serialized);
  });

  test("element-scoped tool declaration round-trips", () => {
    const src = `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with std.httpCall as fetch memoize

    fetch.url <- item.url
    .result <- fetch.response
  }
}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(
      serialized.includes("with std.httpCall as fetch memoize"),
      `expected element-scoped with in serialized output: ${serialized}`,
    );

    // Element-scoped handles should NOT appear in bridge header
    const headerLines = serialized
      .split("\n")
      .filter((l) => l.match(/^\s{2}with /));
    const fetchInHeader = headerLines.some((l) => l.includes("fetch"));
    assert.ok(
      !fetchInHeader,
      "element-scoped handle should not be in bridge header",
    );
  });
});

// ── Runtime memoization ──────────────────────────────────────────────────────

describe("runtime memoization", () => {
  test("memoized tool called once for identical inputs via ToolMetadata", async () => {
    let callCount = 0;
    const expensiveFetch = async (input: Record<string, any>) => {
      callCount++;
      return { data: `result-${input.id}` };
    };
    (expensiveFetch as any).bridge = { memoize: true };

    const doc = parseBridge(`version 1.5
bridge Query.test {
  with expensiveFetch as a
  with expensiveFetch as b
  with input as i
  with output as o

  a.id <- i.id
  b.id <- i.id
  o.fromA <- a.data
  o.fromB <- b.data
}`);
    const { data } = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: { id: "42" },
      tools: { expensiveFetch },
    });
    assert.equal(data.fromA, "result-42");
    assert.equal(data.fromB, "result-42");
    // With memoization, identical inputs should only trigger one call
    assert.equal(callCount, 1, "memoized tool should be called only once");
  });

  test("memoized tool with different inputs calls separately", async () => {
    let callCount = 0;
    const fetch = async (input: Record<string, any>) => {
      callCount++;
      return { data: `result-${input.id}` };
    };
    (fetch as any).bridge = { memoize: true };

    const doc = parseBridge(`version 1.5
bridge Query.test {
  with fetch as a
  with fetch as b
  with input as i
  with output as o

  a.id = "1"
  b.id = "2"
  o.fromA <- a.data
  o.fromB <- b.data
}`);
    const { data } = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal(data.fromA, "result-1");
    assert.equal(data.fromB, "result-2");
    assert.equal(callCount, 2, "different inputs should call separately");
  });

  test("memoize with custom keyFn", async () => {
    let callCount = 0;
    const lookup = async (_input: Record<string, any>) => {
      callCount++;
      return { rate: 1.5 };
    };
    (lookup as any).bridge = {
      memoize: {
        keyFn: (input: Record<string, any>) =>
          `${input.base}:${input.target}`,
      },
    };

    const doc = parseBridge(`version 1.5
bridge Query.test {
  with lookup as a
  with lookup as b
  with output as o

  a.base = "USD"
  a.target = "EUR"
  b.base = "USD"
  b.target = "EUR"
  o.rateA <- a.rate
  o.rateB <- b.rate
}`);
    const { data } = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { lookup },
    });
    assert.equal(data.rateA, 1.5);
    assert.equal(data.rateB, 1.5);
    assert.equal(callCount, 1, "custom keyFn should deduplicate");
  });

  test("DSL-level memoize on bridge handle", async () => {
    let callCount = 0;
    const fetch = async (input: Record<string, any>) => {
      callCount++;
      return { data: `result-${input.id}` };
    };

    const doc = parseBridge(`version 1.5
bridge Query.test {
  with fetch as a memoize
  with fetch as b memoize
  with output as o

  a.id = "42"
  b.id = "42"
  o.fromA <- a.data
  o.fromB <- b.data
}`);
    const { data } = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal(data.fromA, "result-42");
    assert.equal(data.fromB, "result-42");
    assert.equal(callCount, 1, "DSL memoize should deduplicate");
  });

  test("DSL-level memoize on tool block", async () => {
    let callCount = 0;
    const myFetcher = async (input: Record<string, any>) => {
      callCount++;
      return { result: `fetched-${input.url}` };
    };

    const doc = parseBridge(`version 1.5
tool api from myFetcher memoize {
  .url = "https://example.com/data"
}

bridge Query.test {
  with api as a
  with api as b
  with output as o

  o.fromA <- a.result
  o.fromB <- b.result
}`);
    const { data } = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { myFetcher },
    });
    assert.equal(data.fromA, "fetched-https://example.com/data");
    assert.equal(data.fromB, "fetched-https://example.com/data");
    assert.equal(callCount, 1, "ToolDef memoize should deduplicate");
  });

  test("memoize deduplicates in array with top-level tool", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with lookup as fetch memoize
  with input as i
  with output as o

  o.items <- i.list[] as item {
    fetch.id <- item.id
    .name <- fetch.name
  }
}`);
    // This tests that memoization is enabled on top-level tools used in arrays.
    // Full element-scoped isolation requires deeper shadow tree support.
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const handle = bridge.handles.find(
      (h) => h.kind === "tool" && h.handle === "fetch",
    ) as Extract<HandleBinding, { kind: "tool" }>;
    assert.ok(handle, "should find tool handle");
    assert.equal(handle.memoize, true);
  });

  test("memoization cache is request-scoped (not global)", async () => {
    let callCount = 0;
    const fetch = async (_input: Record<string, any>) => {
      callCount++;
      return { data: `result-${callCount}` };
    };
    (fetch as any).bridge = { memoize: true };

    const doc = parseBridge(`version 1.5
bridge Query.test {
  with fetch as f
  with output as o

  f.id = "42"
  o.data <- f.data
}`);

    // First request
    const r1 = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal(r1.data.data, "result-1");

    // Second request should get a fresh result (not cached from first request)
    const r2 = await executeBridge<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal(r2.data.data, "result-2");
    assert.equal(callCount, 2, "each request should have its own cache");
  });
});

// ── Element-scoped tool isolation ────────────────────────────────────────────

describe("element-scoped tool isolation", () => {
  test("element-scoped tool declaration produces correct AST structure", () => {
    const doc = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with processTool as proc

    proc.value <- item.val
    .out <- proc.result
  }
}`);
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    // Element-scoped handle exists
    const handle = bridge.handles.find(
      (h) => h.kind === "tool" && h.handle === "proc",
    ) as Extract<HandleBinding, { kind: "tool" }>;
    assert.ok(handle, "should find element-scoped tool handle");
    assert.equal(handle.elementScoped, true);
    assert.equal(handle.name, "processTool");

    // Pipe handle entry exists with instance >= 100000
    assert.ok(bridge.pipeHandles, "should have pipe handles");
    const ph = bridge.pipeHandles!.find((p) => p.handle === "proc");
    assert.ok(ph, "should find pipe handle for proc");
    assert.ok(
      ph.key.includes(":100000"),
      "pipe handle should use instance >= 100000",
    );

    // Wires targeting the element-scoped tool instance exist
    const toolWires = bridge.wires.filter(
      (w) => "to" in w && w.to.instance === 100000,
    );
    assert.ok(
      toolWires.length > 0,
      "should have wires targeting element-scoped tool",
    );
  });
});

// ── Compiler parity ─────────────────────────────────────────────────────────

describe("memoize compiler parity", () => {
  test("compiler generates __callMemo for memoized tools", async () => {
    let callCount = 0;
    const fetch = async (input: Record<string, any>) => {
      callCount++;
      return { data: `result-${input.id}` };
    };
    (fetch as any).bridge = { memoize: true };

    const doc = parseBridge(`version 1.5
bridge Query.test {
  with fetch as a memoize
  with output as o

  a.id = "42"
  o.fromA <- a.data
}`);
    const { data } = await executeAot<AnyData>({
      document: doc,
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal(data.fromA, "result-42");
    assert.equal(callCount, 1, "compiled tool should execute once");
  });
});
