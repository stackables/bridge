/**
 * Tests for subpath exports — verifies that each entry point
 * (`./core`, `./compiler`, `./graphql`, `./stdlib`) re-exports the
 * expected symbols correctly.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

// ── Core ────────────────────────────────────────────────────────────────────

import {
  executeBridge,
  BridgeAbortError,
  BridgePanicError,
  internal,
  SELF_MODULE,
  parsePath,
} from "../src/core.ts";

describe("subpath: core", () => {
  test("exports executeBridge function", () => {
    assert.equal(typeof executeBridge, "function");
  });

  test("exports error classes", () => {
    const panic = new BridgePanicError("test");
    assert.ok(panic instanceof Error);
    assert.equal(panic.name, "BridgePanicError");

    const abort = new BridgeAbortError();
    assert.ok(abort instanceof Error);
    assert.equal(abort.name, "BridgeAbortError");
  });

  test("exports internal tools (core language primitives)", () => {
    assert.equal(typeof internal.add, "function");
    assert.equal(typeof internal.multiply, "function");
    assert.equal(typeof internal.eq, "function");
    assert.equal(typeof internal.not, "function");
    assert.equal(typeof internal.concat, "function");
    assert.equal(internal.add({ a: 2, b: 3 }), 5);
  });

  test("exports SELF_MODULE constant", () => {
    assert.equal(SELF_MODULE, "_");
  });

  test("exports parsePath utility", () => {
    assert.deepEqual(parsePath("items[0].name"), ["items", "0", "name"]);
  });
});

// ── Compiler ────────────────────────────────────────────────────────────────

import {
  parseBridge,
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
  BridgeLanguageService,
  serializeBridge,
} from "../src/compiler.ts";

describe("subpath: compiler", () => {
  test("exports parseBridge function", () => {
    assert.equal(typeof parseBridge, "function");
    assert.equal(parseBridge, parseBridgeChevrotain);
  });

  test("parseBridge parses a simple bridge", () => {
    const result = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name
}`);
    assert.equal(result.length, 1);
    assert.equal(result[0].kind, "bridge");
  });

  test("exports parseBridgeDiagnostics", () => {
    const { instructions, diagnostics } = parseBridgeDiagnostics(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name
}`);
    assert.ok(Array.isArray(instructions));
    assert.ok(Array.isArray(diagnostics));
    assert.equal(diagnostics.length, 0);
  });

  test("exports serializeBridge", () => {
    const instructions = parseBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name
}`);
    const text = serializeBridge(instructions);
    assert.ok(text.includes("bridge Query.test"));
    assert.ok(text.includes("o.name <- i.name"));
  });

  test("exports BridgeLanguageService", () => {
    const svc = new BridgeLanguageService();
    svc.update(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name
}`);
    const diags = svc.getDiagnostics();
    assert.ok(Array.isArray(diags));
  });
});

// ── GraphQL ─────────────────────────────────────────────────────────────────

import {
  bridgeTransform,
  getBridgeTraces,
  useBridgeTracing,
} from "../src/graphql.ts";

describe("subpath: graphql", () => {
  test("exports bridgeTransform function", () => {
    assert.equal(typeof bridgeTransform, "function");
  });

  test("exports getBridgeTraces function", () => {
    assert.equal(typeof getBridgeTraces, "function");
    // Returns empty array for context without tracer
    assert.deepEqual(getBridgeTraces({}), []);
  });

  test("exports useBridgeTracing function", () => {
    assert.equal(typeof useBridgeTracing, "function");
    const plugin = useBridgeTracing();
    assert.ok(plugin);
    assert.equal(typeof plugin.onExecute, "function");
  });
});

// ── Stdlib ───────────────────────────────────────────────────────────────────

import {
  std,
  builtinTools,
  builtinToolNames,
  createHttpCall,
  audit,
} from "../src/stdlib.ts";

describe("subpath: stdlib", () => {
  test("exports std namespace with tools", () => {
    assert.ok(std);
    assert.equal(typeof std.str.toUpperCase, "function");
    assert.equal(typeof std.str.toLowerCase, "function");
    assert.equal(typeof std.arr.filter, "function");
    assert.equal(typeof std.httpCall, "function");
    assert.equal(typeof std.audit, "function");
    assert.equal(typeof std.assert, "function");
  });

  test("std.str tools work correctly", () => {
    assert.equal(std.str.toUpperCase({ in: "hello" }), "HELLO");
    assert.equal(std.str.toLowerCase({ in: "HELLO" }), "hello");
  });

  test("exports builtinTools (std + internal)", () => {
    assert.ok(builtinTools.std);
    assert.ok(builtinTools.internal);
  });

  test("exports builtinToolNames", () => {
    assert.ok(Array.isArray(builtinToolNames));
    assert.ok(builtinToolNames.length > 0);
    assert.ok(builtinToolNames.some((n) => n.startsWith("std.")));
    assert.ok(builtinToolNames.some((n) => n.startsWith("internal.")));
  });

  test("exports createHttpCall factory", () => {
    assert.equal(typeof createHttpCall, "function");
  });

  test("exports audit tool", () => {
    assert.equal(typeof audit, "function");
  });
});

// ── Cross-subpath compatibility ─────────────────────────────────────────────

describe("subpath: cross-module compatibility", () => {
  test("core executeBridge works with compiler parseBridge", async () => {
    const instructions = parseBridge(`version 1.5
bridge Query.echo {
  with input as i
  with output as o
  o.message <- i.message
}`);
    const { data } = await executeBridge({
      instructions,
      operation: "Query.echo",
      input: { message: "hello" },
    });
    assert.deepEqual(data, { message: "hello" });
  });
});
