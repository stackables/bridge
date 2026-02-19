import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.js";
import { builtinTools } from "../src/tools/index.js";
import { upperCase } from "../src/tools/upper-case.js";
import { lowerCase } from "../src/tools/lower-case.js";
import { findObject } from "../src/tools/find-object.js";
import { pickFirst } from "../src/tools/pick-first.js";
import { toArray } from "../src/tools/to-array.js";
import { createHttpCall } from "../src/tools/http-call.js";
import { createGateway } from "./_gateway.js";

// ── Unit tests for individual tools ─────────────────────────────────────────

describe("upperCase tool", () => {
  test("converts string to uppercase", () => {
    assert.equal(upperCase({ in: "hello" }), "HELLO");
  });

  test("handles empty string", () => {
    assert.equal(upperCase({ in: "" }), "");
  });

  test("handles already uppercase", () => {
    assert.equal(upperCase({ in: "HELLO" }), "HELLO");
  });

  test("handles mixed case with numbers", () => {
    assert.equal(upperCase({ in: "abc123def" }), "ABC123DEF");
  });
});

describe("lowerCase tool", () => {
  test("converts string to lowercase", () => {
    assert.equal(lowerCase({ in: "HELLO" }), "hello");
  });

  test("handles empty string", () => {
    assert.equal(lowerCase({ in: "" }), "");
  });

  test("handles already lowercase", () => {
    assert.equal(lowerCase({ in: "hello" }), "hello");
  });

  test("handles mixed case with symbols", () => {
    assert.equal(lowerCase({ in: "Hello-World_123" }), "hello-world_123");
  });
});

describe("findObject tool", () => {
  const data = [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
    { id: 3, name: "Charlie", role: "user" },
  ];

  test("finds by single criterion", () => {
    const result = findObject({ in: data, name: "Bob" });
    assert.deepEqual(result, { id: 2, name: "Bob", role: "user" });
  });

  test("finds by multiple criteria", () => {
    const result = findObject({ in: data, role: "user", name: "Charlie" });
    assert.deepEqual(result, { id: 3, name: "Charlie", role: "user" });
  });

  test("returns undefined when no match", () => {
    const result = findObject({ in: data, name: "Dave" });
    assert.equal(result, undefined);
  });

  test("returns first match when multiple match", () => {
    const result = findObject({ in: data, role: "user" });
    assert.deepEqual(result, { id: 2, name: "Bob", role: "user" });
  });

  test("handles empty array", () => {
    const result = findObject({ in: [], name: "Alice" });
    assert.equal(result, undefined);
  });
});

describe("pickFirst tool", () => {
  test("returns first element", () => {
    assert.equal(pickFirst({ in: [10, 20, 30] }), 10);
  });

  test("returns undefined for empty array", () => {
    assert.equal(pickFirst({ in: [] }), undefined);
  });

  test("returns single element", () => {
    assert.deepEqual(pickFirst({ in: [{ id: 1 }] }), { id: 1 });
  });

  test("strict mode: passes with exactly one element", () => {
    assert.equal(pickFirst({ in: [42], strict: true }), 42);
  });

  test("strict mode: throws on empty array", () => {
    assert.throws(() => pickFirst({ in: [], strict: true }), /non-empty/);
  });

  test("strict mode: throws on multiple elements", () => {
    assert.throws(() => pickFirst({ in: [1, 2], strict: true }), /exactly one/);
  });

  test("strict as string 'true' works", () => {
    assert.equal(pickFirst({ in: [7], strict: "true" }), 7);
  });
});

describe("toArray tool", () => {
  test("wraps single value in array", () => {
    assert.deepEqual(toArray({ in: 42 }), [42]);
  });

  test("wraps object in array", () => {
    assert.deepEqual(toArray({ in: { a: 1 } }), [{ a: 1 }]);
  });

  test("wraps string in array", () => {
    assert.deepEqual(toArray({ in: "hello" }), ["hello"]);
  });

  test("returns array as-is if already array", () => {
    assert.deepEqual(toArray({ in: [1, 2, 3] }), [1, 2, 3]);
  });

  test("wraps null in array", () => {
    assert.deepEqual(toArray({ in: null }), [null]);
  });
});

