import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBridgeChevrotain } from "../../bridge-parser/src/index.ts";
import {
  buildTraversalManifest,
  type Bridge,
  type Expression,
  type SourceLocation,
  type TraversalEntry,
  type Statement,
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

    assert.ok(instr.body, "bridge should have body");
    const aliasStmt = instr.body!.find(
      (s): s is Extract<Statement, { kind: "alias" }> =>
        s.kind === "alias" && s.name === "clean",
    );
    const messageStmt = instr.body!.find(
      (s): s is Extract<Statement, { kind: "wire" }> =>
        s.kind === "wire" && s.target.path.join(".") === "message",
    );

    assert.ok(aliasStmt);
    assert.ok(messageStmt);

    const manifest = buildTraversalManifest(instr);

    // Body ref entries use expr.loc (the expression's own location span)
    const msgPrimaryExpr = messageStmt.sources[0]!.expr;
    assertLoc(
      manifest.find((entry) => entry.id === "message/primary"),
      msgPrimaryExpr.loc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "message/fallback:0"),
      messageStmt.sources[1]?.loc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "message/catch"),
      messageStmt.catch?.loc,
    );
    const aliasPrimaryExpr = aliasStmt.sources[0]!.expr;
    assertLoc(
      manifest.find((entry) => entry.id === "clean/primary"),
      aliasPrimaryExpr.loc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "clean/catch"),
      aliasStmt.catch?.loc,
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

    assert.ok(instr.body, "bridge should have body");
    const nameStmt = instr.body!.find(
      (s): s is Extract<Statement, { kind: "wire" }> =>
        s.kind === "wire" && s.target.path.join(".") === "name",
    );
    assert.ok(nameStmt);

    const ternaryExpr = nameStmt.sources[0]!.expr as Extract<
      Expression,
      { type: "ternary" }
    >;
    assert.equal(ternaryExpr.type, "ternary");

    const manifest = buildTraversalManifest(instr);
    // Body ternary: thenLoc/elseLoc may not be set, so we fall back to branch expr.loc
    assertLoc(
      manifest.find((entry) => entry.id === "name/then"),
      ternaryExpr.thenLoc ?? ternaryExpr.then.loc,
    );
    assertLoc(
      manifest.find((entry) => entry.id === "name/else"),
      ternaryExpr.elseLoc ?? ternaryExpr.else.loc,
    );
  });

  it("maps constant entries to the statement span", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.test {
        with output as o
        o.name = "Ada"
      }
    `);

    assert.ok(instr.body, "bridge should have body");
    const nameStmt = instr.body!.find(
      (s): s is Extract<Statement, { kind: "wire" }> =>
        s.kind === "wire" && s.target.path.join(".") === "name",
    );
    assert.ok(nameStmt);

    const manifest = buildTraversalManifest(instr);
    assertLoc(
      manifest.find((entry) => entry.id === "name/const"),
      (nameStmt as any).loc,
    );
  });
});
