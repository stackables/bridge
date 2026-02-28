import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat as parseBridge } from "../src/index.ts";
import { std } from "../src/index.ts";
import { createGateway } from "./_gateway.ts";

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

  const bridgeText = `version 1.5
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

  const bridgeText = `version 1.5
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
          str: {
            toUpperCase: (opts: any) => opts.in.split("").reverse().join(""),
          },
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

  const bridgeText = `version 1.5
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

  const bridgeText = `version 1.5
bridge Query.findUser {
  with getUsers as db
  with std.arr.find as find
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

  const bridgeText = `version 1.5
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

  const bridgeText = `version 1.5
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

  const bridgeText = `version 1.5
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
  const bridgeText = `version 1.5
bridge Query.normalize {
  with std.arr.toArray as ta
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
  const bridgeText = `version 1.5
bridge Query.wrap {
  with std.arr.toArray as ta
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

  const bridgeText = `version 1.5
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

    const bridgeText = `version 1.5
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

    const bridgeText = `version 1.5
bridge Query.search {
  with searchApi as api
  with std.audit as audit
  with input as i
  with output as o

  api.q <- i.q
  audit.query <- i.q
  force audit catch null
  o.title <- api.title

}`;

    const tools: Record<string, any> = {
      searchApi: async (_input: any) => ({ title: "OK" }),
      std: { ...std, audit: failAudit },
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

    const bridgeText = `version 1.5
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
      searchApi: async (_input: any) => ({ title: "OK" }),
      std: { ...std, audit: failAudit },
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
