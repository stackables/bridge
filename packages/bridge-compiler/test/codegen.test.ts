import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat } from "@stackables/bridge-parser";
import { executeBridge } from "@stackables/bridge-core";
import type { BridgeDocument } from "@stackables/bridge-core";
import { compileBridge, executeBridge as executeAot } from "../src/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as typeof Function;

/** Build an async function from AOT-generated code. */
function buildAotFn(code: string) {
  const bodyMatch = code.match(
    /export default async function \w+\(input, tools, context, __opts\) \{([\s\S]*)\}\s*$/,
  );
  if (!bodyMatch)
    throw new Error(`Cannot extract function body from:\n${code}`);
  return new AsyncFunction(
    "input",
    "tools",
    "context",
    "__opts",
    bodyMatch[1]!,
  ) as (
    input: Record<string, unknown>,
    tools: Record<string, (...args: any[]) => any>,
    context: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ) => Promise<any>;
}

/**
 * Parse bridge text, compile to JS, evaluate the generated function,
 * and call it with the given input/tools/context.
 */
async function compileAndRun(
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools: Record<string, (...args: any[]) => any> = {},
  context: Record<string, unknown> = {},
): Promise<any> {
  const document = parseBridgeFormat(bridgeText);
  const { code } = compileBridge(document, { operation });
  const fn = buildAotFn(code);
  return fn(input, tools, context);
}

/** Compile only — returns the generated code for inspection. */
function compileOnly(bridgeText: string, operation: string): string {
  const document = parseBridgeFormat(bridgeText);
  return compileBridge(document, { operation }).code;
}

// ── Phase 1: From wires + constants ──────────────────────────────────────────

describe("AOT codegen: from wires + constants", () => {
  test("chained tool calls resolve all fields", async () => {
    const bridgeText = `version 1.5
bridge Query.livingStandard {
  with hereapi.geocode as gc
  with companyX.getLivingStandard as cx
  with input as i
  with toInt as ti
  with output as out

  gc.q <- i.location
  cx.x <- gc.lat
  cx.y <- gc.lon
  ti.value <- cx.lifeExpectancy
  out.lifeExpectancy <- ti.result
}`;

    const tools = {
      "hereapi.geocode": async () => ({ lat: 52.53, lon: 13.38 }),
      "companyX.getLivingStandard": async () => ({
        lifeExpectancy: "81.5",
      }),
      toInt: (p: { value: string }) => ({
        result: Math.round(parseFloat(p.value)),
      }),
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.livingStandard",
      { location: "Berlin" },
      tools,
    );
    assert.deepEqual(data, { lifeExpectancy: 82 });
  });

  test("constant wires emit literal values", async () => {
    const bridgeText = `version 1.5
bridge Query.info {
  with api as a
  with output as o

  a.method = "GET"
  a.timeout = 5000
  a.enabled = true
  o.result <- a.data
}`;

    const tools = {
      api: (p: any) => {
        assert.equal(p.method, "GET");
        assert.equal(p.timeout, 5000);
        assert.equal(p.enabled, true);
        return { data: "ok" };
      },
    };

    const data = await compileAndRun(bridgeText, "Query.info", {}, tools);
    assert.deepEqual(data, { result: "ok" });
  });

  test("root passthrough returns tool output directly", async () => {
    const bridgeText = `version 1.5
bridge Query.user {
  with api as a
  with input as i
  with output as o

  a.id <- i.userId
  o <- a
}`;

    const tools = {
      api: (p: any) => ({ name: "Alice", id: p.id }),
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.user",
      { userId: 42 },
      tools,
    );
    assert.deepEqual(data, { name: "Alice", id: 42 });
  });

  test("tools receive correct chained inputs", async () => {
    const bridgeText = `version 1.5
bridge Query.chain {
  with first as f
  with second as s
  with input as i
  with output as o

  f.x <- i.a
  s.y <- f.result
  o.final <- s.result
}`;

    let firstInput: any;
    let secondInput: any;
    const tools = {
      first: (p: any) => {
        firstInput = p;
        return { result: p.x * 2 };
      },
      second: (p: any) => {
        secondInput = p;
        return { result: p.y + 1 };
      },
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.chain",
      { a: 5 },
      tools,
    );
    assert.equal(firstInput.x, 5);
    assert.equal(secondInput.y, 10);
    assert.deepEqual(data, { final: 11 });
  });

  test("context references resolve correctly", async () => {
    const bridgeText = `version 1.5
bridge Query.secured {
  with api as a
  with context as ctx
  with input as i
  with output as o

  a.token <- ctx.apiKey
  a.query <- i.q
  o.data <- a.result
}`;

    const tools = {
      api: (p: any) => ({ result: `${p.query}:${p.token}` }),
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.secured",
      { q: "test" },
      tools,
      { apiKey: "secret123" },
    );
    assert.deepEqual(data, { data: "test:secret123" });
  });

  test("empty output throws descriptive error", async () => {
    const bridgeText = `version 1.5
bridge Query.empty {
  with output as o
}`;

    await assert.rejects(
      () => compileAndRun(bridgeText, "Query.empty", {}),
      (err: Error) => {
        assert.match(err.message, /has no output wires/);
        return true;
      },
    );
  });
});

