import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  executeBridgeStream,
  isStreamHandle,
} from "../src/index.ts";
import type {
  StreamPayload,
  StreamInitialPayload,
  StreamIncrementalPayload,
} from "../src/index.ts";
import { forEachEngine } from "./_dual-run.ts";

// node:test describe is re-exported via forEachEngine; import for stream-only tests
import { describe } from "node:test";

// ── Helpers ──────────────────────────────────────────────────────────────────

function parse(bridgeText: string) {
  const raw = parseBridge(bridgeText);
  return JSON.parse(JSON.stringify(raw)) as ReturnType<typeof parseBridge>;
}

async function collectPayloads<T = unknown>(
  stream: AsyncGenerator<StreamPayload<T>, void, undefined>,
): Promise<StreamPayload<T>[]> {
  const payloads: StreamPayload<T>[] = [];
  for await (const payload of stream) {
    payloads.push(payload);
    if (!payload.hasNext) break;
  }
  return payloads;
}

// ── Stream tool factories ────────────────────────────────────────────────────

function createStreamTool(items: unknown[]) {
  async function* streamTool() {
    for (const item of items) {
      yield item;
    }
  }
  streamTool.bridge = { stream: true } as const;
  return streamTool;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe("executeBridgeStream", () => {
  const simpleBridge = `version 1.5
bridge Query.search {
  with searchApi as api
  with input as i
  with output as o

  api.query <- i.query
  o.name <- api.name
  o.items <- api.items
}`;

  describe("no stream tools — single payload", () => {
    test("returns single payload with hasNext: false", async () => {
      const tools = {
        searchApi: async () => ({
          name: "Results",
          items: [{ sku: "A" }, { sku: "B" }],
        }),
      };

      const document = parse(simpleBridge);
      const stream = executeBridgeStream({
        document,
        operation: "Query.search",
        input: { query: "shoes" },
        tools,
      });

      const payloads = await collectPayloads(stream);
      assert.equal(payloads.length, 1);

      const first = payloads[0]! as StreamInitialPayload;
      assert.equal("data" in first, true);
      assert.equal(first.hasNext, false);
      assert.deepEqual(first.data, {
        name: "Results",
        items: [{ sku: "A" }, { sku: "B" }],
      });
    });
  });

  describe("stream tool — direct output wiring", () => {
    const streamBridge = `version 1.5
bridge Query.products {
  with productStream as ps
  with staticInfo as info
  with input as i
  with output as o

  ps.query <- i.query
  info.category <- i.category
  o.title <- info.title
  o.items <- ps
}`;

    test("yields initial data then incremental items", async () => {
      const streamItems = [
        { sku: "PROD-001", name: "Widget" },
        { sku: "PROD-002", name: "Gadget" },
        { sku: "PROD-003", name: "Doohickey" },
      ];

      const productStream = createStreamTool(streamItems);
      const tools = {
        productStream,
        staticInfo: (input: { category: string }) => ({
          title: `${input.category} Products`,
        }),
      };

      const document = parse(streamBridge);
      const stream = executeBridgeStream({
        document,
        operation: "Query.products",
        input: { query: "all", category: "Electronics" },
        tools,
      });

      const payloads = await collectPayloads(stream);

      // First payload should have data with items: []
      const initial = payloads[0]! as StreamInitialPayload;
      assert.equal("data" in initial, true);
      assert.equal(initial.hasNext, true);
      assert.deepEqual((initial.data as any).title, "Electronics Products");
      assert.deepEqual((initial.data as any).items, []);

      // Subsequent payloads should have incremental items
      const incrementals = payloads.slice(1) as StreamIncrementalPayload[];
      assert.ok(incrementals.length > 0, "Should have incremental payloads");

      // Collect all items from incremental payloads
      const allItems: unknown[] = [];
      for (const inc of incrementals) {
        if (inc.incremental) {
          for (const entry of inc.incremental) {
            allItems.push(...entry.items);
          }
        }
      }
      assert.deepEqual(allItems, streamItems);

      // Last payload should have hasNext: false
      const last = payloads[payloads.length - 1]!;
      assert.equal(last.hasNext, false);
    });

    test("stream with single item", async () => {
      const productStream = createStreamTool([{ sku: "ONLY-1" }]);
      const tools = {
        productStream,
        staticInfo: () => ({ title: "One Item" }),
      };

      const document = parse(streamBridge);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.products",
          input: { query: "one", category: "Test" },
          tools,
        }),
      );

      const initial = payloads[0]! as StreamInitialPayload;
      assert.deepEqual((initial.data as any).items, []);
      assert.equal(initial.hasNext, true);

      // Should eventually get the single item
      const allItems: unknown[] = [];
      for (const p of payloads.slice(1)) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allItems.push(...entry.items);
          }
        }
      }
      assert.deepEqual(allItems, [{ sku: "ONLY-1" }]);
    });

    test("empty stream yields only initial payload", async () => {
      const productStream = createStreamTool([]);
      const tools = {
        productStream,
        staticInfo: () => ({ title: "Empty" }),
      };

      const document = parse(streamBridge);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.products",
          input: { query: "none", category: "Test" },
          tools,
        }),
      );

      // With an empty stream generator, the handle is still detected,
      // so initial has hasNext: true, then a final payload with hasNext: false
      const initial = payloads[0]! as StreamInitialPayload;
      assert.deepEqual((initial.data as any).items, []);

      const last = payloads[payloads.length - 1]!;
      assert.equal(last.hasNext, false);
    });
  });

  describe("incremental payload format", () => {
    const streamBridge = `version 1.5
bridge Query.feed {
  with feedStream as fs
  with output as o

  o.entries <- fs
}`;

    test("incremental items have correct path and index", async () => {
      const feedStream = createStreamTool(["a", "b", "c"]);

      const document = parse(streamBridge);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.feed",
          input: {},
          tools: { feedStream },
        }),
      );

      const incrementals = payloads.filter(
        (p): p is StreamIncrementalPayload => "incremental" in p,
      );

      // Each incremental item should reference path ["entries", index]
      let index = 0;
      for (const inc of incrementals) {
        for (const entry of inc.incremental) {
          assert.deepEqual(entry.path, ["entries", index]);
          index++;
        }
      }
    });
  });

  describe("stream tool with input wiring", () => {
    const bridgeText = `version 1.5
bridge Query.aiResponse {
  with aiStream as ai
  with input as i
  with output as o

  ai.prompt <- i.prompt
  ai.model <- i.model
  o.tokens <- ai
}`;

    test("stream tool receives wired input", async () => {
      let receivedInput: any;
      async function* aiStream(input: { prompt: string; model: string }) {
        receivedInput = input;
        yield { token: "Hello" };
        yield { token: " world" };
      }
      aiStream.bridge = { stream: true } as const;

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.aiResponse",
          input: { prompt: "Hi", model: "gpt-4" },
          tools: { aiStream },
        }),
      );

      assert.deepEqual(receivedInput, { prompt: "Hi", model: "gpt-4" });

      const allTokens: unknown[] = [];
      for (const p of payloads) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allTokens.push(...entry.items);
          }
        }
      }
      assert.deepEqual(allTokens, [{ token: "Hello" }, { token: " world" }]);
    });
  });

  describe("abort signal", () => {
    test("stops stream iteration when aborted", async () => {
      const controller = new AbortController();

      async function* slowStream() {
        yield { id: 1 };
        // Signal abort after first yield
        controller.abort();
        yield { id: 2 };
        yield { id: 3 };
      }
      slowStream.bridge = { stream: true } as const;

      const bridgeText = `version 1.5
bridge Query.data {
  with slowStream as s
  with output as o
  o.items <- s
}`;

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.data",
          input: {},
          tools: { slowStream },
          signal: controller.signal,
        }),
      );

      // Should have initial + at most a few incrementals before abort
      const initial = payloads[0]! as StreamInitialPayload;
      assert.equal("data" in initial, true);
    });
  });

  describe("isStreamHandle", () => {
    test("returns false for non-stream values", () => {
      assert.equal(isStreamHandle(null), false);
      assert.equal(isStreamHandle(undefined), false);
      assert.equal(isStreamHandle(42), false);
      assert.equal(isStreamHandle("hello"), false);
      assert.equal(isStreamHandle({}), false);
      assert.equal(isStreamHandle([]), false);
    });
  });

  describe("traces and executionTraceId", () => {
    test("initial payload includes traces", async () => {
      const bridgeText = `version 1.5
bridge Query.simple {
  with myTool as t
  with output as o
  o.value <- t
}`;
      const myTool = () => 42;
      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.simple",
          input: {},
          tools: { myTool },
        }),
      );

      const initial = payloads[0]! as StreamInitialPayload;
      assert.ok("traces" in initial);
      assert.ok("executionTraceId" in initial);
    });
  });

  describe("array mapping on streamed events", () => {
    test("nested field: maps streamed items through element wires", async () => {
      const bridgeText = `version 1.5
bridge Query.products {
  with productStream as ps
  with output as o

  o.items <- ps[] as item {
    .name <- item.rawName
    .sku  <- item.rawSku
  }
}`;
      const streamItems = [
        { rawName: "Widget", rawSku: "W-001" },
        { rawName: "Gadget", rawSku: "G-002" },
        { rawName: "Doohickey", rawSku: "D-003" },
      ];
      const productStream = createStreamTool(streamItems);

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.products",
          input: {},
          tools: { productStream },
        }),
      );

      // Initial payload should have items: []
      const initial = payloads[0]! as StreamInitialPayload;
      assert.equal("data" in initial, true);
      assert.equal(initial.hasNext, true);
      assert.deepEqual((initial.data as any).items, []);

      // Incremental payloads should have mapped items
      const allItems: unknown[] = [];
      for (const p of payloads.slice(1)) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allItems.push(...entry.items);
          }
        }
      }

      // Items should be transformed through array mapping
      assert.deepEqual(allItems, [
        { name: "Widget", sku: "W-001" },
        { name: "Gadget", sku: "G-002" },
        { name: "Doohickey", sku: "D-003" },
      ]);
    });

    test("root-level: maps streamed items at output root", async () => {
      const bridgeText = `version 1.5
bridge Query.labels {
  with labelStream as ls
  with output as o

  o <- ls[] as item {
    .label <- item.text
    .id    <- item.key
  }
}`;
      const streamItems = [
        { text: "Alpha", key: "a" },
        { text: "Beta", key: "b" },
      ];
      const labelStream = createStreamTool(streamItems);

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.labels",
          input: {},
          tools: { labelStream },
        }),
      );

      const initial = payloads[0]! as StreamInitialPayload;
      assert.equal(initial.hasNext, true);
      assert.deepEqual(initial.data, []);

      const allItems: unknown[] = [];
      for (const p of payloads.slice(1)) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allItems.push(...entry.items);
          }
        }
      }

      assert.deepEqual(allItems, [
        { label: "Alpha", id: "a" },
        { label: "Beta", id: "b" },
      ]);
    });

    test("mixed: static fields alongside mapped stream", async () => {
      const bridgeText = `version 1.5
bridge Query.catalog {
  with meta as m
  with productStream as ps
  with output as o

  o.title <- m.title
  o.items <- ps[] as item {
    .name <- item.rawName
  }
}`;
      const productStream = createStreamTool([
        { rawName: "Item A" },
        { rawName: "Item B" },
      ]);
      const meta = () => ({ title: "My Catalog" });

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.catalog",
          input: {},
          tools: { productStream, meta },
        }),
      );

      const initial = payloads[0]! as StreamInitialPayload;
      assert.deepEqual((initial.data as any).title, "My Catalog");
      assert.deepEqual((initial.data as any).items, []);
      assert.equal(initial.hasNext, true);

      const allItems: unknown[] = [];
      for (const p of payloads.slice(1)) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allItems.push(...entry.items);
          }
        }
      }

      assert.deepEqual(allItems, [{ name: "Item A" }, { name: "Item B" }]);
    });

    test("empty stream with array mapping yields no incremental items", async () => {
      const bridgeText = `version 1.5
bridge Query.empty {
  with emptyStream as es
  with output as o

  o.items <- es[] as item {
    .name <- item.rawName
  }
}`;
      const emptyStream = createStreamTool([]);

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.empty",
          input: {},
          tools: { emptyStream },
        }),
      );

      const initial = payloads[0]! as StreamInitialPayload;
      assert.deepEqual((initial.data as any).items, []);

      const last = payloads[payloads.length - 1]!;
      assert.equal(last.hasNext, false);

      // No actual items should be delivered incrementally
      const allItems: unknown[] = [];
      for (const p of payloads) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allItems.push(...entry.items);
          }
        }
      }
      assert.deepEqual(allItems, []);
    });

    test("subtool inside array mapping on stream", async () => {
      const bridgeText = `version 1.5
bridge Query.catalog {
  with meta as m
  with productStream as ps
  with output as o

  o.title <- m.title
  o.items <- ps[] as item {
    with asynctool as t
    t.in <- item.rawName
    .name <- t.rawValue
  }
}`;
      const productStream = createStreamTool([
        { rawName: "Widget" },
        { rawName: "Gadget" },
      ]);
      const meta = () => ({ title: "My Catalog" });
      const asynctool = async (input: { in: string }) => ({
        rawValue: input.in.toUpperCase(),
      });

      const document = parse(bridgeText);
      const payloads = await collectPayloads(
        executeBridgeStream({
          document,
          operation: "Query.catalog",
          input: {},
          tools: { productStream, meta, asynctool },
        }),
      );

      const initial = payloads[0]! as StreamInitialPayload;
      assert.deepEqual((initial.data as any).title, "My Catalog");
      assert.deepEqual((initial.data as any).items, []);
      assert.equal(initial.hasNext, true);

      const allItems: unknown[] = [];
      for (const p of payloads.slice(1)) {
        if ("incremental" in p) {
          for (const entry of p.incremental) {
            allItems.push(...entry.items);
          }
        }
      }

      assert.deepEqual(allItems, [{ name: "WIDGET" }, { name: "GADGET" }]);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Dual-engine tests (runtime + compiled)
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("stream tools — eager consumption", (run) => {
  test("direct stream output consumed into array", async () => {
    const itemStream = createStreamTool([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const { data } = await run(
      `version 1.5
bridge Query.items {
  with itemStream as s
  with input as i
  with output as o

  s.query <- i.query
  o.items <- s
}`,
      "Query.items",
      { query: "test" },
      { itemStream },
    );
    assert.deepEqual(data, { items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  });

  test("array mapping on stream items", async () => {
    const productStream = createStreamTool([
      { rawName: "Widget" },
      { rawName: "Gadget" },
    ]);
    const { data } = await run(
      `version 1.5
bridge Query.products {
  with productStream as ps
  with output as o

  o.items <- ps[] as item {
    .name <- item.rawName
  }
}`,
      "Query.products",
      {},
      { productStream },
    );
    assert.deepEqual(data, {
      items: [{ name: "Widget" }, { name: "Gadget" }],
    });
  });

  test("subtool inside array mapping on stream", async () => {
    const productStream = createStreamTool([
      { rawName: "Widget" },
      { rawName: "Gadget" },
    ]);
    const meta = () => ({ title: "My Catalog" });
    const asynctool = async (input: { in: string }) => ({
      rawValue: input.in.toUpperCase(),
    });
    const { data } = await run(
      `version 1.5
bridge Query.catalog {
  with meta as m
  with productStream as ps
  with output as o

  o.title <- m.title
  o.items <- ps[] as item {
    with asynctool as t
    t.in <- item.rawName
    .name <- t.rawValue
  }
}`,
      "Query.catalog",
      {},
      { productStream, meta, asynctool },
    );
    assert.deepEqual(data, {
      title: "My Catalog",
      items: [{ name: "WIDGET" }, { name: "GADGET" }],
    });
  });
});
