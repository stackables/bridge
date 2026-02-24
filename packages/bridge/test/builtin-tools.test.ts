import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge } from "../src/bridge-format.ts";
import { builtinTools } from "../src/tools/index.ts";
import { audit } from "../src/tools/audit.ts";
import { std } from "../src/tools";
import { createGateway } from "./_gateway.ts";

// ── Unit tests for individual tools ─────────────────────────────────────────

describe("upperCase tool", () => {
  test("converts string to uppercase", () => {
    assert.equal(std.str.toUpperCase({ in: "hello" }), "HELLO");
  });

  test("handles empty string", () => {
    assert.equal(std.str.toUpperCase({ in: "" }), "");
  });

  test("handles already uppercase", () => {
    assert.equal(std.str.toUpperCase({ in: "HELLO" }), "HELLO");
  });

  test("handles mixed case with numbers", () => {
    assert.equal(std.str.toUpperCase({ in: "abc123def" }), "ABC123DEF");
  });
});

describe("lowerCase tool", () => {
  test("converts string to lowercase", () => {
    assert.equal(std.str.toLowerCase({ in: "HELLO" }), "hello");
  });

  test("handles empty string", () => {
    assert.equal(std.str.toLowerCase({ in: "" }), "");
  });

  test("handles already lowercase", () => {
    assert.equal(std.str.toLowerCase({ in: "hello" }), "hello");
  });

  test("handles mixed case with symbols", () => {
    assert.equal(
      std.str.toLowerCase({ in: "Hello-World_123" }),
      "hello-world_123",
    );
  });
});

describe("findObject tool", () => {
  const data = [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
    { id: 3, name: "Charlie", role: "user" },
  ];

  test("finds by single criterion", () => {
    const result = std.arr.find({ in: data, name: "Bob" });
    assert.deepEqual(result, { id: 2, name: "Bob", role: "user" });
  });

  test("finds by multiple criteria", () => {
    const result = std.arr.find({ in: data, role: "user", name: "Charlie" });
    assert.deepEqual(result, { id: 3, name: "Charlie", role: "user" });
  });

  test("returns undefined when no match", () => {
    const result = std.arr.find({ in: data, name: "Dave" });
    assert.equal(result, undefined);
  });

  test("returns first match when multiple match", () => {
    const result = std.arr.find({ in: data, role: "user" });
    assert.deepEqual(result, { id: 2, name: "Bob", role: "user" });
  });

  test("handles empty array", () => {
    const result = std.arr.find({ in: [], name: "Alice" });
    assert.equal(result, undefined);
  });
});

describe("pickFirst tool", () => {
  test("returns first element", () => {
    assert.equal(std.arr.first({ in: [10, 20, 30] }), 10);
  });

  test("returns undefined for empty array", () => {
    assert.equal(std.arr.first({ in: [] }), undefined);
  });

  test("returns single element", () => {
    assert.deepEqual(std.arr.first({ in: [{ id: 1 }] }), { id: 1 });
  });

  test("strict mode: passes with exactly one element", () => {
    assert.equal(std.arr.first({ in: [42], strict: true }), 42);
  });

  test("strict mode: throws on empty array", () => {
    assert.throws(() => std.arr.first({ in: [], strict: true }), /non-empty/);
  });

  test("strict mode: throws on multiple elements", () => {
    assert.throws(
      () => std.arr.first({ in: [1, 2], strict: true }),
      /exactly one/,
    );
  });

  test("strict as string 'true' works", () => {
    assert.equal(std.arr.first({ in: [7], strict: "true" }), 7);
  });
});

describe("toArray tool", () => {
  test("wraps single value in array", () => {
    assert.deepEqual(std.arr.toArray({ in: 42 }), [42]);
  });

  test("wraps object in array", () => {
    assert.deepEqual(std.arr.toArray({ in: { a: 1 } }), [{ a: 1 }]);
  });

  test("wraps string in array", () => {
    assert.deepEqual(std.arr.toArray({ in: "hello" }), ["hello"]);
  });

  test("returns array as-is if already array", () => {
    assert.deepEqual(std.arr.toArray({ in: [1, 2, 3] }), [1, 2, 3]);
  });

  test("wraps null in array", () => {
    assert.deepEqual(std.arr.toArray({ in: null }), [null]);
  });
});