// ── builtinTools bundle ─────────────────────────────────────────────────────

describe("builtinTools bundle", () => {
  test("has one top-level key: std", () => {
    assert.deepEqual(Object.keys(builtinTools), ["std"]);
  });

  test("std namespace contains all built-in tools", () => {
    assert.ok(builtinTools.std.httpCall, "httpCall present");
    assert.ok(builtinTools.std.upperCase, "upperCase present");
    assert.ok(builtinTools.std.lowerCase, "lowerCase present");
    assert.ok(builtinTools.std.findObject, "findObject present");
    assert.ok(builtinTools.std.pickFirst, "pickFirst present");
    assert.ok(builtinTools.std.toArray, "toArray present");
    assert.equal(Object.keys(builtinTools.std).length, 6);
  });

  test("httpCall is callable with and without std. prefix", () => {
    assert.equal(typeof builtinTools.std.httpCall, "function");
  });
});

// ── Default tools behaviour in bridgeTransform ──────────────────────────────

describe("default tools (no tools option)", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      greet(name: String!): Greeting
    }
    type Greeting {
      upper: String
      lower: String
    }
  `;

  const bridgeText = `
bridge Query.greet {
  with std.upperCase as up
  with std.lowerCase as lo
  with input as i

upper <- up:i.name
lower <- lo:i.name

}`;

  test("upperCase and lowerCase are available by default", async () => {
    const instructions = parseBridge(bridgeText);
    // No tools option passed — should use builtinTools
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ greet(name: "Hello") { upper lower } }`),
    });

    assert.equal(result.data.greet.upper, "HELLO");
    assert.equal(result.data.greet.lower, "hello");
  });
});

describe("user can override std namespace", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      greet(name: String!): Greeting
    }
    type Greeting {
      upper: String
    }
  `;

  const bridgeText = `
