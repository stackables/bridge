import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { executeBridge, parseBridge } from "../src/index.ts";

function run(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, any> = {},
): Promise<{ data: any; traces: any[] }> {
  const raw = parseBridge(bridgeText);
  const document = JSON.parse(JSON.stringify(raw)) as ReturnType<
    typeof parseBridge
  >;
  return executeBridge({
    document,
    operation,
    input,
    tools,
  });
}

describe("strict scope rules - invalid cases", () => {
  test("tool inputs can be wired only in the scope that imports the tool", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.5

bridge Query.test {
  with std.httpCall as fetch
  with input as i
  with output as o

  o.items <- i.list[] as item {
    fetch {
      .id <- item.id
    }
    .result <- fetch.data
    .sub <- item.list[] as p {
      .more <- item.id
      .result <- fetch.data
    }
  }
}`),
      (error: unknown) => {
        assert.ok(
          error instanceof Error,
          "expected parseBridge to throw an Error",
        );
        assert.ok(
          error.message.length > 0,
          "expected parseBridge to provide a non-empty error message",
        );
        return true;
      },
    );
  });
});

describe("strict scope rules - valid behavior", () => {
  test("nested scopes can pull data from visible parent scopes", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with std.httpCall as fetch
  with input as i
  with output as o

  fetch.id <- i.requestId
  o.items <- i.list[] as item {
    .id <- item.id
    .result <- fetch.data
    .sub <- item.list[] as p {
      .more <- item.id
      .value <- p.value
      .result <- fetch.data
    }
  }
}`;

    const { data } = await run(
      bridge,
      "Query.test",
      {
        requestId: "req-1",
        list: [
          {
            id: "outer-a",
            list: [{ value: "a-1" }, { value: "a-2" }],
          },
          {
            id: "outer-b",
            list: [{ value: "b-1" }],
          },
        ],
      },
      {
        std: {
          httpCall: async (params: { id: string }) => ({
            data: `fetch:${params.id}`,
          }),
        },
      },
    );

    assert.deepStrictEqual(data, {
      items: [
        {
          id: "outer-a",
          result: "fetch:req-1",
          sub: [
            {
              more: "outer-a",
              value: "a-1",
              result: "fetch:req-1",
            },
            {
              more: "outer-a",
              value: "a-2",
              result: "fetch:req-1",
            },
          ],
        },
        {
          id: "outer-b",
          result: "fetch:req-1",
          sub: [
            {
              more: "outer-b",
              value: "b-1",
              result: "fetch:req-1",
            },
          ],
        },
      ],
    });
  });

  test("inner scopes shadow outer tool names during execution", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with std.httpCall as whatever
  with input as i
  with output as o

  whatever.id <- i.requestId
  o.items <- i.list[] as whatever {
    .id <- whatever.id
    .data <- whatever.data
    .sub <- whatever.list[] as whatever {
      .id <- whatever.id
      .data <- whatever.data
    }
  }
}`;

    const { data } = await run(
      bridge,
      "Query.test",
      {
        requestId: "tool-value",
        list: [
          {
            id: "item-a",
            data: "item-a-data",
            list: [{ id: "sub-a1", data: "sub-a1-data" }],
          },
        ],
      },
      {
        "std.httpCall": async (params: { id: string }) => ({
          data: `tool:${params.id}`,
        }),
      },
    );

    assert.deepStrictEqual(data, {
      items: [
        {
          id: "item-a",
          data: "item-a-data",
          sub: [{ id: "sub-a1", data: "sub-a1-data" }],
        },
      ],
    });
  });

  test("nearest scope binding wins during execution when names overlap repeatedly", async () => {
    const bridge = `version 1.5

bridge Query.test {
  with std.httpCall as whatever
  with input as i
  with output as o

  whatever.id <- i.requestId
  o.items <- i.list[] as whatever {
    .value <- whatever.id
    .sub <- whatever.list[] as whatever {
      .value <- whatever.id
      .result <- whatever.data
    }
  }
}`;

    const { data } = await run(
      bridge,
      "Query.test",
      {
        requestId: "tool-value",
        list: [
          {
            id: "outer-a",
            list: [
              { id: "inner-a1", data: "inner-a1-data" },
              { id: "inner-a2", data: "inner-a2-data" },
            ],
          },
        ],
      },
      {
        "std.httpCall": async (params: { id: string }) => ({
          data: `tool:${params.id}`,
        }),
      },
    );

    assert.deepStrictEqual(data, {
      items: [
        {
          value: "outer-a",
          sub: [
            { value: "inner-a1", result: "inner-a1-data" },
            { value: "inner-a2", result: "inner-a2-data" },
          ],
        },
      ],
    });
  });
});