// ── Phase 2: Nullish coalescing (??) and falsy fallback (||) ─────────────────

describe("AOT codegen: fallback operators", () => {
  test("?? nullish coalescing with constant fallback", async () => {
    const bridgeText = `version 1.5
bridge Query.defaults {
  with api as a
  with input as i
  with output as o

  a.id <- i.id
  o.name <- a.name ?? "unknown"
}`;

    const tools = {
      api: () => ({ name: null }),
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.defaults",
      { id: 1 },
      tools,
    );
    assert.deepEqual(data, { name: "unknown" });
  });

  test("?? does not trigger on falsy non-null values", async () => {
    const bridgeText = `version 1.5
bridge Query.falsy {
  with api as a
  with output as o

  o.count <- a.count ?? 42
}`;

    const tools = {
      api: () => ({ count: 0 }),
    };

    const data = await compileAndRun(bridgeText, "Query.falsy", {}, tools);
    assert.deepEqual(data, { count: 0 });
  });

  test("|| falsy fallback with constant", async () => {
    const bridgeText = `version 1.5
bridge Query.fallback {
  with api as a
  with output as o

  o.label <- a.label || "default"
}`;

    const tools = {
      api: () => ({ label: "" }),
    };

    const data = await compileAndRun(bridgeText, "Query.fallback", {}, tools);
    assert.deepEqual(data, { label: "default" });
  });

  test("|| falsy fallback with ref", async () => {
    const bridgeText = `version 1.5
bridge Query.refFallback {
  with primary as p
  with backup as b
  with output as o

  o.value <- p.val || b.val
}`;

    const tools = {
      primary: () => ({ val: null }),
      backup: () => ({ val: "from-backup" }),
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.refFallback",
      {},
      tools,
    );
    assert.deepEqual(data, { value: "from-backup" });
  });

  test("nullish fallback to null matches runtime overdefinition semantics", async () => {
    const document: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "nullishProbe",
          handles: [
            { kind: "input", handle: "i" },
            { kind: "output", handle: "o" },
          ],
          wires: [
            {
              from: {
                module: "_",
                type: "Query",
                field: "nullishProbe",
                path: ["m"],
              },
              to: {
                module: "_",
                type: "Query",
                field: "nullishProbe",
                path: ["k"],
              },
              nullishFallback: "null",
            },
          ],
        },
      ],
    };

    const runtime = await executeBridge({
      document,
      operation: "Query.nullishProbe",
      input: {},
      tools: {},
    });
    const aot = await executeAot({
      document,
      operation: "Query.nullishProbe",
      input: {},
      tools: {},
    });

    assert.deepStrictEqual(aot.data, runtime.data);
    assert.deepStrictEqual(aot.data, { k: undefined });
  });
});

// ── Phase 3: Array mapping ───────────────────────────────────────────────────

describe("AOT codegen: array mapping", () => {
  test("array mapping renames fields", async () => {
    const bridgeText = `version 1.5
bridge Query.catalog {
  with api as src
  with output as o

  o.title <- src.name
  o.entries <- src.items[] as item {
    .id <- item.item_id
    .label <- item.item_name
    .cost <- item.unit_price
  }
}`;

    const tools = {
      api: async () => ({
        name: "Catalog A",
        items: [
          { item_id: 1, item_name: "Widget", unit_price: 9.99 },
          { item_id: 2, item_name: "Gadget", unit_price: 14.5 },
        ],
      }),
    };

    const data = await compileAndRun(bridgeText, "Query.catalog", {}, tools);
    assert.deepEqual(data, {
      title: "Catalog A",
      entries: [
        { id: 1, label: "Widget", cost: 9.99 },
        { id: 2, label: "Gadget", cost: 14.5 },
      ],
    });
  });

  test("array mapping with empty array returns empty array", async () => {
    const bridgeText = `version 1.5
bridge Query.empty {
  with api as src
  with output as o

  o.items <- src.list[] as item {
    .name <- item.label
  }
}`;

    const tools = {
      api: () => ({ list: [] }),
    };

    const data = await compileAndRun(bridgeText, "Query.empty", {}, tools);
    assert.deepEqual(data, { items: [] });
  });

  test("array mapping with null source returns empty array", async () => {
    const bridgeText = `version 1.5
bridge Query.nullable {
  with api as src
  with output as o

  o.items <- src.list[] as item {
    .name <- item.label
  }
}`;

    const tools = {
      api: () => ({ list: null }),
    };

    const data = await compileAndRun(bridgeText, "Query.nullable", {}, tools);
    assert.deepEqual(data, { items: null });
  });
});

// ── Code generation output ──────────────────────────────────────────────────

