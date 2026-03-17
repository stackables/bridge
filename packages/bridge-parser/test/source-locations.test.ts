import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBridgeChevrotain as parseBridge } from "../src/index.ts";
import type { Bridge, Wire, WireAliasStatement } from "@stackables/bridge-core";
import { bridge } from "@stackables/bridge-core";
import { flatWires } from "./utils/parse-test-utils.ts";

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

    assertLoc(flatWires(instr.body)[0], 5, 3);
  });

  it("constant wire loc is populated", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with output as o
        o.name = "Ada"
      }
    `);

    assertLoc(flatWires(instr.body)[0], 4, 3);
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

    const ternaryWire = flatWires(instr.body).find(
      (wire) => wire.sources[0]?.expr.type === "ternary",
    );
    assertLoc(ternaryWire, 5, 3);
    const ternaryExpr = ternaryWire!.sources[0]!.expr;
    assert.equal(ternaryExpr.type, "ternary");
    if (ternaryExpr.type === "ternary") {
      assert.equal(ternaryExpr.cond.loc?.startLine, 5);
      assert.equal(ternaryExpr.cond.loc?.startColumn, 13);
      assert.equal(ternaryExpr.then.loc?.startLine, 5);
      assert.equal(ternaryExpr.then.loc?.startColumn, 22);
      assert.equal(ternaryExpr.else.loc?.startLine, 5);
      assert.equal(ternaryExpr.else.loc?.startColumn, 36);
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

    const concatWire = flatWires(instr.body).find(
      (wire) => wire.sources[0]?.expr.type === "concat",
    );
    assertLoc(concatWire, 5, 3);
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

    const aliasStmt = instr.body.find(
      (s): s is WireAliasStatement => s.kind === "alias" && s.name === "clean",
    );
    assert.ok(aliasStmt?.catch);
    assert.equal(aliasStmt.catch.loc?.startLine, 5);
    assert.equal(aliasStmt.catch.loc?.startColumn, 44);

    const messageWire = flatWires(instr.body).find(
      (wire) => wire.to.path.join(".") === "message",
    );
    assert.ok(messageWire && messageWire.sources.length >= 2);
    const msgExpr0 = messageWire.sources[0]!.expr;
    assert.equal(
      msgExpr0.type === "ref" ? msgExpr0.loc?.startLine : undefined,
      6,
    );
    assert.equal(
      msgExpr0.type === "ref" ? msgExpr0.loc?.startColumn : undefined,
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

    const destinationIdWire = flatWires(instr.body).find(
      (wire) => wire.to.path.join(".") === "legs.destination.station.id",
    );
    assertLoc(destinationIdWire, 8, 9);
    assert.ok(destinationIdWire);
    const idExpr = destinationIdWire.sources[0]!.expr;
    assert.equal(idExpr.type === "ref" ? idExpr.loc?.startLine : undefined, 8);
    assert.equal(
      idExpr.type === "ref" ? idExpr.loc?.startColumn : undefined,
      16,
    );

    const destinationPlannedTimeWire = flatWires(instr.body).find(
      (wire) => wire.to.path.join(".") === "legs.destination.plannedTime",
    );
    assertLoc(destinationPlannedTimeWire, 11, 7);
    assert.ok(destinationPlannedTimeWire);
    const ptExpr = destinationPlannedTimeWire.sources[0]!.expr;
    assert.equal(ptExpr.type === "ref" ? ptExpr.loc?.startLine : undefined, 11);
    assert.equal(
      ptExpr.type === "ref" ? ptExpr.loc?.startColumn : undefined,
      23,
    );

    const destinationDelayWire = flatWires(instr.body).find(
      (wire) => wire.to.path.join(".") === "legs.destination.delayMinutes",
    );
    assert.ok(destinationDelayWire && destinationDelayWire.sources.length >= 2);
    assertLoc(destinationDelayWire, 12, 7);
    assert.equal(destinationDelayWire.sources[1]!.loc?.startLine, 12);
    assert.equal(destinationDelayWire.sources[1]!.loc?.startColumn, 43);
  });
});
