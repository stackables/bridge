import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.ts";
import type { Bridge } from "../src/types.ts";
import { SELF_MODULE } from "../src/types.ts";
import { createGateway } from "./_gateway.ts";

// ── Parser: `force <handle>` creates forces entries ─────────────────────────

describe("parseBridge: force <handle>", () => {
  test("regular bridge has no forces", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myTool as t
  with input as i
  with output as o

t.action <- i.name
o.result <- t.output

}`) as Bridge[];

    assert.equal(bridge.forces, undefined);
  });

  test("force statement creates a forces entry", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Mutation.audit {
  with logger.log as lg
  with input as i

lg.action <- i.event
force lg

}`) as Bridge[];

    assert.ok(bridge.forces, "should have forces");
    assert.equal(bridge.forces!.length, 1);
    assert.equal(bridge.forces![0].handle, "lg");
    assert.equal(bridge.forces![0].module, "logger");
    assert.equal(bridge.forces![0].field, "log");
    assert.equal(bridge.forces![0].instance, 1);
  });

  test("force and regular wires coexist", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.query
audit.action <- i.query
force audit
o.result <- m.data

}`) as Bridge[];

    assert.ok(bridge.forces);
    assert.equal(bridge.forces!.length, 1);
    assert.equal(bridge.forces![0].handle, "audit");
    // No wire should have a force flag
    for (const w of bridge.wires) {
      if ("from" in w) {
        assert.equal((w as any).force, undefined, "wires should not have force");
      }
    }
  });

  test("multiple force statements", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Mutation.multi {
  with logger.log as lg
  with metrics.emit as mt
  with input as i

lg.action <- i.event
mt.name <- i.event
force lg
force mt

}`) as Bridge[];

    assert.ok(bridge.forces);
    assert.equal(bridge.forces!.length, 2);
    assert.equal(bridge.forces![0].handle, "lg");
    assert.equal(bridge.forces![1].handle, "mt");
  });

  test("force on undeclared handle throws", () => {
    assert.throws(
      () =>
        parseBridge(`version 1.4

bridge Query.demo {
  with input as i
  with output as o

force unknown

}`),
      /Cannot force undeclared handle "unknown"/,
    );
  });

  test("force on simple (non-dotted) tool handle", () => {
    const [bridge] = parseBridge(`version 1.4

bridge Query.demo {
  with myTool as t
  with input as i
  with output as o

t.in <- i.name
force t
o.result <- t.out

}`) as Bridge[];

    assert.ok(bridge.forces);
    assert.equal(bridge.forces!.length, 1);
    assert.equal(bridge.forces![0].handle, "t");
    assert.equal(bridge.forces![0].module, SELF_MODULE);
    assert.equal(bridge.forces![0].type, "Tools");
    assert.equal(bridge.forces![0].field, "myTool");
  });

  test("force without any wires to the handle", () => {
    // The whole point of force — handle has no output wires, just triggers execution
    const [bridge] = parseBridge(`version 1.4

bridge Mutation.fire {
  with sideEffect as se
  with input as i
  with output as o

se.action = "fire"
force se
o.ok = "true"

}`) as Bridge[];

    assert.ok(bridge.forces);
    assert.equal(bridge.forces![0].handle, "se");
  });
});

// ── Serializer roundtrip ─────────────────────────────────────────────────────

describe("serializeBridge: force statement roundtrip", () => {
  test("force statement roundtrips", () => {
    const input = `version 1.4
bridge Mutation.audit {
  with logger.log as lg
  with input as i

lg.action <- i.event
lg.userId <- i.userId
force lg

}`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });

  test("mixed force and regular wires roundtrip", () => {
    const input = `version 1.4
bridge Query.demo {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.query
audit.action <- i.query
force audit
o.result <- m.data

}`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });

  test("serialized output contains force syntax", () => {
    const input = `version 1.4
bridge Mutation.audit {
  with logger.log as lg
  with input as i

lg.action <- i.event
force lg

}`;
    const output = serializeBridge(parseBridge(input));
    assert.ok(output.includes("force lg"), "serialized output should contain 'force lg'");
    assert.ok(!output.includes("<-!"), "serialized output should NOT contain <-!");
  });

  test("multiple force statements roundtrip", () => {
    const input = `version 1.4
bridge Mutation.multi {
  with logger.log as lg
  with metrics.emit as mt
  with input as i

lg.action <- i.event
mt.name <- i.event
force lg
force mt

}`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });
});

