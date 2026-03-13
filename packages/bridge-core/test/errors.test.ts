import { test } from "node:test";
import { formatBridgeError } from "../src/formatBridgeError.ts";
import { BridgeRuntimeError } from "../src/tree-types.ts";
import assert from "node:assert/strict";

function maxCaretCount(formatted: string): number {
  return Math.max(
    0,
    ...formatted.split("\n").map((line) => (line.match(/\^/g) ?? []).length),
  );
}

const FN = "playground.bridge";

test("formatBridgeError underlines the full inclusive source span", () => {
  const sourceLine = "o.message <- i.empty.array.error";
  const formatted = formatBridgeError(
    new BridgeRuntimeError("boom", {
      bridgeLoc: {
        startLine: 1,
        startColumn: 14,
        endLine: 1,
        endColumn: 32,
      },
    }),
    { source: sourceLine, filename: FN },
  );

  assert.equal(maxCaretCount(formatted), "i.empty.array.error".length);
});
