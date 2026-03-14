import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Shared engine parity — behavioural tests run against both runtime and
// AOT compiler to guarantee identical output.
//
// Migrated from legacy/shared-parity.test.ts
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Pull wires + constants ───────────────────────────────────────────────

regressionTest("parity: pull wires + constants", {
  bridge: bridge`
    version 1.5

    bridge Query.livingStandard {
      with hereapi.geocode as gc
      with companyX.getLivingStandard as cx
      with toInt as ti
      with input as i
      with output as out

      gc.q <- i.location
      cx.x <- gc.lat
      cx.y <- gc.lon
      ti.value <- cx.lifeExpectancy
      out.lifeExpectancy <- ti.result
    }

    bridge Query.constWires {
      with api as a
      with output as o

      a.method = "GET"
      a.timeout = 5000
      a.enabled = true
      o.result <- a.data
    }

    bridge Query.constAndInput {
      with input as i
      with output as o

      o.greeting = "hello"
      o.name <- i.name
    }

    bridge Query.user {
      with api as a
      with input as i
      with output as o

      a.id <- i.userId
      o <- a
    }

    bridge Query.getUser {
      with userApi as api
      with input as i
      with output as o

      api.id <- i.id
      o <- api.user
    }

    bridge Query.secured {
      with api as a
      with context as ctx
      with input as i
      with output as o

      a.token <- ctx.apiKey
      a.query <- i.q
      o.data <- a.result
    }

    bridge Query.chain {
      with first as f
      with second as s
      with input as i
      with output as o

      f.x <- i.a
      s.y <- f.result
      o.final <- s.result
    }
  `,
  scenarios: {
    "Query.livingStandard": {
      "chained tool calls resolve all fields": {
        input: { location: "Berlin" },
        tools: {
          "hereapi.geocode": async () => ({ lat: 52.53, lon: 13.38 }),
          "companyX.getLivingStandard": async () => ({
            lifeExpectancy: "81.5",
          }),
          toInt: (p: any) => ({ result: Math.round(parseFloat(p.value)) }),
        },
        assertData: { lifeExpectancy: 82 },
        assertTraces: 3,
      },
    },
    "Query.constWires": {
      "constant wires emit literal values": {
        input: {},
        tools: {
          api: (p: any) => {
            assert.equal(p.method, "GET");
            assert.equal(p.timeout, 5000);
            assert.equal(p.enabled, true);
            return { data: "ok" };
          },
        },
        assertData: { result: "ok" },
        assertTraces: 1,
      },
    },
    "Query.constAndInput": {
      "constant and input wires coexist": {
        input: { name: "World" },
        assertData: { greeting: "hello", name: "World" },
        assertTraces: 0,
      },
    },
    "Query.user": {
      "root passthrough returns tool output directly": {
        input: { userId: 42 },
        tools: {
          api: (p: any) => ({ name: "Alice", id: p.id }),
        },
        assertData: { name: "Alice", id: 42 },
        assertTraces: 1,
      },
    },
    "Query.getUser": {
      "root passthrough with path": {
        input: { id: "123" },
        tools: {
          userApi: async () => ({
            user: { name: "Alice", age: 30, email: "alice@example.com" },
          }),
        },
        assertData: { name: "Alice", age: 30, email: "alice@example.com" },
        assertTraces: 1,
      },
    },
    "Query.secured": {
      "context references resolve correctly": {
        input: { q: "test" },
        tools: { api: (p: any) => ({ result: `${p.query}:${p.token}` }) },
        context: { apiKey: "secret123" },
        assertData: { data: "test:secret123" },
        assertTraces: 1,
      },
    },
    "Query.chain": {
      "tools receive correct chained inputs": {
        input: { a: 5 },
        tools: {
          first: (p: any) => ({ result: p.x * 2 }),
          second: (p: any) => ({ result: p.y + 1 }),
        },
        assertData: { final: 11 },
        assertTraces: 2,
      },
    },
  },
});

// ── 2. Fallback operators (??, ||) ──────────────────────────────────────────

regressionTest("parity: fallback operators", {
  bridge: bridge`
    version 1.5

    bridge Query.nullishConst {
      with api as a
      with input as i
      with output as o

      a.id <- i.id
      o.name <- a.name ?? "unknown"
    }

    bridge Query.nullishNoTrigger {
      with api as a
      with output as o

      o.count <- a.count ?? 42
    }

    bridge Query.falsyConst {
      with api as a
      with output as o

      o.label <- a.label || "default"
    }

    bridge Query.falsyRef {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val || b.val
    }

    bridge Query.nullishScope {
      with api as a
      with output as o

      o.summary {
        .temp <- a.temp ?? 0
        .wind <- a.wind ?? 0
      }
    }
  `,
  scenarios: {
    "Query.nullishConst": {
      "?? nullish coalescing with constant fallback": {
        input: { id: 1 },
        tools: { api: () => ({ name: null }) },
        assertData: { name: "unknown" },
        assertTraces: 1,
      },
    },
    "Query.nullishNoTrigger": {
      "?? does not trigger on falsy non-null values": {
        input: {},
        tools: { api: () => ({ count: 0 }) },
        assertData: { count: 0 },
        assertTraces: 1,
      },
      "?? triggers fallback on null": {
        input: {},
        tools: { api: () => ({ count: null }) },
        assertData: { count: 42 },
        assertTraces: 1,
      },
    },
    "Query.falsyConst": {
      "|| falsy fallback with constant": {
        input: {},
        tools: { api: () => ({ label: "" }) },
        assertData: { label: "default" },
        assertTraces: 1,
      },
    },
    "Query.falsyRef": {
      "|| falsy fallback with ref": {
        input: {},
        tools: {
          primary: () => ({ val: null }),
          backup: () => ({ val: "from-backup" }),
        },
        assertData: { value: "from-backup" },
        allowDowngrade: true,
        assertTraces: 2,
      },
    },
    "Query.nullishScope": {
      "?? with nested scope and null response": {
        input: {},
        tools: { api: async () => ({ temp: null, wind: null }) },
        assertData: { summary: { temp: 0, wind: 0 } },
        assertTraces: 1,
      },
    },
  },
});