// ── builtinTools bundle ─────────────────────────────────────────────────────

describe("builtinTools bundle", () => {
  test("has two top-level keys: std and math", () => {
    assert.deepEqual(Object.keys(builtinTools).sort(), ["math", "std"]);
  });

  test("std namespace contains transform tools", () => {
    assert.ok(builtinTools.std.audit, "audit present");
    assert.ok(builtinTools.std.concat, "concat present");
    assert.ok(builtinTools.std.httpCall, "httpCall present");
    assert.ok(builtinTools.std.str.toUpperCase, "upperCase present");
    assert.ok(builtinTools.std.str.toLowerCase, "lowerCase present");
    assert.ok(builtinTools.std.arr.find, "findObject present");
    assert.ok(builtinTools.std.arr.first, "pickFirst present");
    assert.ok(builtinTools.std.arr.toArray, "toArray present");
    assert.equal(Object.keys(builtinTools.std).length, 8);
  });

  test("math namespace contains math/comparison tools", () => {
    assert.ok(builtinTools.math.multiply, "multiply present");
    assert.ok(builtinTools.math.divide, "divide present");
    assert.ok(builtinTools.math.add, "add present");
    assert.ok(builtinTools.math.subtract, "subtract present");
    assert.ok(builtinTools.math.eq, "eq present");
    assert.ok(builtinTools.math.neq, "neq present");
    assert.ok(builtinTools.math.gt, "gt present");
    assert.ok(builtinTools.math.gte, "gte present");
    assert.ok(builtinTools.math.lt, "lt present");
    assert.ok(builtinTools.math.lte, "lte present");
    assert.equal(Object.keys(builtinTools.math).length, 10);
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

  const bridgeText = `version 1.4
bridge Query.greet {
  with std.str.toUpperCase as up
  with std.str.toLowerCase as lo
  with input as i
  with output as o

o.upper <- up:i.name
o.lower <- lo:i.name

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

  const bridgeText = `version 1.4
bridge Query.greet {
  with std.str.toUpperCase as up
  with input as i
  with output as o

o.upper <- up:i.name

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

  const bridgeText = `version 1.4
bridge Query.process {
  with std.str.toUpperCase as up
  with reverse as rev
  with input as i
  with output as o

o.upper <- up:i.text
o.custom <- rev:i.text

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

  const bridgeText = `version 1.4
bridge Query.findUser {
  with getUsers as db
  with std.findObject as find
  with input as i
  with output as o

find.in <- db.users
find.role <- i.role
o.id <- find.id
o.name <- find.name
o.role <- find.role

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

  const bridgeText = `version 1.4
bridge Query.shout {
  with std.str.toUpperCase as up
  with input as i
  with output as o

o.value <- up:i.text

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

  const bridgeText = `version 1.4
bridge Query.first {
  with std.arr.first as pf
  with input as i
  with output as o

o.value <- pf:i.items

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

  const bridgeText = `version 1.4
tool pf from std.arr.first {
  .strict = true

}
bridge Query.onlyOne {
  with pf
  with input as i
  with output as o

pf.in <- i.items
o.value <- pf

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
  const bridgeText = `version 1.4
bridge Query.normalize {
  with std.toArray as ta
  with std.arr.first as pf
  with input as i
  with output as o

o.value <- pf:ta:i.value

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
  const bridgeText = `version 1.4
bridge Query.wrap {
  with std.toArray as ta
  with countItems as cnt
  with input as i
  with output as o

cnt.in <- ta:i.value
o.count <- cnt.count

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

  const bridgeText = `version 1.4
bridge Query.format {
  with std.str.toUpperCase as up
  with std.str.toLowerCase as lo
  with input as i
  with output as o

o.upper <- up:i.text
o.lower <- lo:i.text

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

// ── audit tool ──────────────────────────────────────────────────────────────

describe("audit tool", () => {
  test("uses ToolContext logger when provided", () => {
    const logged: any[] = [];
    const logger = { info: (...args: any[]) => logged.push(args) };

    const input = { action: "login", userId: "u42" };
    const result = audit(input, { logger });

    assert.deepEqual(
      result,
      input,
      "returns input as-is (including level default)",
    );
    assert.equal(logged.length, 1, "logged exactly once");
    // structured: data first, message last
    assert.deepEqual(logged[0][0], { action: "login", userId: "u42" });
    assert.equal(logged[0][1], "[bridge:audit]");
  });

  test("no-op when no ToolContext logger", () => {
    assert.equal(typeof audit, "function");
    // No logger → noop, should not throw
    assert.deepEqual(audit({ x: 1 }), { x: 1 });
  });

  test("level input selects logger method", () => {
    const warns: any[] = [];
    const infos: any[] = [];
    const logger = {
      info: (...a: any[]) => infos.push(a),
      warn: (...a: any[]) => warns.push(a),
    };

    audit({ action: "risky", level: "warn" }, { logger });

    assert.equal(infos.length, 0, "info not called");
    assert.equal(warns.length, 1, "warn called");
    assert.deepEqual(warns[0][0], { action: "risky" });
    assert.equal(warns[0][1], "[bridge:audit]");
  });

  test("ToolContext logger receives all wired inputs", () => {
    const entries: any[] = [];
    const logger = { info: (...a: any[]) => entries.push(a) };

    audit(
      { action: "order", userId: "u1", amount: 99.5, item: "widget" },
      { logger },
    );

    assert.equal(entries.length, 1);
    const payload = entries[0][0];
    assert.equal(payload.action, "order");
    assert.equal(payload.userId, "u1");
    assert.equal(payload.amount, 99.5);
    assert.equal(payload.item, "widget");
  });
});

// ── audit + force e2e ───────────────────────────────────────────────────────

describe("audit tool with force (e2e)", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      search(q: String!): SearchResult
    }
    type SearchResult {
      title: String
    }
  `;

  test("forced audit logs via engine logger (ToolContext flow)", async () => {
    const logged: any[] = [];
    const logger = { info: (...args: any[]) => logged.push(args) };

    const bridgeText = `version 1.4
bridge Query.search {
  with searchApi as api
  with std.audit as audit
  with input as i
  with output as o

  api.q <- i.q
  audit.action = "search"
  audit.query <- i.q
  audit.resultTitle <- api.title
  force audit
  o.title <- api.title

}`;

    const tools: Record<string, any> = {
      searchApi: async (input: any) => ({ title: `Result for ${input.q}` }),
    };

    const instructions = parseBridge(bridgeText);
    // Logger is passed via gateway options — audit receives it through ToolContext
    const gateway = createGateway(typeDefs, instructions, { tools, logger });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "bridge") { title } }`),
    });

    assert.equal(result.data.search.title, "Result for bridge");
    // The engine logger.info is called by the audit tool (structured: data first)
    const auditEntry = logged.find((l) => l[1] === "[bridge:audit]");
    assert.ok(auditEntry, "audit logged via engine logger");
    const payload = auditEntry[0];
    assert.equal(payload.action, "search");
    assert.equal(payload.query, "bridge");
    assert.equal(payload.resultTitle, "Result for bridge");
  });

  test("fire-and-forget audit failure does not break response", async () => {
    const failAudit = () => {
      throw new Error("audit down");
    };

    const bridgeText = `version 1.4
bridge Query.search {
  with searchApi as api
  with std.audit as audit
  with input as i
  with output as o

  api.q <- i.q
  audit.query <- i.q
  force audit ?? null
  o.title <- api.title

}`;

    const tools: Record<string, any> = {
      searchApi: async (input: any) => ({ title: "OK" }),
      std: { ...builtinTools.std, audit: failAudit },
      math: builtinTools.math,
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "test") { title } }`),
    });

    // Fire-and-forget: main response succeeds despite audit failure
    assert.equal(result.data.search.title, "OK");
  });

  test("critical audit failure propagates error", async () => {
    const failAudit = () => {
      throw new Error("audit down");
    };

    const bridgeText = `version 1.4
bridge Query.search {
  with searchApi as api
  with std.audit as audit
  with input as i
  with output as o

  api.q <- i.q
  audit.query <- i.q
  force audit
  o.title <- api.title

}`;

    const tools: Record<string, any> = {
      searchApi: async (input: any) => ({ title: "OK" }),
      std: { ...builtinTools.std, audit: failAudit },
      math: builtinTools.math,
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "test") { title } }`),
    });

    // Critical force: error propagates into GraphQL errors
    assert.ok(result.errors, "should have errors");
    assert.ok(result.errors.length > 0, "should have at least one error");
  });
});
