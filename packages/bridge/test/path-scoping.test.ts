import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Path scoping — scope blocks, nested scopes, array mapper scoping,
// spread syntax, and scope=flat equivalence.
//
// Migrated from legacy/path-scoping.test.ts
//
// NOTE: Parser-only tests (scope block parsing, serializer round-trip,
// array mapper, spread-syntax parser) have been moved to
// packages/bridge-parser/test/path-scoping-parser.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Scope block execution — constants ────────────────────────────────────

regressionTest("path scoping: scope block constants", {
  bridge: `
    version 1.5

    bridge Query.scopeConst {
      with input as i
      with output as o

      o.address {
        .city = "Zurich"
        .country = "CH"
      }
    }
  `,
  scenarios: {
    "Query.scopeConst": {
      "scope block constants resolve to nested object": {
        input: {},
        assertData: {
          address: { city: "Zurich", country: "CH" },
        },
        assertTraces: 0,
      },
    },
  },
});

// ── 2. Scope block execution — pull wires ───────────────────────────────────

regressionTest("path scoping: scope block pull wires", {
  bridge: `
    version 1.5

    bridge Query.scopePull {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      o.result {
        .name <- a.name
        .score <- a.score
      }
    }
  `,
  scenarios: {
    "Query.scopePull": {
      "scope block pull wires resolve from tool output": {
        input: { q: "test" },
        tools: {
          api: () => ({ name: "Widget", score: 42 }),
        },
        assertData: {
          result: { name: "Widget", score: 42 },
        },
        assertTraces: 1,
      },
    },
  },
});

// ── 3. Scope block execution — nested scopes ────────────────────────────────

regressionTest("path scoping: nested scope blocks", {
  bridge: `
    version 1.5

    bridge Query.nestedScope {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      o.outer {
        .label <- a.label
        .inner {
          .value <- a.deepValue
          .flag = true
        }
      }
    }
  `,
  scenarios: {
    "Query.nestedScope": {
      "nested scope blocks create deeply nested objects": {
        input: { q: "test" },
        tools: {
          api: () => ({ label: "top", deepValue: 99 }),
        },
        assertData: {
          outer: {
            label: "top",
            inner: { value: 99, flag: true },
          },
        },
        assertTraces: 1,
      },
    },
  },
});

// ── 4. Scope block on tool input ────────────────────────────────────────────

regressionTest("path scoping: scope block on tool input", {
  bridge: `
    version 1.5

    bridge Query.toolInputScope {
      with api as a
      with input as i
      with output as o

      a.query {
        .text <- i.searchText
        .limit = 10
      }
      o.results <- a.data
    }
  `,
  scenarios: {
    "Query.toolInputScope": {
      "scope block on tool input constructs nested input": {
        input: { searchText: "hello" },
        tools: {
          api: (p: any) => {
            assert.deepEqual(p.query, { text: "hello", limit: 10 });
            return { data: "found" };
          },
        },
        assertData: { results: "found" },
        assertTraces: 1,
      },
    },
  },
});

// ── 5. Alias inside nested scope blocks ─────────────────────────────────────

