import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildSchema, execute, parse } from "graphql";
import {
  BridgeRuntimeError,
  bridgeTransform,
  executeBridge,
  formatBridgeError,
  parseBridgeChevrotain as parseBridge,
} from "../src/index.ts";

const bridgeText = `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc memoize
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o.message <- i.empty.array.error
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`;

const bridgeCoalesceText = `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc memoize
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  alias i.empty.array.error catch i.empty.array.error as clean

  o.message <- i.empty.array?.error ?? i.empty.array.error
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`;

const bridgeMissingToolText = `version 1.5

bridge Query.greet {
  with xxx as missing
  with input as i
  with output as o

  o.message <- missing:i.name
}`;

const bridgeThrowFallbackText = `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  with kala as k
  with input as i
  with output as o

  o.message <- i.does?.not?.crash ?? throw "Errore"

  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`;

const bridgePanicFallbackText = `version 1.5

bridge Query.greet {
  with input as i
  with output as o

  o.message <- i.name ?? panic "Fatale"
}`;

function maxCaretCount(formatted: string): number {
  return Math.max(
    0,
    ...formatted.split("\n").map((line) => (line.match(/\^/g) ?? []).length),
  );
}

describe("runtime error formatting", () => {
  test("formatBridgeError underlines the full inclusive source span", () => {
    const sourceLine = "o.message <- i.empty.array.error";
    const formatted = formatBridgeError(
      new BridgeRuntimeError("boom", {
        bridgeSource: sourceLine,
        bridgeFilename: "playground.bridge",
        bridgeLoc: {
          startLine: 1,
          startColumn: 14,
          endLine: 1,
          endColumn: 32,
        },
      }),
    );

    assert.equal(maxCaretCount(formatted), "i.empty.array.error".length);
  });

  test("executeBridge formats runtime errors with bridge source location", async () => {
    const document = parseBridge(bridgeText, {
      filename: "playground.bridge",
    });

    await assert.rejects(
      () =>
        executeBridge({
          document,
          operation: "Query.greet",
          input: { name: "Ada" },
        }),
      (err: unknown) => {
        const formatted = formatBridgeError(err);
        assert.match(
          formatted,
          /Bridge Execution Error: Cannot read properties of undefined \(reading '(array|error)'\)/,
        );
        assert.match(formatted, /playground\.bridge:9:16/);
        assert.match(formatted, /o\.message <- i\.empty\.array\.error/);
        assert.equal(maxCaretCount(formatted), "i.empty.array.error".length);
        return true;
      },
    );
  });

  test("executeBridge formats missing tool errors with bridge source location", async () => {
    const document = parseBridge(bridgeMissingToolText, {
      filename: "playground.bridge",
    });

    await assert.rejects(
      () =>
        executeBridge({
          document,
          operation: "Query.greet",
          input: { name: "Ada" },
        }),
      (err: unknown) => {
        const formatted = formatBridgeError(err);
        assert.match(
          formatted,
          /Bridge Execution Error: No tool found for "xxx"/,
        );
        assert.match(formatted, /playground\.bridge:8:16/);
        assert.match(formatted, /o\.message <- missing:i\.name/);
        assert.equal(maxCaretCount(formatted), "missing:i.name".length);
        return true;
      },
    );
  });

  test("throw fallbacks underline only the throw clause", async () => {
    const document = parseBridge(bridgeThrowFallbackText, {
      filename: "playground.bridge",
    });

    await assert.rejects(
      () =>
        executeBridge({
          document,
          operation: "Query.greet",
          input: { name: "Ada" },
        }),
      (err: unknown) => {
        const formatted = formatBridgeError(err);
        assert.match(formatted, /Bridge Execution Error: Errore/);
        assert.match(formatted, /playground\.bridge:10:38/);
        assert.match(
          formatted,
          /o\.message <- i\.does\?\.not\?\.crash \?\? throw "Errore"/,
        );
        assert.equal(maxCaretCount(formatted), 'throw "Errore"'.length);
        return true;
      },
    );
  });

  test("panic fallbacks underline only the panic clause", async () => {
    const document = parseBridge(bridgePanicFallbackText, {
      filename: "playground.bridge",
    });

    await assert.rejects(
      () =>
        executeBridge({
          document,
          operation: "Query.greet",
          input: {},
        }),
      (err: unknown) => {
        const formatted = formatBridgeError(err);
        assert.match(formatted, /Bridge Execution Error: Fatale/);
        assert.match(formatted, /playground\.bridge:7:26/);
        assert.match(formatted, /o\.message <- i\.name \?\? panic "Fatale"/);
        assert.equal(maxCaretCount(formatted), 'panic "Fatale"'.length);
        return true;
      },
    );
  });

  test("bridgeTransform surfaces formatted runtime errors through GraphQL", async () => {
    const schema = buildSchema(/* GraphQL */ `
      type Query {
        greet(name: String!): Greeting
      }

      type Greeting {
        message: String
        upper: String
        lower: String
      }
    `);

    const transformed = bridgeTransform(
      schema,
      parseBridge(bridgeText, {
        filename: "playground.bridge",
      }),
    );

    const result = await execute({
      schema: transformed,
      document: parse(`{ greet(name: "Ada") { message upper lower } }`),
      contextValue: {},
    });

    assert.ok(result.errors?.length, "expected GraphQL errors");
    const message = result.errors?.[0]?.message ?? "";
    assert.match(
      message,
      /Bridge Execution Error: Cannot read properties of undefined \(reading '(array|error)'\)/,
    );
    assert.match(message, /playground\.bridge:9:16/);
    assert.match(message, /o\.message <- i\.empty\.array\.error/);
  });

  test("coalesce fallback errors highlight the failing fallback branch", async () => {
    const document = parseBridge(bridgeCoalesceText, {
      filename: "playground.bridge",
    });

    await assert.rejects(
      () =>
        executeBridge({
          document,
          operation: "Query.greet",
          input: { name: "Ada" },
        }),
      (err: unknown) => {
        const formatted = formatBridgeError(err);
        assert.match(
          formatted,
          /Bridge Execution Error: Cannot read properties of undefined \(reading 'array'\)/,
        );
        assert.match(formatted, /playground\.bridge:11:16/);
        assert.match(
          formatted,
          /o\.message <- i\.empty\.array\?\.error \?\? i\.empty\.array\.error/,
        );
        return true;
      },
    );
  });
});
