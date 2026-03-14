import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBridgeChevrotain as parseBridge } from "../src/index.ts";
import type { Bridge, WireLegacy } from "@stackables/bridge-core";
import { v2ToLegacy } from "@stackables/bridge-core";
import { bridge } from "@stackables/bridge-core";

function getBridge(text: string): Bridge {
  const document = parseBridge(text);
  const instr = document.instructions.find(
    (instruction): instruction is Bridge => instruction.kind === "bridge",
  );
  assert.ok(instr, "expected a bridge instruction");
  return instr;
}

function assertLoc(wire: WireLegacy | undefined, line: number, column: number): void {
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

    assertLoc(instr.wires.map(v2ToLegacy)[0], 5, 3);
  });

  it("constant wire loc is populated", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with output as o
        o.name = "Ada"
      }
    `);

    assertLoc(instr.wires.map(v2ToLegacy)[0], 4, 3);
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

    const ternaryWire = instr.wires.map(v2ToLegacy).find((wire) => "cond" in wire);
    assertLoc(ternaryWire, 5, 3);
    assert.equal(ternaryWire?.condLoc?.startLine, 5);
    assert.equal(ternaryWire?.condLoc?.startColumn, 13);
    assert.equal(ternaryWire?.thenLoc?.startLine, 5);
    assert.equal(ternaryWire?.thenLoc?.startColumn, 22);
    assert.equal(ternaryWire?.elseLoc?.startLine, 5);
    assert.equal(ternaryWire?.elseLoc?.startColumn, 36);
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

    const concatPartWire = instr.wires.map(v2ToLegacy).find(
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
        alias i.empty.array.error catch i.empty.array.error as clean
        o.message <- i.empty.array?.error ?? i.empty.array.error catch clean
      }
    `);

    const aliasWire = instr.wires.map(v2ToLegacy).find(
      (wire) => "to" in wire && wire.to.field === "clean",
    );
    assert.ok(aliasWire && "catchLoc" in aliasWire);
    assert.equal(aliasWire.catchLoc?.startLine, 5);
    assert.equal(aliasWire.catchLoc?.startColumn, 35);

    const messageWire = instr.wires.map(v2ToLegacy).find(
      (wire) => "to" in wire && wire.to.path.join(".") === "message",
    );
    assert.ok(
      messageWire && "from" in messageWire && "fallbacks" in messageWire,
    );
    assert.equal(messageWire.fromLoc?.startLine, 6);
    assert.equal(messageWire.fromLoc?.startColumn, 16);
    assert.equal(messageWire.fallbacks?.[0]?.loc?.startLine, 6);
    assert.equal(messageWire.fallbacks?.[0]?.loc?.startColumn, 40);
    assert.equal(messageWire.catchLoc?.startLine, 6);
    assert.equal(messageWire.catchLoc?.startColumn, 66);
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

    const destinationIdWire = instr.wires.map(v2ToLegacy).find(
      (wire) =>
        "to" in wire &&
        wire.to.path.join(".") === "legs.destination.station.id",
    );
    assertLoc(destinationIdWire, 8, 9);
    assert.ok(destinationIdWire && "from" in destinationIdWire);
    assert.equal(destinationIdWire.fromLoc?.startLine, 8);
    assert.equal(destinationIdWire.fromLoc?.startColumn, 16);

    const destinationPlannedTimeWire = instr.wires.map(v2ToLegacy).find(
      (wire) =>
        "to" in wire &&
        wire.to.path.join(".") === "legs.destination.plannedTime",
    );
    assertLoc(destinationPlannedTimeWire, 11, 7);
    assert.ok(
      destinationPlannedTimeWire && "from" in destinationPlannedTimeWire,
    );
    assert.equal(destinationPlannedTimeWire.fromLoc?.startLine, 11);
    assert.equal(destinationPlannedTimeWire.fromLoc?.startColumn, 23);

    const destinationDelayWire = instr.wires.map(v2ToLegacy).find(
      (wire) =>
        "to" in wire &&
        wire.to.path.join(".") === "legs.destination.delayMinutes",
    );
    assert.ok(
      destinationDelayWire &&
        "from" in destinationDelayWire &&
        "fallbacks" in destinationDelayWire,
    );
    assertLoc(destinationDelayWire, 12, 7);
    assert.equal(destinationDelayWire.fallbacks?.[0]?.loc?.startLine, 12);
    assert.equal(destinationDelayWire.fallbacks?.[0]?.loc?.startColumn, 43);
  });
});
