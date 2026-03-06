/**
 * Variable scoping test suite.
 *
 * Validates which references are visible at each nesting level in array
 * mapping blocks and documents current limitations.  Each case runs against
 * **both** the runtime interpreter and the AOT compiler.
 *
 * ## Scope rules
 *
 *  Level 0 – bridge root:
 *    All `with … as handle` declarations are visible everywhere.
 *
 *  Level 1 – `[] as x { … }`:
 *    • The iterator `x` is visible.
 *    • Root-level handles remain visible.
 *    • `.field` targets the output element.
 *
 *  Level 2 – `[] as y { … }` nested inside level 1:
 *    • The inner iterator `y` is visible.
 *    • Root-level handles remain visible.
 *    • **Outer iterator `x`** should be visible but is NOT yet supported
 *      by the parser (tracked as TODO — tests document the expected
 *      behavior and are marked pending).
 *
 *  Level 3 – `[] as z { … }` nested inside level 2:
 *    • Same rules — `z` visible, root handles visible,
 *      outer iterators `x` / `y` are expected but not yet reachable.
 *
 * ## Element-scoped tools
 *
 *  `with <tool> as <handle>` inside array blocks creates an isolated
 *  per-element fork.  The handle is visible only within that block.
 *
 * ## Aliases & Pipes
 *
 *  `alias source.path as name` and `pipe:source.path` are scoped to the
 *  block in which they appear.
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
  /**
   * When set, the test documents expected behavior that is not yet
   * implemented.  The test is registered as a `TODO` with the given
   * reason string instead of running (and failing).
   */
  pending?: string;
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
        // Cases that document expected behavior not yet implemented.
        // The body runs the full assertion so the test will auto-pass
        // once the feature lands (node:test treats todo-pass as info).
        if (c.pending) {
          test("runtime", { todo: c.pending }, async () => {
            const data = await runRuntime(c);
            if (c.expected !== undefined) assert.deepEqual(data, c.expected);
          });
          test("aot", { todo: c.pending }, async () => {
            const data = await runAot(c);
            if (c.expected !== undefined) assert.deepEqual(data, c.expected);
          });
          return;
        }

        test("runtime", async () => {
          const data = await runRuntime(c);
          if (c.expected !== undefined) assert.deepEqual(data, c.expected);
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
// 1. Single-level array — iterator and root handles visible
// ═══════════════════════════════════════════════════════════════════════════

const singleLevelCases: ScopingTestCase[] = [
  {
    name: "iterator fields visible at level 1",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    .id <- item.id
    .name <- item.name
  }
}`,
    operation: "Query.test",
    input: { list: [{ id: "1", name: "one" }, { id: "2", name: "two" }] },
    expected: {
      items: [
        { id: "1", name: "one" },
        { id: "2", name: "two" },
      ],
    },
  },
  {
    name: "root-level tool visible from level 1",
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
    tools: { config: () => ({ setting: "global" }) },
    expected: {
      items: [
        { val: "a", cfgVal: "global" },
        { val: "b", cfgVal: "global" },
      ],
    },
    aotSupported: false,
  },
  {
    name: "multiple root-level tools visible from level 1",
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

runScopingSuite("Scoping: single-level array", singleLevelCases);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Two-level nested arrays — own iterators only (current behavior)
// ═══════════════════════════════════════════════════════════════════════════

const twoLevelCases: ScopingTestCase[] = [
  {
    name: "each level reads its own iterator",
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
        { name: "A", items: [{ label: "a1" }, { label: "a2" }] },
        { name: "B", items: [{ label: "b1" }] },
      ],
    },
    aotSupported: false,
  },
  {
    name: "root-level tool visible from level 2 (two levels deep)",
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
    tools: { enricher: () => ({ tag: "enriched" }) },
    expected: {
      items: [
        {
          val: "a",
          enriched: "enriched",
          subs: [
            { sv: "a1", enriched: "enriched" },
            { sv: "a2", enriched: "enriched" },
          ],
        },
        {
          val: "b",
          enriched: "enriched",
          subs: [{ sv: "b1", enriched: "enriched" }],
        },
      ],
    },
    aotSupported: false,
  },
  {
    // EXPECTED but NOT YET SUPPORTED: inner scope reads outer iterator
    name: "level 2 reads outer iterator x.v (cross-scope)",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.l1 <- i.a[] as x {
    .xv <- x.v
    .l2 <- x.children[] as y {
      .yv <- y.v
      .xv <- x.v
    }
  }
}`,
    operation: "Query.test",
    input: {
      a: [
        { v: "X1", children: [{ v: "Y1" }, { v: "Y2" }] },
        { v: "X2", children: [{ v: "Y3" }] },
      ],
    },
    expected: {
      l1: [
        {
          xv: "X1",
          l2: [
            { yv: "Y1", xv: "X1" },
            { yv: "Y2", xv: "X1" },
          ],
        },
        {
          xv: "X2",
          l2: [{ yv: "Y3", xv: "X2" }],
        },
      ],
    },
    pending: "parser does not yet support outer-scope iterator references",
  },
];