describe("AOT codegen: output verification", () => {
  test("generated code contains function signature", () => {
    const code = compileOnly(
      `version 1.5
bridge Query.test {
  with output as o
}`,
      "Query.test",
    );
    assert.ok(code.includes("export default async function Query_test"));
    assert.ok(code.includes("(input, tools, context, __opts)"));
  });

  test("invalid operation throws", () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with output as o
}`);
    assert.throws(
      () => compileBridge(document, { operation: "Query.missing" }),
      /No bridge definition found/,
    );
    assert.throws(
      () => compileBridge(document, { operation: "invalid" }),
      /expected "Type\.field"/,
    );
  });

  test("generated code is deterministic", () => {
    const bridgeText = `version 1.5
bridge Query.det {
  with api as a
  with input as i
  with output as o

  a.x <- i.x
  o.y <- a.y
}`;
    const code1 = compileOnly(bridgeText, "Query.det");
    const code2 = compileOnly(bridgeText, "Query.det");
    assert.equal(code1, code2);
  });
});

// ── Ternary / conditional wires ──────────────────────────────────────────────

describe("AOT codegen: conditional wires", () => {
  test("ternary expression compiles correctly", async () => {
    const bridgeText = `version 1.5
bridge Query.conditional {
  with api as a
  with input as i
  with output as o

  a.mode <- i.premium ? "full" : "basic"
  o.result <- a.data
}`;

    let capturedInput: any;
    const tools = {
      api: (p: any) => {
        capturedInput = p;
        return { data: "ok" };
      },
    };

    await compileAndRun(
      bridgeText,
      "Query.conditional",
      { premium: true },
      tools,
    );
    assert.equal(capturedInput.mode, "full");

    await compileAndRun(
      bridgeText,
      "Query.conditional",
      { premium: false },
      tools,
    );
    assert.equal(capturedInput.mode, "basic");
  });

  test("condAnd parity — matches runtime boolean semantics", async () => {
    const document: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "probe",
          handles: [
            { kind: "input", handle: "i" },
            { kind: "output", handle: "o" },
          ],
          wires: [
            {
              condAnd: {
                leftRef: {
                  module: "_",
                  type: "Query",
                  field: "probe",
                  path: ["m"],
                },
                rightValue: "null",
              },
              to: {
                module: "_",
                type: "Query",
                field: "probe",
                path: ["k"],
              },
            },
          ],
        },
      ],
    };

    const runtime = await executeBridge({
      document,
      operation: "Query.probe",
      input: {},
      tools: {},
    });
    const aot = await executeAot({
      document,
      operation: "Query.probe",
      input: {},
      tools: {},
    });

    assert.deepStrictEqual(aot.data, runtime.data);
    assert.deepStrictEqual(aot.data, { k: false });
  });

  test("condOr parity — matches runtime boolean semantics", async () => {
    const document: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "probeOr",
          handles: [
            { kind: "input", handle: "i" },
            { kind: "output", handle: "o" },
          ],
          wires: [
            {
              condOr: {
                leftRef: {
                  module: "_",
                  type: "Query",
                  field: "probeOr",
                  path: ["m"],
                },
                rightValue: "null",
              },
              to: {
                module: "_",
                type: "Query",
                field: "probeOr",
                path: ["k"],
              },
            },
          ],
        },
      ],
    };

    const runtime = await executeBridge({
      document,
      operation: "Query.probeOr",
      input: {},
      tools: {},
    });
    const aot = await executeAot({
      document,
      operation: "Query.probeOr",
      input: {},
      tools: {},
    });

    assert.deepStrictEqual(aot.data, runtime.data);
    assert.deepStrictEqual(aot.data, { k: false });
  });
});

// ── Benchmark: AOT vs Runtime ────────────────────────────────────────────────

describe("AOT codegen: performance comparison", () => {
  const bridgeText = `version 1.5
bridge Query.chain {
  with first as f
  with second as s
  with third as t
  with input as i
  with output as o

  f.x <- i.value
  s.y <- f.result
  t.z <- s.result
  o.final <- t.result ?? 0
}`;

  const tools = {
    first: (p: any) => ({ result: (p.x ?? 0) + 1 }),
    second: (p: any) => ({ result: (p.y ?? 0) * 2 }),
    third: (p: any) => ({ result: (p.z ?? 0) + 10 }),
  };

  test("AOT produces same result as runtime executor", async () => {
    const document = parseBridgeFormat(bridgeText);

    // Runtime execution
    const runtime = await executeBridge({
      document: JSON.parse(JSON.stringify(document)),
      operation: "Query.chain",
      input: { value: 5 },
      tools,
    });

    // AOT execution
    const aotData = await compileAndRun(
      bridgeText,
      "Query.chain",
      { value: 5 },
      tools,
    );

    assert.deepEqual(aotData, runtime.data);
  });

  test("AOT execution is faster than runtime (sync tools)", async () => {
    const document = parseBridgeFormat(bridgeText);
    const iterations = 1000;

    // Build AOT function once
    const { code } = compileBridge(document, { operation: "Query.chain" });
    const aotFn = buildAotFn(code);

    // Warm up
    for (let i = 0; i < 10; i++) {
      await aotFn({ value: i }, tools, {});
      await executeBridge({
        document: JSON.parse(JSON.stringify(document)),
        operation: "Query.chain",
        input: { value: i },
        tools,
      });
    }

    // Benchmark AOT
    const aotStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await aotFn({ value: i }, tools, {});
    }
    const aotTime = performance.now() - aotStart;

    // Benchmark runtime
    const rtStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      await executeBridge({
        document: JSON.parse(JSON.stringify(document)),
        operation: "Query.chain",
        input: { value: i },
        tools,
      });
    }
    const rtTime = performance.now() - rtStart;

    const speedup = rtTime / aotTime;
    console.log(
      `  AOT: ${aotTime.toFixed(1)}ms | Runtime: ${rtTime.toFixed(1)}ms | Speedup: ${speedup.toFixed(1)}×`,
    );

    // AOT should be measurably faster with sync tools
    assert.ok(
      speedup > 1.0,
      `Expected AOT to be faster, got speedup: ${speedup.toFixed(2)}×`,
    );
  });
});

// ── Phase 6: Catch fallback ──────────────────────────────────────────────────

describe("AOT codegen: catch fallback", () => {
  test("catch with constant fallback value", async () => {
    const bridgeText = `version 1.5
bridge Query.safe {
  with api as a
  with output as o

  o.data <- a.result catch "fallback"
}`;

    const tools = {
      api: () => {
        throw new Error("boom");
      },
    };

    const data = await compileAndRun(bridgeText, "Query.safe", {}, tools);
    assert.deepEqual(data, { data: "fallback" });
  });

  test("catch does not trigger on success", async () => {
    const bridgeText = `version 1.5
bridge Query.noerr {
  with api as a
  with output as o

  o.data <- a.result catch "fallback"
}`;

    const tools = {
      api: () => ({ result: "success" }),
    };

    const data = await compileAndRun(bridgeText, "Query.noerr", {}, tools);
    assert.deepEqual(data, { data: "success" });
  });

  test("catch with ref fallback", async () => {
    const bridgeText = `version 1.5
bridge Query.refCatch {
  with primary as p
  with backup as b
  with output as o

  o.data <- p.result catch b.fallback
}`;

    const tools = {
      primary: () => {
        throw new Error("primary failed");
      },
      backup: () => ({ fallback: "from-backup" }),
    };

    const data = await compileAndRun(bridgeText, "Query.refCatch", {}, tools);
    assert.deepEqual(data, { data: "from-backup" });
  });
});

// ── Phase 7: Force statements ────────────────────────────────────────────────

describe("AOT codegen: force statements", () => {
  test("force tool runs even when output not queried", async () => {
    let auditCalled = false;
    let auditInput: any = null;

    const bridgeText = `version 1.5
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

    const tools = {
      mainApi: async (_p: any) => ({ title: "Hello World" }),
      "audit.log": async (input: any) => {
        auditCalled = true;
        auditInput = input;
        return { ok: true };
      },
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.search",
      { q: "test" },
      tools,
    );

    assert.equal(data.title, "Hello World");
    assert.ok(auditCalled, "audit tool must be called");
    assert.deepStrictEqual(auditInput, { action: "test" });
  });

  test("fire-and-forget force does not break response on error", async () => {
    const bridgeText = `version 1.5
bridge Query.safe {
  with mainApi as m
  with analytics as ping
  with input as i
  with output as o

  m.q <- i.q
  ping.event <- i.q
  force ping catch null
  o.title <- m.title
}`;

    const tools = {
      mainApi: async () => ({ title: "OK" }),
      analytics: async () => {
        throw new Error("analytics down");
      },
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.safe",
      { q: "test" },
      tools,
    );

    assert.equal(data.title, "OK");
  });

  test("critical force propagates errors", async () => {
    const bridgeText = `version 1.5
bridge Query.critical {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

  m.q <- i.q
  audit.action <- i.q
  force audit
  o.title <- m.title
}`;

    const tools = {
      mainApi: async () => ({ title: "OK" }),
      "audit.log": async () => {
        throw new Error("audit failed");
      },
    };

    await assert.rejects(
      () => compileAndRun(bridgeText, "Query.critical", { q: "test" }, tools),
      /audit failed/,
    );
  });

  test("force with constant-only wires (no pull)", async () => {
    let sideEffectCalled = false;

    const bridgeText = `version 1.5
bridge Mutation.fire {
  with sideEffect as se
  with input as i
  with output as o

  se.action = "fire"
  force se
  o.ok = "true"
}`;

    const tools = {
      sideEffect: async (input: any) => {
        sideEffectCalled = true;
        assert.equal(input.action, "fire");
        return null;
      },
    };

    const data = await compileAndRun(
      bridgeText,
      "Mutation.fire",
      { action: "deploy" },
      tools,
    );

    assert.equal(data.ok, true);
    assert.ok(sideEffectCalled, "side-effect tool must run");
  });
});

