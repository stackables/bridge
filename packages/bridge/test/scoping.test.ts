/**
 * Scoping & Memoization test suite.
 *
 * Validates variable scoping rules and memoization behavior against
 * **both** the runtime interpreter and the AOT compiler.
 *
 * Scope rules:
 *  - Each array element gets its own shadow scope; `.field` targets the element.
 *  - Root-level tools are visible from inside array blocks.
 *  - Aliases declared inside array blocks are scoped to the element.
 *  - Memoization cache is request-scoped (never global) and shared across
 *    all elements in the same request via Promise-based stampede protection.
 *
 * Each test case is a data record run through both execution paths.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBridgeFormat } from "@stackables/bridge-parser";
import { executeBridge } from "@stackables/bridge-core";
import { executeBridge as executeAot } from "@stackables/bridge-compiler";

// ── Test-case type ──────────────────────────────────────────────────────────

interface ScopingTestCase {
  /** Human-readable test name */
  name: string;
  /** Bridge source text (with `version 1.5` prefix) */
  bridgeText: string;
  /** Operation to execute */
  operation: string;
  /** Input arguments */
  input?: Record<string, unknown>;
  /** Tool implementations (keyed by name) */
  tools?: Record<string, (...args: any[]) => any>;
  /** Context passed to the engine */
  context?: Record<string, unknown>;
  /** Expected output data */
  expected?: unknown;
  /** Whether the AOT compiler supports this case (default: true) */
  aotSupported?: boolean;
  /** Side-effect assertions run after execution (e.g. call counts) */
  afterAssert?: () => void;
}

// ── Runners ─────────────────────────────────────────────────────────────────

async function runRuntime(c: ScopingTestCase): Promise<unknown> {
  const document = parseBridgeFormat(c.bridgeText);
  const doc = JSON.parse(JSON.stringify(document));
  const { data } = await executeBridge({
    document: doc,
    operation: c.operation,
    input: c.input ?? {},
    tools: c.tools ?? {},
    context: c.context,
  });
  return data;
}

async function runAot(c: ScopingTestCase): Promise<unknown> {
  const document = parseBridgeFormat(c.bridgeText);
  const { data } = await executeAot({
    document,
    operation: c.operation,
    input: c.input ?? {},
    tools: c.tools ?? {},
    context: c.context,
  });
  return data;
}

