import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBridge } from "../../src/index.ts";
import { forEachEngine } from "../utils/dual-run.ts";

test("define handles cannot be memoized at the invocation site", () => {
  assert.throws(
    () =>
      parseBridge(`version 1.5

define formatProfile {
  with output as o

  o.data = null
}

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with formatProfile as profile memoize

    .item <- profile.data
  }
}`),
    /memoize|tool/i,
  );
});

forEachEngine("define blocks interacting with loop scopes", (run) => {
  test("tools inside a define block invoked in a loop correctly scope and memoize", async () => {
    // 1. We declare a macro (define block) that uses a memoized tool.
    // 2. We invoke this macro INSIDE an array loop.
    // 3. This tests whether the engine/AST correctly tracks that `fetch`
    //    transitively belongs to the array loop via the `in` synthetic trunk.
    const bridge = `version 1.5

define formatProfile {
  with input as i
  with output as o
  with std.httpCall as fetch memoize

  fetch.value <- i.userId
  o.data <- fetch.data
}

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with formatProfile as profile
    
    profile.userId <- cat.id
    .item <- profile.data
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
            return { data: `profile:${params.value}` };
          },
        },
      },
      {
        context: {
          // "user-1" is duplicated to test if memoization survives the define boundary
          catalog: [{ id: "user-1" }, { id: "user-2" }, { id: "user-1" }],
        },
      },
    );

    // Assert the data mapped perfectly through the define block
    assert.deepStrictEqual(result.data, [
      { item: "profile:user-1" },
      { item: "profile:user-2" },
      { item: "profile:user-1" },
    ]);

    // Assert memoization successfully deduplicated "user-1"
    // across the array elements, proving the cache pools aligned correctly!
    assert.equal(calls, 2);
  });
});
