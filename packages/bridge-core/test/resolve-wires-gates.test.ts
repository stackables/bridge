/**
 * Unit tests for the wire resolution gate helpers extracted from
 * `resolveWires.ts`.  These functions can be tested independently of the
 * full execution engine via a lightweight mock `TreeContext`.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BREAK_SYM,
  CONTINUE_SYM,
  isLoopControlSignal,
} from "../src/tree-types.ts";
import { applyFallbackGates, applyCatchGate } from "../src/resolveWires.ts";
import type { TreeContext } from "../src/tree-types.ts";
import type { NodeRef, WireLegacy } from "../src/types.ts";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal NodeRef for use in test wires */
const REF: NodeRef = { module: "m", type: "Query", field: "f", path: [] };

/** Build a NodeRef with an alternative field name. */
function ref(field: string): NodeRef {
  return { module: "m", type: "Query", field, path: [] };
}

/** Build a minimal TreeContext that resolves refs from a plain value map. */
function makeCtx(values: Record<string, unknown> = {}): TreeContext {
  return {
    pullSingle(ref) {
      const key = `${ref.module}.${ref.field}`;
      return (key in values ? values[key] : undefined) as ReturnType<
        TreeContext["pullSingle"]
      >;
    },
  };
}

/** A wire with no gate modifiers — used as a baseline. */
type TestWire = Extract<WireLegacy, { from: unknown }>;

function fromWire(overrides: Partial<TestWire> = {}): TestWire {
  return { from: REF, to: REF, ...overrides } as TestWire;
}

// ── applyFallbackGates — falsy (||) ─────────────────────────────────────────

describe("applyFallbackGates — falsy (||)", () => {
  test("passes through a truthy value unchanged", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyFallbackGates(ctx, w, "hello"), "hello");
    assert.equal(await applyFallbackGates(ctx, w, 42), 42);
    assert.equal(await applyFallbackGates(ctx, w, true), true);
    assert.deepEqual(await applyFallbackGates(ctx, w, { x: 1 }), { x: 1 });
  });

  test("returns falsy value when no fallback is configured", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyFallbackGates(ctx, w, 0), 0);
    assert.equal(await applyFallbackGates(ctx, w, ""), "");
    assert.equal(await applyFallbackGates(ctx, w, false), false);
    assert.equal(await applyFallbackGates(ctx, w, null), null);
  });

  test("returns first truthy ref from falsy fallback refs", async () => {
    const ctx = makeCtx({ "m.a": null, "m.b": "found" });
    const w = fromWire({
      fallbacks: [
        { type: "falsy", ref: ref("a") },
        { type: "falsy", ref: ref("b") },
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), "found");
  });

  test("skips falsy refs and falls through to falsy constant", async () => {
    const ctx = makeCtx({ "m.a": 0 });
    const w = fromWire({
      fallbacks: [
        { type: "falsy", ref: ref("a") },
        { type: "falsy", value: "42" },
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), 42);
  });

  test("applies falsy constant when value is falsy and no refs given", async () => {
    const ctx = makeCtx();
    const w = fromWire({ fallbacks: [{ type: "falsy", value: "default" }] });
    assert.equal(await applyFallbackGates(ctx, w, null), "default");
    assert.equal(await applyFallbackGates(ctx, w, false), "default");
    assert.equal(await applyFallbackGates(ctx, w, ""), "default");
  });

  test("applies falsy control when value is falsy", async () => {
    const ctx = makeCtx();
    const w = fromWire({
      fallbacks: [{ type: "falsy", control: { kind: "continue" } }],
    });
    assert.equal(await applyFallbackGates(ctx, w, 0), CONTINUE_SYM);
  });

  test("falsy control kind=break returns BREAK_SYM", async () => {
    const ctx = makeCtx();
    const w = fromWire({
      fallbacks: [{ type: "falsy", control: { kind: "break" } }],
    });
    assert.equal(await applyFallbackGates(ctx, w, false), BREAK_SYM);
  });

  test("falsy control kind=break with level 2 returns multi-level signal", async () => {
    const ctx = makeCtx();
    const w = fromWire({
      fallbacks: [{ type: "falsy", control: { kind: "break", levels: 2 } }],
    });
    const out = await applyFallbackGates(ctx, w, false);
    assert.ok(isLoopControlSignal(out));
    assert.notEqual(out, BREAK_SYM);
    assert.notEqual(out, CONTINUE_SYM);
    assert.deepStrictEqual(out, { __bridgeControl: "break", levels: 2 });
  });

  test("falsy control kind=throw throws an error", async () => {
    const ctx = makeCtx();
    const w = fromWire({
      fallbacks: [
        { type: "falsy", control: { kind: "throw", message: "boom" } },
      ],
    });
    await assert.rejects(() => applyFallbackGates(ctx, w, null), /boom/);
  });

  test("forwards pullChain to ctx.pullSingle for falsy ref", async () => {
    let capturedChain: Set<string> | undefined;
    const ctx: TreeContext = {
      pullSingle(_ref, pullChain) {
        capturedChain = pullChain;
        return "value";
      },
    };
    const chain = new Set(["some:key"]);
    const w = fromWire({ fallbacks: [{ type: "falsy", ref: ref("a") }] });
    await applyFallbackGates(ctx, w, null, chain);
    assert.equal(capturedChain, chain);
  });
});

