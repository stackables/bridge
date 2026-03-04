/**
 * Unit tests for the wire resolution gate helpers extracted from
 * `resolveWires.ts`.  These functions can be tested independently of the
 * full execution engine via a lightweight mock `TreeContext`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BREAK_SYM, CONTINUE_SYM } from "../src/tree-types.ts";
import {
  applyFalsyGate,
  applyNullishGate,
  applyCatchGate,
} from "../src/resolveWires.ts";
import type { TreeContext } from "../src/tree-types.ts";
import type { Wire } from "../src/types.ts";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal NodeRef for use in test wires */
const REF: import("../src/types.ts").NodeRef = { module: "m", type: "Query", field: "f", path: [] };

/** Build a NodeRef with an alternative field name. */
function ref(field: string): import("../src/types.ts").NodeRef {
  return { module: "m", type: "Query", field, path: [] };
}

/** Build a minimal TreeContext that resolves refs from a plain value map. */
function makeCtx(
  values: Record<string, unknown> = {},
): TreeContext {
  return {
    pullSingle(ref) {
      const key = `${ref.module}.${ref.field}`;
      return (key in values ? values[key] : undefined) as ReturnType<TreeContext["pullSingle"]>;
    },
  };
}

/** A wire with no gate modifiers — used as a baseline. */
type TestWire = Extract<Wire, { from: unknown }>;

function fromWire(overrides: Partial<TestWire> = {}): TestWire {
  return { from: REF, to: REF, ...overrides } as TestWire;
}

// ── applyFalsyGate ────────────────────────────────────────────────────────────

describe("applyFalsyGate", () => {
  test("passes through a truthy value unchanged", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyFalsyGate(ctx, w, "hello"), "hello");
    assert.equal(await applyFalsyGate(ctx, w, 42), 42);
    assert.equal(await applyFalsyGate(ctx, w, true), true);
    assert.deepEqual(await applyFalsyGate(ctx, w, { x: 1 }), { x: 1 });
  });

  test("returns falsy value when no fallback is configured", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyFalsyGate(ctx, w, 0), 0);
    assert.equal(await applyFalsyGate(ctx, w, ""), "");
    assert.equal(await applyFalsyGate(ctx, w, false), false);
    assert.equal(await applyFalsyGate(ctx, w, null), null);
  });

  test("returns first truthy ref from falsyFallbackRefs", async () => {
    const ctx = makeCtx({ "m.a": null, "m.b": "found" });
    const w = fromWire({ falsyFallbackRefs: [ref("a"), ref("b")] });
    assert.equal(await applyFalsyGate(ctx, w, null), "found");
  });

  test("skips falsy refs and falls through to falsyFallback constant", async () => {
    const ctx = makeCtx({ "m.a": 0 });
    const w = fromWire({ falsyFallbackRefs: [ref("a")], falsyFallback: "42" });
    assert.equal(await applyFalsyGate(ctx, w, null), 42);
  });

  test("applies falsyFallback constant when value is falsy and no refs given", async () => {
    const ctx = makeCtx();
    const w = fromWire({ falsyFallback: "default" });
    assert.equal(await applyFalsyGate(ctx, w, null), "default");
    assert.equal(await applyFalsyGate(ctx, w, false), "default");
    assert.equal(await applyFalsyGate(ctx, w, ""), "default");
  });

  test("applies falsyControl when value is falsy", async () => {
    const ctx = makeCtx();
    const w = fromWire({ falsyControl: { kind: "continue" } });
    assert.equal(await applyFalsyGate(ctx, w, 0), CONTINUE_SYM);
  });

  test("falsyControl kind=break returns BREAK_SYM", async () => {
    const ctx = makeCtx();
    const w = fromWire({ falsyControl: { kind: "break" } });
    assert.equal(await applyFalsyGate(ctx, w, false), BREAK_SYM);
  });

  test("falsyControl kind=throw throws an error", async () => {
    const ctx = makeCtx();
    const w = fromWire({ falsyControl: { kind: "throw", message: "boom" } });
    await assert.rejects(() => applyFalsyGate(ctx, w, null), /boom/);
  });

  test("forwards pullChain to ctx.pullSingle for falsyFallbackRefs", async () => {
    let capturedChain: Set<string> | undefined;
    const ctx: TreeContext = {
      pullSingle(_ref, pullChain) {
        capturedChain = pullChain;
        return "value";
      },
    };
    const chain = new Set(["some:key"]);
    const w = fromWire({ falsyFallbackRefs: [ref("a")] });
    await applyFalsyGate(ctx, w, null, chain);
    assert.equal(capturedChain, chain);
  });
});

