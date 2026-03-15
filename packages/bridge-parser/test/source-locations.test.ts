import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBridgeChevrotain as parseBridge } from "../src/index.ts";
import type { Bridge, Wire } from "@stackables/bridge-core";
import { bridge } from "@stackables/bridge-core";

function getBridge(text: string): Bridge {
  const document = parseBridge(text);
  const instr = document.instructions.find(
    (instruction): instruction is Bridge => instruction.kind === "bridge",
  );
  assert.ok(instr, "expected a bridge instruction");
  return instr;
}

function assertLoc(wire: Wire | undefined, line: number, column: number): void {
  assert.ok(wire, "expected wire to exist");
  assert.ok(wire.loc, "expected wire to carry a source location");
  assert.equal(wire.loc.startLine, line);
  assert.equal(wire.loc.startColumn, column);
  assert.ok(wire.loc.endColumn >= wire.loc.startColumn);
}

describe("parser source locations", () => {
  it("pull wire loc is populated", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        o.name <- i.user.name
      }
    `);

    assertLoc(instr.wires[0], 5, 3);
  });

  it("constant wire loc is populated", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with output as o
        o.name = "Ada"
      }
    `);

    assertLoc(instr.wires[0], 4, 3);
  });

  it("ternary wire loc is populated", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        o.name <- i.user ? i.user.name : "Anonymous"
      }
    `);

    const ternaryWire = instr.wires.find(
      (wire) => wire.sources[0]?.expr.type === "ternary",
    );
    assertLoc(ternaryWire, 5, 3);
    const ternaryExpr = ternaryWire!.sources[0]!.expr;
    assert.equal(ternaryExpr.type, "ternary");
    if (ternaryExpr.type === "ternary") {
      assert.equal(ternaryExpr.condLoc?.startLine, 5);
      assert.equal(ternaryExpr.condLoc?.startColumn, 13);
      assert.equal(ternaryExpr.thenLoc?.startLine, 5);
      assert.equal(ternaryExpr.thenLoc?.startColumn, 22);
      assert.equal(ternaryExpr.elseLoc?.startLine, 5);
      assert.equal(ternaryExpr.elseLoc?.startColumn, 36);
    }
  });

  it("desugared template wires inherit the originating source loc", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        o.label <- "Hello {i.name}"
      }
    `);

    const concatPartWire = instr.wires.find(
      (wire) => wire.to.field === "concat",
    );
    assertLoc(concatPartWire, 5, 3);
  });

  it("fallback and catch refs carry granular locations", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        alias clean <- i.empty.array.error catch i.empty.array.error
        o.message <- i.empty.array?.error ?? i.empty.array.error catch clean
      }
    `);

    const aliasWire = instr.wires.find((wire) => wire.to.field === "clean");
    assert.ok(aliasWire?.catch);
    assert.equal(aliasWire.catch.loc?.startLine, 5);
    assert.equal(aliasWire.catch.loc?.startColumn, 45);

    const messageWire = instr.wires.find(
      (wire) => wire.to.path.join(".") === "message",
    );
    assert.ok(messageWire && messageWire.sources.length >= 2);
    const msgExpr0 = messageWire.sources[0]!.expr;
    assert.equal(
      msgExpr0.type === "ref" ? msgExpr0.refLoc?.startLine : undefined,
      6,
    );
    assert.equal(
      msgExpr0.type === "ref" ? msgExpr0.refLoc?.startColumn : undefined,
      16,
    );
    assert.equal(messageWire.sources[1]!.loc?.startLine, 6);
    assert.equal(messageWire.sources[1]!.loc?.startColumn, 40);
    assert.equal(messageWire.catch?.loc?.startLine, 6);
    assert.equal(messageWire.catch?.loc?.startColumn, 66);
  });

  it("element scope wires in nested blocks carry source locations", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        o.legs <- i.legs[] as s {
          .destination {
            .station {
              .id <- s.arrival.station.id
              .name <- s.arrival.station.name
            }
            .plannedTime <- s.arrival.arrival
            .delayMinutes <- s.arrival.delay || 0
          }
        }
      }
    `);

    const destinationIdWire = instr.wires.find(
      (wire) => wire.to.path.join(".") === "legs.destination.station.id",
    );
    assertLoc(destinationIdWire, 8, 9);
    assert.ok(destinationIdWire);
    const idExpr = destinationIdWire.sources[0]!.expr;
    assert.equal(
      idExpr.type === "ref" ? idExpr.refLoc?.startLine : undefined,
      8,
    );
    assert.equal(
      idExpr.type === "ref" ? idExpr.refLoc?.startColumn : undefined,
      16,
    );

    const destinationPlannedTimeWire = instr.wires.find(
      (wire) => wire.to.path.join(".") === "legs.destination.plannedTime",
    );
    assertLoc(destinationPlannedTimeWire, 11, 7);
    assert.ok(destinationPlannedTimeWire);
    const ptExpr = destinationPlannedTimeWire.sources[0]!.expr;
    assert.equal(
      ptExpr.type === "ref" ? ptExpr.refLoc?.startLine : undefined,
      11,
    );
    assert.equal(
      ptExpr.type === "ref" ? ptExpr.refLoc?.startColumn : undefined,
      23,
    );

    const destinationDelayWire = instr.wires.find(
      (wire) => wire.to.path.join(".") === "legs.destination.delayMinutes",
    );
    assert.ok(destinationDelayWire && destinationDelayWire.sources.length >= 2);
    assertLoc(destinationDelayWire, 12, 7);
    assert.equal(destinationDelayWire.sources[1]!.loc?.startLine, 12);
    assert.equal(destinationDelayWire.sources[1]!.loc?.startColumn, 43);
  });
});