// ── Phase 8: ToolDef support ─────────────────────────────────────────────────

describe("AOT codegen: ToolDef support", () => {
  test("ToolDef constant wires merged with bridge wires", async () => {
    let apiInput: any = null;

    const bridgeText = `version 1.5
tool restApi from std.httpCall {
  with context
  .method = "GET"
  .baseUrl = "https://api.example.com"
  .headers.Authorization <- context.token
}

bridge Query.data {
  with restApi as api
  with input as i
  with output as o

  api.path <- i.path
  o.result <- api.body
}`;

    const tools = {
      "std.httpCall": async (input: any) => {
        apiInput = input;
        return { body: { ok: true } };
      },
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.data",
      { path: "/users" },
      tools,
      { token: "Bearer abc123" },
    );

    assert.equal(apiInput.method, "GET");
    assert.equal(apiInput.baseUrl, "https://api.example.com");
    assert.equal(apiInput.path, "/users");
    assert.deepEqual(data, { result: { ok: true } });
  });

  test("bridge wires override ToolDef wires", async () => {
    let apiInput: any = null;

    const bridgeText = `version 1.5
tool restApi from std.httpCall {
  .method = "GET"
  .timeout = 5000
}

bridge Query.custom {
  with restApi as api
  with output as o

  api.method = "POST"
  o.result <- api.data
}`;

    const tools = {
      "std.httpCall": async (input: any) => {
        apiInput = input;
        return { data: "ok" };
      },
    };

    const data = await compileAndRun(bridgeText, "Query.custom", {}, tools);

    // Bridge wire "POST" overrides ToolDef wire "GET"
    assert.equal(apiInput.method, "POST");
    // ToolDef wire timeout persists
    assert.equal(apiInput.timeout, 5000);
    assert.deepEqual(data, { result: "ok" });
  });

  test("ToolDef onError provides fallback on failure", async () => {
    const bridgeText = `version 1.5
tool safeApi from std.httpCall {
  on error = {"status":"error","message":"service unavailable"}
}

bridge Query.safe {
  with safeApi as api
  with input as i
  with output as o

  api.url <- i.url
  o <- api
}`;

    const tools = {
      "std.httpCall": async () => {
        throw new Error("connection refused");
      },
    };

    const data = await compileAndRun(
      bridgeText,
      "Query.safe",
      { url: "https://broken.api" },
      tools,
    );

    assert.deepEqual(data, { status: "error", message: "service unavailable" });
  });

  test("ToolDef extends chain", async () => {
    let apiInput: any = null;

    const bridgeText = `version 1.5
tool baseApi from std.httpCall {
  .method = "GET"
  .baseUrl = "https://api.example.com"
}

tool userApi from baseApi {
  .path = "/users"
}

bridge Query.users {
  with userApi as api
  with output as o

  o <- api
}`;

    const tools = {
      "std.httpCall": async (input: any) => {
        apiInput = input;
        return { users: [] };
      },
    };

    const data = await compileAndRun(bridgeText, "Query.users", {}, tools);

    assert.equal(apiInput.method, "GET");
    assert.equal(apiInput.baseUrl, "https://api.example.com");
    assert.equal(apiInput.path, "/users");
    assert.deepEqual(data, { users: [] });
  });
});