// ── 3. Array mapping ────────────────────────────────────────────────────────

regressionTest("parity: array mapping", {
  bridge: bridge`
    version 1.5

    bridge Query.catalog {
      with api as src
      with output as o

      o.title <- src.name
      o.entries <- src.items[] as item {
        .id <- item.item_id
        .label <- item.item_name
        .cost <- item.unit_price
      }
    }

    bridge Query.arrayEmpty {
      with api as src
      with output as o

      o.items <- src.list[] as item {
        .name <- item.label
      }
    }

    bridge Query.arrayNull {
      with api as src
      with output as o

      o.items <- src.list[] as item {
        .name <- item.label
      }
    }

    bridge Query.geocode {
      with hereapi.geocode as gc
      with input as i
      with output as o

      gc.q <- i.search
      o <- gc.items[] as item {
        .name <- item.title
        .lat  <- item.position.lat
        .lon  <- item.position.lng
      }
    }
  `,
  scenarios: {
    "Query.catalog": {
      "array mapping renames fields": {
        input: {},
        tools: {
          api: async () => ({
            name: "Catalog A",
            items: [
              { item_id: 1, item_name: "Widget", unit_price: 9.99 },
              { item_id: 2, item_name: "Gadget", unit_price: 14.5 },
            ],
          }),
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
      "empty catalog items": {
        input: {},
        tools: { api: async () => ({ name: "Empty", items: [] }) },
        assertData: { title: "Empty", entries: [] },
        assertTraces: 1,
      },
    },
    "Query.arrayEmpty": {
      "array mapping with empty array returns empty array": {
        input: {},
        tools: { api: () => ({ list: [] }) },
        assertData: { items: [] },
        assertTraces: 1,
      },
      "non-empty items map correctly": {
        input: {},
        tools: { api: () => ({ list: [{ label: "X" }] }) },
        assertData: { items: [{ name: "X" }] },
        assertTraces: 1,
      },
    },
    "Query.arrayNull": {
      "array mapping with null source returns null": {
        input: {},
        tools: { api: () => ({ list: null }) },
        assertData: { items: null },
        assertTraces: 1,
      },
      "non-empty items map correctly": {
        input: {},
        tools: { api: () => ({ list: [{ label: "Y" }] }) },
        assertData: { items: [{ name: "Y" }] },
        assertTraces: 1,
      },
      "empty items list": {
        input: {},
        tools: { api: () => ({ list: [] }) },
        assertData: { items: [] },
        assertTraces: 1,
      },
    },
    "Query.geocode": {
      "root array output": {
        input: { search: "Ber" },
        tools: {
          "hereapi.geocode": async () => ({
            items: [
              { title: "Berlin", position: { lat: 52.53, lng: 13.39 } },
              { title: "Bern", position: { lat: 46.95, lng: 7.45 } },
            ],
          }),
        },
        assertData: [
          { name: "Berlin", lat: 52.53, lon: 13.39 },
          { name: "Bern", lat: 46.95, lon: 7.45 },
        ],
        assertTraces: 1,
      },
      "empty geocode results": {
        input: { search: "zzz" },
        tools: { "hereapi.geocode": async () => ({ items: [] }) },
        assertData: [],
        assertTraces: 1,
      },
    },
  },
});

// ── 4. Ternary / conditional wires ──────────────────────────────────────────

regressionTest("parity: ternary / conditional wires", {
  bridge: bridge`
    version 1.5

    bridge Query.conditional {
      with api as a
      with input as i
      with output as o

      a.mode <- i.premium ? "full" : "basic"
      o.result <- a.data
    }

    bridge Query.pricing {
      with api as a
      with input as i
      with output as o

      a.id <- i.id
      o.price <- i.isPro ? a.proPrice : a.basicPrice
    }

    bridge Query.pricingOptional {
      with api as a
      with input as i
      with output as o

      o.price <- i.isPro ? a.user?.profile.name : "basic"
    }
  `,
  scenarios: {
    "Query.conditional": {
      "ternary expression with input condition — true branch": {
        input: { premium: true },
        tools: { api: (p: any) => ({ data: p.mode }) },
        assertData: { result: "full" },
        assertTraces: 1,
      },
      "ternary expression with input condition — false branch": {
        input: { premium: false },
        tools: { api: (p: any) => ({ data: p.mode }) },
        assertData: { result: "basic" },
        assertTraces: 1,
      },
    },
    "Query.pricing": {
      "ternary with ref branches": {
        input: { id: 1, isPro: true },
        tools: { api: () => ({ proPrice: 99, basicPrice: 49 }) },
        assertData: { price: 99 },
        assertTraces: 1,
      },
      "ternary false branch returns basicPrice": {
        input: { id: 1, isPro: false },
        tools: { api: () => ({ proPrice: 99, basicPrice: 49 }) },
        assertData: { price: 49 },
        assertTraces: 1,
      },
    },
    "Query.pricingOptional": {
      "ternary branch preserves segment-local ?. semantics": {
        input: { isPro: true },
        tools: { api: () => ({ user: null }) },
        assertError: /Cannot read properties of undefined \(reading 'name'\)/,
        assertTraces: 1,
      },
      "ternary false branch returns constant": {
        input: { isPro: false },
        tools: { api: () => ({ user: { profile: { name: "X" } } }) },
        assertData: { price: "basic" },
        assertTraces: 0,
      },
    },
  },
});

// ── 5. Catch fallbacks ──────────────────────────────────────────────────────

regressionTest("parity: catch fallbacks", {
  bridge: bridge`
    version 1.5

    bridge Query.catchConst {
      with api as a
      with output as o

      o.data <- a.result catch "fallback"
    }

    bridge Query.catchNoTrigger {
      with api as a
      with output as o

      o.data <- a.result catch "fallback"
    }

    bridge Query.catchRef {
      with primary as p
      with backup as b
      with output as o

      o.data <- p.result catch b.fallback
    }

    bridge Query.catchMixed {
      with api as a
      with output as o

      o.safe  <- a.result catch "fallback"
      o.risky <- a.id
    }
  `,
  scenarios: {
    "Query.catchConst": {
      "catch with constant fallback value": {
        input: {},
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        assertData: { data: "fallback" },
        assertTraces: 1,
      },
    },
    "Query.catchNoTrigger": {
      "catch does not trigger on success": {
        input: {},
        tools: { api: () => ({ result: "success" }) },
        assertData: { data: "success" },
        assertTraces: 1,
      },
      "catch triggers on error": {
        input: {},
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        assertData: { data: "fallback" },
        assertTraces: 1,
      },
    },
    "Query.catchRef": {
      "catch with ref fallback": {
        input: {},
        tools: {
          primary: () => {
            throw new Error("primary failed");
          },
          backup: () => ({ fallback: "from-backup" }),
        },
        assertData: { data: "from-backup" },
        assertTraces: 2,
      },
    },
    "Query.catchMixed": {
      "unguarded wire referencing catch-guarded tool re-throws on error": {
        input: {},
        tools: {
          api: () => {
            throw new Error("api down");
          },
        },
        assertError: /api down/,
        assertTraces: 1,
      },
      "unguarded wire referencing catch-guarded tool succeeds on no error": {
        input: {},
        tools: { api: () => ({ result: "ok", id: 42 }) },
        assertData: { safe: "ok", risky: 42 },
        assertTraces: 1,
      },
    },
  },
});

// ── 6. Force statements ─────────────────────────────────────────────────────

regressionTest("parity: force statements", {
  bridge: bridge`
    version 1.5

    bridge Query.forceRuns {
      with mainApi as m
      with audit.log as audit
      with input as i
      with output as o

      m.q <- i.q
      audit.action <- i.q
      force audit
      o.title <- m.title
    }

    bridge Query.forceFireAndForget {
      with mainApi as m
      with analytics as ping
      with input as i
      with output as o

      m.q <- i.q
      ping.event <- i.q
      force ping catch null
      o.title <- m.title
    }

    bridge Query.forceCritical {
      with mainApi as m
      with audit.log as audit
      with input as i
      with output as o

      m.q <- i.q
      audit.action <- i.q
      force audit
      o.title <- m.title
    }
  `,
  scenarios: {
    "Query.forceRuns": {
      "force tool runs even when output not queried": {
        input: { q: "test" },
        tools: {
          mainApi: async () => ({ title: "Hello World" }),
          "audit.log": async () => ({ ok: true }),
        },
        assertData: { title: "Hello World" },
        assertTraces: 2,
      },
    },
    "Query.forceFireAndForget": {
      "fire-and-forget force does not break on error": {
        input: { q: "test" },
        tools: {
          mainApi: async () => ({ title: "OK" }),
          analytics: async () => {
            throw new Error("analytics down");
          },
        },
        assertData: { title: "OK" },
        assertTraces: 2,
      },
    },
    "Query.forceCritical": {
      "critical force propagates errors": {
        input: { q: "test" },
        tools: {
          mainApi: async () => ({ title: "OK" }),
          "audit.log": async () => {
            throw new Error("audit failed");
          },
        },
        assertError: /audit failed/,
        assertTraces: 2,
      },
    },
  },
});

// ── 7. ToolDef support ──────────────────────────────────────────────────────

regressionTest("parity: ToolDef support", {
  bridge: bridge`
    version 1.5

    tool restApi from myHttp {
      with context
      .method = "GET"
      .baseUrl = "https://api.example.com"
      .headers.Authorization <- context.token
    }

    bridge Query.tooldefData {
      with restApi as api
      with input as i
      with output as o

      api.path <- i.path
      o.result <- api.body
    }

    tool restApiOverride from myHttp {
      .method = "GET"
      .timeout = 5000
    }

    bridge Query.tooldefOverride {
      with restApiOverride as api
      with output as o

      api.method = "POST"
      o.result <- api.data
    }

    tool safeApi from myHttp {
      on error = {"status":"error","message":"service unavailable"}
    }

    bridge Query.tooldefOnError {
      with safeApi as api
      with input as i
      with output as o

      api.url <- i.url
      o <- api
    }

    tool baseApi from myHttp {
      .method = "GET"
      .baseUrl = "https://api.example.com"
    }

    tool userApi from baseApi {
      .path = "/users"
    }

    bridge Query.tooldefExtends {
      with userApi as api
      with output as o

      o <- api
    }

    tool strictApi from myHttp {
      with context
      .headers.Authorization <- context.auth.profile.token
    }

    bridge Query.tooldefStrictPath {
      with strictApi as api
      with output as o

      o.result <- api.body
    }
  `,
  scenarios: {
    "Query.tooldefData": {
      "ToolDef constant wires merged with bridge wires": {
        input: { path: "/users" },
        tools: {
          myHttp: async (_: any) => ({ body: { ok: true } }),
        },
        context: { token: "Bearer abc123" },
        assertData: { result: { ok: true } },
        assertTraces: 1,
      },
    },
    "Query.tooldefOverride": {
      "bridge wires override ToolDef wires": {
        input: {},
        tools: {
          myHttp: async (input: any) => {
            assert.equal(input.method, "POST");
            assert.equal(input.timeout, 5000);
            return { data: "ok" };
          },
        },
        assertData: { result: "ok" },
        assertTraces: 1,
      },
    },
    "Query.tooldefOnError": {
      "ToolDef onError provides fallback on failure": {
        input: { url: "https://broken.api" },
        tools: {
          myHttp: async () => {
            throw new Error("connection refused");
          },
        },
        assertData: { status: "error", message: "service unavailable" },
        assertTraces: 1,
      },
    },
    "Query.tooldefExtends": {
      "ToolDef extends chain": {
        input: {},
        tools: {
          myHttp: async (input: any) => {
            assert.equal(input.method, "GET");
            assert.equal(input.baseUrl, "https://api.example.com");
            assert.equal(input.path, "/users");
            return { users: [] };
          },
        },
        assertData: { users: [] },
        assertTraces: 1,
      },
    },
    "Query.tooldefStrictPath": {
      "ToolDef strict path resolves normally": {
        input: {},
        tools: {
          myHttp: async (_: any) => ({ body: { ok: true } }),
        },
        context: { auth: { profile: { token: "t1" } } },
        assertData: { result: { ok: true } },
        assertTraces: 1,
      },
      "ToolDef source paths stay strict after null intermediate": {
        input: {},
        tools: {
          myHttp: async (_: any) => ({ body: { ok: true } }),
        },
        context: { auth: { profile: null } },
        assertError: /Cannot read properties of null \(reading 'token'\)/,
        assertTraces: 0,
      },
    },
  },
});

// ── 8. Tool context injection ───────────────────────────────────────────────

regressionTest("parity: tool context injection", {
  bridge: bridge`
    version 1.5

    bridge Query.ctx {
      with api as a
      with input as i
      with output as o

      a.q <- i.q
      o.result <- a.data
    }
  `,
  scenarios: {
    "Query.ctx": {
      "tool function receives context as second argument": {
        input: { q: "hello" },
        tools: {
          api: (input: any, ctx: any) => {
            assert.ok(ctx != null, "context must be passed as second argument");
            return { data: input.q };
          },
        },
        assertData: { result: "hello" },
        assertTraces: 1,
      },
    },
  },
});

// ── 9. Const blocks ─────────────────────────────────────────────────────────

regressionTest("parity: const blocks", {
  bridge: bridge`
    version 1.5

    const fallbackGeo = { "lat": 0, "lon": 0 }

    bridge Query.locate {
      with geoApi as geo
      with const as c
      with input as i
      with output as o

      geo.q <- i.q
      o.lat <- geo.lat ?? c.fallbackGeo.lat
      o.lon <- geo.lon ?? c.fallbackGeo.lon
    }

    const defaults = { "user": null }

    bridge Query.constStrict {
      with const as c
      with output as o

      o.name <- c.defaults.user.profile.name
    }
  `,
  scenarios: {
    "Query.locate": {
      "const value used in fallback": {
        input: { q: "unknown" },
        tools: { geoApi: () => ({ lat: null, lon: null }) },
        assertData: { lat: 0, lon: 0 },
        assertTraces: 1,
      },
    },
    "Query.constStrict": {
      "const path traversal stays strict after null intermediate": {
        input: {},
        assertError: /Cannot read properties of null \(reading 'profile'\)/,
        assertTraces: 0,
      },
    },
  },
});

// ── 10. String interpolation ────────────────────────────────────────────────

regressionTest("parity: string interpolation", {
  bridge: bridge`
    version 1.5

    bridge Query.greet {
      with input as i
      with output as o

      o.message <- "Hello, {i.name}!"
    }

    bridge Query.url {
      with api as a
      with input as i
      with output as o

      a.path <- "/users/{i.id}/orders"
      o.result <- a.data
    }
  `,
  scenarios: {
    "Query.greet": {
      "basic string interpolation": {
        input: { name: "World" },
        assertData: { message: "Hello, World!" },
        assertTraces: 0,
      },
    },
    "Query.url": {
      "URL construction with interpolation": {
        input: { id: 42 },
        tools: { api: (p: any) => ({ data: p.path }) },
        assertData: { result: "/users/42/orders" },
        assertTraces: 1,
      },
    },
  },
});

// ── 11. Expressions (math, comparison) ──────────────────────────────────────

regressionTest("parity: expressions", {
  bridge: bridge`
    version 1.5

    bridge Query.calc {
      with input as i
      with output as o

      o.result <- i.price * i.qty
    }

    bridge Query.check {
      with input as i
      with output as o

      o.isAdult <- i.age >= 18
    }
  `,
  scenarios: {
    "Query.calc": {
      "multiplication expression": {
        input: { price: 10, qty: 3 },
        assertData: { result: 30 },
        assertTraces: 0,
      },
    },
    "Query.check": {
      "comparison expression (greater than or equal)": {
        input: { age: 21 },
        assertData: { isAdult: true },
        assertTraces: 0,
      },
    },
  },
});

// ── 12. Nested scope blocks ─────────────────────────────────────────────────

regressionTest("parity: nested scope blocks", {
  bridge: bridge`
    version 1.5

    bridge Query.weather {
      with weatherApi as w
      with input as i
      with output as o

      w.city <- i.city

      o.why {
        .temperature <- w.temperature ?? 0.0
        .city <- i.city
      }
    }
  `,
  scenarios: {
    "Query.weather": {
      "nested object via scope block": {
        input: { city: "Berlin" },
        tools: {
          weatherApi: async () => ({ temperature: 25, feelsLike: 23 }),
        },
        assertData: { why: { temperature: 25, city: "Berlin" } },
        assertTraces: 1,
      },
      "fallback triggers on null temperature": {
        input: { city: "Unknown" },
        tools: {
          weatherApi: async () => ({ temperature: null }),
        },
        assertData: { why: { temperature: 0, city: "Unknown" } },
        assertTraces: 1,
      },
    },
  },
});

// ── 13. Nested arrays ───────────────────────────────────────────────────────

regressionTest("parity: nested arrays", {
  bridge: bridge`
    version 1.5

    bridge Query.searchTrains {
      with transportApi as api
      with input as i
      with output as o

      api.from <- i.from
      api.to <- i.to
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
  scenarios: {
    "Query.searchTrains": {
      "nested array-in-array mapping": {
        input: { from: "Bern", to: "Aarau" },
        tools: {
          transportApi: async () => ({
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
          }),
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
        input: { from: "X", to: "Y" },
        tools: { transportApi: async () => ({ connections: [] }) },
        assertData: [],
        assertTraces: 1,
      },
      "connection with empty sections": {
        input: { from: "A", to: "B" },
        tools: {
          transportApi: async () => ({
            connections: [{ id: "c1", sections: [] }],
          }),
        },
        assertData: [{ id: "c1", legs: [] }],
        assertTraces: 1,
      },
    },
  },
});

// ── 14. Pipe operators ──────────────────────────────────────────────────────

regressionTest("parity: pipe operators", {
  bridge: bridge`
    version 1.5

    bridge Query.shout {
      with toUpperCase as tu
      with input as i
      with output as o

      o.loud <- tu:i.text
    }
  `,
  scenarios: {
    "Query.shout": {
      "simple pipe shorthand": {
        input: { text: "hello" },
        tools: {
          toUpperCase: (p: any) => ({ out: p.in.toUpperCase() }),
        },
        assertData: { loud: { out: "HELLO" } },
        assertTraces: 1,
      },
    },
  },
});

// ── 15. Define blocks ───────────────────────────────────────────────────────

regressionTest("parity: define blocks", {
  bridge: bridge`
    version 1.5

    define userProfile {
      with userApi as api
      with input as i
      with output as o
      api.id <- i.userId
      o.name <- api.login
    }

    bridge Query.defineSimple {
      with userProfile as sp
      with input as i
      with output as o
      sp.userId <- i.id
      o.profile <- sp
    }

    define enrichedGeo {
      with hereapi.geocode as gc
      with input as i
      with output as o
      gc.q <- i.query
      o.lat <- gc.lat
      o.lon <- gc.lon
    }

    bridge Query.defineModuleTool {
      with enrichedGeo as geo
      with input as i
      with output as o
      geo.query <- i.location
      o.coordinates <- geo
    }

    define weatherInfo {
      with weatherApi as api
      with input as i
      with output as o
      api.city <- i.cityName
      o.temp <- api.temperature
      o.humidity <- api.humidity
      o.wind <- api.windSpeed
    }

    bridge Query.defineMultiOutput {
      with weatherInfo as w
      with input as i
      with output as o
      w.cityName <- i.city
      o.forecast <- w
    }
  `,
  scenarios: {
    "Query.defineSimple": {
      "simple define block inlines tool call": {
        input: { id: 42 },
        tools: {
          userApi: async (input: any) => ({ login: "admin_" + input.id }),
        },
        assertData: { profile: { name: "admin_42" } },
        assertTraces: 1,
      },
    },
    "Query.defineModuleTool": {
      "define with module-prefixed tool": {
        input: { location: "Berlin" },
        tools: {
          "hereapi.geocode": async () => ({ lat: 52.53, lon: 13.38 }),
        },
        assertData: { coordinates: { lat: 52.53, lon: 13.38 } },
        assertTraces: 1,
      },
    },
    "Query.defineMultiOutput": {
      "define with multiple output fields": {
        input: { city: "Berlin" },
        tools: {
          weatherApi: async (_: any) => ({
            temperature: 22,
            humidity: 65,
            windSpeed: 15,
          }),
        },
        assertData: { forecast: { temp: 22, humidity: 65, wind: 15 } },
        assertTraces: 1,
      },
    },
  },
});

// ── 16. Alias declarations ──────────────────────────────────────────────────

regressionTest("parity: alias declarations", {
  bridge: bridge`
    version 1.5

    bridge Query.aliasSimple {
      with api
      with output as o
      alias api.result.data as d
      o.value <- d.name
    }

    bridge Query.aliasPipe {
      with myUC
      with input as i
      with output as o

      alias myUC:i.name as upper
      o.greeting <- upper.out
    }
  `,
  scenarios: {
    "Query.aliasSimple": {
      "top-level alias — simple rename": {
        input: {},
        tools: {
          api: async () => ({ result: { data: { name: "hello" } } }),
        },
        assertData: { value: "hello" },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.aliasPipe": {
      "top-level alias with pipe — caches result": {
        input: { name: "hello" },
        tools: {
          myUC: (p: any) => ({ out: p.in.toUpperCase() }),
        },
        assertData: { greeting: "HELLO" },
        assertTraces: 1,
      },
    },
  },
});

// ── 17. Overdefinition ──────────────────────────────────────────────────────

regressionTest("parity: overdefinition", {
  bridge: bridge`
    version 1.5

    bridge Query.lookup {
      with expensiveApi as api
      with input as i
      with output as o
      api.q <- i.q
      o.label <- api.label
      o.label <- i.hint
    }

    bridge Query.lookupCtx {
      with expensiveApi as api
      with context as ctx
      with input as i
      with output as o
      api.q <- i.q
      o.label <- api.label
      o.label <- ctx.defaultLabel
    }

    bridge Query.lookupSameCost {
      with svcA as a
      with svcB as b
      with input as i
      with output as o
      a.q <- i.q
      b.q <- i.q
      o.label <- a.label
      o.label <- b.label
    }
  `,
  scenarios: {
    "Query.lookup": {
      "authored tool wire beats input source when both are available": {
        input: { q: "x", hint: "cheap" },
        tools: {
          expensiveApi: async () => ({ label: "from-api" }),
        },
        assertData: { label: "from-api" },
        assertTraces: 1,
      },
      "tool wire used when input is undefined": {
        input: { q: "x" },
        tools: {
          expensiveApi: async () => ({ label: "from-api" }),
        },
        assertData: { label: "from-api" },
        assertTraces: 1,
      },
      "input source is used when the tool returns undefined": {
        input: { q: "x", hint: "cheap" },
        tools: {
          expensiveApi: async () => ({}),
        },
        assertData: { label: "cheap" },
        assertTraces: 1,
      },
    },
    "Query.lookupCtx": {
      "authored tool wire beats context source when both are available": {
        input: { q: "x" },
        context: { defaultLabel: "from-context" },
        tools: {
          expensiveApi: async () => ({ label: "from-api" }),
        },
        assertData: { label: "from-api" },
        assertTraces: 1,
      },
      "tool wire used when context key is missing": {
        input: { q: "x" },
        context: {},
        tools: {
          expensiveApi: async () => ({ label: "from-api" }),
        },
        assertData: { label: "from-api" },
        assertTraces: 1,
      },
      "context source is used when the tool returns undefined": {
        input: { q: "x" },
        context: { defaultLabel: "from-context" },
        tools: {
          expensiveApi: async () => ({}),
        },
        assertData: { label: "from-context" },
        assertTraces: 1,
      },
    },
    "Query.lookupSameCost": {
      "same-cost tool sources preserve authored order": {
        input: { q: "x" },
        tools: {
          svcA: async () => ({ label: "from-A" }),
          svcB: async () => ({ label: "from-B" }),
        },
        assertData: { label: "from-A" },
        allowDowngrade: true,
        assertTraces: 1,
      },
      "second tool used when first returns undefined": {
        input: { q: "x" },
        tools: {
          svcA: async () => ({}),
          svcB: async () => ({ label: "from-B" }),
        },
        assertData: { label: "from-B" },
        allowDowngrade: true,
        assertTraces: 2,
      },
    },
  },
});

// ── 18. Break/continue in array mapping ─────────────────────────────────────

regressionTest("parity: break/continue in array mapping", {
  bridge: bridge`
    version 1.5

    bridge Query.continueNull {
      with api as a
      with output as o
      o <- a.items[] as item {
        .name <- item.name ?? continue
      }
    }

    bridge Query.breakHalt {
      with api as a
      with output as o
      o <- a.items[] as item {
        .name <- item.name ?? break
      }
    }

    bridge Query.continueNonRoot {
      with api as a
      with output as o
      o.items <- a.list[] as item {
        .name <- item.name ?? continue
      }
    }

    bridge Query.continueNested {
      with api as a
      with output as o
      o <- a.orders[] as order {
        .id <- order.id
        .items <- order.items[] as item {
          .sku <- item.sku ?? continue
        }
      }
    }

    bridge Query.breakNested {
      with api as a
      with output as o
      o <- a.orders[] as order {
        .id <- order.id
        .items <- order.items[] as item {
          .sku <- item.sku ?? break
        }
      }
    }
  `,
  scenarios: {
    "Query.continueNull": {
      "continue skips null elements": {
        input: {},
        tools: {
          api: async () => ({
            items: [
              { name: "Alice" },
              { name: null },
              { name: "Bob" },
              { name: null },
            ],
          }),
        },
        assertData: [{ name: "Alice" }, { name: "Bob" }],
        assertTraces: 1,
      },
      "empty items returns empty array": {
        input: {},
        tools: { api: async () => ({ items: [] }) },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.breakHalt": {
      "break halts array processing": {
        input: {},
        tools: {
          api: async () => ({
            items: [
              { name: "Alice" },
              { name: "Bob" },
              { name: null },
              { name: "Carol" },
            ],
          }),
        },
        assertData: [{ name: "Alice" }, { name: "Bob" }],
        assertTraces: 1,
      },
      "empty items returns empty array": {
        input: {},
        tools: { api: async () => ({ items: [] }) },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.continueNonRoot": {
      "continue in non-root array field": {
        input: {},
        tools: {
          api: async () => ({
            list: [{ name: "X" }, { name: null }, { name: "Y" }],
          }),
        },
        assertData: { items: [{ name: "X" }, { name: "Y" }] },
        assertTraces: 1,
      },
      "empty list returns empty items": {
        input: {},
        tools: { api: async () => ({ list: [] }) },
        assertData: { items: [] },
        assertTraces: 1,
      },
    },
    "Query.continueNested": {
      "continue in nested array": {
        input: {},
        tools: {
          api: async () => ({
            orders: [
              {
                id: 1,
                items: [{ sku: "A" }, { sku: null }, { sku: "B" }],
              },
              { id: 2, items: [{ sku: null }, { sku: "C" }] },
            ],
          }),
        },
        assertData: [
          { id: 1, items: [{ sku: "A" }, { sku: "B" }] },
          { id: 2, items: [{ sku: "C" }] },
        ],
        assertTraces: 1,
      },
      "empty orders returns empty array": {
        input: {},
        tools: { api: async () => ({ orders: [] }) },
        assertData: [],
        assertTraces: 1,
      },
      "order with empty items": {
        input: {},
        tools: {
          api: async () => ({ orders: [{ id: 1, items: [] }] }),
        },
        assertData: [{ id: 1, items: [] }],
        assertTraces: 1,
      },
    },
    "Query.breakNested": {
      "break in nested array": {
        input: {},
        tools: {
          api: async () => ({
            orders: [
              {
                id: 1,
                items: [
                  { sku: "A" },
                  { sku: "B" },
                  { sku: null },
                  { sku: "D" },
                ],
              },
              { id: 2, items: [{ sku: null }, { sku: "E" }] },
            ],
          }),
        },
        assertData: [
          { id: 1, items: [{ sku: "A" }, { sku: "B" }] },
          { id: 2, items: [] },
        ],
        assertTraces: 1,
      },
      "empty orders returns empty array": {
        input: {},
        tools: { api: async () => ({ orders: [] }) },
        assertData: [],
        assertTraces: 1,
      },
      "order with empty items": {
        input: {},
        tools: {
          api: async () => ({ orders: [{ id: 1, items: [] }] }),
        },
        assertData: [{ id: 1, items: [] }],
        assertTraces: 1,
      },
    },
  },
});

// ── 19. Sparse fieldsets (requestedFields) ──────────────────────────────────

regressionTest("parity: sparse fieldsets — basic", {
  bridge: bridge`
    version 1.5

    bridge Query.sparseBasic {
      with input as i
      with expensive as exp
      with cheap as ch
      with output as o

      exp.x <- i.x
      ch.y <- i.y

      o.a <- exp.result
      o.b <- ch.result
    }

    bridge Query.sparseAll {
      with input as i
      with toolA as a
      with toolB as b
      with output as o

      a.x <- i.x
      b.y <- i.y

      o.first <- a.result
      o.second <- b.result
    }

    bridge Query.sparseMulti {
      with input as i
      with output as o

      o.a <- i.a
      o.b <- i.b
      o.c <- i.c
    }
  `,
  scenarios: {
    "Query.sparseBasic": {
      "only requested fields are returned, unrequested tool is not called": {
        input: { x: 1, y: 2 },
        tools: {
          expensive: () => {
            throw new Error("expensive tool should not be called");
          },
          cheap: (p: any) => ({ result: p.y * 10 }),
        },
        fields: ["b"],
        assertData: { b: 20 },
        assertTraces: 1,
      },
      "requesting a calls expensive tool": {
        input: { x: 5, y: 2 },
        tools: {
          expensive: (p: any) => ({ result: p.x + 1 }),
          cheap: () => {
            throw new Error("cheap tool should not be called");
          },
        },
        fields: ["a"],
        assertData: { a: 6 },
        assertTraces: 1,
      },
    },
    "Query.sparseAll": {
      "no requestedFields returns all fields": {
        input: { x: 1, y: 2 },
        tools: {
          toolA: (p: any) => ({ result: p.x + 100 }),
          toolB: (p: any) => ({ result: p.y + 200 }),
        },
        assertData: { first: 101, second: 202 },
        assertTraces: 2,
      },
    },
    "Query.sparseMulti": {
      "requesting multiple fields returns only those": {
        input: { a: 1, b: 2, c: 3 },
        fields: ["a", "c"],
        assertData: { a: 1, c: 3 },
        assertTraces: 0,
      },
      "requesting b returns b": {
        input: { a: 1, b: 2, c: 3 },
        fields: ["b"],
        assertData: { b: 2 },
        assertTraces: 0,
      },
    },
  },
});

regressionTest("parity: sparse fieldsets — wildcard and chains", {
  bridge: bridge`
    version 1.5

    bridge Query.trip {
      with input as i
      with api as a
      with output as o

      a.id <- i.id

      o.id <- a.id
      o.legs {
        .duration <- a.duration
        .distance <- a.distance
      }
      o.price <- a.price
    }

    bridge Query.chainSparse {
      with input as i
      with toolA as a
      with toolB as b
      with toolC as c
      with output as o

      a.x <- i.x
      b.y <- i.y
      c.z <- b.partial

      o.fromA <- a.result
      o.fromB <- b.result || c.result
    }
  `,
  scenarios: {
    "Query.trip": {
      "wildcard legs.* matches all immediate children": {
        input: { id: 42 },
        tools: {
          api: (p: any) => ({
            id: p.id,
            duration: "2h",
            distance: 150,
            price: 99,
          }),
        },
        fields: ["id", "legs.*"],
        assertData: { id: 42, legs: { duration: "2h", distance: 150 } },
        assertTraces: 1,
      },
      "requesting price returns price": {
        input: { id: 42 },
        tools: {
          api: (p: any) => ({
            id: p.id,
            duration: "2h",
            distance: 150,
            price: 99,
          }),
        },
        fields: ["price"],
        assertData: { price: 99 },
        assertTraces: 1,
      },
    },
    "Query.chainSparse": {
      "A||B→C: requesting only fromA skips B and C": {
        input: { x: 10, y: 20 },
        tools: {
          toolA: (p: any) => ({ result: p.x * 2 }),
          toolB: () => {
            throw new Error("toolB should not be called");
          },
          toolC: () => {
            throw new Error("toolC should not be called");
          },
        },
        fields: ["fromA"],
        assertData: { fromA: 20 },
        allowDowngrade: true,
        assertTraces: 1,
      },
      "A||B→C: requesting only fromB skips A, calls B and fallback C": {
        input: { x: 10, y: 20 },
        tools: {
          toolA: () => {
            throw new Error("toolA should not be called");
          },
          toolB: (p: any) => ({ result: null, partial: p.y }),
          toolC: (p: any) => ({ result: p.z + 5 }),
        },
        fields: ["fromB"],
        assertData: { fromB: 25 },
        allowDowngrade: true,
        assertTraces: 2,
      },
    },
  },
});

regressionTest("parity: sparse fieldsets — nested and array paths", {
  bridge: bridge`
    version 1.5

    bridge Query.sparseNested {
      with input as i
      with api as a
      with output as o

      a.id <- i.id

      o.id <- i.id
      o.detail {
        .name <- a.name
        .age <- a.age
      }
    }

    bridge Query.sparseArray {
      with input as i
      with api as a
      with output as o

      a.from <- i.from
      a.to <- i.to

      o <- a.items[] as item {
        .id <- item.id
        .provider <- item.provider
        .price <- item.price
        .legs <- item.legs
      }
    }

    bridge Query.sparseArrayNested {
      with input as i
      with api as a
      with output as o

      a.from <- i.from
      a.to <- i.to

      o <- a.connections[] as c {
        .id <- c.id
        .provider = "SBB"
        .departureTime <- c.departure

        .legs <- c.sections[] as s {
          .trainName <- s.name
          .destination <- s.dest
        }
      }
    }

    bridge Query.sparseArrayDeep {
      with input as i
      with api as a
      with output as o

      a.from <- i.from

      o <- a.connections[] as c {
        .id <- c.id
        .provider = "SBB"

        .legs <- c.sections[] as s {
          .trainName <- s.name

          .destination.station.name <- s.arrStation
          .destination.plannedTime <- s.arrTime
          .destination.actualTime <- s.arrActual
          .destination.platform <- s.arrPlatform
        }
      }
    }
  `,
  scenarios: {
    "Query.sparseNested": {
      "requesting nested path includes parent and specified children": {
        input: { id: 1 },
        tools: {
          api: (_p: any) => ({ name: "Alice", age: 30 }),
        },
        fields: ["detail.name"],
        assertData: { detail: { name: "Alice" } },
        assertTraces: 1,
      },
      "all fields returns id and full detail": {
        input: { id: 7 },
        tools: {
          api: (_p: any) => ({ name: "Bob", age: 25 }),
        },
        assertData: { id: 7, detail: { name: "Bob", age: 25 } },
        assertTraces: 1,
      },
    },
    "Query.sparseArray": {
      "array-mapped output filters top-level fields via requestedFields": {
        input: { from: "A", to: "B" },
        tools: {
          api: () => ({
            items: [
              { id: 1, provider: "X", price: 50, legs: [{ name: "L1" }] },
              { id: 2, provider: "Y", price: 80, legs: [{ name: "L2" }] },
            ],
          }),
        },
        fields: ["id", "legs"],
        assertData: [
          { id: 1, legs: [{ name: "L1" }] },
          { id: 2, legs: [{ name: "L2" }] },
        ],
        assertTraces: 1,
      },
      "all fields returned when no requestedFields": {
        input: { from: "A", to: "B" },
        tools: {
          api: () => ({
            items: [
              { id: 1, provider: "X", price: 50, legs: [{ name: "L1" }] },
            ],
          }),
        },
        assertData: [
          { id: 1, provider: "X", price: 50, legs: [{ name: "L1" }] },
        ],
        assertTraces: 1,
      },
      "empty items returns empty array": {
        input: { from: "A", to: "B" },
        tools: { api: () => ({ items: [] }) },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Query.sparseArrayNested": {
      "array-mapped output with nested requestedFields path": {
        input: { from: "Bern", to: "Zürich" },
        tools: {
          api: () => ({
            connections: [
              {
                id: 1,
                departure: "08:00",
                sections: [
                  { name: "IC1", dest: "Zürich" },
                  { name: "IC2", dest: "Basel" },
                ],
              },
            ],
          }),
        },
        fields: ["legs.destination"],
        assertData: [
          {
            legs: [{ destination: "Zürich" }, { destination: "Basel" }],
          },
        ],
        assertTraces: 1,
      },
      "all fields returned when no requestedFields": {
        input: { from: "Bern", to: "Zürich" },
        tools: {
          api: () => ({
            connections: [
              {
                id: 1,
                departure: "08:00",
                sections: [{ name: "IC1", dest: "Zürich" }],
              },
            ],
          }),
        },
        assertData: [
          {
            id: 1,
            provider: "SBB",
            departureTime: "08:00",
            legs: [{ trainName: "IC1", destination: "Zürich" }],
          },
        ],
        assertTraces: 1,
      },
      "empty connections returns empty array": {
        input: { from: "Bern", to: "Zürich" },
        tools: { api: () => ({ connections: [] }) },
        assertData: [],
        assertTraces: 1,
      },
      "connection with empty sections": {
        input: { from: "Bern", to: "Zürich" },
        tools: {
          api: () => ({
            connections: [{ id: 1, departure: "09:00", sections: [] }],
          }),
        },
        assertData: [
          { id: 1, provider: "SBB", departureTime: "09:00", legs: [] },
        ],
        assertTraces: 1,
      },
    },
    "Query.sparseArrayDeep": {
      "array-mapped output: deep nested path filters sub-fields": {
        input: { from: "Bern" },
        tools: {
          api: () => ({
            connections: [
              {
                id: 1,
                sections: [
                  {
                    name: "IC1",
                    arrStation: "Zürich",
                    arrTime: "08:30",
                    arrActual: "08:32",
                    arrPlatform: "3",
                  },
                ],
              },
            ],
          }),
        },
        fields: ["legs.destination.actualTime"],
        assertData: [
          {
            legs: [{ destination: { actualTime: "08:32" } }],
          },
        ],
        assertTraces: 1,
      },
      "all fields returned when no requestedFields": {
        input: { from: "Bern" },
        tools: {
          api: () => ({
            connections: [
              {
                id: 1,
                sections: [
                  {
                    name: "IC1",
                    arrStation: "Zürich",
                    arrTime: "08:30",
                    arrActual: "08:32",
                    arrPlatform: "3",
                  },
                ],
              },
            ],
          }),
        },
        assertData: [
          {
            id: 1,
            provider: "SBB",
            legs: [
              {
                trainName: "IC1",
                destination: {
                  station: { name: "Zürich" },
                  plannedTime: "08:30",
                  actualTime: "08:32",
                  platform: "3",
                },
              },
            ],
          },
        ],
        assertTraces: 1,
      },
      "empty connections returns empty array": {
        input: { from: "Bern" },
        tools: { api: () => ({ connections: [] }) },
        assertData: [],
        assertTraces: 1,
      },
      "connection with empty sections": {
        input: { from: "Bern" },
        tools: {
          api: () => ({
            connections: [{ id: 1, sections: [] }],
          }),
        },
        assertData: [{ id: 1, provider: "SBB", legs: [] }],
        assertTraces: 1,
      },
    },
  },
});

regressionTest("parity: sparse fieldsets — non-array object selection", {
  bridge: bridge`
    version 1.5

    bridge Query.sparseObjPassthrough {
      with input as i
      with api as a
      with output as o

      a.id <- i.id

      o.id <- a.id
      o.legs <- a.legs
      o.price <- a.price
    }

    bridge Query.sparseObjStructured {
      with input as i
      with api as a
      with output as o

      a.id <- i.id

      o.id <- a.id
      o.legs {
        .duration <- a.duration
        .distance <- a.distance
      }
      o.price <- a.price
    }
  `,
  scenarios: {
    "Query.sparseObjPassthrough": {
      "bare legs selector passes through object via JSONObject": {
        input: { id: 42 },
        tools: {
          api: (p: any) => ({
            id: p.id,
            legs: { duration: "2h", distance: 150 },
            price: 99,
          }),
        },
        fields: ["id", "legs"],
        assertData: { id: 42, legs: { duration: "2h", distance: 150 } },
        assertTraces: 1,
      },
      "all fields returned when no requestedFields": {
        input: { id: 42 },
        tools: {
          api: (p: any) => ({
            id: p.id,
            legs: { duration: "2h", distance: 150 },
            price: 99,
          }),
        },
        assertData: {
          id: 42,
          legs: { duration: "2h", distance: 150 },
          price: 99,
        },
        assertTraces: 1,
      },
    },
    "Query.sparseObjStructured": {
      "bare legs selector on structured output via JSONObject": {
        input: { id: 42 },
        tools: {
          api: (p: any) => ({
            id: p.id,
            duration: "2h",
            distance: 150,
            price: 99,
          }),
        },
        fields: ["id", "legs"],
        assertData: {
          id: 42,
          legs: { duration: "2h", distance: 150 },
        },
        assertTraces: 1,
      },
      "all fields returned when no requestedFields": {
        input: { id: 42 },
        tools: {
          api: (p: any) => ({
            id: p.id,
            duration: "2h",
            distance: 150,
            price: 99,
          }),
        },
        assertData: {
          id: 42,
          legs: { duration: "2h", distance: 150 },
          price: 99,
        },
        assertTraces: 1,
      },
    },
  },
});
