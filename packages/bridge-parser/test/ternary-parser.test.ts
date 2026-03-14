import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import { bridge } from "@stackables/bridge-core";

// ── Parser / desugaring tests for ternary syntax ──────────────────────────

describe("ternary: parser", () => {
  test("simple ref ? ref : ref produces a conditional wire", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.pricing {
        with input as i
        with output as o

        o.amount <- i.isPro ? i.proPrice : i.basicPrice
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire, "should have a conditional wire");
    const expr = condWire.sources[0].expr;
    assert.equal(expr.type, "ternary");
    assert.equal(expr.then.type, "ref");
    assert.equal(expr.else.type, "ref");
    assert.deepEqual(expr.then.type === "ref" ? expr.then.ref.path : [], [
      "proPrice",
    ]);
    assert.deepEqual(expr.else.type === "ref" ? expr.else.ref.path : [], [
      "basicPrice",
    ]);
  });

  test("string literal branches produce thenValue / elseValue", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.label {
        with input as i
        with output as o

        o.tier <- i.isPro ? "premium" : "basic"
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    const expr = condWire.sources[0].expr;
    assert.equal(
      expr.then.type === "literal" ? expr.then.value : undefined,
      '"premium"',
    );
    assert.equal(
      expr.else.type === "literal" ? expr.else.value : undefined,
      '"basic"',
    );
  });

  test("numeric literal branches produce thenValue / elseValue", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.pricing {
        with input as i
        with output as o

        o.discount <- i.isPro ? 20 : 0
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    const expr = condWire.sources[0].expr;
    assert.equal(
      expr.then.type === "literal" ? expr.then.value : undefined,
      "20",
    );
    assert.equal(
      expr.else.type === "literal" ? expr.else.value : undefined,
      "0",
    );
  });

  test("boolean literal branches", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.check {
        with input as i
        with output as o

        o.result <- i.cond ? true : false
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    const expr = condWire.sources[0].expr;
    assert.equal(
      expr.then.type === "literal" ? expr.then.value : undefined,
      "true",
    );
    assert.equal(
      expr.else.type === "literal" ? expr.else.value : undefined,
      "false",
    );
  });

  test("null literal branch", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.check {
        with input as i
        with output as o

        o.result <- i.cond ? i.value : null
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    const expr = condWire.sources[0].expr;
    assert.equal(expr.then.type, "ref");
    assert.equal(
      expr.else.type === "literal" ? expr.else.value : undefined,
      "null",
    );
  });

  test("condition with expression chain: i.age >= 18 ? a : b", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.check {
        with input as i
        with output as o

        o.result <- i.age >= 18 ? i.proValue : i.basicValue
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    const expr = condWire.sources[0].expr;
    assert.ok(
      expr.cond.type === "ref" &&
        expr.cond.ref.instance != null &&
        expr.cond.ref.instance >= 100000,
      "cond should be an expression fork result",
    );
    const exprHandle = instr.pipeHandles!.find((ph) =>
      ph.handle.startsWith("__expr_"),
    );
    assert.ok(exprHandle, "should have expression fork");
    assert.equal(exprHandle.baseTrunk.field, "gte");
  });

  test("|| literal fallback stored on conditional wire", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.pricing {
        with input as i
        with output as o

        o.amount <- i.isPro ? i.proPrice : i.basicPrice || 0
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    assert.equal(condWire.sources.length, 2);
    assert.equal(condWire.sources[1].gate, "falsy");
    assert.equal(
      condWire.sources[1].expr.type === "literal"
        ? condWire.sources[1].expr.value
        : undefined,
      "0",
    );
  });

  test("catch literal fallback stored on conditional wire", () => {
    const doc = parseBridge(bridge`
      version 1.5
      bridge Query.pricing {
        with input as i
        with output as o

        o.amount <- i.isPro ? i.proPrice : i.basicPrice catch -1
      }
    `);
    const instr = doc.instructions.find((inst) => inst.kind === "bridge")!;
    const condWire = instr.wires.find(
      (w) => w.sources[0]?.expr.type === "ternary",
    );
    assert.ok(condWire && condWire.sources[0].expr.type === "ternary");
    assert.ok(condWire.catch && "value" in condWire.catch);
    assert.equal(condWire.catch.value, "-1");
  });
});