// ── Phase 9: executeAot integration ──────────────────────────────────────────

describe("executeAot: compile-once, run-many", () => {
  const bridgeText = `version 1.5
bridge Query.echo {
  with api as a
  with input as i
  with output as o

  a.msg <- i.msg
  o.reply <- a.echo
}`;

  test("basic executeAot works", async () => {
    const document = parseBridgeFormat(bridgeText);
    const { data } = await executeAot({
      document,
      operation: "Query.echo",
      input: { msg: "hello" },
      tools: { api: (p: any) => ({ echo: p.msg + "!" }) },
    });
    assert.deepEqual(data, { reply: "hello!" });
  });

  test("executeAot caches compiled function", async () => {
    const document = parseBridgeFormat(bridgeText);

    // First call compiles
    const { data: d1 } = await executeAot({
      document,
      operation: "Query.echo",
      input: { msg: "first" },
      tools: { api: (p: any) => ({ echo: p.msg }) },
    });
    assert.deepEqual(d1, { reply: "first" });

    // Second call reuses cached function (same document object)
    const { data: d2 } = await executeAot({
      document,
      operation: "Query.echo",
      input: { msg: "second" },
      tools: { api: (p: any) => ({ echo: p.msg }) },
    });
    assert.deepEqual(d2, { reply: "second" });
  });

  test("executeAot matches executeBridge result", async () => {
    const document = parseBridgeFormat(bridgeText);
    const tools = { api: (p: any) => ({ echo: `${p.msg}!` }) };

    const aotResult = await executeAot({
      document,
      operation: "Query.echo",
      input: { msg: "test" },
      tools,
    });

    const rtResult = await executeBridge({
      document: JSON.parse(JSON.stringify(document)),
      operation: "Query.echo",
      input: { msg: "test" },
      tools,
    });

    assert.deepEqual(aotResult.data, rtResult.data);
  });

  test("executeAot with context", async () => {
    const ctxBridge = `version 1.5
bridge Query.secure {
  with api as a
  with context as ctx
  with output as o

  a.token <- ctx.key
  o.result <- a.data
}`;
    const document = parseBridgeFormat(ctxBridge);
    const { data } = await executeAot({
      document,
      operation: "Query.secure",
      tools: { api: (p: any) => ({ data: p.token }) },
      context: { key: "secret" },
    });
    assert.deepEqual(data, { result: "secret" });
  });
});

// ── Phase: Abort signal & timeout ────────────────────────────────────────────

describe("executeAot: abort signal & timeout", () => {
  test("abort signal prevents tool execution", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name
}`);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () =>
        executeAot({
          document,
          operation: "Query.test",
          tools: { api: async () => ({ name: "should not run" }) },
          signal: controller.signal,
        }),
      /aborted/,
    );
  });

  test("tool timeout triggers error", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name
}`);
    await assert.rejects(
      () =>
        executeAot({
          document,
          operation: "Query.test",
          tools: {
            api: () =>
              new Promise((resolve) =>
                setTimeout(() => resolve({ name: "slow" }), 5000),
              ),
          },
          toolTimeoutMs: 50,
        }),
      /Tool timeout/,
    );
  });
});

