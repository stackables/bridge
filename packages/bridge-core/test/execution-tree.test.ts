import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BridgeAbortError,
  BridgePanicError,
  BridgeRuntimeError,
  ExecutionTree,
  type BridgeDocument,
  type NodeRef,
} from "../src/index.ts";

const DOC: BridgeDocument = { version: "1.5", instructions: [] };
const TRUNK = { module: "_", type: "Query", field: "test" };

function ref(path: string[], rootSafe = false): NodeRef {
  return { module: "_", type: "Query", field: "test", path, rootSafe };
}

describe("ExecutionTree edge cases", () => {
  test("constructor rejects parent depth beyond hard recursion limit", () => {
    const parent = { depth: 30 } as unknown as ExecutionTree;
    assert.throws(
      () => new ExecutionTree(TRUNK, DOC, {}, undefined, parent),
      BridgePanicError,
    );
  });

  test("createShadowArray aborts when signal is already aborted", () => {
    const tree = new ExecutionTree(TRUNK, DOC);
    const controller = new AbortController();
    controller.abort();
    tree.signal = controller.signal;

    assert.throws(
      () => (tree as any).createShadowArray([{}]),
      BridgeAbortError,
    );
  });

  test("applyPath respects rootSafe and throws when not rootSafe", () => {
    const tree = new ExecutionTree(TRUNK, DOC);
    assert.equal((tree as any).applyPath(null, ref(["x"], true)), undefined);
    assert.throws(
      () => (tree as any).applyPath(null, ref(["x"])),
      (err: unknown) => {
        assert.ok(err instanceof BridgeRuntimeError);
        assert.ok(err.cause instanceof TypeError);
        assert.match(
          err.message,
          /Cannot read properties of null \(reading 'x'\)/,
        );
        return true;
      },
    );
  });

  test("applyPath warns when using object-style access on arrays", () => {
    const tree = new ExecutionTree(TRUNK, DOC);
    let warning = "";
    tree.logger = { warn: (msg: string) => (warning = msg) };

    assert.equal((tree as any).applyPath([{ x: 1 }], ref(["x"])), undefined);
    assert.equal((tree as any).applyPath([{ x: 1 }], ref(["0", "x"])), 1);
    assert.match(warning, /Accessing "\.x" on an array/);
  });
});

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
