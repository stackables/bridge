import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  compileBridge,
  executeBridge as executeCompiled,
} from "@stackables/bridge-compiler";
import { parseBridge } from "../src/index.ts";
import { forEachEngine } from "./utils/dual-run.ts";

describe("loop scoped tools - invalid cases", () => {
  test("outer bridge tools cannot be wired inside array loops without a local with", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5

bridge Query.processCatalog {
  with output as o
  with context as ctx
  with std.httpCall as http

  o <- ctx.catalog[] as cat {
    http.value <- cat.val
    .val <- http.data
  }
}`),
      /current scope|local with|loop scope|writable/i,
    );
  });

  test("parent loop tools cannot be wired from nested loops", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5

bridge Query.processCatalog {
  with output as o
  with context as ctx

  o <- ctx.catalog[] as cat {
    with std.httpCall as http
    http.value <- cat.val
    .children <- cat.children[] as child {
      http.value <- child.val
      .val <- http.data
    }
  }
}`),
      /current scope|local with|loop scope|writable/i,
    );
  });

  test("loop scoped tools are not visible outside their loop", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5

bridge Query.processCatalog {
  with output as o
  with context as ctx

  o <- ctx.catalog[] as cat {
    with std.httpCall as http
    http.value <- cat.val
    .val <- http.data
  }

  o.last <- http.data
}`),
      /Undeclared handle "http"|not visible|scope/i,
    );
  });
});

describe("loop scoped tools - compiler support", () => {
  test("nested loop-scoped tools compile without falling back", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with std.httpCall as http

    http.value <- cat.val
    .outer <- http.data
    .children <- cat.children[] as child {
      with std.httpCall as http

      http.value <- child.val
      .inner <- http.data
    }
  }
}`;

    const document = parseBridge(bridge);
    assert.doesNotThrow(() =>
      compileBridge(document, { operation: "Query.processCatalog" }),
    );

    const warnings: string[] = [];
    const result = await executeCompiled({
      document,
      operation: "Query.processCatalog",
      tools: {
        std: {
          httpCall: async (params: { value: string }) => ({
            data: `tool:${params.value}`,
          }),
        },
      },
      context: {
        catalog: [
          {
            val: "outer-a",
            children: [{ val: "inner-a1" }, { val: "inner-a2" }],
          },
        ],
      },
      logger: {
        warn: (message: string) => warnings.push(message),
      },
    });

    assert.deepStrictEqual(result.data, [
      {
        outer: "tool:outer-a",
        children: [{ inner: "tool:inner-a1" }, { inner: "tool:inner-a2" }],
      },
    ]);
    assert.deepStrictEqual(warnings, []);
  });

  test("unused repeated tool bindings still compile to distinct synthetic instances", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o
  with std.httpCall as http

  o <- ctx.catalog[] as cat {
    with std.httpCall as http
    .val <- cat.val
  }
}`;

    const document = parseBridge(bridge);
    assert.doesNotThrow(() =>
      compileBridge(document, { operation: "Query.processCatalog" }),
    );

    const warnings: string[] = [];
    const result = await executeCompiled({
      document,
      operation: "Query.processCatalog",
      context: {
        catalog: [{ val: "a" }, { val: "b" }],
      },
      logger: {
        warn: (message: string) => warnings.push(message),
      },
    });

    assert.deepStrictEqual(result.data, [{ val: "a" }, { val: "b" }]);
    assert.deepStrictEqual(warnings, []);
  });
});

forEachEngine("loop scoped tools - valid behavior", (run) => {
  test("tools can be declared and called inside array loops", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with std.httpCall as http

    http.value <- cat.val
    .val <- http.data
  }
}`;

    const result = await run(
      bridge,
      "Query.processCatalog",
      {},
      {
        std: {
          httpCall: async (params: { value: string }) => ({
            data: `tool:${params.value}`,
          }),
        },
      },
      {
        context: {
          catalog: [{ val: "a" }, { val: "b" }],
        },
      },
    );

    assert.deepStrictEqual(result.data, [{ val: "tool:a" }, { val: "tool:b" }]);
  });

  test("nested loops can introduce their own writable tool handles", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o

  o <- ctx.catalog[] as cat {
    with std.httpCall as http

    http.value <- cat.val
    .outer <- http.data
    .children <- cat.children[] as child {
      with std.httpCall as http

      http.value <- child.val
      .inner <- http.data
    }
  }
}`;

    const result = await run(
      bridge,
      "Query.processCatalog",
      {},
      {
        std: {
          httpCall: async (params: { value: string }) => ({
            data: `tool:${params.value}`,
          }),
        },
      },
      {
        context: {
          catalog: [
            {
              val: "outer-a",
              children: [{ val: "inner-a1" }, { val: "inner-a2" }],
            },
          ],
        },
      },
    );

    assert.deepStrictEqual(result.data, [
      {
        outer: "tool:outer-a",
        children: [{ inner: "tool:inner-a1" }, { inner: "tool:inner-a2" }],
      },
    ]);
  });

  test("inner loop-scoped tools shadow outer and bridge level handles", async () => {
    const bridge = `version 1.5

bridge Query.processCatalog {
  with context as ctx
  with output as o
  with std.httpCall as http

  http.value <- ctx.prefix
  o <- ctx.catalog[] as cat {
    with std.httpCall as http

    http.value <- cat.val
    .outer <- http.data
    .children <- cat.children[] as child {
      with std.httpCall as http

      http.value <- child.val
      .inner <- http.data
    }
  }
}`;

    const result = await run(
      bridge,
      "Query.processCatalog",
      {},
      {
        std: {
          httpCall: async (params: { value: string }) => ({
            data: `tool:${params.value}`,
          }),
        },
      },
      {
        context: {
          prefix: "bridge-level",
          catalog: [
            {
              val: "outer-a",
              children: [{ val: "inner-a1" }],
            },
          ],
        },
      },
    );

    assert.deepStrictEqual(result.data, [
      {
        outer: "tool:outer-a",
        children: [{ inner: "tool:inner-a1" }],
      },
    ]);
  });
});
