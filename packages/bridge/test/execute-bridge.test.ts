import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// executeBridge — core language behavior
//
// Migrated from legacy/execute-bridge.test.ts to regressionTest harness.
// Tests object output, root wires, arrays, nested structures, aliases,
// constant wires, and error handling.
// ═══════════════════════════════════════════════════════════════════════════

// ── Object output: chained tools, root passthrough, constants ─────────────

regressionTest("object output: chained tools and passthrough", {
  bridge: bridge`
    version 1.5

    bridge Query.chained {
      with test.multitool as a
      with test.multitool as b
      with test.multitool as c
      with input as i
      with output as out

      a <- i.a
      b.x <- a.val
      c.y <- b.x
      out.result <- c.y
    }

    bridge Query.passthrough {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o <- api.user
    }

    bridge Query.constants {
      with input as i
      with output as o

      o.greeting = "hello"
      o.name <- i.name
    }
  `,
  tools,
  scenarios: {
    "Query.chained": {
      "chained providers resolve all fields": {
        input: { a: { val: 42 } },
        assertData: { result: 42 },
        assertTraces: 3,
      },
    },
    "Query.passthrough": {
      "root object wire returns entire tool output": {
        input: {
          api: { user: { name: "Alice", age: 30, email: "alice@example.com" } },
        },
        assertData: { name: "Alice", age: 30, email: "alice@example.com" },
        assertTraces: 1,
      },
    },
    "Query.constants": {
      "constant and input wires coexist": {
        input: { name: "World" },
        assertData: { greeting: "hello", name: "World" },
        assertTraces: 0,
      },
    },
  },
});

// ── Array output ──────────────────────────────────────────────────────────

