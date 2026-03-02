import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat } from "@stackables/bridge-compiler";
import { executeBridge } from "@stackables/bridge-core";
import { compileBridge } from "../src/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as typeof Function;

/** Build an async function from AOT-generated code. */
function buildAotFn(code: string) {
  const bodyMatch = code.match(
    /export default async function \w+\(input, tools, context\) \{([\s\S]*)\}\s*$/,
  );
  if (!bodyMatch)
    throw new Error(`Cannot extract function body from:\n${code}`);
  return new AsyncFunction("input", "tools", "context", bodyMatch[1]!) as (
    input: Record<string, unknown>,
    tools: Record<string, (...args: any[]) => any>,
    context: Record<string, unknown>,
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

  test("empty output returns empty object", async () => {
    const bridgeText = `version 1.5
bridge Query.empty {
  with output as o
}`;

    const data = await compileAndRun(bridgeText, "Query.empty", {});
    assert.deepEqual(data, {});
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

    const data = await compileAndRun(
      bridgeText,
      "Query.falsy",
      {},
      tools,
    );
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

    const data = await compileAndRun(
      bridgeText,
      "Query.fallback",
      {},
      tools,
    );
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

    const data = await compileAndRun(
      bridgeText,
      "Query.catalog",
      {},
      tools,
    );
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

    const data = await compileAndRun(
      bridgeText,
      "Query.empty",
      {},
      tools,
    );
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

    const data = await compileAndRun(
      bridgeText,
      "Query.nullable",
      {},
      tools,
    );
    assert.deepEqual(data, { items: [] });
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
    assert.ok(code.includes("(input, tools, context)"));
  });

  test("invalid operation throws", () => {
    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with output as o
}`);
    assert.throws(
      () => compileBridge(document, { operation: "Query.missing" }),
      /No bridge found/,
    );
    assert.throws(
      () => compileBridge(document, { operation: "invalid" }),
      /Invalid operation/,
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
