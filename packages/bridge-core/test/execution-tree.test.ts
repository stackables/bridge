import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BridgeAbortError, BridgePanicError } from "../src/index.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Error class identity
// ═══════════════════════════════════════════════════════════════════════════

describe("BridgePanicError / BridgeAbortError", () => {
  test("BridgePanicError extends Error", () => {
    const err = new BridgePanicError("test");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BridgePanicError);
    assert.equal(err.name, "BridgePanicError");
    assert.equal(err.message, "test");
  });

  test("BridgeAbortError extends Error with default message", () => {
    const err = new BridgeAbortError();
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BridgeAbortError);
    assert.equal(err.name, "BridgeAbortError");
    assert.equal(err.message, "Execution aborted by external signal");
  });

  test("BridgeAbortError accepts custom message", () => {
    const err = new BridgeAbortError("custom");
    assert.equal(err.message, "custom");
  });
});
