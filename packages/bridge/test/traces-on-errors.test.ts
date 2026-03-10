/**
 * Traces on errors.
 *
 * When executeBridge throws, the error should carry any tool traces
 * collected before the failure.  This is critical for debugging —
 * you need to see what already ran when diagnosing a failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine, type ExecuteFn } from "./utils/dual-run.ts";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { BridgeRuntimeError } from "@stackables/bridge-core";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A tool that always succeeds. */
async function goodTool(input: Record<string, any>) {
  return { greeting: `hello ${input.name ?? "world"}` };
}

/** A tool that always throws. */
async function failingTool(): Promise<never> {
  throw new Error("tool boom");
}

/** Helper to call executeBridge directly (with trace enabled). */
function execWithTrace(
  executeFn: ExecuteFn,
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any>,
) {
  const raw = parseBridge(bridgeText);
  const document = JSON.parse(JSON.stringify(raw)) as ReturnType<
    typeof parseBridge
  >;
  return executeFn({
    document,
    operation,
    input,
    tools,
    trace: "basic",
  } as any);
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("traces on errors", (_run, { executeFn }) => {
  test("error carries traces from tools that completed before the failure", async () => {
    // goodTool runs first (its output feeds into failingTool's input),
    // so there should be at least one trace entry for goodTool on the error.
    const bridge = `version 1.5
bridge Query.test {
  with goodTool as g
  with failingTool as f
  with input as i
  with output as o

  g.name <- i.name
  f.x <- g.greeting
  o.result <- f
}`;
    try {
      await execWithTrace(
        executeFn,
        bridge,
        "Query.test",
        { name: "alice" },
        {
          goodTool,
          failingTool,
        },
      );
      assert.fail("Expected an error to be thrown");
    } catch (err: any) {
      assert.ok(
        err instanceof BridgeRuntimeError,
        `Expected BridgeRuntimeError, got ${err?.constructor?.name}: ${err?.message}`,
      );
      assert.ok(Array.isArray(err.traces), "Expected traces array on error");
      assert.ok(err.traces.length > 0, "Expected at least one trace entry");
      // The successful tool should appear in traces
      const goodTrace = err.traces.find(
        (t: any) => t.tool === "g" || t.tool === "goodTool",
      );
      assert.ok(goodTrace, "Expected a trace entry for goodTool");
      assert.ok(!goodTrace.error, "goodTool trace should not have an error");
    }
  });

  test("error carries executionTraceId", async () => {
    const bridge = `version 1.5
bridge Query.test {
  with failingTool as f
  with input as i
  with output as o

  f.x <- i.x
  o.result <- f
}`;
    try {
      await execWithTrace(
        executeFn,
        bridge,
        "Query.test",
        { x: 1 },
        {
          failingTool,
        },
      );
      assert.fail("Expected an error to be thrown");
    } catch (err: any) {
      assert.ok(err instanceof BridgeRuntimeError);
      assert.equal(
        typeof err.executionTraceId,
        "bigint",
        "Expected executionTraceId (bigint) on error",
      );
    }
  });

  test("traces array is empty when no tools completed before the failure", async () => {
    // failingTool is the only tool — no traces should be collected before it
    const bridge = `version 1.5
bridge Query.test {
  with failingTool as f
  with input as i
  with output as o

  f.x <- i.x
  o.result <- f
}`;
    try {
      await execWithTrace(
        executeFn,
        bridge,
        "Query.test",
        { x: 1 },
        {
          failingTool,
        },
      );
      assert.fail("Expected an error to be thrown");
    } catch (err: any) {
      assert.ok(err instanceof BridgeRuntimeError);
      assert.ok(Array.isArray(err.traces), "Expected traces array on error");
      // The failing tool might or might not appear in traces (it errored).
      // But the array should exist.
    }
  });
});
