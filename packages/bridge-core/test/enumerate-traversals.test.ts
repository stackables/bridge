import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseBridge } from "@stackables/bridge-parser";
import {
  buildTraversalManifest,
  decodeExecutionTrace,
  executeBridge,
} from "@stackables/bridge-core";
import type { Bridge, BridgeDocument } from "@stackables/bridge-core";
import { bridge } from "@stackables/bridge-core";

function getBridge(source: string): Bridge {
  const doc = parseBridge(source);
  const instr = doc.instructions.find((i): i is Bridge => i.kind === "bridge");
  assert.ok(instr, "expected a bridge instruction");
  return instr;
}

// ── buildTraversalManifest ──────────────────────────────────────────────────

describe("buildTraversalManifest", () => {
  test("delegates to body-based traversal for bridges with body", () => {
    const src = `version 1.5
bridge Query.foo {
  with input as i
  with output as o
  o.x <- i.x
}`;
    const instr = getBridge(src);
    assert.ok(instr.body, "bridge should have body");
    const manifest = buildTraversalManifest(instr);
    assert.ok(manifest.length > 0, "manifest should have entries");
    // Body-based entries get wireIndex -1
    for (const e of manifest) {
      assert.equal(e.wireIndex, -1, "body entries use wireIndex -1");
    }
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
    assert.deepEqual(decoded.map((e) => e.kind).sort(), [
      "catch",
      "fallback",
      "primary",
    ]);
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
