import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "@stackables/bridge-parser";
import { bridge } from "@stackables/bridge-core";
import { v2ToLegacy } from "@stackables/bridge-core";

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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire, "should have a conditional wire");
    assert.ok("cond" in condWire);
    assert.ok(condWire.thenRef, "thenRef should be a NodeRef");
    assert.ok(condWire.elseRef, "elseRef should be a NodeRef");
    assert.deepEqual(condWire.thenRef!.path, ["proPrice"]);
    assert.deepEqual(condWire.elseRef!.path, ["basicPrice"]);
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, '"premium"');
    assert.equal(condWire.elseValue, '"basic"');
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, "20");
    assert.equal(condWire.elseValue, "0");
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.thenValue, "true");
    assert.equal(condWire.elseValue, "false");
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.ok(condWire.thenRef, "thenRef should be NodeRef");
    assert.equal(condWire.elseValue, "null");
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.ok(
      condWire.cond.instance != null && condWire.cond.instance >= 100000,
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.fallbacks?.length, 1);
    assert.equal(condWire.fallbacks![0]!.type, "falsy");
    assert.equal(condWire.fallbacks![0]!.value, "0");
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
    const condWire = instr.wires.map(v2ToLegacy).find((w) => "cond" in w);
    assert.ok(condWire && "cond" in condWire);
    assert.equal(condWire.catchFallback, "-1");
  });
});