function runScopingSuite(suiteName: string, cases: ScopingTestCase[]) {
  describe(suiteName, () => {
    for (const c of cases) {
      describe(c.name, () => {
        test("runtime", async () => {
          const data = await runRuntime(c);
          if (c.expected !== undefined) assert.deepEqual(data, c.expected);
          c.afterAssert?.();
        });

        if (c.aotSupported !== false) {
          test("aot", async () => {
            const data = await runAot(c);
            if (c.expected !== undefined) assert.deepEqual(data, c.expected);
          });

          test("parity: runtime === aot", async () => {
            const [rtData, aotData] = await Promise.all([
              runRuntime(c),
              runAot(c),
            ]);
            assert.deepEqual(rtData, aotData);
          });
        } else {
          test("aot: skipped (not yet supported)", () => {});
        }
      });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Reading from root-level tools inside array blocks
// ═══════════════════════════════════════════════════════════════════════════

const outerScopeReadCases: ScopingTestCase[] = [
  {
    name: "array element reads from root-level tool output",
    bridgeText: `version 1.5
bridge Query.test {
  with config as cfg
  with input as i
  with output as o

  o.items <- i.list[] as item {
    .val <- item.x
    .cfgVal <- cfg.setting
  }
}`,
    operation: "Query.test",
    input: { list: [{ x: "a" }, { x: "b" }] },
    tools: {
      config: () => ({ setting: "global-setting" }),
    },
    expected: {
      items: [
        { val: "a", cfgVal: "global-setting" },
        { val: "b", cfgVal: "global-setting" },
      ],
    },
    // AOT compiler doesn't fully support tool reads inside array mapping blocks
    aotSupported: false,
  },
  {
    name: "array element reads from root-level tool — multiple tools in scope",
    bridgeText: `version 1.5
bridge Query.test {
  with toolA as a
  with toolB as b
  with input as i
  with output as o

  o.items <- i.list[] as item {
    .id <- item.id
    .fromA <- a.tag
    .fromB <- b.tag
  }
}`,
    operation: "Query.test",
    input: { list: [{ id: "1" }, { id: "2" }] },
    tools: {
      toolA: () => ({ tag: "A" }),
      toolB: () => ({ tag: "B" }),
    },
    expected: {
      items: [
        { id: "1", fromA: "A", fromB: "B" },
        { id: "2", fromA: "A", fromB: "B" },
      ],
    },
    aotSupported: false,
  },
];

runScopingSuite("Scoping: reading from root-level tools", outerScopeReadCases);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Nested arrays — each level maps its own iterator fields
// ═══════════════════════════════════════════════════════════════════════════

const nestedArrayCases: ScopingTestCase[] = [
  {
    name: "two-level nested array maps fields independently",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.groups <- i.groups[] as g {
    .name <- g.name
    .items <- g.items[] as item {
      .label <- item.label
    }
  }
}`,
    operation: "Query.test",
    input: {
      groups: [
        { name: "A", items: [{ label: "a1" }, { label: "a2" }] },
        { name: "B", items: [{ label: "b1" }] },
      ],
    },
    expected: {
      groups: [
        {
          name: "A",
          items: [{ label: "a1" }, { label: "a2" }],
        },
        {
          name: "B",
          items: [{ label: "b1" }],
        },
      ],
    },
    aotSupported: false,
  },
  {
    name: "three-level nested arrays map element fields at each depth",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.l1 <- i.a[] as x {
    .xv <- x.v
    .l2 <- x.children[] as y {
      .yv <- y.v
      .l3 <- y.children[] as z {
        .zv <- z.v
      }
    }
  }
}`,
    operation: "Query.test",
    input: {
      a: [
        {
          v: "X1",
          children: [
            { v: "Y1", children: [{ v: "Z1" }, { v: "Z2" }] },
            { v: "Y2", children: [{ v: "Z3" }] },
          ],
        },
        {
          v: "X2",
          children: [{ v: "Y3", children: [{ v: "Z4" }] }],
        },
      ],
    },
    expected: {
      l1: [
        {
          xv: "X1",
          l2: [
            {
              yv: "Y1",
              l3: [{ zv: "Z1" }, { zv: "Z2" }],
            },
            {
              yv: "Y2",
              l3: [{ zv: "Z3" }],
            },
          ],
        },
        {
          xv: "X2",
          l2: [
            {
              yv: "Y3",
              l3: [{ zv: "Z4" }],
            },
          ],
        },
      ],
    },
    aotSupported: false,
  },
  {
    name: "nested array with root-level tool visible at inner depth",
    bridgeText: `version 1.5
bridge Query.test {
  with enricher as e
  with input as i
  with output as o

  o.items <- i.list[] as item {
    .val <- item.v
    .enriched <- e.tag
    .subs <- item.children[] as sub {
      .sv <- sub.v
      .enriched <- e.tag
    }
  }
}`,
    operation: "Query.test",
    input: {
      list: [
        { v: "a", children: [{ v: "a1" }, { v: "a2" }] },
        { v: "b", children: [{ v: "b1" }] },
      ],
    },
    tools: {
      enricher: () => ({ tag: "enriched-value" }),
    },
    expected: {
      items: [
        {
          val: "a",
          enriched: "enriched-value",
          subs: [
            { sv: "a1", enriched: "enriched-value" },
            { sv: "a2", enriched: "enriched-value" },
          ],
        },
        {
          val: "b",
          enriched: "enriched-value",
          subs: [{ sv: "b1", enriched: "enriched-value" }],
        },
      ],
    },
    aotSupported: false,
  },
];

runScopingSuite("Scoping: nested array mappings", nestedArrayCases);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Alias scoping inside array blocks
// ═══════════════════════════════════════════════════════════════════════════

const aliasScopingCases: ScopingTestCase[] = [
  {
    name: "alias binds sub-field in array block",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    alias item.meta.label as lbl
    .name <- lbl
    .id <- item.id
  }
}`,
    operation: "Query.test",
    input: {
      list: [
        { id: "1", meta: { label: "first" } },
        { id: "2", meta: { label: "second" } },
      ],
    },
    expected: {
      items: [
        { name: "first", id: "1" },
        { name: "second", id: "2" },
      ],
    },
  },
];

runScopingSuite("Scoping: alias inside array blocks", aliasScopingCases);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Pipe inside array blocks (colon syntax)
// ═══════════════════════════════════════════════════════════════════════════

const pipeInArrayCases: ScopingTestCase[] = [
  {
    name: "pipe transforms element field inside array block",
    bridgeText: `version 1.5
bridge Query.test {
  with std.str.toUpperCase as upper
  with input as i
  with output as o

  o.items <- i.list[] as item {
    .upper <- upper:item.name
    .raw <- item.name
  }
}`,
    operation: "Query.test",
    input: { list: [{ name: "hello" }, { name: "world" }] },
    expected: {
      items: [
        { upper: "HELLO", raw: "hello" },
        { upper: "WORLD", raw: "world" },
      ],
    },
  },
];

runScopingSuite("Scoping: pipes inside array blocks", pipeInArrayCases);

// ═══════════════════════════════════════════════════════════════════════════
// 5. ToolMetadata memoize deduplicates identical inputs
// ═══════════════════════════════════════════════════════════════════════════

const memoMetaCases: ScopingTestCase[] = (() => {
  let count = 0;
  const lookup = async (input: Record<string, unknown>) => {
    count++;
    return { result: `fetched-${input.id}` };
  };
  (lookup as any).bridge = { memoize: true };

  return [
    {
      name: "ToolMetadata memoize deduplicates identical inputs across two handles",
      bridgeText: `version 1.5
bridge Query.test {
  with lookup as a
  with lookup as b
  with output as o

  a.id = "42"
  b.id = "42"
  o.fromA <- a.result
  o.fromB <- b.result
}`,
      operation: "Query.test",
      tools: { lookup },
      expected: { fromA: "fetched-42", fromB: "fetched-42" },
      afterAssert: () => {
        assert.equal(count, 1, "should call once for identical inputs");
        count = 0;
      },
      aotSupported: false,
    },
    {
      name: "ToolMetadata memoize calls separately for different inputs",
      bridgeText: `version 1.5
bridge Query.test {
  with lookup as a
  with lookup as b
  with output as o

  a.id = "1"
  b.id = "2"
  o.fromA <- a.result
  o.fromB <- b.result
}`,
      operation: "Query.test",
      tools: { lookup },
      expected: { fromA: "fetched-1", fromB: "fetched-2" },
      afterAssert: () => {
        assert.equal(count, 2, "should call twice for different inputs");
        count = 0;
      },
      aotSupported: false,
    },
  ];
})();

runScopingSuite("Scoping: ToolMetadata memoization", memoMetaCases);

// ═══════════════════════════════════════════════════════════════════════════
// 6. DSL-level memoize keyword on handle bindings
// ═══════════════════════════════════════════════════════════════════════════

const dslMemoCases: ScopingTestCase[] = (() => {
  let count = 0;
  const fetch = async (input: Record<string, unknown>) => {
    count++;
    return { data: `result-${input.id}` };
  };
  return [
    {
      name: "DSL memoize on handle deduplicates identical inputs",
      bridgeText: `version 1.5
bridge Query.test {
  with fetch as a memoize
  with fetch as b memoize
  with output as o

  a.id = "42"
  b.id = "42"
  o.fromA <- a.data
  o.fromB <- b.data
}`,
      operation: "Query.test",
      tools: { fetch },
      expected: { fromA: "result-42", fromB: "result-42" },
      afterAssert: () => {
        assert.equal(count, 1, "DSL memoize: one call for identical inputs");
        count = 0;
      },
      // AOT compiler doesn't yet support multiple instances of the same tool
      aotSupported: false,
    },
  ];
})();

runScopingSuite("Scoping: DSL memoize keyword", dslMemoCases);

// ═══════════════════════════════════════════════════════════════════════════
// 7. ToolDef memoize on tool blocks
// ═══════════════════════════════════════════════════════════════════════════

const toolDefMemoCases: ScopingTestCase[] = (() => {
  let count = 0;
  const myFetcher = async (input: Record<string, unknown>) => {
    count++;
    return { result: `fetched-${input.url}` };
  };
  return [
    {
      name: "tool block memoize deduplicates across handles",
      bridgeText: `version 1.5
tool api from myFetcher memoize {
  .url = "https://example.com/data"
}

bridge Query.test {
  with api as a
  with api as b
  with output as o

  o.fromA <- a.result
  o.fromB <- b.result
}`,
      operation: "Query.test",
      tools: { myFetcher },
      expected: {
        fromA: "fetched-https://example.com/data",
        fromB: "fetched-https://example.com/data",
      },
      afterAssert: () => {
        assert.equal(count, 1, "ToolDef memoize: one call for same tool block");
        count = 0;
      },
      aotSupported: false,
    },
  ];
})();

runScopingSuite("Scoping: ToolDef memoize on tool blocks", toolDefMemoCases);

// ═══════════════════════════════════════════════════════════════════════════
// 8. Request-scoped cache — each execution gets a fresh cache
// ═══════════════════════════════════════════════════════════════════════════

describe("Scoping: request-scoped cache", () => {
  test("each executeBridge call gets a fresh memoization cache", async () => {
    let callCount = 0;
    const fetch = async (_input: Record<string, unknown>) => {
      callCount++;
      return { data: `result-${callCount}` };
    };
    (fetch as any).bridge = { memoize: true };

    const document = parseBridgeFormat(`version 1.5
bridge Query.test {
  with fetch as f
  with output as o

  f.id = "42"
  o.data <- f.data
}`);

    const r1 = await executeBridge({
      document: JSON.parse(JSON.stringify(document)),
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal((r1.data as Record<string, unknown>).data, "result-1");

    const r2 = await executeBridge({
      document: JSON.parse(JSON.stringify(document)),
      operation: "Query.test",
      input: {},
      tools: { fetch },
    });
    assert.equal((r2.data as Record<string, unknown>).data, "result-2");
    assert.equal(callCount, 2, "each request should have its own cache");
  });
});