// ── End-to-end: forced tool runs without output demand ──────────────────────

describe("force statement: end-to-end execution", () => {
  const typeDefs = /* GraphQL */ `
    type Query {
      search(q: String!): SearchResult
    }
    type SearchResult {
      title: String
    }
  `;

  test("forced tool runs even when its output is not queried", async () => {
    let auditCalled = false;
    let auditInput: any = null;

    const bridgeText = `version 1.4
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.q
audit.action <- i.q
force audit
o.title <- m.title

}`;

    const tools: Record<string, any> = {
      mainApi: async (input: any) => {
        return { title: "Hello World" };
      },
      "audit.log": async (input: any) => {
        auditCalled = true;
        auditInput = input;
        return { ok: true };
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "test") { title } }`),
    });

    assert.equal(result.data.search.title, "Hello World");
    assert.ok(auditCalled, "audit tool must be called even though output is not queried");
    assert.deepStrictEqual(auditInput, { action: "test" });
  });

  test("forced tool receives correct input from multiple wires", async () => {
    let auditInput: any = null;

    const typeDefs2 = /* GraphQL */ `
      type Query { _unused: String }
      type Mutation {
        createUser(name: String!, role: String!): CreateResult
      }
      type CreateResult {
        id: String
      }
    `;

    const bridgeText = `version 1.4
bridge Mutation.createUser {
  with userApi.create as u
  with audit.log as audit
  with input as i
  with output as o

u.name <- i.name
audit.action = "createUser"
audit.userName <- i.name
force audit
o.id <- u.id

}`;

    const tools: Record<string, any> = {
      "userApi.create": async (input: any) => ({ id: "usr_123" }),
      "audit.log": async (input: any) => {
        auditInput = input;
        return { ok: true };
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs2, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`mutation { createUser(name: "Alice", role: "admin") { id } }`),
    });

    assert.equal(result.data.createUser.id, "usr_123");
    assert.ok(auditInput, "audit tool must be called");
    assert.equal(auditInput.action, "createUser", "constant wire feeds audit");
    assert.equal(auditInput.userName, "Alice", "pull wire feeds audit");
  });

  test("forced tool runs in parallel with demand-driven tools", async () => {
    let mainStart = 0;
    let auditStart = 0;
    const t0 = performance.now();

    const bridgeText = `version 1.4
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.q
audit.action <- i.q
force audit
o.title <- m.title

}`;

    const tools: Record<string, any> = {
      mainApi: async (input: any) => {
        mainStart = performance.now() - t0;
        await new Promise((r) => setTimeout(r, 50));
        return { title: "result" };
      },
      "audit.log": async (input: any) => {
        auditStart = performance.now() - t0;
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true };
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "test") { title } }`),
    });

    assert.equal(result.data.search.title, "result");
    // Both tools should start nearly simultaneously (within 20ms of each other)
    assert.ok(
      Math.abs(mainStart - auditStart) < 20,
      `main and audit should start in parallel (Δ=${Math.abs(mainStart - auditStart).toFixed(1)}ms)`,
    );
  });

  test("force without output wires (204 No Content scenario)", async () => {
    let sideEffectCalled = false;

    const typeDefs4 = /* GraphQL */ `
      type Query { _unused: String }
      type Mutation {
        fire(action: String!): FireResult
      }
      type FireResult {
        ok: String
      }
    `;

    const bridgeText = `version 1.4
bridge Mutation.fire {
  with sideEffect as se
  with input as i
  with output as o

se.action <- i.action
force se
o.ok = "true"

}`;

    const tools: Record<string, any> = {
      sideEffect: async (input: any) => {
        sideEffectCalled = true;
        // Returns nothing — 204 No Content scenario
        return null;
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs4, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`mutation { fire(action: "deploy") { ok } }`),
    });

    assert.equal(result.data.fire.ok, "true");
    assert.ok(sideEffectCalled, "side-effect tool must run even with no output wires");
  });

  test("forced tool error does not break demand-driven response", async () => {
    const bridgeText = `version 1.4
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.q
audit.action <- i.q
force audit
o.title <- m.title

}`;

    const tools: Record<string, any> = {
      mainApi: async () => ({ title: "OK" }),
      "audit.log": async () => {
        throw new Error("audit service unavailable");
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    const result: any = await executor({
      document: parse(`{ search(q: "test") { title } }`),
    });

    // The main result should succeed even if the forced tool fails
    assert.equal(result.data.search.title, "OK");
  });
});
