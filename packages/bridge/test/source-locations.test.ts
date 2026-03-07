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
});
