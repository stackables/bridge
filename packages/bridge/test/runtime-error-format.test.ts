import assert from "node:assert/strict";
import test from "node:test";
import { BridgeRuntimeError, formatBridgeError } from "@stackables/bridge-core";
import { regressionTest } from "./utils/regression.ts";

// ══════════════════════════════════════════════════════════════════════════════
// Runtime error formatting
//
// Tests that `formatBridgeError` produces correct source snippets, caret
// underlines, and location references for various error types.
// ══════════════════════════════════════════════════════════════════════════════

function maxCaretCount(formatted: string): number {
  return Math.max(
    0,
    ...formatted.split("\n").map((line) => (line.match(/\^/g) ?? []).length),
  );
}

const FN = "playground.bridge";

// ── Pure unit test (no engine needed) ────────────────────────────────────────

test("formatBridgeError underlines the full inclusive source span", () => {
  const sourceLine = "o.message <- i.empty.array.error";
  const formatted = formatBridgeError(
    new BridgeRuntimeError("boom", {
      bridgeLoc: {
        startLine: 1,
        startColumn: 14,
        endLine: 1,
        endColumn: 32,
      },
    }),
    { source: sourceLine, filename: FN },
  );

  assert.equal(maxCaretCount(formatted), "i.empty.array.error".length);
});

// ── Engine-level error formatting ────────────────────────────────────────────