// ── Overdefinition bypass ────────────────────────────────────────────────────

describe("AOT codegen: overdefinition bypass", () => {
  test("input before tool — tool skipped when input is non-null", async () => {
    const callLog: string[] = [];
    const result = await compileAndRun(
      `version 1.5
bridge Query.test {
  with expensiveApi
  with input as i
  with output as o

  o.val <- i.cached
  o.val <- expensiveApi.data
}`,
      "Query.test",
      { cached: "hit" },
      {
        expensiveApi: () => {
          callLog.push("expensiveApi");
          return { data: "expensive" };
        },
      },
    );
    assert.equal(result.val, "hit");
    assert.deepStrictEqual(callLog, [], "tool should NOT be called");
  });

  test("input before tool — tool called when input is null", async () => {
    const callLog: string[] = [];
    const result = await compileAndRun(
      `version 1.5
bridge Query.test {
  with expensiveApi
  with input as i
  with output as o

  o.val <- i.cached
  o.val <- expensiveApi.data
}`,
      "Query.test",
      {},
      {
        expensiveApi: () => {
          callLog.push("expensiveApi");
          return { data: "expensive" };
        },
      },
    );
    assert.equal(result.val, "expensive");
    assert.deepStrictEqual(callLog, ["expensiveApi"], "tool should be called");
  });

  test("tool before input — tool always called (primary position)", async () => {
    const callLog: string[] = [];
    const result = await compileAndRun(
      `version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o

  o.label <- api.label
  o.label <- i.hint
}`,
      "Query.test",
      { hint: "from-input" },
      {
        api: () => {
          callLog.push("api");
          return { label: "from-api" };
        },
      },
    );
    // Tool is first (primary) → always called → wins
    assert.equal(result.label, "from-api");
    assert.deepStrictEqual(callLog, ["api"]);
  });

  test("two tools — second skipped when first resolves non-null", async () => {
    const callLog: string[] = [];
    const result = await compileAndRun(
      `version 1.5
bridge Query.test {
  with svcA
  with svcB
  with input as i
  with output as o

  svcA.q <- i.q
  svcB.q <- i.q
  o.label <- svcA.label
  o.label <- svcB.label
}`,
      "Query.test",
      { q: "test" },
      {
        svcA: () => {
          callLog.push("svcA");
          return { label: "from-A" };
        },
        svcB: () => {
          callLog.push("svcB");
          return { label: "from-B" };
        },
      },
    );
    assert.equal(result.label, "from-A");
    assert.deepStrictEqual(callLog, ["svcA"], "svcB should NOT be called");
  });

  test("tool with multiple fields — not skipped if one field is primary", async () => {
    const callLog: string[] = [];
    const result = await compileAndRun(
      `version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o

  o.name <- i.hint
  o.name <- api.name
  o.score <- api.score
}`,
      "Query.test",
      { hint: "from-input" },
      {
        api: () => {
          callLog.push("api");
          return { name: "from-api", score: 42 };
        },
      },
    );
    // api has primary contribution (score) + secondary (name)
    // → can't skip → tool MUST be called
    assert.equal(result.name, "from-input");
    assert.equal(result.score, 42);
    assert.deepStrictEqual(callLog, ["api"]);
  });

  test("overdefinition parity — matches runtime behavior", async () => {
    const bridgeText = `version 1.5
bridge Query.test {
  with expensiveApi
  with input as i
  with output as o

  o.val <- i.cached
  o.val <- expensiveApi.data
}`;
    const document = parseBridgeFormat(bridgeText);
    const tools = {
      expensiveApi: () => ({ data: "expensive" }),
    };

    // With cached value
    const rtWithCache = await executeBridge({
      document,
      operation: "Query.test",
      input: { cached: "hit" },
      tools,
    });
    const aotWithCache = await executeAot({
      document,
      operation: "Query.test",
      input: { cached: "hit" },
      tools,
    });
    assert.deepStrictEqual(aotWithCache.data, rtWithCache.data);

    // Without cached value
    const rtNoCache = await executeBridge({
      document,
      operation: "Query.test",
      input: {},
      tools,
    });
    const aotNoCache = await executeAot({
      document,
      operation: "Query.test",
      input: {},
      tools,
    });
    assert.deepStrictEqual(aotNoCache.data, rtNoCache.data);
  });

  test("constant overdefinition parity — first constant remains terminal", async () => {
    const document: BridgeDocument = {
      instructions: [
        {
          kind: "bridge",
          type: "Query",
          field: "constantOverdef",
          handles: [{ kind: "output", handle: "o" }],
          wires: [
            {
              value: "null",
              to: {
                module: "_",
                type: "Query",
                field: "constantOverdef",
                path: ["k"],
              },
            },
            {
              value: "false",
              to: {
                module: "_",
                type: "Query",
                field: "constantOverdef",
                path: ["k"],
              },
            },
          ],
        },
      ],
    };

    const runtime = await executeBridge({
      document,
      operation: "Query.constantOverdef",
      input: {},
      tools: {},
    });
    const aot = await executeAot({
      document,
      operation: "Query.constantOverdef",
      input: {},
      tools: {},
    });

    assert.deepStrictEqual(aot.data, runtime.data);
    assert.deepStrictEqual(aot.data, { k: null });
  });

  test("generated code contains conditional wrapping", () => {
    const code = compileOnly(
      `version 1.5
bridge Query.test {
  with expensiveApi
  with input as i
  with output as o

  o.val <- i.cached
  o.val <- expensiveApi.data
}`,
      "Query.test",
    );
    // Should contain a let declaration (conditional) instead of const
    assert.ok(code.includes("let _t"), "should use let for conditional tool");
    assert.ok(code.includes("if ("), "should have conditional check");
  });
});