// ── applyFallbackGates — nullish (??) ────────────────────────────────────────

describe("applyFallbackGates — nullish (??)", () => {
  test("passes through a non-nullish value unchanged", async () => {
    const ctx = makeCtx();
    const w = fromWire({ fallbacks: [{ type: "nullish", value: "99" }] });
    assert.equal(await applyFallbackGates(ctx, w, "hello"), "hello");
    assert.equal(await applyFallbackGates(ctx, w, 0), 0);
    assert.equal(await applyFallbackGates(ctx, w, false), false);
    assert.equal(await applyFallbackGates(ctx, w, ""), "");
  });

  test("returns null/undefined when no fallback is configured", async () => {
    const ctx = makeCtx();
    const w = fromWire();
    assert.equal(await applyFallbackGates(ctx, w, null), null);
    assert.equal(await applyFallbackGates(ctx, w, undefined), undefined);
  });

  test("resolves nullish ref when value is null", async () => {
    const ctx = makeCtx({ "m.fallback": "resolved" });
    const w = fromWire({
      fallbacks: [{ type: "nullish", ref: ref("fallback") }],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), "resolved");
  });

  test("applies nullish constant when value is null", async () => {
    const ctx = makeCtx();
    const w = fromWire({ fallbacks: [{ type: "nullish", value: "99" }] });
    assert.equal(await applyFallbackGates(ctx, w, null), 99);
    assert.equal(await applyFallbackGates(ctx, w, undefined), 99);
  });

  test("applies nullish control when value is null", async () => {
    const ctx = makeCtx();
    const w = fromWire({
      fallbacks: [{ type: "nullish", control: { kind: "continue" } }],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), CONTINUE_SYM);
  });

  test("nullish control takes priority (returns immediately)", async () => {
    const ctx = makeCtx({ "m.f": "should-not-be-used" });
    const w = fromWire({
      fallbacks: [
        { type: "nullish", control: { kind: "break" } },
        { type: "nullish", ref: REF },
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), BREAK_SYM);
  });

  test("forwards pullChain to ctx.pullSingle for nullish ref", async () => {
    let capturedChain: Set<string> | undefined;
    const ctx: TreeContext = {
      pullSingle(_ref, pullChain) {
        capturedChain = pullChain;
        return "resolved";
      },
    };
    const chain = new Set(["some:key"]);
    const w = fromWire({ fallbacks: [{ type: "nullish", ref: REF }] });
    await applyFallbackGates(ctx, w, null, chain);
    assert.equal(capturedChain, chain);
  });
});

// ── applyFallbackGates — mixed chains ────────────────────────────────────────

describe("applyFallbackGates — mixed || and ??", () => {
  test("A ?? B || C — nullish then falsy", async () => {
    const ctx = makeCtx({ "m.b": 0, "m.c": "found" });
    const w = fromWire({
      fallbacks: [
        { type: "nullish", ref: ref("b") }, // ?? B  → 0 (non-nullish, stops ?? but falsy)
        { type: "falsy", ref: ref("c") }, // || C  → "found"
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), "found");
  });

  test("A || B ?? C — falsy then nullish", async () => {
    const ctx = makeCtx({ "m.b": null, "m.c": "fallback" });
    const w = fromWire({
      fallbacks: [
        { type: "falsy", ref: ref("b") }, // || B  → null (still falsy)
        { type: "nullish", ref: ref("c") }, // ?? C  → "fallback"
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, ""), "fallback");
  });

  test("A ?? B || C ?? D — four-item chain", async () => {
    const ctx = makeCtx({ "m.b": null, "m.c": null });
    const w = fromWire({
      fallbacks: [
        { type: "nullish", ref: ref("b") }, // ?? B  → null (still nullish)
        { type: "falsy", ref: ref("c") }, // || C  → null (still falsy)
        { type: "nullish", value: "final" }, // ?? D  → "final"
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), "final");
  });

  test("mixed chain stops when value becomes truthy and non-nullish", async () => {
    const ctx = makeCtx({ "m.b": "good" });
    const w = fromWire({
      fallbacks: [
        { type: "nullish", ref: ref("b") }, // ?? B  → "good"
        { type: "falsy", value: "unused" }, // || ... gate closed, value is truthy
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, null), "good");
  });

  test("falsy gate open but nullish gate closed for 0", async () => {
    const ctx = makeCtx();
    const w = fromWire({
      fallbacks: [
        { type: "nullish", value: "unused" }, // ?? gate closed: 0 != null
        { type: "falsy", value: "fallback" }, // || gate open: !0 is true
      ],
    });
    assert.equal(await applyFallbackGates(ctx, w, 0), "fallback");
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

  test("applies catchControl kind=continue with level 3", async () => {
    const ctx = makeCtx();
    const w = fromWire({ catchControl: { kind: "continue", levels: 3 } });
    const out = await applyCatchGate(ctx, w);
    assert.ok(isLoopControlSignal(out));
    assert.deepStrictEqual(out, { __bridgeControl: "continue", levels: 3 });
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
    const w = fromWire({
      catchControl: { kind: "throw", message: "catch-throw" },
    });
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
