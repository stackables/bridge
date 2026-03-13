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
import { bridge } from "@stackables/bridge-core";

function getBridge(source: string): Bridge {
  const doc = parseBridge(source);
  const instr = doc.instructions.find((i): i is Bridge => i.kind === "bridge");
  assert.ok(instr, "expected a bridge instruction");
  return instr;
}

function ids(entries: TraversalEntry[]): string[] {
  return entries.map((e) => e.id);
}

// ── Simple wires ────────────────────────────────────────────────────────────

describe("enumerateTraversalIds", () => {
  test("simple pull wire — 1 traversal (primary)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api.label
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const primaries = entries.filter((e) => e.kind === "primary");
    assert.ok(primaries.length >= 2, "at least 2 primary wires");
    assert.ok(
      entries.every((e) => e.kind === "primary"),
      "no fallbacks or catches",
    );
  });

  test("constant wire — 1 traversal (const)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with output as o
        api.mode = "fast"
        o.result <- api.label
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const consts = entries.filter((e) => e.kind === "const");
    assert.equal(consts.length, 1);
    assert.ok(consts[0].id.endsWith("/const"));
  });

  // ── Fallback chains ───────────────────────────────────────────────────────

  test("|| fallback — 2 non-error traversals (primary + fallback)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1 && !e.error,
    );
    assert.equal(labelEntries.length, 2);
    assert.equal(labelEntries[0].kind, "primary");
    assert.equal(labelEntries[1].kind, "fallback");
    assert.equal(labelEntries[1].gateType, "falsy");
    assert.equal(labelEntries[1].fallbackIndex, 0);
  });

  test("?? fallback — 2 non-error traversals (primary + nullish fallback)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.label <- api.label ?? "default"
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1 && !e.error,
    );
    assert.equal(labelEntries.length, 2);
    assert.equal(labelEntries[0].kind, "primary");
    assert.equal(labelEntries[1].kind, "fallback");
    assert.equal(labelEntries[1].gateType, "nullish");
  });

  test("|| || — 3 non-error traversals (primary + 2 fallbacks)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label || "fallback"
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1 && !e.error,
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.lat <- api.lat catch 0
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const latEntries = entries.filter(
      (e) => e.target.includes("lat") && e.target.length === 1,
    );
    assert.equal(latEntries.length, 2);
    assert.equal(latEntries[0].kind, "primary");
    assert.equal(latEntries[1].kind, "catch");
  });

  // ── Problem statement example: || + catch ─────────────────────────────────

  test("o <- i.a || i.b catch i.c — 3 traversals", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.result <- a.value || b.value catch i.fallback
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const resultEntries = entries.filter(
      (e) => e.target.includes("result") && e.target.length === 1,
    );
    assert.equal(resultEntries.length, 3);
    assert.equal(resultEntries[0].kind, "primary");
    assert.equal(resultEntries[1].kind, "fallback");
    assert.equal(resultEntries[2].kind, "catch");
  });

  // ── Error traversal entries ───────────────────────────────────────────────

  test("a.label || b.label — 4 traversals (primary, fallback, primary/error, fallback/error)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.equal(labelEntries.length, 4);
    // Non-error entries come first
    assert.equal(labelEntries[0].kind, "primary");
    assert.ok(!labelEntries[0].error);
    assert.equal(labelEntries[1].kind, "fallback");
    assert.ok(!labelEntries[1].error);
    // Error entries come after
    assert.equal(labelEntries[2].kind, "primary");
    assert.ok(labelEntries[2].error);
    assert.equal(labelEntries[3].kind, "fallback");
    assert.ok(labelEntries[3].error);
  });

  test("a.label || b?.label — 3 traversals (primary, fallback, primary/error)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b?.label
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    assert.equal(labelEntries.length, 3);
    // Non-error entries come first
    assert.equal(labelEntries[0].kind, "primary");
    assert.ok(!labelEntries[0].error);
    assert.equal(labelEntries[1].kind, "fallback");
    assert.ok(!labelEntries[1].error);
    // b?.label has rootSafe — no error entry for fallback
    assert.equal(labelEntries[2].kind, "primary");
    assert.ok(labelEntries[2].error);
  });

  test("a.label || b.label catch 'whatever' — 3 traversals (primary, fallback, catch)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label catch "whatever"
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    // catch absorbs all errors — no error entries for primary or fallback
    assert.equal(labelEntries.length, 3);
    assert.equal(labelEntries[0].kind, "primary");
    assert.ok(!labelEntries[0].error);
    assert.equal(labelEntries[1].kind, "fallback");
    assert.ok(!labelEntries[1].error);
    assert.equal(labelEntries[2].kind, "catch");
    assert.ok(!labelEntries[2].error);
  });

  test("catch with tool ref — catch/error entry added", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label catch b.fallback
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const labelEntries = entries.filter(
      (e) => e.target.includes("label") && e.target.length === 1,
    );
    // primary + catch + catch/error
    assert.equal(labelEntries.length, 3);
    assert.equal(labelEntries[0].kind, "primary");
    assert.ok(!labelEntries[0].error);
    assert.equal(labelEntries[1].kind, "catch");
    assert.ok(!labelEntries[1].error);
    assert.equal(labelEntries[2].kind, "catch");
    assert.ok(labelEntries[2].error);
  });

  test("simple pull wire — primary + primary/error", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api.value
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const resultEntries = entries.filter(
      (e) => e.target.includes("result") && e.target.length === 1,
    );
    assert.equal(resultEntries.length, 2);
    assert.equal(resultEntries[0].kind, "primary");
    assert.ok(!resultEntries[0].error);
    assert.equal(resultEntries[1].kind, "primary");
    assert.ok(resultEntries[1].error);
  });

  test("input ref wire — no error entry (inputs cannot throw)", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api.value
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const qEntries = entries.filter(
      (e) => e.target.includes("q") && e.target.length === 1,
    );
    // i.q is an input ref — no error entry
    assert.equal(qEntries.length, 1);
    assert.equal(qEntries[0].kind, "primary");
    assert.ok(!qEntries[0].error);
  });

  test("safe (?.) wire — no primary/error entry", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api?.value
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const resultEntries = entries.filter(
      (e) => e.target.includes("result") && e.target.length === 1,
    );
    // rootSafe ref — canRefError returns false, no error entry
    assert.equal(resultEntries.length, 1);
    assert.equal(resultEntries[0].kind, "primary");
    assert.ok(!resultEntries[0].error);
  });

  test("error entries have unique IDs", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const allIds = ids(entries);
    const unique = new Set(allIds);
    assert.equal(
      unique.size,
      allIds.length,
      `IDs must be unique: ${JSON.stringify(allIds)}`,
    );
  });

  // ── Array iterators ───────────────────────────────────────────────────────

  test("array block — adds empty-array traversal", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with output as o
        o <- api.items[] as it {
          .id <- it.id
          .name <- it.name
        }
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const emptyArr = entries.filter((e) => e.kind === "empty-array");
    assert.equal(emptyArr.length, 1);
    assert.equal(emptyArr[0].wireIndex, -1);
  });

  // ── Problem statement example: array + ?? ─────────────────────────────────

  test("o.out <- i.array[] as a { .data <- a.a ?? a.b } — 3 traversals", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with output as o
        o <- api.items[] as a {
          .data <- a.a ?? a.b
        }
      }
    `);
    const entries = enumerateTraversalIds(instr);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with output as o
        o <- api.journeys[] as j {
          .label <- j.label
          .legs <- j.legs[] as l {
            .name <- l.name
          }
        }
      }
    `);
    const entries = enumerateTraversalIds(instr);
    const emptyArr = entries.filter((e) => e.kind === "empty-array");
    assert.equal(emptyArr.length, 2, "two array scopes");
  });

  // ── IDs are unique ────────────────────────────────────────────────────────

  test("all IDs within a bridge are unique", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label catch "none"
        o.score <- a.score ?? 0
      }
    `);
    const entries = enumerateTraversalIds(instr);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api.value || "default" catch 0
      }
    `);
    const entries = enumerateTraversalIds(instr);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.label <- i.flag ? api.a : api.b
      }
    `);
    const entries = enumerateTraversalIds(instr);
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
    const simple = getBridge(bridge`
      version 1.5
      bridge Query.simple {
        with api
        with output as o
        o.value <- api.value
      }
    `);
    const complex = getBridge(bridge`
      version 1.5
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
      }
    `);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label catch "none"
        o.score <- a.score ?? 0
      }
    `);
    const manifest = buildTraversalManifest(instr);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api.label
      }
    `);
    const manifest = buildTraversalManifest(instr);
    const result = decodeExecutionTrace(manifest, 0n);
    assert.equal(result.length, 0);
  });

  test("single bit decodes to one entry", () => {
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.result <- api.label || "fallback"
      }
    `);
    const manifest = buildTraversalManifest(instr);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with a
        with b
        with input as i
        with output as o
        a.q <- i.q
        b.q <- i.q
        o.label <- a.label || b.label catch "none"
      }
    `);
    const manifest = buildTraversalManifest(instr);
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
    const instr = getBridge(bridge`
      version 1.5
      bridge Query.demo {
        with api
        with input as i
        with output as o
        api.q <- i.q
        o.label <- i.flag ? api.a : api.b
      }
    `);
    const manifest = buildTraversalManifest(instr);
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
    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
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

    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
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

    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
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

    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
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

    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
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

    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
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

  test("primary error bit is set when tool throws", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.lat <- api.lat
}`);
    try {
      await executeBridge({
        document: doc,
        operation: "Query.demo",
        input: { q: "test" },
        tools: {
          api: async () => {
            throw new Error("boom");
          },
        },
      });
      assert.fail("should have thrown");
    } catch (err: any) {
      const executionTraceId: bigint = err.executionTraceId;
      assert.ok(
        typeof executionTraceId === "bigint",
        "error should carry executionTraceId",
      );

      const instr = doc.instructions.find(
        (i): i is Bridge => i.kind === "bridge",
      )!;
      const manifest = buildTraversalManifest(instr);
      const decoded = decodeExecutionTrace(manifest, executionTraceId);
      const primaryError = decoded.find((e) => e.kind === "primary" && e.error);
      assert.ok(primaryError, "primary error bit should be set");
    }
  });

  test("no error bit when tool succeeds", async () => {
    const doc = getDoc(`version 1.5
bridge Query.demo {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.result <- api.value
}`);
    const { executionTraceId } = await executeBridge({
      document: doc,
      operation: "Query.demo",
      input: { q: "test" },
      tools: { api: async () => ({ value: "ok" }) },
    });

    const instr = doc.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    )!;
    const manifest = buildTraversalManifest(instr);
    const decoded = decodeExecutionTrace(manifest, executionTraceId);
    const errorEntries = decoded.filter((e) => e.error);
    assert.equal(errorEntries.length, 0, "no error bits when tool succeeds");
  });
});
