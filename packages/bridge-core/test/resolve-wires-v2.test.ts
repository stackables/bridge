/**
 * Unit tests for the V2 wire resolution model.
 *
 * Tests the unified source-loop evaluation (resolveWiresV2.ts) and the
 * legacy-to-V2 conversion (wire-compat.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BREAK_SYM,
  CONTINUE_SYM,
  isLoopControlSignal,
} from "../src/tree-types.ts";
import type { TreeContext } from "../src/tree-types.ts";
import type { Expression, NodeRef, WireLegacy, WireV2 } from "../src/types.ts";
import {
  evaluateExpression,
  applyFallbackGatesV2,
  applyCatchV2,
} from "../src/resolveWiresV2.ts";
import { legacyToV2, v2ToLegacy } from "../src/wire-compat.ts";

// ── Test helpers ─────────────────────────────────────────────────────────────

const REF: NodeRef = { module: "m", type: "Query", field: "f", path: [] };

function ref(field: string): NodeRef {
  return { module: "m", type: "Query", field, path: [] };
}

function makeCtx(values: Record<string, unknown> = {}): TreeContext {
  return {
    pullSingle(ref) {
      const key = `${ref.module}.${ref.field}`;
      if (key in values) {
        const v = values[key];
        if (v instanceof Error) throw v;
        return v as ReturnType<TreeContext["pullSingle"]>;
      }
      return undefined as ReturnType<TreeContext["pullSingle"]>;
    },
  };
}

function makeV2Wire(
  sources: WireV2["sources"],
  opts: Partial<WireV2> = {},
): WireV2 {
  return { to: REF, sources, ...opts };
}

// ── evaluateExpression ──────────────────────────────────────────────────────

describe("evaluateExpression", () => {
  test("evaluates a ref expression", async () => {
    const ctx = makeCtx({ "m.x": "hello" });
    const expr: Expression = { type: "ref", ref: ref("x") };
    assert.equal(await evaluateExpression(ctx, expr), "hello");
  });

  test("evaluates a literal expression", async () => {
    const ctx = makeCtx();
    assert.equal(
      await evaluateExpression(ctx, { type: "literal", value: "42" }),
      42,
    );
    assert.equal(
      await evaluateExpression(ctx, { type: "literal", value: '"hello"' }),
      "hello",
    );
    assert.equal(
      await evaluateExpression(ctx, { type: "literal", value: "true" }),
      true,
    );
  });

  test("safe ref returns undefined on error", async () => {
    const ctx = makeCtx({ "m.x": new Error("boom") });
    const expr: Expression = { type: "ref", ref: ref("x"), safe: true };
    assert.equal(await evaluateExpression(ctx, expr), undefined);
  });

  test("evaluates a ternary expression — then branch", async () => {
    const ctx = makeCtx({ "m.flag": true, "m.a": "yes", "m.b": "no" });
    const expr: Expression = {
      type: "ternary",
      cond: { type: "ref", ref: ref("flag") },
      then: { type: "ref", ref: ref("a") },
      else: { type: "ref", ref: ref("b") },
    };
    assert.equal(await evaluateExpression(ctx, expr), "yes");
  });

  test("evaluates a ternary expression — else branch", async () => {
    const ctx = makeCtx({ "m.flag": false, "m.a": "yes", "m.b": "no" });
    const expr: Expression = {
      type: "ternary",
      cond: { type: "ref", ref: ref("flag") },
      then: { type: "ref", ref: ref("a") },
      else: { type: "ref", ref: ref("b") },
    };
    assert.equal(await evaluateExpression(ctx, expr), "no");
  });

  test("evaluates AND expression — both truthy", async () => {
    const ctx = makeCtx({ "m.a": "yes", "m.b": "also" });
    const expr: Expression = {
      type: "and",
      left: { type: "ref", ref: ref("a") },
      right: { type: "ref", ref: ref("b") },
    };
    assert.equal(await evaluateExpression(ctx, expr), true);
  });

  test("evaluates AND expression — left falsy", async () => {
    const ctx = makeCtx({ "m.a": false, "m.b": "yes" });
    const expr: Expression = {
      type: "and",
      left: { type: "ref", ref: ref("a") },
      right: { type: "ref", ref: ref("b") },
    };
    assert.equal(await evaluateExpression(ctx, expr), false);
  });

  test("evaluates OR expression — left truthy", async () => {
    const ctx = makeCtx({ "m.a": "yes", "m.b": false });
    const expr: Expression = {
      type: "or",
      left: { type: "ref", ref: ref("a") },
      right: { type: "ref", ref: ref("b") },
    };
    assert.equal(await evaluateExpression(ctx, expr), true);
  });

  test("evaluates OR expression — both falsy", async () => {
    const ctx = makeCtx({ "m.a": false, "m.b": false });
    const expr: Expression = {
      type: "or",
      left: { type: "ref", ref: ref("a") },
      right: { type: "ref", ref: ref("b") },
    };
    assert.equal(await evaluateExpression(ctx, expr), false);
  });

  test("evaluates control — continue", async () => {
    const ctx = makeCtx();
    const expr: Expression = {
      type: "control",
      control: { kind: "continue" },
    };
    assert.equal(await evaluateExpression(ctx, expr), CONTINUE_SYM);
  });

  test("evaluates control — break", async () => {
    const ctx = makeCtx();
    const expr: Expression = {
      type: "control",
      control: { kind: "break" },
    };
    assert.equal(await evaluateExpression(ctx, expr), BREAK_SYM);
  });

  test("evaluates control — throw", () => {
    const ctx = makeCtx();
    const expr: Expression = {
      type: "control",
      control: { kind: "throw", message: "boom" },
    };
    assert.throws(() => evaluateExpression(ctx, expr), { message: "boom" });
  });
});

// ── applyFallbackGatesV2 ───────────────────────────────────────────────────

describe("applyFallbackGatesV2 — falsy (||)", () => {
  test("passes through a truthy value unchanged", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }]);
    assert.equal(await applyFallbackGatesV2(ctx, w, "hello"), "hello");
    assert.equal(await applyFallbackGatesV2(ctx, w, 42), 42);
  });

  test("returns falsy value when no fallback entries exist", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }]);
    assert.equal(await applyFallbackGatesV2(ctx, w, 0), 0);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), null);
  });

  test("returns first truthy ref from falsy fallback refs", async () => {
    const ctx = makeCtx({ "m.a": null, "m.b": "found" });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("a") }, gate: "falsy" },
      { expr: { type: "ref", ref: ref("b") }, gate: "falsy" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), "found");
  });

  test("skips falsy refs and falls through to falsy constant", async () => {
    const ctx = makeCtx({ "m.a": 0 });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("a") }, gate: "falsy" },
      { expr: { type: "literal", value: "42" }, gate: "falsy" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), 42);
  });

  test("applies falsy constant when value is falsy", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "literal", value: "default" }, gate: "falsy" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), "default");
    assert.equal(await applyFallbackGatesV2(ctx, w, false), "default");
    assert.equal(await applyFallbackGatesV2(ctx, w, ""), "default");
  });

  test("applies falsy control — continue", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      {
        expr: { type: "control", control: { kind: "continue" } },
        gate: "falsy",
      },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, 0), CONTINUE_SYM);
  });

  test("applies falsy control — break", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      {
        expr: { type: "control", control: { kind: "break" } },
        gate: "falsy",
      },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, false), BREAK_SYM);
  });

  test("applies falsy control — break level 2", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      {
        expr: { type: "control", control: { kind: "break", levels: 2 } },
        gate: "falsy",
      },
    ]);
    const out = await applyFallbackGatesV2(ctx, w, false);
    assert.ok(isLoopControlSignal(out));
    assert.deepStrictEqual(out, { __bridgeControl: "break", levels: 2 });
  });

  test("applies falsy control — throw", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      {
        expr: { type: "control", control: { kind: "throw", message: "boom" } },
        gate: "falsy",
      },
    ]);
    await assert.rejects(() => applyFallbackGatesV2(ctx, w, null), /boom/);
  });
});

describe("applyFallbackGatesV2 — nullish (??)", () => {
  test("passes through a non-nullish value unchanged", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "literal", value: "99" }, gate: "nullish" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, "hello"), "hello");
    assert.equal(await applyFallbackGatesV2(ctx, w, 0), 0);
    assert.equal(await applyFallbackGatesV2(ctx, w, false), false);
    assert.equal(await applyFallbackGatesV2(ctx, w, ""), "");
  });

  test("resolves nullish ref when value is null", async () => {
    const ctx = makeCtx({ "m.fallback": "resolved" });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("fallback") }, gate: "nullish" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), "resolved");
  });

  test("applies nullish constant when value is null", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "literal", value: "99" }, gate: "nullish" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), 99);
    assert.equal(await applyFallbackGatesV2(ctx, w, undefined), 99);
  });
});

describe("applyFallbackGatesV2 — mixed || and ??", () => {
  test("A ?? B || C — nullish then falsy", async () => {
    const ctx = makeCtx({ "m.b": 0, "m.c": "found" });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("b") }, gate: "nullish" },
      { expr: { type: "ref", ref: ref("c") }, gate: "falsy" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), "found");
  });

  test("A || B ?? C — falsy then nullish", async () => {
    const ctx = makeCtx({ "m.b": null, "m.c": "fallback" });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("b") }, gate: "falsy" },
      { expr: { type: "ref", ref: ref("c") }, gate: "nullish" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, ""), "fallback");
  });

  test("four-item chain", async () => {
    const ctx = makeCtx({ "m.b": null, "m.c": null });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("b") }, gate: "nullish" },
      { expr: { type: "ref", ref: ref("c") }, gate: "falsy" },
      { expr: { type: "literal", value: "final" }, gate: "nullish" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), "final");
  });

  test("mixed chain stops when value becomes truthy", async () => {
    const ctx = makeCtx({ "m.b": "good" });
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "ref", ref: ref("b") }, gate: "nullish" },
      { expr: { type: "literal", value: "unused" }, gate: "falsy" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, null), "good");
  });

  test("falsy gate open but nullish gate closed for 0", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([
      { expr: { type: "ref", ref: REF } },
      { expr: { type: "literal", value: "unused" }, gate: "nullish" },
      { expr: { type: "literal", value: "fallback" }, gate: "falsy" },
    ]);
    assert.equal(await applyFallbackGatesV2(ctx, w, 0), "fallback");
  });
});

// ── applyCatchV2 ────────────────────────────────────────────────────────────

describe("applyCatchV2", () => {
  test("returns undefined when no catch handler", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }]);
    assert.equal(await applyCatchV2(ctx, w), undefined);
  });

  test("applies catch value constant", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }], {
      catch: { value: "fallback" },
    });
    assert.equal(await applyCatchV2(ctx, w), "fallback");
  });

  test("resolves catch ref", async () => {
    const ctx = makeCtx({ "m.backup": "backup-value" });
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }], {
      catch: { ref: ref("backup") },
    });
    assert.equal(await applyCatchV2(ctx, w), "backup-value");
  });

  test("applies catch control — continue", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }], {
      catch: { control: { kind: "continue" } },
    });
    assert.equal(await applyCatchV2(ctx, w), CONTINUE_SYM);
  });

  test("applies catch control — break", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }], {
      catch: { control: { kind: "break" } },
    });
    assert.equal(await applyCatchV2(ctx, w), BREAK_SYM);
  });

  test("catch control — throw", async () => {
    const ctx = makeCtx();
    const w = makeV2Wire([{ expr: { type: "ref", ref: REF } }], {
      catch: { control: { kind: "throw", message: "catch-throw" } },
    });
    await assert.rejects(() => applyCatchV2(ctx, w), /catch-throw/);
  });
});

// ── legacyToV2 conversion ───────────────────────────────────────────────────

describe("legacyToV2", () => {
  test("converts constant wire", () => {
    const legacy: WireLegacy = { value: "42", to: REF };
    const v2 = legacyToV2(legacy);
    assert.equal(v2.sources.length, 1);
    assert.equal(v2.sources[0]!.expr.type, "literal");
    assert.equal((v2.sources[0]!.expr as any).value, "42");
    assert.equal(v2.catch, undefined);
  });

  test("converts pull wire with no modifiers", () => {
    const legacy: WireLegacy = { from: ref("x"), to: REF };
    const v2 = legacyToV2(legacy);
    assert.equal(v2.sources.length, 1);
    const expr = v2.sources[0]!.expr;
    assert.equal(expr.type, "ref");
    assert.equal((expr as any).ref.field, "x");
    assert.equal(v2.catch, undefined);
  });

  test("converts pull wire with safe flag", () => {
    const legacy: WireLegacy = { from: ref("x"), to: REF, safe: true };
    const v2 = legacyToV2(legacy);
    const expr = v2.sources[0]!.expr;
    assert.equal(expr.type, "ref");
    assert.equal((expr as any).safe, true);
  });

  test("converts pull wire with fallbacks", () => {
    const legacy: WireLegacy = {
      from: ref("x"),
      to: REF,
      fallbacks: [
        { type: "falsy", ref: ref("a") },
        { type: "nullish", value: "99" },
      ],
    };
    const v2 = legacyToV2(legacy);
    assert.equal(v2.sources.length, 3);
    assert.equal(v2.sources[0]!.gate, undefined); // primary — no gate
    assert.equal(v2.sources[1]!.gate, "falsy");
    assert.equal(v2.sources[1]!.expr.type, "ref");
    assert.equal(v2.sources[2]!.gate, "nullish");
    assert.equal(v2.sources[2]!.expr.type, "literal");
  });

  test("converts pull wire with catch constant", () => {
    const legacy: WireLegacy = { from: ref("x"), to: REF, catchFallback: "err" };
    const v2 = legacyToV2(legacy);
    assert.ok(v2.catch);
    assert.equal("value" in v2.catch, true);
    assert.equal((v2.catch as any).value, "err");
  });

  test("converts pull wire with catch ref", () => {
    const legacy: WireLegacy = {
      from: ref("x"),
      to: REF,
      catchFallbackRef: ref("backup"),
    };
    const v2 = legacyToV2(legacy);
    assert.ok(v2.catch);
    assert.equal("ref" in v2.catch, true);
    assert.equal((v2.catch as any).ref.field, "backup");
  });

  test("converts pull wire with catch control", () => {
    const legacy: WireLegacy = {
      from: ref("x"),
      to: REF,
      catchControl: { kind: "throw", message: "boom" },
    };
    const v2 = legacyToV2(legacy);
    assert.ok(v2.catch);
    assert.equal("control" in v2.catch, true);
    assert.equal((v2.catch as any).control.message, "boom");
  });

  test("converts ternary wire", () => {
    const legacy: WireLegacy = {
      cond: ref("flag"),
      thenRef: ref("a"),
      elseValue: "fallback",
      to: REF,
    };
    const v2 = legacyToV2(legacy);
    assert.equal(v2.sources.length, 1);
    const expr = v2.sources[0]!.expr;
    assert.equal(expr.type, "ternary");
    const ternary = expr as Extract<Expression, { type: "ternary" }>;
    assert.equal(ternary.cond.type, "ref");
    assert.equal(ternary.then.type, "ref");
    assert.equal(ternary.else.type, "literal");
  });

  test("converts condAnd wire", () => {
    const legacy: WireLegacy = {
      condAnd: {
        leftRef: ref("a"),
        rightRef: ref("b"),
        safe: true,
        rightSafe: true,
      },
      to: REF,
    };
    const v2 = legacyToV2(legacy);
    const expr = v2.sources[0]!.expr;
    assert.equal(expr.type, "and");
    const andExpr = expr as Extract<Expression, { type: "and" }>;
    assert.equal(andExpr.leftSafe, true);
    assert.equal(andExpr.rightSafe, true);
  });

  test("converts condOr wire", () => {
    const legacy: WireLegacy = {
      condOr: { leftRef: ref("a"), rightValue: "42" },
      to: REF,
    };
    const v2 = legacyToV2(legacy);
    const expr = v2.sources[0]!.expr;
    assert.equal(expr.type, "or");
    const orExpr = expr as Extract<Expression, { type: "or" }>;
    assert.equal(orExpr.left.type, "ref");
    assert.equal(orExpr.right.type, "literal");
  });

  test("preserves pipe and spread flags", () => {
    const legacy: WireLegacy = {
      from: ref("x"),
      to: REF,
      pipe: true,
      spread: true,
    };
    const v2 = legacyToV2(legacy);
    assert.equal(v2.pipe, true);
    assert.equal(v2.spread, true);
  });
});

// ── v2ToLegacy round-trip ───────────────────────────────────────────────────

describe("v2ToLegacy", () => {
  test("round-trips a constant wire", () => {
    const original: WireLegacy = { value: "42", to: REF };
    const v2 = legacyToV2(original);
    const back = v2ToLegacy(v2);
    assert.equal("value" in back, true);
    assert.equal((back as any).value, "42");
  });

  test("round-trips a pull wire with fallbacks + catch", () => {
    const original: WireLegacy = {
      from: ref("x"),
      to: REF,
      safe: true,
      fallbacks: [
        { type: "falsy", ref: ref("a") },
        { type: "nullish", value: "99" },
      ],
      catchFallback: "err",
    };
    const v2 = legacyToV2(original);
    const back = v2ToLegacy(v2);
    assert.ok("from" in back);
    assert.equal((back as any).from.field, "x");
    assert.equal((back as any).safe, true);
    assert.equal((back as any).fallbacks?.length, 2);
    assert.equal((back as any).fallbacks[0].type, "falsy");
    assert.equal((back as any).fallbacks[1].type, "nullish");
    assert.equal((back as any).catchFallback, "err");
  });

  test("round-trips a ternary wire", () => {
    const original: WireLegacy = {
      cond: ref("flag"),
      thenRef: ref("a"),
      elseValue: "fallback",
      to: REF,
    };
    const v2 = legacyToV2(original);
    const back = v2ToLegacy(v2);
    assert.ok("cond" in back);
    assert.equal((back as any).cond.field, "flag");
    assert.equal((back as any).thenRef.field, "a");
    assert.equal((back as any).elseValue, "fallback");
  });

  test("round-trips a condAnd wire", () => {
    const original: WireLegacy = {
      condAnd: { leftRef: ref("a"), rightRef: ref("b"), safe: true },
      to: REF,
    };
    const v2 = legacyToV2(original);
    const back = v2ToLegacy(v2);
    assert.ok("condAnd" in back);
    assert.equal((back as any).condAnd.leftRef.field, "a");
    assert.equal((back as any).condAnd.rightRef.field, "b");
    assert.equal((back as any).condAnd.safe, true);
  });
});

// ── Behavioral equivalence: V2 gates match legacy gates ─────────────────────

describe("V2 gates match legacy behavior", () => {
  test("falsy gate: converted wire produces same results", async () => {
    const ctx = makeCtx({ "m.a": null, "m.b": "found" });
    const legacyWire: WireLegacy = {
      from: ref("x"),
      to: REF,
      fallbacks: [
        { type: "falsy", ref: ref("a") },
        { type: "falsy", ref: ref("b") },
      ],
    };
    const v2 = legacyToV2(legacyWire);
    assert.equal(await applyFallbackGatesV2(ctx, v2, null), "found");
  });

  test("nullish gate: converted wire produces same results", async () => {
    const ctx = makeCtx({ "m.fallback": "resolved" });
    const legacyWire: WireLegacy = {
      from: ref("x"),
      to: REF,
      fallbacks: [{ type: "nullish", ref: ref("fallback") }],
    };
    const v2 = legacyToV2(legacyWire);
    assert.equal(await applyFallbackGatesV2(ctx, v2, null), "resolved");
    // Non-nullish should pass through
    assert.equal(await applyFallbackGatesV2(ctx, v2, 0), 0);
    assert.equal(await applyFallbackGatesV2(ctx, v2, false), false);
  });

  test("mixed chain: converted wire matches legacy behavior", async () => {
    const ctx = makeCtx({ "m.b": 0, "m.c": "found" });
    const legacyWire: WireLegacy = {
      from: ref("x"),
      to: REF,
      fallbacks: [
        { type: "nullish", ref: ref("b") },
        { type: "falsy", ref: ref("c") },
      ],
    };
    const v2 = legacyToV2(legacyWire);
    assert.equal(await applyFallbackGatesV2(ctx, v2, null), "found");
  });
});
