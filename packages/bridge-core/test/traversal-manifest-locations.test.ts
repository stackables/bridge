import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBridgeChevrotain } from "../../bridge-parser/src/index.ts";
import {
  buildTraversalManifest,
  type Bridge,
  type Expression,
  type SourceLocation,
  type TraversalEntry,
  type Wire,
} from "../src/index.ts";
import { bridge } from "@stackables/bridge-core";

function getBridge(text: string): Bridge {
  const document = parseBridgeChevrotain(text);
  const instr = document.instructions.find(
    (instruction): instruction is Bridge => instruction.kind === "bridge",
  );
  assert.ok(instr, "expected a bridge instruction");
  return instr;
}

function assertLoc(
  entry: TraversalEntry | undefined,
  expected: SourceLocation | undefined,
): void {
  assert.ok(entry, "expected traversal entry to exist");
  assert.deepEqual(entry.loc, expected);
}

function isPullWire(wire: Wire): boolean {
  return wire.sources.length >= 1 && wire.sources[0]!.expr.type === "ref";
}

function isTernaryWire(wire: Wire): boolean {
  return wire.sources.length >= 1 && wire.sources[0]!.expr.type === "ternary";
}

describe("buildTraversalManifest source locations", () => {
  it("maps pull, fallback, and catch entries to granular source spans", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        alias clean <- i.empty.array.error catch i.empty.array.error
        o.message <- i.empty.array?.error ?? i.empty.array.error catch clean
      }
    `);

    const pullWires = instr.wires.filter(isPullWire);
    const aliasWire = pullWires.find((wire) => wire.to.field === "clean");
    const messageWire = pullWires.find(
      (wire) => wire.to.path.join(".") === "message",
    );

    assert.ok(aliasWire);
    assert.ok(messageWire);

    const manifest = buildTraversalManifest(instr);
    const msgExpr = messageWire.sources[0]!.expr as Extract<
      Expression,
      { type: "ref" }
    >;
    assertLoc(
      manifest.find((entry) => entry.id === "message/primary"),
      msgExpr.refLoc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "message/fallback:0"),
      messageWire.sources[1]?.loc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "message/catch"),
      messageWire.catch?.loc,
    );
    const aliasExpr = aliasWire.sources[0]!.expr as Extract<
      Expression,
      { type: "ref" }
    >;
    assertLoc(
      manifest.find((entry) => entry.id === "clean/primary"),
      aliasExpr.refLoc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "clean/catch"),
      aliasWire.catch?.loc,
    );
  });

  it("maps ternary branches to then/else spans", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with input as i
        with output as o
        o.name <- i.user ? i.user.name : "Anonymous"
      }
    `);

    const ternaryWire = instr.wires.find(isTernaryWire);
    assert.ok(ternaryWire);

    const ternaryExpr = ternaryWire.sources[0]!.expr as Extract<
      Expression,
      { type: "ternary" }
    >;
    const manifest = buildTraversalManifest(instr);
    assertLoc(
      manifest.find((entry) => entry.id === "name/then"),
      ternaryExpr.thenLoc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "name/else"),
      ternaryExpr.elseLoc,
    );
  });

  it("maps constant entries to the wire span", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with output as o
        o.name = "Ada"
      }
    `);

    const manifest = buildTraversalManifest(instr);
    assertLoc(
      manifest.find((entry) => entry.id === "name/const"),
      instr.wires[0]?.loc,
    );
  });
});
