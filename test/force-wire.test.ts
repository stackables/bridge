import { buildHTTPExecutor } from "@graphql-tools/executor-http";
import { parse } from "graphql";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridge, serializeBridge } from "../src/bridge-format.js";
import type { Bridge } from "../src/types.js";
import { SELF_MODULE } from "../src/types.js";
import { createGateway } from "./_gateway.js";

// ── Parser: <-! creates force wires ─────────────────────────────────────────

describe("parseBridge: force wire (<-!)", () => {
  test("regular pull wire has no force flag", () => {
    const [bridge] = parseBridge(`
bridge Query.demo {
  with myTool as t
  with input as i

t.action <- i.name
result <- t.output

}`) as Bridge[];

    // Wire targeting tool input
    const toolWire = bridge.wires.find(
      (w) => "from" in w && w.to.field === "demo" === false,
    );
    // None of the wires should have force
    for (const w of bridge.wires) {
      if ("from" in w) {
        assert.equal(w.force, undefined, "regular wires should not have force");
      }
    }
  });

  test("<-! sets force: true on pull wire", () => {
    const [bridge] = parseBridge(`
bridge Mutation.audit {
  with logger.log as lg
  with input as i

lg.action <-! i.event

}`) as Bridge[];

    const forcedWire = bridge.wires.find(
      (w) => "from" in w && w.to.module === "logger",
    );
    assert.ok(forcedWire, "should find the forced wire");
    assert.ok("from" in forcedWire!, "should be a pull wire");
    if ("from" in forcedWire!) {
      assert.equal(forcedWire.force, true, "force flag should be true");
    }
  });

  test("<-! and <- can coexist on the same bridge", () => {
    const [bridge] = parseBridge(`
bridge Query.demo {
  with mainApi as m
  with audit.log as audit
  with input as i

m.q <- i.query
audit.action <-! i.query
result <- m.data

}`) as Bridge[];

    const regularWires = bridge.wires.filter(
      (w) => "from" in w && !w.force,
    );
    const forcedWires = bridge.wires.filter(
      (w) => "from" in w && w.force,
    );
    assert.ok(regularWires.length >= 2, "should have at least 2 regular wires");
    assert.equal(forcedWires.length, 1, "should have exactly 1 forced wire");
  });

  test("<-! on pipe chain sets force on outermost fork", () => {
    const [bridge] = parseBridge(`
bridge Query.demo {
  with transform as t
  with input as i

result <-! t:i.text

}`) as Bridge[];

    // The outermost fork's input wire should have force: true
    const forcedWire = bridge.wires.find(
      (w) => "from" in w && w.force === true,
    );
    assert.ok(forcedWire, "should have a forced wire in the pipe chain");
    assert.ok("from" in forcedWire!);
    // It should be a pipe wire
    if ("from" in forcedWire!) {
      assert.equal(forcedWire.pipe, true, "forced wire should be a pipe wire");
    }
  });

  test("<-! on multi-handle pipe chain sets force only on outermost fork", () => {
    const [bridge] = parseBridge(`
bridge Query.demo {
  with a as a
  with b as b
  with input as i

result <-! a:b:i.text

}`) as Bridge[];

    // Exactly one wire should have force
    const forcedWires = bridge.wires.filter(
      (w) => "from" in w && w.force === true,
    );
    assert.equal(forcedWires.length, 1, "exactly one wire should be forced");

    // That wire should target the outermost fork (a), not inner (b)
    const fw = forcedWires[0]!;
    if ("from" in fw) {
      // The outermost fork (a) gets the highest instance number in the reversed loop
      // Its input wire comes FROM b_fork root
      assert.equal(fw.pipe, true, "forced wire should be a pipe wire");
    }
  });
});

// ── Serializer roundtrip ─────────────────────────────────────────────────────

describe("serializeBridge: force wire roundtrip", () => {
  test("regular force wire roundtrips", () => {
    const input = `
bridge Mutation.audit {
  with logger.log as lg
  with input as i

lg.action <-! i.event
lg.userId <-! i.userId

}`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });

  test("mixed force and regular wires roundtrip", () => {
    const input = `
bridge Query.demo {
  with mainApi as m
  with audit.log as audit
  with input as i

m.q <- i.query
audit.action <-! i.query
result <- m.data

}`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });

  test("force pipe chain roundtrips", () => {
    const input = `
bridge Query.demo {
  with transform as t
  with input as i

result <-! t:i.text

}`;
    const instructions = parseBridge(input);
    const serialized = serializeBridge(instructions);
    const reparsed = parseBridge(serialized);
    assert.deepStrictEqual(reparsed, instructions);
  });

  test("serialized output contains <-! syntax", () => {
    const input = `
bridge Mutation.audit {
  with logger.log as lg
  with input as i

lg.action <-! i.event

}`;
    const output = serializeBridge(parseBridge(input));
    assert.ok(output.includes("<-!"), "serialized output should contain <-!");
  });
});

// ── End-to-end: forced tool runs without output demand ──────────────────────

describe("forced wire: end-to-end execution", () => {
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

    const bridgeText = `
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i

m.q <- i.q
audit.action <-! i.q
title <- m.title

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

    const bridgeText = `
bridge Mutation.createUser {
  with userApi.create as u
  with audit.log as audit
  with input as i

u.name <- i.name
audit.action = "createUser"
audit.userName <-! i.name
id <- u.id

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
    assert.equal(auditInput.userName, "Alice", "forced wire feeds audit");
  });

  test("forced tool runs in parallel with demand-driven tools", async () => {
    let mainStart = 0;
    let auditStart = 0;
    const t0 = performance.now();

    const bridgeText = `
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i

m.q <- i.q
audit.action <-! i.q
title <- m.title

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

  test("forced pipe chain runs even when output is not queried", async () => {
    let transformCalled = false;
    let transformInput: any = null;

    const typeDefs3 = /* GraphQL */ `
      type Query {
        process(text: String!): ProcessResult
      }
      type ProcessResult {
        status: String
        transformed: String
      }
    `;

    const bridgeText = `
bridge Query.process {
  with mainWork as m
  with sideEffect as se
  with input as i

m.text <- i.text
status <- m.status
transformed <-! se:i.text

}`;

    const tools: Record<string, any> = {
      mainWork: async (input: any) => {
        return { status: "done" };
      },
      sideEffect: async (input: any) => {
        transformCalled = true;
        transformInput = input;
        return `processed: ${input.in}`;
      },
    };

    const instructions = parseBridge(bridgeText);
    const gateway = createGateway(typeDefs3, instructions, { tools });
    const executor = buildHTTPExecutor({ fetch: gateway.fetch as any });

    // Only query status — NOT transformed
    const result: any = await executor({
      document: parse(`{ process(text: "hello") { status } }`),
    });

    assert.equal(result.data.process.status, "done");
    assert.ok(transformCalled, "forced pipe tool must run even when transformed is not queried");
    assert.deepStrictEqual(transformInput, { in: "hello" });
  });

  test("forced tool error does not break demand-driven response", async () => {
    const bridgeText = `
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i

m.q <- i.q
audit.action <-! i.q
title <- m.title

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