// ── applyNullishGate ──────────────────────────────────────────────────────────

describe("applyNullishGate", () => {
  test("passes through a non-nullish value unchanged", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyNullishGate(ctx, w, "hello"), "hello");
    assert.equal(await applyNullishGate(ctx, w, 0), 0);
    assert.equal(await applyNullishGate(ctx, w, false), false);
    assert.equal(await applyNullishGate(ctx, w, ""), "");
  });

  test("returns null/undefined when no fallback is configured", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyNullishGate(ctx, w, null), null);
    assert.equal(await applyNullishGate(ctx, w, undefined), undefined);
  });

  test("resolves nullishFallbackRef when value is null", async () => {
    const ctx = makeCtx({ "m.fallback": "resolved" });
    const w = fromWire({ nullishFallbackRef: ref("fallback") });
    assert.equal(await applyNullishGate(ctx, w, null), "resolved");
  });

  test("applies nullishFallback constant when value is null", async () => {
    const ctx = makeCtx();
    const w = fromWire({ nullishFallback: "99" });
    assert.equal(await applyNullishGate(ctx, w, null), 99);
    assert.equal(await applyNullishGate(ctx, w, undefined), 99);
  });

  test("applies nullishControl when value is null", async () => {
    const ctx = makeCtx();
    const w = fromWire({ nullishControl: { kind: "continue" } });
    assert.equal(await applyNullishGate(ctx, w, null), CONTINUE_SYM);
  });

  test("nullishControl takes priority over nullishFallbackRef", async () => {
    const ctx = makeCtx({ "m.f": "should-not-be-used" });
    const w = fromWire({
      nullishControl: { kind: "break" },
      nullishFallbackRef: REF,
    });
    assert.equal(await applyNullishGate(ctx, w, null), BREAK_SYM);
  });

  test("forwards pullChain to ctx.pullSingle for nullishFallbackRef", async () => {
    let capturedChain: Set<string> | undefined;
    const ctx: TreeContext = {
      pullSingle(_ref, pullChain) {
        capturedChain = pullChain;
        return "resolved";
      },
    };
    const chain = new Set(["some:key"]);
    const w = fromWire({ nullishFallbackRef: REF });
    await applyNullishGate(ctx, w, null, chain);
    assert.equal(capturedChain, chain);
  });
});

// ── applyCatchGate ────────────────────────────────────────────────────────────

describe("applyCatchGate", () => {
  test("returns undefined when no catch handler is configured", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyCatchGate(ctx, w), undefined);
  });

  test("applies catchFallback constant", async () => {
    const ctx = makeCtx();
    const w = fromWire({ catchFallback: "fallback" });
    assert.equal(await applyCatchGate(ctx, w), "fallback");
  });

  test("resolves catchFallbackRef", async () => {
    const ctx = makeCtx({ "m.backup": "backup-value" });
    const w = fromWire({ catchFallbackRef: ref("backup") });
    assert.equal(await applyCatchGate(ctx, w), "backup-value");
  });

  test("applies catchControl kind=continue", async () => {
    const ctx = makeCtx();
    const w = fromWire({ catchControl: { kind: "continue" } });
    assert.equal(await applyCatchGate(ctx, w), CONTINUE_SYM);
  });

  test("catchControl takes priority over catchFallbackRef", async () => {
    const ctx = makeCtx({ "m.backup": "should-not-be-used" });
    const w = fromWire({
      catchControl: { kind: "break" },
      catchFallbackRef: REF,
    });
    assert.equal(await applyCatchGate(ctx, w), BREAK_SYM);
  });

  test("catchControl kind=throw propagates the error", async () => {
    const ctx = makeCtx();
    const w = fromWire({ catchControl: { kind: "throw", message: "catch-throw" } });
    await assert.rejects(() => applyCatchGate(ctx, w), /catch-throw/);
  });

  test("forwards pullChain to ctx.pullSingle for catchFallbackRef", async () => {
    let capturedChain: Set<string> | undefined;
    const ctx: TreeContext = {
      pullSingle(_ref, pullChain) {
        capturedChain = pullChain;
        return "recovered";
      },
    };
    const chain = new Set(["some:key"]);
    const w = fromWire({ catchFallbackRef: REF });
    await applyCatchGate(ctx, w, chain);
    assert.equal(capturedChain, chain);
  });
});
