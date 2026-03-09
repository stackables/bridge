import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseBridge } from "@stackables/bridge-parser";
import {
  enumerateTraversalIds,
  buildTraversalManifest,
  decodeExecutionTrace,
  executeBridge,
} from "@stackables/bridge-core";
import type {
  Bridge,
  TraversalEntry,
  BridgeDocument,
} from "@stackables/bridge-core";

function getBridge(source: string): Bridge {
  const doc = parseBridge(source);
  const bridge = doc.instructions.find((i): i is Bridge => i.kind === "bridge");
  assert.ok(bridge, "expected a bridge instruction");
  return bridge;
}

function ids(entries: TraversalEntry[]): string[] {
  return entries.map((e) => e.id);
}

// ── Simple wires ────────────────────────────────────────────────────────────

describe("enumerateTraversalIds", () => {
  test("simple pull wire — 1 traversal (primary)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.label
}`);
    const entries = enumerateTraversalIds(bridge);
    const primaries = entries.filter((e) => e.kind === "primary");
    assert.ok(primaries.length >= 2, "at least 2 primary wires");
    assert.ok(
      entries.every((e) => e.kind === "primary"),
      "no fallbacks or catches",
    );
  });

  test("constant wire — 1 traversal (const)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with output as o
  api.mode = "fast"
  o.result <- api.label
}`);
    const entries = enumerateTraversalIds(bridge);
    const consts = entries.filter((e) => e.kind === "const");
    assert.equal(consts.length, 1);
    assert.ok(consts[0].id.endsWith("/const"));
  });

  // ── Fallback chains ───────────────────────────────────────────────────────

  test("|| fallback — 2 traversals (primary + fallback)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.label <- a.label || b.label
}`);
    const entries = enumerateTraversalIds(bridge);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.equal(labelEntries.length, 2);
    assert.equal(labelEntries[0].kind, "primary");
    assert.equal(labelEntries[1].kind, "fallback");
    assert.equal(labelEntries[1].gateType, "falsy");
    assert.equal(labelEntries[1].fallbackIndex, 0);
  });

  test("?? fallback — 2 traversals (primary + nullish fallback)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.label <- api.label ?? "default"
}`);
    const entries = enumerateTraversalIds(bridge);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.equal(labelEntries.length, 2);
    assert.equal(labelEntries[0].kind, "primary");
    assert.equal(labelEntries[1].kind, "fallback");
    assert.equal(labelEntries[1].gateType, "nullish");
  });

  test("|| || — 3 traversals (primary + 2 fallbacks)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.label <- a.label || b.label || "fallback"
}`);
    const entries = enumerateTraversalIds(bridge);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.equal(labelEntries.length, 3);
    assert.equal(labelEntries[0].kind, "primary");
    assert.equal(labelEntries[1].kind, "fallback");
    assert.equal(labelEntries[1].fallbackIndex, 0);
    assert.equal(labelEntries[2].kind, "fallback");
    assert.equal(labelEntries[2].fallbackIndex, 1);
  });

  // ── Catch ─────────────────────────────────────────────────────────────────

  test("catch — 2 traversals (primary + catch)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.lat <- api.lat catch 0
}`);
    const entries = enumerateTraversalIds(bridge);
    const latEntries = entries.filter(
      (e) => e.target.includes("lat") && e.target.length === 1,
    );
    assert.equal(latEntries.length, 2);
    assert.equal(latEntries[0].kind, "primary");
    assert.equal(latEntries[1].kind, "catch");
  });

  // ── Problem statement example: || + catch ─────────────────────────────────

  test("o <- i.a || i.b catch i.c — 3 traversals", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.result <- a.value || b.value catch i.fallback
}`);
    const entries = enumerateTraversalIds(bridge);
    const resultEntries = entries.filter(
      (e) => e.target.includes("result") && e.target.length === 1,
    );
    assert.equal(resultEntries.length, 3);
    assert.equal(resultEntries[0].kind, "primary");
    assert.equal(resultEntries[1].kind, "fallback");
    assert.equal(resultEntries[2].kind, "catch");
  });

  // ── Array iterators ───────────────────────────────────────────────────────

  test("array block — adds empty-array traversal", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with output as o
  o <- api.items[] as it {
    .id <- it.id
    .name <- it.name
  }
}`);
    const entries = enumerateTraversalIds(bridge);
    const emptyArr = entries.filter((e) => e.kind === "empty-array");
    assert.equal(emptyArr.length, 1);
    assert.equal(emptyArr[0].wireIndex, -1);
  });

  // ── Problem statement example: array + ?? ─────────────────────────────────

  test("o.out <- i.array[] as a { .data <- a.a ?? a.b } — 3 traversals", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with output as o
  o <- api.items[] as a {
    .data <- a.a ?? a.b
  }
}`);
    const entries = enumerateTraversalIds(bridge);
    // Should have: empty-array + primary(.data) + fallback(.data)
    assert.equal(entries.length, 3);
    const emptyArr = entries.filter((e) => e.kind === "empty-array");
    assert.equal(emptyArr.length, 1);
    const dataEntries = entries.filter((e) =>
      e.target.join(".").includes("data"),
    );
    assert.equal(dataEntries.length, 2);
    assert.equal(dataEntries[0].kind, "primary");
    assert.equal(dataEntries[1].kind, "fallback");
    assert.equal(dataEntries[1].gateType, "nullish");
  });

  // ── Nested arrays ─────────────────────────────────────────────────────────

  test("nested array blocks — 2 empty-array entries", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with output as o
  o <- api.journeys[] as j {
    .label <- j.label
    .legs <- j.legs[] as l {
      .name <- l.name
    }
  }
}`);
    const entries = enumerateTraversalIds(bridge);
    const emptyArr = entries.filter((e) => e.kind === "empty-array");
    assert.equal(emptyArr.length, 2, "two array scopes");
  });

  // ── IDs are unique ────────────────────────────────────────────────────────

  test("all IDs within a bridge are unique", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.label <- a.label || b.label catch "none"
  o.score <- a.score ?? 0
}`);
    const entries = enumerateTraversalIds(bridge);
    const allIds = ids(entries);
    const unique = new Set(allIds);
    assert.equal(
      unique.size,
      allIds.length,
      `IDs must be unique: ${JSON.stringify(allIds)}`,
    );
  });

  // ── TraversalEntry shape ──────────────────────────────────────────────────

  test("entries have correct structure", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.value || "default" catch 0
}`);
    const entries = enumerateTraversalIds(bridge);
    for (const entry of entries) {
      assert.ok(typeof entry.id === "string", "id is string");
      assert.ok(typeof entry.wireIndex === "number", "wireIndex is number");
      assert.ok(Array.isArray(entry.target), "target is array");
      assert.ok(typeof entry.kind === "string", "kind is string");
    }
    const fb = entries.find((e) => e.kind === "fallback");
    assert.ok(fb, "should have a fallback entry");
    assert.equal(fb!.fallbackIndex, 0);
    assert.equal(fb!.gateType, "falsy");
  });

  // ── Conditional wire ──────────────────────────────────────────────────────

  test("conditional (ternary) wire — 2 traversals (then + else)", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.label <- i.flag ? api.a : api.b
}`);
    const entries = enumerateTraversalIds(bridge);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.ok(labelEntries.length >= 2, "at least then + else");
    const then = labelEntries.find((e) => e.kind === "then");
    const els = labelEntries.find((e) => e.kind === "else");
    assert.ok(then, "should have a then entry");
    assert.ok(els, "should have an else entry");
  });

  // ── Total count is a complexity proxy ─────────────────────────────────────

  test("total traversal count reflects complexity", () => {
    const simple = getBridge(`version 1.5