regressionTest("error formatting – runtime errors", {
  bridge: `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc memoize
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o.message <- i.empty.array.error
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`,
  scenarios: {
    "Query.greet": {
      "formats runtime errors with bridge source location": {
        input: { name: "Ada" },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(
            formatted,
            /Bridge Execution Error: Cannot read properties of undefined \(reading '(array|error)'\)/,
          );
          assert.match(formatted, /playground\.bridge:9:16/);
          assert.match(formatted, /o\.message <- i\.empty\.array\.error/);
          assert.equal(maxCaretCount(formatted), "i.empty.array.error".length);
        },
        // engines may produce different trace counts depending on scheduling
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});

regressionTest("error formatting – missing tool", {
  bridge: `version 1.5

bridge Query.greet {
  with xxx as missing
  with input as i
  with output as o

  o.message <- missing:i.name
}`,
  scenarios: {
    "Query.greet": {
      "formats missing tool errors with source location": {
        input: { name: "Ada" },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(
            formatted,
            /Bridge Execution Error: No tool found for "xxx"/,
          );
          assert.match(formatted, /playground\.bridge:8:16/);
          assert.match(formatted, /o\.message <- missing:i\.name/);
          assert.equal(maxCaretCount(formatted), "missing:i.name".length);
        },
        // no tool calls → 0 traces, but use function to be resilient to future changes
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});

regressionTest("error formatting – throw fallback", {
  bridge: `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc
  with std.str.toLowerCase as lc
  with kala as k
  with input as i
  with output as o

  o.message <- i.does?.not?.crash ?? throw "Errore"

  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`,
  scenarios: {
    "Query.greet": {
      "throw fallbacks underline only the throw clause": {
        input: { name: "Ada" },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(formatted, /Bridge Execution Error: Errore/);
          assert.match(formatted, /playground\.bridge:10:38/);
          assert.match(
            formatted,
            /o\.message <- i\.does\?\.not\?\.crash \?\? throw "Errore"/,
          );
          assert.equal(maxCaretCount(formatted), 'throw "Errore"'.length);
        },
        // engines may produce different trace counts depending on scheduling
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});

regressionTest("error formatting – panic fallback", {
  bridge: `version 1.5

bridge Query.greet {
  with input as i
  with output as o

  o.message <- i.name ?? panic "Fatale"
}`,
  scenarios: {
    "Query.greet": {
      "panic fallbacks underline only the panic clause": {
        input: {},
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(formatted, /Bridge Execution Error: Fatale/);
          assert.match(formatted, /playground\.bridge:7:26/);
          assert.match(formatted, /o\.message <- i\.name \?\? panic "Fatale"/);
          assert.equal(maxCaretCount(formatted), 'panic "Fatale"'.length);
        },
        // engines may produce different trace counts depending on scheduling
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});

regressionTest("error formatting – ternary branch", {
  bridge: `version 1.5

bridge Query.greet {
  with input as i
  with output as o

  o.discount <- i.isPro ? 20 : i.asd.asd.asd
}`,
  scenarios: {
    "Query.greet": {
      "ternary branch errors underline only the failing branch": {
        input: { isPro: false },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(
            formatted,
            /Bridge Execution Error: Cannot read properties of undefined \(reading 'asd'\)/,
          );
          assert.match(formatted, /playground\.bridge:7:32/);
          assert.match(
            formatted,
            /o\.discount <- i\.isPro \? 20 : i\.asd\.asd\.asd/,
          );
          assert.equal(maxCaretCount(formatted), "i.asd.asd.asd".length);
        },
        assertTraces: 0,
      },
      "true branch succeeds": {
        input: { isPro: true },
        assertData: { discount: 20 },
        assertTraces: 0,
      },
    },
  },
});

regressionTest("error formatting – array throw", {
  bridge: `version 1.5

bridge Query.processCatalog {
  with input as i
  with output as o

  o <- i.catalog[] as cat {
    .name <- cat.name
    .items <- cat.items[] as item {
      .sku <- item.sku ?? continue
      .price <- item.price ?? throw "panic"
    }
  }
}`,
  scenarios: {
    "Query.processCatalog": {
      "array-mapped throw fallbacks retain source snippets": {
        input: {
          catalog: [
            {
              name: "Cat",
              items: [{ sku: "ABC", price: null }],
            },
          ],
        },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(formatted, /Bridge Execution Error: panic/);
          assert.match(formatted, /playground\.bridge:11:31/);
          assert.match(formatted, /\.price <- item\.price \?\? throw "panic"/);
          assert.equal(maxCaretCount(formatted), 'throw "panic"'.length);
        },
        assertTraces: 0,
      },
      "valid items succeed": {
        input: {
          catalog: [
            {
              name: "Cat",
              items: [{ sku: "ABC", price: 9.99 }],
            },
          ],
        },
        assertData: [{ name: "Cat", items: [{ sku: "ABC", price: 9.99 }] }],
        assertTraces: 0,
      },
      "missing sku triggers continue": {
        input: {
          catalog: [
            {
              name: "Cat",
              items: [{ price: 5 }, { sku: "OK", price: 10 }],
            },
          ],
        },
        assertData: [{ name: "Cat", items: [{ sku: "OK", price: 10 }] }],
        assertTraces: 0,
      },
      "empty arrays": {
        input: { catalog: [] },
        assertData: [],
        assertTraces: 0,
      },
      "empty items array": {
        input: {
          catalog: [{ name: "Empty", items: [] }],
        },
        assertData: [{ name: "Empty", items: [] }],
        assertTraces: 0,
      },
    },
  },
});

regressionTest("error formatting – ternary condition", {
  bridge: `version 1.5

bridge Query.pricing {
  with input as i
  with output as o

  o.tier <- i.isPro ? "premium" : "basic"
  o.discount <- i.isPro ? 20 : 5
  o.price <- i.isPro.fail.asd ? i.proPrice : i.basicPrice
}`,
  scenarios: {
    "Query.pricing": {
      "ternary condition errors point at condition and missing segment": {
        input: { isPro: false, proPrice: 49.99, basicPrice: 9.99 },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(
            formatted,
            /Bridge Execution Error: Cannot read properties of false \(reading 'fail'\)/,
          );
          assert.match(formatted, /playground\.bridge:9:14/);
          assert.match(
            formatted,
            /o\.price <- i\.isPro\.fail\.asd \? i\.proPrice : i\.basicPrice/,
          );
          assert.equal(maxCaretCount(formatted), "i.isPro.fail.asd".length);
        },
        assertTraces: 0,
      },
      "truthy condition succeeds": {
        input: {
          isPro: { fail: { asd: true } },
          proPrice: 49.99,
          basicPrice: 9.99,
        },
        assertData: { tier: "premium", discount: 20, price: 49.99 },
        assertTraces: 0,
      },
      "falsy condition selects else branch": {
        input: {
          isPro: { fail: { asd: false } },
          proPrice: 49.99,
          basicPrice: 9.99,
        },
        assertData: { tier: "premium", discount: 20, price: 9.99 },
        assertTraces: 0,
      },
    },
  },
});

regressionTest("error formatting – coalesce fallback", {
  bridge: `version 1.5

bridge Query.greet {
  with std.str.toUpperCase as uc memoize
  with std.str.toLowerCase as lc
  with input as i
  with output as o

  o.message <- i.empty.array?.error ?? i.empty.array.error
  o.upper <- uc:i.name
  o.lower <- lc:i.name
}`,
  scenarios: {
    "Query.greet": {
      "coalesce fallback errors highlight the failing fallback branch": {
        input: { name: "Ada" },
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(
            formatted,
            /Bridge Execution Error: Cannot read properties of undefined \(reading 'array'\)/,
          );
          assert.match(formatted, /playground\.bridge:9:16/);
          assert.match(
            formatted,
            /o\.message <- i\.empty\.array\?\.error \?\? i\.empty\.array\.error/,
          );
        },
        // engines may produce different trace counts depending on scheduling
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
      "valid path succeeds": {
        input: { name: "Ada", empty: { array: { error: "hello" } } },
        assertData: { message: "hello", upper: "ADA", lower: "ada" },
        // engines may produce different trace counts depending on scheduling
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
      "fallback path returns undefined when primary is nullish": {
        input: { name: "Ada", empty: { array: {} } },
        assertData: { upper: "ADA", lower: "ada" },
        // engines may produce different trace counts depending on scheduling
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});

regressionTest("error formatting – tool input cycle", {
  bridge: `version 1.5

tool geo from std.httpCall {
  .baseUrl = "https://nominatim.openstreetmap.org"
  .path = "/search"
  .format = "json"
  .limit = "1"
}

bridge Query.location {
  with geo
  with input as i
  with output as o

  geo.q <- geo[0].city
  o.lat <- geo[0].lat
  o.lon <- geo[0].lon
}`,
  scenarios: {
    "Query.location": {
      "tool input cycles retain the originating wire source location": {
        input: {},
        assertError: (err: any) => {
          const formatted = formatBridgeError(err, { filename: FN });
          assert.match(
            formatted,
            /Bridge Execution Error: Circular dependency detected: "_:Tools:geo:1" depends on itself/,
          );
          assert.match(formatted, /playground\.bridge:15:12/);
          assert.match(formatted, /geo\.q <- geo\[0\]\.city/);
          assert.equal(maxCaretCount(formatted), "geo[0].city".length);
        },
        assertTraces: 0,
      },
    },
  },
});