regressionTest("path scoping: alias inside nested scope", {
  bridge: `
    version 1.5

    bridge Query.aliasInScope {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      alias a.metadata as meta
      o.info {
        .title <- a.title
        .author <- meta.author
        .tags <- meta.tags
      }
    }
  `,
  scenarios: {
    "Query.aliasInScope": {
      "alias resolves correctly inside scope block": {
        input: { q: "test" },
        tools: {
          api: () => ({
            title: "Article",
            metadata: { author: "Alice", tags: ["a", "b"] },
          }),
        },
        assertData: {
          info: { title: "Article", author: "Alice", tags: ["a", "b"] },
        },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
  },
});

// ── 6. Array mapper scope blocks ────────────────────────────────────────────

regressionTest("path scoping: array mapper scope blocks", {
  bridge: `
    version 1.5

    bridge Query.arrayConst {
      with api as a
      with output as o

      o.items <- a.list[] as item {
        .name <- item.label
        .active = true
      }
    }

    bridge Query.arrayPull {
      with api as a
      with input as i
      with output as o

      a.category <- i.category
      o.items <- a.products[] as p {
        .id <- p.product_id
        .name <- p.title
        .price <- p.unit_price
      }
    }

    bridge Query.arrayNested {
      with api as a
      with output as o

      o.groups <- a.departments[] as dept {
        .name <- dept.deptName
        .members <- dept.employees[] as emp {
          .fullName <- emp.name
          .role <- emp.position
        }
      }
    }

    bridge Query.arrayMixed {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      o.title <- a.title
      o.items <- a.results[] as r {
        .id <- r.id
        .label <- r.name
        .source = "api"
      }
    }
  `,
  scenarios: {
    "Query.arrayConst": {
      "constants inside array mapper": {
        input: {},
        tools: {
          api: () => ({
            list: [{ label: "A" }, { label: "B" }],
          }),
        },
        assertData: {
          items: [
            { name: "A", active: true },
            { name: "B", active: true },
          ],
        },
        assertTraces: 1,
      },
      "empty array maps to empty array": {
        input: {},
        tools: {
          api: () => ({ list: [] }),
        },
        assertData: { items: [] },
        assertTraces: 1,
      },
    },
    "Query.arrayPull": {
      "pull wires referencing iterator inside array mapper": {
        input: { category: "electronics" },
        tools: {
          api: () => ({
            products: [
              { product_id: 1, title: "Phone", unit_price: 699 },
              { product_id: 2, title: "Tablet", unit_price: 499 },
            ],
          }),
        },
        assertData: {
          items: [
            { id: 1, name: "Phone", price: 699 },
            { id: 2, name: "Tablet", price: 499 },
          ],
        },
        assertTraces: 1,
      },
      "empty products array": {
        input: { category: "none" },
        tools: {
          api: () => ({ products: [] }),
        },
        assertData: { items: [] },
        assertTraces: 1,
      },
    },
    "Query.arrayNested": {
      "nested array-in-array scope block maps correctly": {
        input: {},
        tools: {
          api: () => ({
            departments: [
              {
                deptName: "Engineering",
                employees: [
                  { name: "Alice", position: "Lead" },
                  { name: "Bob", position: "Senior" },
                ],
              },
              {
                deptName: "Design",
                employees: [{ name: "Carol", position: "Manager" }],
              },
            ],
          }),
        },
        assertData: {
          groups: [
            {
              name: "Engineering",
              members: [
                { fullName: "Alice", role: "Lead" },
                { fullName: "Bob", role: "Senior" },
              ],
            },
            {
              name: "Design",
              members: [{ fullName: "Carol", role: "Manager" }],
            },
          ],
        },
        assertTraces: 1,
      },
      "empty departments array": {
        input: {},
        tools: {
          api: () => ({ departments: [] }),
        },
        assertData: { groups: [] },
        assertTraces: 1,
      },
      "department with empty employees": {
        input: {},
        tools: {
          api: () => ({
            departments: [{ deptName: "Empty", employees: [] }],
          }),
        },
        assertData: {
          groups: [{ name: "Empty", members: [] }],
        },
        assertTraces: 1,
      },
    },
    "Query.arrayMixed": {
      "mixed flat + scope in array mapper with tool output": {
        input: { q: "widgets" },
        tools: {
          api: () => ({
            title: "Search Results",
            results: [
              { id: 1, name: "Widget A" },
              { id: 2, name: "Widget B" },
            ],
          }),
        },
        assertData: {
          title: "Search Results",
          items: [
            { id: 1, label: "Widget A", source: "api" },
            { id: 2, label: "Widget B", source: "api" },
          ],
        },
        assertTraces: 1,
      },
      "empty results array": {
        input: { q: "nothing" },
        tools: {
          api: () => ({ title: "No Results", results: [] }),
        },
        assertData: { title: "No Results", items: [] },
        assertTraces: 1,
      },
    },
  },
});

// ── 7. Spread syntax ────────────────────────────────────────────────────────

regressionTest("path scoping: spread syntax", {
  bridge: `
    version 1.5

    bridge Query.spreadBasic {
      with api as a
      with output as o

      o {
        ... <- a
        .extra = "added"
      }
    }

    bridge Query.spreadWithConst {
      with api as a
      with output as o

      o {
        ... <- a.data
        .source = "api"
      }
    }

    bridge Query.spreadSubPath {
      with api as a
      with output as o

      o.info {
        ... <- a.metadata
        .verified = true
      }
    }
  `,
  scenarios: {
    "Query.spreadBasic": {
      "top-level spread copies all tool fields": {
        input: {},
        tools: {
          api: () => ({ name: "Alice", age: 30 }),
        },
        assertData: { name: "Alice", age: 30, extra: "added" },
        assertTraces: 1,
      },
    },
    "Query.spreadWithConst": {
      "spread + constants combine correctly": {
        input: {},
        tools: {
          api: () => ({ data: { x: 1, y: 2 } }),
        },
        assertData: { x: 1, y: 2, source: "api" },
        assertTraces: 1,
      },
    },
    "Query.spreadSubPath": {
      "spread with sub-path source": {
        input: {},
        tools: {
          api: () => ({ metadata: { author: "Bob", year: 2024 } }),
        },
        assertData: {
          info: { author: "Bob", year: 2024, verified: true },
        },
        assertTraces: 1,
      },
    },
  },
});
