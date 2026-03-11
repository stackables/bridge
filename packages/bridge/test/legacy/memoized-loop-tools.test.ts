import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compileBridge,
  executeBridge as executeCompiled,
} from "@stackables/bridge-compiler";
import { parseBridge } from "../../src/index.ts";
import { forEachEngine } from "../utils/dual-run.ts";

describe("memoized loop-scoped tools - invalid cases", () => {
  test("memoize is only valid for tool references", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5

bridge Query.processCatalog {
  with output as o
  with context as ctx memoize

  o <- ctx.catalog
}`),
      /memoize|tool/i,
    );
  });
});

describe("memoized loop-scoped tools - compiler support", () => {
  test("memoized loop-scoped tools compile without falling back", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with std.httpCall as fetchItem memoize

    fetchItem.value <- cat.id
    .item <- fetchItem.data
  }
}`;

    const document = parseBridge(bridge);
    assert.doesNotThrow(() =>
      compileBridge(document, { operation: "Query.processCatalog" }),
    );

    let calls = 0;
    const warnings: string[] = [];
    const result = await executeCompiled({
      document,
      operation: "Query.processCatalog",
      tools: {
        std: {
          httpCall: async (params: { value: string }) => {
            calls++;
            return { data: `item:${params.value}` };
          },
        },
      },
      context: {
        catalog: [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "a" }],
      },
      logger: {
        warn: (message: string) => warnings.push(message),
      },
    });

    assert.deepStrictEqual(result.data, [
      { item: "item:a" },
      { item: "item:a" },
      { item: "item:b" },
      { item: "item:a" },
    ]);
    assert.equal(calls, 2);
    assert.deepStrictEqual(warnings, []);
  });
});

forEachEngine("memoized loop-scoped tools - valid behavior", (run) => {
  test("same inputs reuse the cached result for one memoized handle", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with std.httpCall as fetchItem memoize

    fetchItem.value <- cat.id
    .item <- fetchItem.data
  }
}`;

    let calls = 0;
    const result = await run(
      bridge,
      "Query.processCatalog",
      {},
      {
        std: {
          httpCall: async (params: { value: string }) => {
            calls++;
            return { data: `item:${params.value}` };
          },
        },
      },
      {
        context: {
          catalog: [{ id: "a" }, { id: "a" }, { id: "b" }, { id: "a" }],
        },
      },
    );

    assert.deepStrictEqual(result.data, [
      { item: "item:a" },
      { item: "item:a" },
      { item: "item:b" },
      { item: "item:a" },
    ]);
    assert.equal(calls, 2);
  });

  test("each memoized handle keeps its own cache", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog1[] as cat {
    with std.httpCall as outer memoize

    outer.value <- cat.id
    .outer <- outer.data
    .inner <- ctx.catalog2[] as item {
      with std.httpCall as fetchItem memoize

      fetchItem.value <- item.id
      .item <- fetchItem.data
    }
  }
}`;

    let calls = 0;
    const result = await run(
      bridge,
      "Query.processCatalog",
      {},
      {
        std: {
          httpCall: async (params: { value: string }) => {
            calls++;
            return { data: `item:${params.value}` };
          },
        },
      },
      {
        context: {
          catalog1: [{ id: "same" }, { id: "same" }],
          catalog2: [{ id: "same" }, { id: "same" }],
        },
      },
    );

    assert.deepStrictEqual(result.data, [
      {
        outer: "item:same",
        inner: [{ item: "item:same" }, { item: "item:same" }],
      },
      {
        outer: "item:same",
        inner: [{ item: "item:same" }, { item: "item:same" }],
      },
    ]);
    assert.equal(calls, 2);
  });

  test("memoized handles with the exact same alias at different scope levels maintain isolated caches", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog1[] as cat {
    with std.httpCall as fetch memoize

    fetch.value <- cat.id
    .outer <- fetch.data
    .inner <- ctx.catalog2[] as item {
      # This shadows the outer alias perfectly!
      with std.httpCall as fetch memoize

      fetch.value <- item.id
      .item <- fetch.data
    }
  }
}`;

    let calls = 0;
    const result = await run(
      bridge,
      "Query.processCatalog",
      {},
      {
        std: {
          httpCall: async (params: { value: string }) => {
            calls++;
            return { data: `item:${params.value}` };
          },
        },
      },
      {
        context: {
          catalog1: [{ id: "collision" }],
          catalog2: [{ id: "collision" }],
        },
      },
    );

    // If the cache key relies on the string "fetch", the inner loop
    // will accidentally hit the outer loop's cache and calls will be 1.
    // Because we securely use TrunkKeys, it should be exactly 2!
    assert.deepStrictEqual(result.data, [
      {
        outer: "item:collision",
        inner: [{ item: "item:collision" }],
      },
    ]);
    assert.equal(calls, 2);
  });
});