bridge Query.simple {
  with api
  with output as o
  o.value <- api.value
}`);
    const complex = getBridge(`version 1.5
bridge Query.complex {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.x <- a.x || b.x catch "none"
  o.y <- a.y ?? b.y
  o.items <- a.items[] as it {
    .name <- it.name || "anon"
  }
}`);
    const simpleCount = enumerateTraversalIds(simple).length;
    const complexCount = enumerateTraversalIds(complex).length;
    assert.ok(
      complexCount > simpleCount,
      `complex (${complexCount}) should exceed simple (${simpleCount})`,
    );
  });
});

// ── buildTraversalManifest ──────────────────────────────────────────────────

describe("buildTraversalManifest", () => {
  test("is an alias for enumerateTraversalIds", () => {
    assert.strictEqual(buildTraversalManifest, enumerateTraversalIds);
  });

  test("entries have sequential bitIndex starting at 0", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.label <- a.label || b.label catch "none"
  o.score <- a.score ?? 0
}`);
    const manifest = buildTraversalManifest(bridge);
    for (let i = 0; i < manifest.length; i++) {
      assert.equal(
        manifest[i].bitIndex,
        i,
        `entry ${i} should have bitIndex ${i}`,
      );
    }
  });
});

// ── decodeExecutionTrace ────────────────────────────────────────────────────

