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

  test("does not mark pipe expression as dead code when its primary entry is active", () => {
    const bridge = getBridge(`version 1.5

bridge Query.searchTrains {
  with input as i
  with output as o
  with std.str.toUpperCase as uc

  o.name <- uc:i.name
}`);

    const manifest = buildTraversalManifest(bridge);
    const primaryEntry = manifest.find((entry) => entry.id === "name/primary");
    assert.ok(primaryEntry, "expected primary manifest entry");
    // Activate only the primary entry (pipe succeeded, no error)
    const activeIds = new Set(
      decodeExecutionTrace(manifest, 1n << BigInt(primaryEntry.bitIndex)).map(
        (entry) => entry.id,
      ),
    );
    // The pipe primary/error entry is a narrower span within the active primary span.
    // It should be suppressed (superseded), not shown as dead code.
    assert.deepEqual(
      collectInactiveTraversalLocations(manifest, activeIds),
      [],
    );
  });

  test("unexecuted nullish fallback branch is shown as dead code", () => {
    // o.value <- i.primary ?? i.fallback
    // When i.primary is not nullish, the ?? fallback is never taken.
    // It must appear as dead code — NOT suppressed just because its loc
    // falls within the active primary's full-wire-span loc.
    const bridge = getBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.value <- i.primary ?? i.fallback
}`);

    const manifest = buildTraversalManifest(bridge);
    const primaryEntry = manifest.find((e) => e.id === "value/primary");
    const fallbackEntry = manifest.find((e) => e.id === "value/fallback:0");
    assert.ok(primaryEntry, "expected value/primary");
    assert.ok(fallbackEntry?.loc, "expected value/fallback:0 with loc");
    // Activate only the primary path (i.primary was not nullish).
    const activeIds = new Set(
      decodeExecutionTrace(manifest, 1n << BigInt(primaryEntry.bitIndex)).map(
        (e) => e.id,
      ),
    );
    const inactiveLocs = collectInactiveTraversalLocations(manifest, activeIds);
    assert.ok(
      inactiveLocs.some(
        (l) =>
          l.startLine === fallbackEntry.loc!.startLine &&
          l.startColumn === fallbackEntry.loc!.startColumn,
      ),
      "fallback loc should be in dead code locations",
    );
  });

  test("ref wire and pipe wire both inactive gray their full wire lines consistently", () => {
    // When two sibling wires are both inactive, both should highlight the full
    // wire statement — not just the RHS expression for the ref wire.
    const bridge = getBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o
  with std.str.toUpperCase as uc

  o.id <- i.user.id
  o.name <- uc:i.user.name
}`);

    const manifest = buildTraversalManifest(bridge);
    const idPrimary = manifest.find((entry) => entry.id === "id/primary");
    const namePrimary = manifest.find((entry) => entry.id === "name/primary");
    assert.ok(idPrimary?.loc, "expected id/primary loc");
    assert.ok(namePrimary?.loc, "expected name/primary loc");
    // Both wire statements begin at the same column ("o.id" / "o.name").
    // After the fix, id/primary should use the full wire loc (matching name/primary),
    // not the narrower RHS expression loc it previously had.
    assert.equal(
      idPrimary.loc.startColumn,
      namePrimary.loc.startColumn,
      "id/primary and name/primary should start at the same column (full wire, not RHS-only)",
    );
  });

  test("scope blocks with no active fields are dimmed entirely", () => {
    const bridge = getBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.legs <- i.items[] as s {
    .origin {
      .id <- s.from.id
      .name <- s.from.name
    }
    .destination {
      .id <- s.to.id
      .name <- s.to.name
    }
  }
}`);

    const manifest = buildTraversalManifest(bridge);
    // Activate only the origin.id and origin.name wires — destination scope is entirely dead.
    const originIdEntry = manifest.find(
      (e) => e.id === "legs.origin.id/primary",
    );
    const originNameEntry = manifest.find(
      (e) => e.id === "legs.origin.name/primary",
    );
    assert.ok(originIdEntry, "expected origin.id entry");
    assert.ok(originNameEntry, "expected origin.name entry");
    const traceBit =
      (1n << BigInt(originIdEntry.bitIndex)) |
      (1n << BigInt(originNameEntry.bitIndex));
    const activeIds = new Set(
      decodeExecutionTrace(manifest, traceBit).map((e) => e.id),
    );

    const inactiveLocs = collectInactiveTraversalLocations(manifest, activeIds);

    // The .destination { ... } scope block should appear as dead code.
    const destinationScopeEntry = manifest.find(
      (e) => e.kind === "scope" && e.loc && inactiveLocs.includes(e.loc),
    );
    assert.ok(
      destinationScopeEntry,
      "expected .destination scope block to be in dead code locations",
    );
  });

  test("scope blocks with at least one active field are not dimmed", () => {
    const bridge = getBridge(`version 1.5

bridge Query.test {
  with input as i
  with output as o

  o.legs <- i.items[] as s {
    .origin {
      .id <- s.from.id
      .name <- s.from.name
    }
  }
}`);

    const manifest = buildTraversalManifest(bridge);
    // Activate only origin.id — scope still has an active descendant.
    const originIdEntry = manifest.find(
      (e) => e.id === "legs.origin.id/primary",
    );
    assert.ok(originIdEntry, "expected origin.id entry");
    const activeIds = new Set(
      decodeExecutionTrace(manifest, 1n << BigInt(originIdEntry.bitIndex)).map(
        (e) => e.id,
      ),
    );

    const inactiveLocs = collectInactiveTraversalLocations(manifest, activeIds);

    // The .origin { ... } scope block itself should NOT be dead code (origin.id is active).
    const originScope = manifest.find((e) => e.kind === "scope");
    assert.ok(originScope?.loc, "expected origin scope entry with loc");
    assert.ok(
      !inactiveLocs.includes(originScope.loc),
      "scope block with an active descendant should not be dimmed",
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
    const thenEntry = manifest.find((entry) => entry.id === "name/then");
    assert.ok(thenEntry, "expected then branch manifest entry");
    const activeIds = new Set(
      decodeExecutionTrace(manifest, 1n << BigInt(thenEntry.bitIndex)).map(
        (entry) => entry.id,
      ),
    );
    const elseEntry = manifest.find((entry) => entry.id === "name/else");

    assert.ok(elseEntry?.loc, "expected else branch source location");
    assert.deepEqual(collectInactiveTraversalLocations(manifest, activeIds), [
      elseEntry.loc,
    ]);
  });
});