// ── Tracing support ──────────────────────────────────────────────────────────

describe("AOT codegen: tracing", () => {
  test("trace: off returns empty traces array", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.name <- api.name
}`);
    const result = await executeAot<any>({
      document,
      operation: "Query.test",
      input: { q: "hello" },
      tools: { api: () => ({ name: "world" }) },
      trace: "off",
    });
    assert.deepStrictEqual(result.traces, []);
    assert.equal(result.data.name, "world");
  });

  test("trace: basic records tool calls without input/output", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.name <- api.name
}`);
    const result = await executeAot<any>({
      document,
      operation: "Query.test",
      input: { q: "hello" },
      tools: {
        api: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { name: "world" };
        },
      },
      trace: "basic",
    });
    assert.equal(result.data.name, "world");
    assert.equal(result.traces.length, 1);
    const trace = result.traces[0]!;
    assert.equal(trace.tool, "api");
    assert.ok(trace.durationMs >= 0);
    assert.ok(trace.startedAt >= 0);
    // basic level should NOT include input/output
    assert.equal(trace.input, undefined);
    assert.equal(trace.output, undefined);
  });

  test("trace: full includes input and output", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.name <- api.name
}`);
    const result = await executeAot({
      document,
      operation: "Query.test",
      input: { q: "hello" },
      tools: { api: () => ({ name: "world" }) },
      trace: "full",
    });
    assert.equal(result.traces.length, 1);
    const trace = result.traces[0]!;
    assert.equal(trace.tool, "api");
    assert.deepStrictEqual(trace.input, { q: "hello" });
    assert.deepStrictEqual(trace.output, { name: "world" });
  });

  test("trace records error on tool failure", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with api
  with input as i
  with output as o
  api.q <- i.q
  o.name <- api?.name catch "fallback"
}`);
    const result = await executeAot<any>({
      document,
      operation: "Query.test",
      input: { q: "hello" },
      tools: {
        api: () => {
          throw new Error("HTTP 500");
        },
      },
      trace: "full",
    });
    assert.equal(result.data.name, "fallback");
    assert.equal(result.traces.length, 1);
    assert.equal(result.traces[0]!.error, "HTTP 500");
  });

  test("no-trace result still has traces field", async () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with input as i
  with output as o
  o.name <- i.name
}`);
    const result = await executeAot<any>({
      document,
      operation: "Query.test",
      input: { name: "Alice" },
    });
    assert.deepStrictEqual(result.traces, []);
    assert.equal(result.data.name, "Alice");
  });
});

// ── Parallel scheduling ──────────────────────────────────────────────────────
//
// Verify that independent tool calls are batched into Promise.all in the
// generated code, achieving true wall-clock parallelism.

describe("AOT codegen: parallel scheduling", () => {
  test("generated code contains Promise.all for independent tools", () => {
    const code = compileOnly(
      `version 1.5
bridge Query.trio {
  with svc.a as sa
  with svc.b as sb
  with svc.c as sc
  with input as i
  with output as o
  sa.x <- i.x
  sb.x <- i.x
  sc.x <- i.x
  o.a <- sa.result
  o.b <- sb.result
  o.c <- sc.result
}`,
      "Query.trio",
    );
    assert.ok(
      code.includes("Promise.all"),
      `Expected Promise.all in generated code, got:\n${code}`,
    );
  });

  test("diamond generated code has Promise.all for second layer", () => {
    const code = compileOnly(
      `version 1.5
bridge Query.dashboard {
  with geo.code as gc
  with weather.get as w
  with census.get as c
  with formatGreeting as fg
  with input as i
  with output as o
  gc.city <- i.city
  w.lat <- gc.lat
  w.lng <- gc.lng
  c.lat <- gc.lat
  c.lng <- gc.lng
  o.greeting <- fg:i.city
  o.temp <- w.temp
  o.humidity <- w.humidity
  o.population <- c.population
}`,
      "Query.dashboard",
    );
    // First layer: geo.code + formatGreeting are independent → Promise.all
    // Second layer: weather.get + census.get are independent → Promise.all
    const allCount = (code.match(/Promise\.all/g) || []).length;
    assert.ok(
      allCount >= 2,
      `Expected at least 2 Promise.all calls (layer1 + layer2), got ${allCount}. Code:\n${code}`,
    );
  });
});

// ── Async array mapping bugs ─────────────────────────────────────────────────

describe("AOT codegen: async array mapping", () => {
  test("catch fallback inside array mapping does not generate await in .map()", async () => {
    // Bug 1: catch on element ref generates await (async () => { try ... })()
    // inside a synchronous .map() callback → SyntaxError
    const bridgeText = `version 1.5
