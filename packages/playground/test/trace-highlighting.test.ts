import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildTraversalManifest,
  decodeExecutionTrace,
  parseBridgeChevrotain,
  type Bridge,
} from "@stackables/bridge";
import { collectInactiveTraversalLocations } from "../src/lib/trace-highlighting.ts";

function getBridge(source: string): Bridge {
  const document = parseBridgeChevrotain(source);
  const bridge = document.instructions.find(
    (instruction): instruction is Bridge => instruction.kind === "bridge",
  );
  assert.ok(bridge, "expected bridge instruction");
  return bridge;
}

describe("collectInactiveTraversalLocations", () => {
  test("ignores synthetic helper spans that blanket an active authored wire", () => {
    const bridge = getBridge(`version 1.5

bridge Query.evaluate {
  with input as i
  with output as o

  o.approved <- (i.age > 18 and i.verified) or i.role == "ADMIN"
  o.requireMFA <- not (i.verified)
}`);

    const manifest = buildTraversalManifest(bridge);
    const activeIds = new Set(
      decodeExecutionTrace(manifest, 0x1e7n).map((entry) => entry.id),
    );

    assert.deepEqual(
      collectInactiveTraversalLocations(manifest, activeIds),
      [],
    );
  });

  test("keeps granular inactive branch spans when they do not cover active code", () => {
    const bridge = getBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.name <- i.user ? i.user.name : "Anonymous"
}`);

    const manifest = buildTraversalManifest(bridge);
    const activeIds = new Set(
      decodeExecutionTrace(manifest, 1n << 0n).map((entry) => entry.id),
    );
    const elseEntry = manifest.find((entry) => entry.id === "name/else");

    assert.ok(elseEntry?.loc, "expected else branch source location");
    assert.deepEqual(collectInactiveTraversalLocations(manifest, activeIds), [
      elseEntry.loc,
    ]);
  });
});