runScopingSuite("Scoping: two-level nested arrays", twoLevelCases);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Three-level nested arrays
// ═══════════════════════════════════════════════════════════════════════════

const threeLevelCases: ScopingTestCase[] = [
  {
    name: "each level reads its own iterator only (three levels)",
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
            { yv: "Y1", l3: [{ zv: "Z1" }, { zv: "Z2" }] },
            { yv: "Y2", l3: [{ zv: "Z3" }] },
          ],
        },
        {
          xv: "X2",
          l2: [{ yv: "Y3", l3: [{ zv: "Z4" }] }],
        },
      ],
    },
    aotSupported: false,
  },
  {
    name: "root-level tool visible from level 3 (three levels deep)",
    bridgeText: `version 1.5
bridge Query.test {
  with enricher as e
  with input as i
  with output as o

  o.l1 <- i.a[] as x {
    .xv <- x.v
    .l2 <- x.children[] as y {
      .yv <- y.v
      .l3 <- y.children[] as z {
        .zv <- z.v
        .enriched <- e.tag
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
            { v: "Y1", children: [{ v: "Z1" }] },
          ],
        },
      ],
    },
    tools: { enricher: () => ({ tag: "enriched" }) },
    expected: {
      l1: [
        {
          xv: "X1",
          l2: [
            {
              yv: "Y1",
              l3: [{ zv: "Z1", enriched: "enriched" }],
            },
          ],
        },
      ],
    },
    aotSupported: false,
  },
  {
    // EXPECTED but NOT YET SUPPORTED
    name: "level 3 reads outer iterators x.v and y.v (cross-scope)",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.l1 <- i.a[] as x {
    .xv <- x.v
    .l2 <- x.children[] as y {
      .yv <- y.v
      .xv <- x.v
      .l3 <- y.children[] as z {
        .zv <- z.v
        .xv <- x.v
        .yv <- y.v
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
            {
              v: "Y1",
              children: [{ v: "Z1" }, { v: "Z2" }],
            },
          ],
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
              xv: "X1",
              l3: [
                { zv: "Z1", xv: "X1", yv: "Y1" },
                { zv: "Z2", xv: "X1", yv: "Y1" },
              ],
            },
          ],
        },
      ],
    },
    pending: "parser does not yet support outer-scope iterator references",
  },
  {
    // EXPECTED but NOT YET SUPPORTED
    name: "level 2 reads outer iterator x.v with three levels (cross-scope)",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.l1 <- i.a[] as x {
    .xv <- x.v
    .l2 <- x.children[] as y {
      .yv <- y.v
      .xv <- x.v
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
            { v: "Y1", children: [{ v: "Z1" }] },
          ],
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
              xv: "X1",
              l3: [{ zv: "Z1" }],
            },
          ],
        },
      ],
    },
    pending: "parser does not yet support outer-scope iterator references",
  },
];

runScopingSuite("Scoping: three-level nested arrays", threeLevelCases);

// ═══════════════════════════════════════════════════════════════════════════
// 4. Alias scoping inside array blocks
// ═══════════════════════════════════════════════════════════════════════════

const aliasCases: ScopingTestCase[] = [
  {
    name: "alias binds sub-path within element block",
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
  {
    name: "alias in nested array block",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.groups <- i.groups[] as g {
    .name <- g.name
    .items <- g.items[] as item {
      alias item.detail as d
      .label <- d.label
    }
  }
}`,
    operation: "Query.test",
    input: {
      groups: [
        { name: "A", items: [{ detail: { label: "a1" } }] },
        { name: "B", items: [{ detail: { label: "b1" } }, { detail: { label: "b2" } }] },
      ],
    },
    expected: {
      groups: [
        { name: "A", items: [{ label: "a1" }] },
        { name: "B", items: [{ label: "b1" }, { label: "b2" }] },
      ],
    },
    aotSupported: false,
  },
];

