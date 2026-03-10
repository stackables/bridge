/**
 * Tests for the ToolMetadata `sync` flag:
 *   1. Enforcement: a tool declaring {sync:true} that returns a Promise throws
 *   2. Optimisation: sync tools bypass promise handling in both engines
 *   3. Array maps: whole map turns sync when all element tools are sync
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolMetadata } from "@stackables/bridge-types";
import { forEachEngine } from "./utils/dual-run.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A sync tool that doubles the value */
function doubler(input: { value: number }) {
  return { result: input.value * 2 };
}
doubler.bridge = { sync: true } satisfies ToolMetadata;

/** A sync tool that uppercases a string */
function upper(input: { in: string }) {
  return input.in.toUpperCase();
}
upper.bridge = { sync: true } satisfies ToolMetadata;

/** A sync tool that INCORRECTLY returns a Promise */
function badSync(input: { q: string }) {
  return Promise.resolve({ answer: input.q + "!" });
}
badSync.bridge = { sync: true } satisfies ToolMetadata;

/** A normal async tool for comparison */
async function asyncTool(input: { q: string }) {
  return { answer: input.q + "!" };
}

// ── 1. Enforcement ──────────────────────────────────────────────────────────

forEachEngine("sync tool enforcement", (run) => {
  test("throws when sync tool returns a Promise", async () => {
    const bridgeText = `version 1.5
bridge Query.bad {
  with api as a
  with input as i
  with output as o

  a.q <- i.q
  o.answer <- a.answer
}`;

    await assert.rejects(
      () => run(bridgeText, "Query.bad", { q: "hello" }, { api: badSync }),
      (err: Error) => {
        assert.ok(
          err.message.includes("sync") && err.message.includes("Promise"),
          `Expected sync-promise error, got: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ── 2. Sync tool optimisation ───────────────────────────────────────────────

forEachEngine("sync tool execution", (run) => {
  test("sync tool produces correct result", async () => {
    const bridgeText = `version 1.5
bridge Query.double {
  with doubler as d
  with input as i
  with output as o

  d.value <- i.n
  o.result <- d.result
}`;

    const { data } = await run(
      bridgeText,
      "Query.double",
      { n: 21 },
      { doubler },
    );
    assert.deepStrictEqual(data, { result: 42 });
  });

  test("sync tool used alongside async tool", async () => {
    const bridgeText = `version 1.5
bridge Query.mixed {
  with asyncApi as api
  with doubler as d
  with input as i
  with output as o

  api.q <- i.q
  d.value <- i.n
  o.answer <- api.answer
  o.doubled <- d.result
}`;

    const { data } = await run(
      bridgeText,
      "Query.mixed",
      { q: "hi", n: 5 },
      { asyncApi: asyncTool, doubler },
    );
    assert.deepStrictEqual(data, { answer: "hi!", doubled: 10 });
  });

  test("multiple sync tools in a chain", async () => {
    const bridgeText = `version 1.5
bridge Query.chain {
  with upper as u
  with doubler as d
  with input as i
  with output as o

  u.in <- i.name
  d.value <- i.n
  o.name <- u
  o.doubled <- d.result
}`;

    const { data } = await run(
      bridgeText,
      "Query.chain",
      { name: "alice", n: 7 },
      { upper, doubler },
    );
    assert.deepStrictEqual(data, { name: "ALICE", doubled: 14 });
  });
});

// ── 3. Array map sync optimisation ──────────────────────────────────────────

forEachEngine("sync array map", (run) => {
  test("array map with sync pipe tool per element", async () => {
    const bridgeText = `version 1.5
bridge Query.items {
  with source as src
  with upper as u
  with output as o

  o <- src.items[] as item {
    .label <- u:item.name
    .qty <- item.count
  }
}`;

    const source = () => ({
      items: [
        { name: "widget", count: 3 },
        { name: "gadget", count: 7 },
      ],
    });
    source.bridge = { sync: true } satisfies ToolMetadata;

    const { data } = await run(
      bridgeText,
      "Query.items",
      {},
      { source, upper },
    );
    assert.deepStrictEqual(data, [
      { label: "WIDGET", qty: 3 },
      { label: "GADGET", qty: 7 },
    ]);
  });

  test("sub-field array map with sync pipe tool", async () => {
    const bridgeText = `version 1.5
bridge Query.catalog {
  with api as src
  with doubler as d
  with output as o

  o.title <- src.name
  o.entries <- src.items[] as it {
    .id <- it.item_id
    .doubled <- d:it.price
  }
}`;

    const api = () => ({
      name: "Catalog A",
      items: [
        { item_id: "x1", price: 5 },
        { item_id: "x2", price: 15 },
      ],
    });
    api.bridge = { sync: true } satisfies ToolMetadata;

    // doubler receives { in: price } via pipe, returns { result: price*2 }
    // but the pipe operator takes the whole return value, so we need to adapt
    const doub = (input: { in: number }) => input.in * 2;
    doub.bridge = { sync: true } satisfies ToolMetadata;

    const { data } = await run(
      bridgeText,
      "Query.catalog",
      {},
      { api, doubler: doub },
    );
    assert.deepStrictEqual(data, {
      title: "Catalog A",
      entries: [
        { id: "x1", doubled: 10 },
        { id: "x2", doubled: 30 },
      ],
    });
  });

  test("array map with alias and sync per-element tool", async () => {
    const bridgeText = `version 1.5
bridge Query.enriched {
  with api as src
  with enrich
  with output as o

  o <- src.items[] as it {
    alias enrich:it as e
    .id <- it.item_id
    .label <- e.name
  }
}`;

    const api = () => ({
      items: [{ item_id: 1 }, { item_id: 2 }, { item_id: 3 }],
    });
    api.bridge = { sync: true } satisfies ToolMetadata;

    const enrich = (input: any) => ({
      name: `enriched-${input.in.item_id}`,
    });
    enrich.bridge = { sync: true } satisfies ToolMetadata;

    const { data } = await run(
      bridgeText,
      "Query.enriched",
      {},
      { api, enrich },
    );
    assert.deepStrictEqual(data, [
      { id: 1, label: "enriched-1" },
      { id: 2, label: "enriched-2" },
      { id: 3, label: "enriched-3" },
    ]);
  });

  test("async tool without sync flag works correctly", async () => {
    const bridgeText = `version 1.5
bridge Query.normal {
  with api as a
  with input as i
  with output as o

  a.q <- i.q
  o.answer <- a.answer
}`;

    // Normal async tool should work fine without sync flag
    const { data } = await run(
      bridgeText,
      "Query.normal",
      { q: "world" },
      { api: asyncTool },
    );
    assert.deepStrictEqual(data, { answer: "world!" });
  });
});
