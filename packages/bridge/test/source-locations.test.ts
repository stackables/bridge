import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseBridgeChevrotain as parseBridge,
  type Bridge,
  type Wire,
} from "../src/index.ts";

function getBridge(text: string): Bridge {
  const document = parseBridge(text);
  const bridge = document.instructions.find(
    (instruction): instruction is Bridge => instruction.kind === "bridge",
  );
  assert.ok(bridge, "expected a bridge instruction");
  return bridge;
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
    const bridge = getBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.user.name
}`);

    assertLoc(bridge.wires[0], 5, 3);
  });

  it("constant wire loc is populated", () => {
    const bridge = getBridge(`version 1.5
bridge Query.test {
  with output as o
  o.name = "Ada"
}`);

    assertLoc(bridge.wires[0], 4, 3);
  });

  it("ternary wire loc is populated", () => {
    const bridge = getBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.user ? i.user.name : "Anonymous"
}`);

    const ternaryWire = bridge.wires.find((wire) => "cond" in wire);
    assertLoc(ternaryWire, 5, 3);
    assert.equal(ternaryWire?.condLoc?.startLine, 5);
    assert.equal(ternaryWire?.condLoc?.startColumn, 13);
    assert.equal(ternaryWire?.thenLoc?.startLine, 5);
    assert.equal(ternaryWire?.thenLoc?.startColumn, 22);
    assert.equal(ternaryWire?.elseLoc?.startLine, 5);
    assert.equal(ternaryWire?.elseLoc?.startColumn, 36);
  });

  it("desugared template wires inherit the originating source loc", () => {
    const bridge = getBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.label <- "Hello {i.name}"
}`);

    const concatPartWire = bridge.wires.find(
      (wire) => wire.to.field === "concat",
    );
    assertLoc(concatPartWire, 5, 3);
  });

  it("fallback and catch refs carry granular locations", () => {
    const bridge = getBridge(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  alias i.empty.array.error catch i.empty.array.error as clean
  o.message <- i.empty.array?.error ?? i.empty.array.error catch clean
}`);

    const aliasWire = bridge.wires.find(
      (wire) => "to" in wire && wire.to.field === "clean",
    );
    assert.ok(aliasWire && "catchLoc" in aliasWire);
    assert.equal(aliasWire.catchLoc?.startLine, 5);
    assert.equal(aliasWire.catchLoc?.startColumn, 35);

    const messageWire = bridge.wires.find(
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
});