runScopingSuite("Scoping: alias inside array blocks", aliasCases);

// ═══════════════════════════════════════════════════════════════════════════
// 5. Pipe scoping inside array blocks (colon syntax)
// ═══════════════════════════════════════════════════════════════════════════

const pipeCases: ScopingTestCase[] = [
  {
    name: "pipe transforms element field at level 1",
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
  {
    name: "pipe in nested array",
    bridgeText: `version 1.5
bridge Query.test {
  with std.str.toUpperCase as upper
  with input as i
  with output as o

  o.groups <- i.groups[] as g {
    .name <- upper:g.name
    .tags <- g.tags[] as tag {
      .label <- upper:tag.label
    }
  }
}`,
    operation: "Query.test",
    input: {
      groups: [
        { name: "alpha", tags: [{ label: "fast" }, { label: "safe" }] },
        { name: "beta", tags: [{ label: "new" }] },
      ],
    },
    expected: {
      groups: [
        { name: "ALPHA", tags: [{ label: "FAST" }, { label: "SAFE" }] },
        { name: "BETA", tags: [{ label: "NEW" }] },
      ],
    },
    aotSupported: false,
  },
];

runScopingSuite("Scoping: pipes inside array blocks", pipeCases);

// ═══════════════════════════════════════════════════════════════════════════
// 6. Element-scoped tool declarations (`with tool as handle` inside block)
// ═══════════════════════════════════════════════════════════════════════════

const elementScopedToolCases: ScopingTestCase[] = [
  {
    name: "element-scoped tool is isolated per element",
    bridgeText: `version 1.5
bridge Query.test {
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with myTool as t

    t.id <- item.id
    .result <- t.data
  }
}`,
    operation: "Query.test",
    input: { list: [{ id: "a" }, { id: "b" }, { id: "c" }] },
    tools: {
      myTool: (inp: Record<string, unknown>) => ({ data: `result-${inp.id}` }),
    },
    expected: {
      items: [
        { result: "result-a" },
        { result: "result-b" },
        { result: "result-c" },
      ],
    },
    pending: "element-scoped tool wires not yet executed by runtime",
  },
  {
    name: "element-scoped tool coexists with root-level tool",
    bridgeText: `version 1.5
bridge Query.test {
  with globalTool as g
  with input as i
  with output as o

  o.items <- i.list[] as item {
    with localTool as lt

    lt.id <- item.id
    .local <- lt.value
    .global <- g.setting
  }
}`,
    operation: "Query.test",
    input: { list: [{ id: "x" }, { id: "y" }] },
    tools: {
      globalTool: () => ({ setting: "shared" }),
      localTool: (inp: Record<string, unknown>) => ({ value: `local-${inp.id}` }),
    },
    expected: {
      items: [
        { local: "local-x", global: "shared" },
        { local: "local-y", global: "shared" },
      ],
    },
    pending: "element-scoped tool wires not yet executed by runtime",
  },
];

runScopingSuite("Scoping: element-scoped tool declarations", elementScopedToolCases);

// ═══════════════════════════════════════════════════════════════════════════
// 7. Request-scoped cache — each execution gets a fresh scope
// ═══════════════════════════════════════════════════════════════════════════

describe("Scoping: request-scoped isolation", () => {
  test("each executeBridge call has an independent scope", async () => {
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
    assert.equal(callCount, 2, "each request should have its own scope");
  });
});