regressionTest("array output: root and sub-field mapping", {
  bridge: bridge`
    version 1.5

    bridge Query.arrayRoot {
      with test.multitool as gc
      with input as i
      with output as o

      gc <- i.gc
      o <- gc.items[] as item {
        .name <- item.title
        .lat  <- item.position.lat
        .lon  <- item.position.lng
      }
    }

    bridge Query.arrayField {
      with test.multitool as src
      with input as i
      with output as o

      src <- i.src
      o.title <- src.name
      o.entries <- src.items[] as item {
        .id <- item.item_id
        .label <- item.item_name
        .cost <- item.unit_price
      }
    }
  `,
  tools,
  scenarios: {
    "Query.arrayRoot": {
      "array elements are materialised with renamed fields": {
        input: {
          gc: {
            items: [
              { title: "Berlin", position: { lat: 52.53, lng: 13.39 } },
              { title: "Bern", position: { lat: 46.95, lng: 7.45 } },
            ],
          },
        },
        assertData: [
          { name: "Berlin", lat: 52.53, lon: 13.39 },
          { name: "Bern", lat: 46.95, lon: 7.45 },
        ],
        assertTraces: 1,
      },
      "empty array returns empty array": {
        input: { gc: { items: [] } },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.arrayField": {
      "sub-field array with renamed fields": {
        input: {
          src: {
            name: "Catalog A",
            items: [
              { item_id: 1, item_name: "Widget", unit_price: 9.99 },
              { item_id: 2, item_name: "Gadget", unit_price: 14.5 },
            ],
          },
        },
        assertData: {
          title: "Catalog A",
          entries: [
            { id: 1, label: "Widget", cost: 9.99 },
            { id: 2, label: "Gadget", cost: 14.5 },
          ],
        },
        assertTraces: 1,
      },
      "empty array on sub-field returns empty array": {
        input: {
          src: { name: "Empty", items: [] },
        },
        assertData: { title: "Empty", entries: [] },
        assertTraces: 1,
      },
    },
  },
});

// ── Pipe, alias and ternary inside array blocks ───────────────────────────

regressionTest("array blocks: pipe, alias, and ternary", {
  bridge: bridge`
    version 1.5

    bridge Query.pipeInArray {
      with test.multitool as src
      with std.str.toUpperCase as upper
      with input as i
      with output as o

      src <- i.src
      o.entries <- src.items[] as it {
        .id <- it.id
        .label <- upper:it.name
      }
    }

    bridge Query.aliasInArray {
      with test.multitool as src
      with test.multitool as enrich
      with input as i
      with output as o

      src <- i.src
      o.title <- src.name ?? "Untitled"
      o.entries <- src.items[] as it {
        alias enrich:it as e
        .id <- it.item_id
        .label <- e.in.name
      }
    }

    bridge Query.ternaryInArray {
      with test.multitool as src
      with input as i
      with output as o

      src <- i.src
      o.entries <- src.items[] as it {
        .id <- it.id
        .active <- it.status == "active" ? true : false
      }
    }
  `,
  tools,
  scenarios: {
    "Query.pipeInArray": {
      "pipe inside array resolves iterator variable": {
        input: {
          src: {
            items: [
              { id: 1, name: "widget" },
              { id: 2, name: "gadget" },
            ],
          },
        },
        assertData: {
          entries: [
            { id: 1, label: "WIDGET" },
            { id: 2, label: "GADGET" },
          ],
        },
        assertTraces: 1,
      },
      "empty items": {
        input: { src: { items: [] } },
        assertData: { entries: [] },
        assertTraces: 1,
      },
    },
    "Query.aliasInArray": {
      "per-element tool call produces correct results": {
        input: {
          src: {
            name: "Catalog A",
            items: [
              { item_id: 1, name: "Widget" },
              { item_id: 2, name: "Gadget" },
            ],
          },
        },
        assertData: {
          title: "Catalog A",
          entries: [
            { id: 1, label: "Widget" },
            { id: 2, label: "Gadget" },
          ],
        },
        assertTraces: 3,
      },
      "empty items with null name": {
        input: { src: { name: null, items: [] } },
        assertData: { title: "Untitled", entries: [] },
        assertTraces: 1,
      },
    },
    "Query.ternaryInArray": {
      "ternary expression inside array block": {
        input: {
          src: {
            items: [
              { id: 1, status: "active" },
              { id: 2, status: "inactive" },
            ],
          },
        },
        assertData: {
          entries: [
            { id: 1, active: true },
            { id: 2, active: false },
          ],
        },
        assertTraces: 1,
      },
      "empty items": {
        input: { src: { items: [] } },
        assertData: { entries: [] },
        assertTraces: 1,
      },
    },
  },
});

// ── Nested structures: scope blocks and nested arrays ─────────────────────

regressionTest("nested structures: scope blocks and nested arrays", {
  bridge: bridge`
    version 1.5

    bridge Query.scopeBlock {
      with test.multitool as w
      with input as i
      with output as o

      w <- i.w
      o.decision <- w.temperature > 20 || false catch false
      o.why {
        .temperature <- w.temperature ?? 0.0
        .city <- i.city
      }
    }

    bridge Query.scopeDefault {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a
      o.summary {
        .temp <- a.temp ?? 0
        .wind <- a.wind ?? 0
      }
    }

    bridge Query.nestedArrays {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o <- api.connections[] as c {
        .id <- c.id
        .legs <- c.sections[] as s {
          .trainName <- s.name
          .origin.station <- s.departure.station
          .destination.station <- s.arrival.station
        }
      }
    }
  `,
  tools,
  scenarios: {
    "Query.scopeBlock": {
      "scope block produces nested object": {
        input: { w: { temperature: 25 }, city: "Berlin" },
        allowDowngrade: true,
        assertData: {
          decision: true,
          why: { temperature: 25, city: "Berlin" },
        },
        assertTraces: 1,
      },
      "scope block with false decision": {
        input: { w: { temperature: 15 }, city: "Oslo" },
        allowDowngrade: true,
        assertData: {
          decision: false,
          why: { temperature: 15, city: "Oslo" },
        },
        assertTraces: 1,
      },
      "temperature null → ?? fallback fires": {
        input: { w: { temperature: null }, city: "Null" },
        allowDowngrade: true,
        assertData: {
          decision: false,
          why: { temperature: 0, city: "Null" },
        },
        assertTraces: 1,
      },
      "tool error → catch fires for decision": {
        input: { w: { _error: "fail" }, city: "Error" },
        allowDowngrade: true,
        fields: ["decision"],
        assertData: { decision: false },
        assertTraces: 1,
      },
    },
    "Query.scopeDefault": {
      "?? default fills null response": {
        input: { a: { temp: null, wind: null } },
        assertData: { summary: { temp: 0, wind: 0 } },
        assertTraces: 1,
      },
      "values present": {
        input: { a: { temp: 22, wind: 5 } },
        assertData: { summary: { temp: 22, wind: 5 } },
        assertTraces: 1,
      },
    },
    "Query.nestedArrays": {
      "nested array elements are fully materialised": {
        input: {
          api: {
            connections: [
              {
                id: "c1",
                sections: [
                  {
                    name: "IC 8",
                    departure: { station: "Bern" },
                    arrival: { station: "Zürich" },
                  },
                  {
                    name: "S3",
                    departure: { station: "Zürich" },
                    arrival: { station: "Aarau" },
                  },
                ],
              },
            ],
          },
        },
        assertData: [
          {
            id: "c1",
            legs: [
              {
                trainName: "IC 8",
                origin: { station: "Bern" },
                destination: { station: "Zürich" },
              },
              {
                trainName: "S3",
                origin: { station: "Zürich" },
                destination: { station: "Aarau" },
              },
            ],
          },
        ],
        assertTraces: 1,
      },
      "empty connections": {
        input: { api: { connections: [] } },
        assertData: [],
        assertTraces: 1,
      },
      "connection with empty sections": {
        input: {
          api: { connections: [{ id: "c2", sections: [] }] },
        },
        assertData: [{ id: "c2", legs: [] }],
        assertTraces: 1,
      },
    },
  },
});

// ── Alias declarations ───────────────────────────────────────────────────

regressionTest("alias: iterator-scoped aliases", {
  bridge: bridge`
    version 1.5

    bridge Query.aliasPipeIter {
      with test.multitool as api
      with test.multitool as enrich
      with input as i
      with output as o

      api <- i.api
      o <- api.items[] as it {
        alias enrich:it as resp
        .a <- resp.in.id
        .b <- resp.in.name
      }
    }

    bridge Query.aliasIterSub {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      o <- api.items[] as it {
        alias it.nested as n
        .x <- n.a
        .y <- n.b
      }
    }

    bridge Query.aliasIterTool {
      with test.multitool as api
      with std.str.toUpperCase as uc
      with input as i
      with output as o

      api <- i.api
      o <- api.items[] as it {
        alias uc:it.name as upper
        .label <- upper
        .id <- it.id
      }
    }
  `,
  tools,
  scenarios: {
    "Query.aliasPipeIter": {
      "alias pipe:iter evaluates once per element": {
        input: {
          api: {
            items: [
              { id: 10, name: "X" },
              { id: 20, name: "Y" },
            ],
          },
        },
        assertData: [
          { a: 10, b: "X" },
          { a: 20, b: "Y" },
        ],
        assertTraces: 3,
      },
      "empty items": {
        input: { api: { items: [] } },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.aliasIterSub": {
      "alias iter.subfield as name": {
        input: {
          api: {
            items: [{ nested: { a: 1, b: 2 } }, { nested: { a: 3, b: 4 } }],
          },
        },
        allowDowngrade: true,
        assertData: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
        assertTraces: 1,
      },
      "empty items": {
        input: { api: { items: [] } },
        allowDowngrade: true,
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.aliasIterTool": {
      "alias tool:iter in array": {
        input: {
          api: {
            items: [
              { id: 1, name: "alice" },
              { id: 2, name: "bob" },
            ],
          },
        },
        assertData: [
          { label: "ALICE", id: 1 },
          { label: "BOB", id: 2 },
        ],
        assertTraces: 1,
      },
      "empty items": {
        input: { api: { items: [] } },
        assertData: [],
        assertTraces: 1,
      },
    },
  },
});

regressionTest("alias: top-level aliases", {
  bridge: bridge`
    version 1.5

    bridge Query.aliasTopPipe {
      with std.str.toUpperCase as uc
      with input as i
      with output as o

      alias uc:i.name as cached

      o.greeting <- cached
      o.label <- cached
      o.title <- cached
    }

    bridge Query.aliasTopHandle {
      with test.multitool as api
      with input as i
      with output as o

      api <- i.api
      alias api.result.data as d

      o.name <- d.name
      o.email <- d.email
    }

    bridge Query.aliasTopReused {
      with test.multitool as api
      with std.str.toUpperCase as uc
      with output as o
      with input as i

      api <- i.api
      alias uc:i.category as upperCat

      o <- api.products[] as it {
        alias uc:it.title as upper
        .name <- upper
        .price <- it.price
        .category <- upperCat
      }
    }
  `,
  tools,
  scenarios: {
    "Query.aliasTopPipe": {
      "top-level alias caches result — reads same value": {
        input: { name: "alice" },
        assertData: {
          greeting: "ALICE",
          label: "ALICE",
          title: "ALICE",
        },
        assertTraces: 0,
      },
    },
    "Query.aliasTopHandle": {
      "top-level alias handle.path as name — simple rename": {
        input: {
          api: {
            result: { data: { name: "Alice", email: "alice@test.com" } },
          },
        },
        allowDowngrade: true,
        assertData: { name: "Alice", email: "alice@test.com" },
        assertTraces: 1,
      },
    },
    "Query.aliasTopReused": {
      "top-level alias reused inside array — not re-evaluated per element": {
        input: {
          api: {
            products: [
              { title: "phone", price: 999 },
              { title: "laptop", price: 1999 },
            ],
          },
          category: "electronics",
        },
        assertData: [
          { name: "PHONE", price: 999, category: "ELECTRONICS" },
          { name: "LAPTOP", price: 1999, category: "ELECTRONICS" },
        ],
        assertTraces: 1,
      },
      "empty products": {
        input: {
          api: { products: [] },
          category: "electronics",
        },
        assertData: [],
        assertTraces: 1,
      },
    },
  },
});

regressionTest("alias: expressions and modifiers", {
  bridge: bridge`
    version 1.5

    bridge AliasOr.test {
      with output as o
      with input as i

      alias i.nickname || "Guest" as displayName

      o.name <- displayName
    }

    bridge AliasNullish.test {
      with output as o
      with input as i

      alias i.score ?? 0 as score

      o.score <- score
    }

    bridge AliasCatch.test {
      with test.multitool as api
      with output as o
      with input as i

      api <- i.api
      alias api.value catch 99 as safeVal

      o.result <- safeVal
    }

    bridge AliasSafe.test {
      with test.multitool as api
      with output as o
      with input as i

      api <- i.api
      alias api?.value as safeVal

      o.result <- safeVal || "fallback"
    }

    bridge AliasMath.test {
      with input as i
      with output as o

      alias i.price + 10 as bumped

      o.result <- bumped
    }

    bridge AliasCompare.test {
      with input as i
      with output as o

      alias i.role == "admin" as isAdmin

      o.isAdmin <- isAdmin
    }

    bridge AliasParens.test {
      with input as i
      with output as o

      alias (i.a + i.b) * 2 as doubled

      o.result <- doubled
    }

    bridge AliasStringLit.test {
      with output as o

      alias "hello world" as greeting

      o.result <- greeting
    }

    bridge AliasStringCmp.test {
      with input as i
      with output as o

      alias "a" == i.val as matchesA

      o.result <- matchesA
    }

    bridge AliasNot.test {
      with input as i
      with output as o

      alias not i.blocked as allowed

      o.allowed <- allowed
    }

    bridge AliasTernary.test {
      with input as i
      with output as o

      alias i.score >= 90 ? "A" : "B" as grade

      o.grade <- grade
    }
  `,
  tools,
  scenarios: {
    "AliasOr.test": {
      "nickname present": {
        input: { nickname: "Alice" },
        allowDowngrade: true,
        assertData: { name: "Alice" },
        assertTraces: 0,
      },
      "nickname missing → fallback": {
        input: {},
        allowDowngrade: true,
        assertData: { name: "Guest" },
        assertTraces: 0,
      },
    },
    "AliasNullish.test": {
      "value present": {
        input: { score: 42 },
        allowDowngrade: true,
        assertData: { score: 42 },
        assertTraces: 0,
      },
      "value missing → fallback": {
        input: {},
        allowDowngrade: true,
        assertData: { score: 0 },
        assertTraces: 0,
      },
    },
    "AliasCatch.test": {
      "tool throws → catch provides fallback": {
        input: { api: { _error: "Service unavailable" } },
        allowDowngrade: true,
        assertData: { result: 99 },
        assertTraces: 1,
      },
      "tool succeeds → value used": {
        input: { api: { value: 42 } },
        allowDowngrade: true,
        assertData: { result: 42 },
        assertTraces: 1,
      },
    },
    "AliasSafe.test": {
      "tool throws → ?. returns undefined, || picks fallback": {
        input: { api: { _error: "Service unavailable" } },
        allowDowngrade: true,
        assertData: { result: "fallback" },
        assertTraces: 1,
      },
      "tool succeeds → value used": {
        input: { api: { value: "real" } },
        allowDowngrade: true,
        assertData: { result: "real" },
        assertTraces: 1,
      },
    },
    "AliasMath.test": {
      "math expression": {
        input: { price: 5 },
        assertData: { result: 15 },
        assertTraces: 0,
      },
    },
    "AliasCompare.test": {
      "comparison true": {
        input: { role: "admin" },
        assertData: { isAdmin: true },
        assertTraces: 0,
      },
      "comparison false": {
        input: { role: "user" },
        assertData: { isAdmin: false },
        assertTraces: 0,
      },
    },
    "AliasParens.test": {
      "parenthesized expression": {
        input: { a: 3, b: 4 },
        assertData: { result: 14 },
        assertTraces: 0,
      },
    },
    "AliasStringLit.test": {
      "string literal source": {
        input: {},
        assertData: { result: "hello world" },
        assertTraces: 0,
      },
    },
    "AliasStringCmp.test": {
      "string literal matches": {
        input: { val: "a" },
        assertData: { result: true },
        assertTraces: 0,
      },
      "string literal does not match": {
        input: { val: "b" },
        assertData: { result: false },
        assertTraces: 0,
      },
    },
    "AliasNot.test": {
      "not false → true": {
        input: { blocked: false },
        assertData: { allowed: true },
        assertTraces: 0,
      },
      "not true → false": {
        input: { blocked: true },
        assertData: { allowed: false },
        assertTraces: 0,
      },
    },
    "AliasTernary.test": {
      "score >= 90 → A": {
        input: { score: 95 },
        assertData: { grade: "A" },
        assertTraces: 0,
      },
      "score < 90 → B": {
        input: { score: 75 },
        assertData: { grade: "B" },
        assertTraces: 0,
      },
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// Tracing
// ═══════════════════════════════════════════════════════════════════════════

const echoTools = { myTool: (p: any) => ({ y: p.x * 2 }) };
const noTraceTool = (p: any) => ({ y: p.x * 3 });
(noTraceTool as any).bridge = { sync: true, trace: false };

regressionTest("tracing", {
  bridge: bridge`
    version 1.5

    bridge Query.echo {
      with myTool as t
      with input as i
      with output as o

      t.x <- i.x
      o.result <- t.y
    }

    bridge Query.combo {
      with myTool as t
      with hiddenTool as h
      with input as i
      with output as o

      t.x <- i.x
      h.x <- t.y
      o.result <- h.y
    }
  `,
  scenarios: {
    "Query.echo": {
      "traces contain tool calls when tracing is enabled": {
        input: { x: 5 },
        tools: echoTools,
        assertData: { result: 10 },
        assertTraces: (traces) => {
          assert.ok(traces.length > 0);
          assert.ok(traces.some((t) => t.tool === "myTool"));
        },
      },
    },
    "Query.combo": {
      "tools with trace:false are excluded from traces": {
        input: { x: 5 },
        tools: { myTool: echoTools.myTool, hiddenTool: noTraceTool },
        assertData: { result: 30 },
        assertTraces: (traces) => {
          assert.ok(traces.length > 0, "should have at least one trace");
          assert.ok(
            traces.some((t) => t.tool === "myTool"),
            "myTool should appear in traces",
          );
          assert.ok(
            !traces.some((t) => t.tool === "hiddenTool"),
            "hiddenTool (trace:false) should NOT appear in traces",
          );
        },
      },
    },
  },
});