bridge Query.greet {
  with std.upperCase as up
  with input as i

upper <- up:i.name

}`;

  test("overriding std replaces its tools", async () => {
    const instructions = parseBridge(bridgeText);
    // Replace the entire std namespace with a custom upperCase
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        std: {
          upperCase: (opts: any) => opts.in.split("").reverse().join(""),
        },
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ greet(name: "Hello") { upper } }`),
    });

    // Should use the custom tool, not the builtin
    assert.equal(result.data.greet.upper, "olleH");
  });

  test("missing std tool when namespace overridden", async () => {
    const instructions = parseBridge(bridgeText);
    // Replace std with a namespace that lacks upperCase
    const gateway = createGateway(typeDefs, instructions, {
      tools: { std: { somethingElse: () => ({}) } },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ greet(name: "Hello") { upper } }`),
    });

    assert.ok(result.errors, "expected errors when tool is missing");
  });
});

describe("user can add custom tools alongside std", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      process(text: String!): Processed
    }
    type Processed {
      upper: String
      custom: String
    }
  `;

  const bridgeText = `
bridge Query.process {
  with std.upperCase as up
  with reverse as rev
  with input as i

upper <- up:i.text
custom <- rev:i.text

}`;

  test("custom tools merge alongside std automatically", async () => {
    const instructions = parseBridge(bridgeText);
    // No need to spread builtinTools — std is always included
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        reverse: (opts: any) => opts.in.split("").reverse().join(""),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ process(text: "Hello") { upper custom } }`),
    });

    assert.equal(result.data.process.upper, "HELLO");
    assert.equal(result.data.process.custom, "olleH");
  });
});

// ── End-to-end: findObject through bridge ───────────────────────────────────

describe("findObject through bridge", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      findUser(role: String!): User
    }
    type User {
      id: Int
      name: String
      role: String
    }
  `;

  const bridgeText = `
bridge Query.findUser {
  with getUsers as db
  with std.findObject as find
  with input as i

find.in <- db.users
find.role <- i.role
id <- find.id
name <- find.name
role <- find.role

}`;

  test("finds object in array returned by another tool", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        getUsers: async () => ({
          users: [
            { id: 1, name: "Alice", role: "admin" },
            { id: 2, name: "Bob", role: "editor" },
            { id: 3, name: "Charlie", role: "viewer" },
          ],
        }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ findUser(role: "editor") { id name role } }`),
    });

    assert.deepEqual(result.data.findUser, {
      id: 2,
      name: "Bob",
      role: "editor",
    });
  });
});

// ── Pipe with built-in tools ────────────────────────────────────────────────

describe("pipe with built-in tools", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      shout(text: String!): Result
    }
    type Result {
      value: String
    }
  `;

  const bridgeText = `
bridge Query.shout {
  with std.upperCase as up
  with input as i

value <- up:i.text

}`;

  test("pipe through upperCase", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ shout(text: "whisper") { value } }`),
    });

    assert.equal(result.data.shout.value, "WHISPER");
  });
});

// ── pickFirst through bridge ────────────────────────────────────────────────

describe("pickFirst through bridge", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      first(items: [String!]!): Result
    }
    type Result {
      value: String
    }
  `;

  const bridgeText = `
bridge Query.first {
  with std.pickFirst as pf
  with input as i

value <- pf:i.items

}`;

  test("picks first element via pipe", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ first(items: ["a", "b", "c"]) { value } }`),
    });

    assert.equal(result.data.first.value, "a");
  });
});

describe("pickFirst strict through bridge", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      onlyOne(items: [String!]!): Result
    }
    type Result {
      value: String
    }
  `;

  const bridgeText = `
extend std.pickFirst as pf {
  strict = true

}
bridge Query.onlyOne {
  with pf
  with input as i

pf.in <- i.items
value <- pf

}`;

  test("strict mode passes with one element", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ onlyOne(items: ["only"]) { value } }`),
    });

    assert.equal(result.data.onlyOne.value, "only");
  });

  test("strict mode errors with multiple elements", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ onlyOne(items: ["a", "b"]) { value } }`),
    });

    assert.ok(result.errors, "expected errors for multi-element strict");
  });
});

// ── toArray through bridge ──────────────────────────────────────────────────

describe("toArray through bridge", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      normalize(value: String!): Result
    }
    type Result {
      value: String
    }
  `;

  // Round-trip: wrap single value in array → pick first element back out
  const bridgeText = `
bridge Query.normalize {
  with std.toArray as ta
  with std.pickFirst as pf
  with input as i

value <- pf:ta:i.value

}`;

  test("toArray + pickFirst round-trip via pipe chain", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ normalize(value: "hello") { value } }`),
    });

    assert.equal(result.data.normalize.value, "hello");
  });
});

describe("toArray as tool input normalizer", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      wrap(value: String!): Result
    }
    type Result {
      count: Int
    }
  `;

  // Use toArray to wrap a scalar, then pass to a custom tool that counts items
  const bridgeText = `
bridge Query.wrap {
  with std.toArray as ta
  with countItems as cnt
  with input as i

cnt.in <- ta:i.value
count <- cnt.count

}`;

  test("toArray normalizes scalar into array for downstream tool", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, {
      tools: {
        countItems: (opts: any) => ({ count: opts.in.length }),
      },
    });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ wrap(value: "hello") { count } }`),
    });

    assert.equal(result.data.wrap.count, 1);
  });
});

// ── Inline with (no tool block needed) ──────────────────────────────────────

describe("inline with — no tool block", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      format(text: String!): F
    }
    type F {
      upper: String
      lower: String
    }
  `;

  const bridgeText = `
bridge Query.format {
  with std.upperCase as up
  with std.lowerCase as lo
  with input as i

upper <- up:i.text
lower <- lo:i.text

}`;

  test("built-in tools work without tool blocks", async () => {
    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions);
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ format(text: "Hello") { upper lower } }`),
    });

    assert.equal(result.data.format.upper, "HELLO");
    assert.equal(result.data.format.lower, "hello");
  });
});