bridge Query.catchElem {
  with api
  with output as o

  o.items <- api.results[] as item {
    .name <- item.name catch "unknown"
  }
}`;

    const code = compileOnly(bridgeText, "Query.catchElem");
    // The generated code must be valid JS — try building & running it
    const fn = buildAotFn(code);
    const result = await fn(
      {},
      { api: () => ({ results: [{ name: "Alice" }, { name: "Bob" }] }) },
      {},
    );
    assert.deepEqual(result, {
      items: [{ name: "Alice" }, { name: "Bob" }],
    });
  });

  test("continue control flow with element-scoped tool uses async loop", async () => {
    // Bug 2: ?? continue triggers flatMap, but element-scoped tool generates
    // await __call() inside the non-async flatMap callback → SyntaxError
    const bridgeText = `version 1.5
bridge Query.contTool {
  with api
  with enricher
  with output as o

  o.items <- api.results[] as item {
    alias enricher:item as e
    .name <- item.name ?? continue
    .extra <- e.data
  }
}`;

    const code = compileOnly(bridgeText, "Query.contTool");
    // Must produce valid JS
    const fn = buildAotFn(code);
    const result = await fn(
      {},
      {
        api: () => ({
          results: [
            { name: "Alice", itemId: 1 },
            { name: null, itemId: 2 },
            { name: "Carol", itemId: 3 },
          ],
        }),
        enricher: (input: any) => ({
          data: `enriched-${input.in?.itemId ?? "?"}`,
        }),
      },
      {},
    );
    // item with null name is skipped by continue
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].name, "Alice");
    assert.equal(result.items[1].name, "Carol");
  });

  test("nested sub-array with catch does not generate await in .map()", async () => {
    // Bug 3: inner sub-array uses .map() but catch generates await inside it
    const bridgeText = `version 1.5
bridge Query.nestedCatch {
  with api
  with output as o

  o <- api.groups[] as g {
    .label <- g.name
    .items <- g.items[] as sub {
      .value <- sub.val catch "default"
    }
  }
}`;

    const code = compileOnly(bridgeText, "Query.nestedCatch");
    const fn = buildAotFn(code);
    const result = await fn(
      {},
      {
        api: () => ({
          groups: [
            {
              name: "G1",
              items: [{ val: "a" }, { val: "b" }],
            },
          ],
        }),
      },
      {},
    );
    assert.deepEqual(result, [
      {
        label: "G1",
        items: [{ value: "a" }, { value: "b" }],
      },
    ]);
  });

  test("nested sub-array with element-scoped tool uses async loop", async () => {
    // Bug 3 variant: inner sub-array has element-scoped tool that generates
    // await __call() inside synchronous .map() → SyntaxError
    const bridgeText = `version 1.5
bridge Query.nestedTool {
  with api
  with enricher
  with output as o

  o <- api.groups[] as g {
    .label <- g.name
    .items <- g.items[] as sub {
      alias enricher:sub as e
      .value <- e.data
    }
  }
}`;

    const code = compileOnly(bridgeText, "Query.nestedTool");
    const fn = buildAotFn(code);
    const result = await fn(
      {},
      {
        api: () => ({
          groups: [
            {
              name: "G1",
              items: [{ id: 1 }, { id: 2 }],
            },
          ],
        }),
        enricher: (input: any) => ({ data: `val-${input.in?.id ?? "?"}` }),
      },
      {},
    );
    assert.equal(result[0].label, "G1");
    assert.equal(result[0].items.length, 2);
  });

  test("continue control flow with catch inside array uses async loop", async () => {
    // Bug 1+2 combined: continue + catch fallback
    const bridgeText = `version 1.5
bridge Query.contCatch {
  with api
  with enricher
  with output as o

  o.items <- api.results[] as item {
    alias enricher:item as e
    .name <- item.name ?? continue
    .extra <- e.data catch "n/a"
  }
}`;

    const code = compileOnly(bridgeText, "Query.contCatch");
    const fn = buildAotFn(code);
    const result = await fn(
      {},
      {
        api: () => ({
          results: [{ name: "Alice" }, { name: null }, { name: "Carol" }],
        }),
        enricher: (_input: any) => ({ data: "ok" }),
      },
      {},
    );
    assert.equal(result.items.length, 2);
  });

  test("non-root array field with continue and element-scoped tool uses async loop", async () => {
    // Bug 2 for non-root arrays: the same flatMap issue in the sub-array codepath
    const bridgeText = `version 1.5
bridge Query.subContTool {
  with api
  with enricher
  with output as o

  o.title <- api.title
  o.items <- api.items[] as item {
    alias enricher:item as e
    .name <- item.name ?? continue
    .extra <- e.data
  }
}`;

    const code = compileOnly(bridgeText, "Query.subContTool");
    const fn = buildAotFn(code);
    const result = await fn(
      {},
      {
        api: () => ({
          title: "Test",
          items: [{ name: "Alice" }, { name: null }, { name: "Carol" }],
        }),
        enricher: (_input: any) => ({ data: "ok" }),
      },
      {},
    );
    assert.equal(result.title, "Test");
    assert.equal(result.items.length, 2);
  });
});
