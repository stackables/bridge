import { BridgeRuntimeError } from "@stackables/bridge-core";
import assert from "node:assert/strict";

function locatedSegment(
  err: BridgeRuntimeError & { bridgeSource?: string },
): string {
  const loc = err.bridgeLoc;
  const source = err.bridgeSource;
  if (!loc || !source) return "<no source location>";
  const line = source.split("\n")[loc.startLine - 1] ?? "";
  return loc.endLine === loc.startLine
    ? line.slice(loc.startColumn - 1, loc.endColumn)
    : line.slice(loc.startColumn - 1);
}

export function assertRuntimeErrorAt(location: string) {
  return (err: any) => {
    assert.ok(err instanceof BridgeRuntimeError);
    assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
    // The caret underlines the `api.body` source reference in `o.result <- api.body`
    assert.equal(locatedSegment(err), location);
  };
}