describe("decodeExecutionTrace", () => {
  test("empty trace returns empty array", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.label
}`);
    const manifest = buildTraversalManifest(bridge);
    const result = decodeExecutionTrace(manifest, 0n);
    assert.equal(result.length, 0);
  });

  test("single bit decodes to one entry", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.label || "fallback"
}`);
    const manifest = buildTraversalManifest(bridge);
    const primary = manifest.find(
      (e) => e.kind === "primary" && e.target.includes("result"),
    );
    assert.ok(primary);
    const result = decodeExecutionTrace(
      manifest,
      1n << BigInt(primary.bitIndex),
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, primary.id);
  });

  test("multiple bits decode to multiple entries", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with a
  with b
  with input as i
  with output as o
  a.q <- i.q
  b.q <- i.q
  o.label <- a.label || b.label catch "none"
}`);
    const manifest = buildTraversalManifest(bridge);
    const labelEntries = manifest.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.equal(labelEntries.length, 3);

    // Set all label bits
    let mask = 0n;
    for (const e of labelEntries) {
      mask |= 1n << BigInt(e.bitIndex);
    }
    const decoded = decodeExecutionTrace(manifest, mask);
    assert.equal(decoded.length, 3);
    assert.deepEqual(
      decoded.map((e) => e.kind),
      ["primary", "fallback", "catch"],
    );
  });

  test("round-trip: build manifest, set bits, decode", () => {
    const bridge = getBridge(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.label <- i.flag ? api.a : api.b
}`);
    const manifest = buildTraversalManifest(bridge);
    const thenEntry = manifest.find((e) => e.kind === "then");
    assert.ok(thenEntry);
    const decoded = decodeExecutionTrace(
      manifest,
      1n << BigInt(thenEntry.bitIndex),
    );
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].kind, "then");
  });
});

// ── End-to-end execution trace ──────────────────────────────────────────────

function getDoc(source: string): BridgeDocument {
  const raw = parseBridge(source);
  return JSON.parse(JSON.stringify(raw)) as BridgeDocument;
}

describe("executionTraceId: end-to-end", () => {
  test("simple pull wire — primary bits are set", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.label
}`);
    const { executionTraceId } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "test" },
      tools: { api: async () => ({ label: "Hello" }) },
    });

    assert.ok(executionTraceId > 0n, "trace should have bits set");

    // Decode and verify
    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(bridge);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const kinds = decoded.map((e) => e.kind);
    assert.ok(kinds.includes("primary"), "should include primary paths");
  });

  test("fallback fires — fallback bit is set", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.label <- api.label || "default"
}`);
    const { executionTraceId, data } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "test" },
      tools: { api: async () => ({ label: null }) },
    });

    assert.equal((data as any).label, "default");

    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(bridge);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const kinds = decoded.map((e) => e.kind);
    assert.ok(kinds.includes("fallback"), "should include fallback path");
  });

  test("catch fires — catch bit is set", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.lat <- api.lat catch 0
}`);
    const { executionTraceId, data } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "test" },
      tools: {
        api: async () => {
          throw new Error("boom");
        },
      },
    });

    assert.equal((data as any).lat, 0);

    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(bridge);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const kinds = decoded.map((e) => e.kind);
    assert.ok(kinds.includes("catch"), "should include catch path");
  });

  test("ternary — then branch bit is set", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.label <- i.flag ? api.a : api.b
}`);
    const { executionTraceId } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "test", flag: true },
      tools: { api: async () => ({ a: "yes", b: "no" }) },
    });

    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(bridge);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const kinds = decoded.map((e) => e.kind);
    assert.ok(kinds.includes("then"), "should include then path");
    assert.ok(!kinds.includes("else"), "should NOT include else path");
  });

  test("ternary — else branch bit is set", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.label <- i.flag ? api.a : api.b
}`);
    const { executionTraceId } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "test", flag: false },
      tools: { api: async () => ({ a: "yes", b: "no" }) },
    });

    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(bridge);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const kinds = decoded.map((e) => e.kind);
    assert.ok(kinds.includes("else"), "should include else path");
    assert.ok(!kinds.includes("then"), "should NOT include then path");
  });

  test("constant wire — const bit is set", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with output as o
  api.mode = "fast"
  o.result <- api.label
}`);
    const { executionTraceId } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: {},
      tools: { api: async () => ({ label: "done" }) },
    });

    const bridge = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(bridge);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const kinds = decoded.map((e) => e.kind);
    assert.ok(kinds.includes("const"), "should include const path");
  });

  test("executionTraceId is a bigint suitable for hex encoding", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.label
}`);
    const { executionTraceId } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "Berlin" },
      tools: { api: async () => ({ label: "Berlin" }) },
    });

    assert.equal(typeof executionTraceId, "bigint");
    const hex = `0x${executionTraceId.toString(16)}`;
    assert.ok(hex.startsWith("0x"), "should be hex-encodable");
  });
});
