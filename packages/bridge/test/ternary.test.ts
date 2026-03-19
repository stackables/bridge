import assert from "node:assert/strict";
import { BridgePanicError } from "../src/index.ts";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

// ── Basic ternary: ref + literal branches ─────────────────────────────────

regressionTest("ternary: basic + literal branches", {
  bridge: bridge`
    version 1.5

    bridge Ternary.basic {
      with input as i
      with output as o

      o.amount <- i.isPro ? i.proPrice : i.basicPrice
      o.tier <- i.isPro ? "premium" : "basic"
      o.discount <- i.isPro ? 20 : 0
    }
  `,
  scenarios: {
    "Ternary.basic": {
      "truthy condition selects then branches": {
        input: { isPro: true, proPrice: 99.99, basicPrice: 9.99 },
        assertData: { amount: 99.99, tier: "premium", discount: 20 },
        assertTraces: 0,
      },
      "falsy condition selects else branches": {
        input: { isPro: false, proPrice: 99.99, basicPrice: 9.99 },
        assertData: { amount: 9.99, tier: "basic", discount: 0 },
        assertTraces: 0,
      },
    },
  },
});

// ── Expression condition ──────────────────────────────────────────────────

regressionTest("ternary: expression condition", {
  bridge: bridge`
    version 1.5

    bridge Ternary.expression {
      with input as i
      with output as o

      o.result <- i.age >= 18 ? i.proPrice : i.basicPrice
    }
  `,
  scenarios: {
    "Ternary.expression": {
      "adult (age >= 18) selects then branch": {
        input: { age: 20, proPrice: 99, basicPrice: 9 },
        assertData: { result: 99 },
        assertTraces: 0,
      },
      "minor (age < 18) selects else branch": {
        input: { age: 15, proPrice: 99, basicPrice: 9 },
        assertData: { result: 9 },
        assertTraces: 0,
      },
    },
  },
});

// ── Fallbacks ─────────────────────────────────────────────────────────────

regressionTest("ternary: fallbacks", {
  bridge: bridge`
    version 1.5

    bridge Ternary.literalFallback {
      with input as i
      with output as o

      o.amount <- i.isPro ? i.proPrice : i.basicPrice || 0
    }

    bridge Ternary.catchFallback {
      with test.multitool as proTool
      with input as i
      with output as o

      proTool <- i.proTool

      o.amount <- i.isPro ? proTool.price : i.basicPrice catch -1
    }

    bridge Ternary.refFallback {
      with test.multitool as fb
      with input as i
      with output as o

      fb <- i.fb

      o.amount <- i.isPro ? i.proPrice : i.basicPrice || fb.defaultPrice
    }
  `,
  tools: tools,
  scenarios: {
    "Ternary.literalFallback": {
      "falsy, basicPrice null → || 0 fires": {
        input: { isPro: false, proPrice: 99 },
        assertData: { amount: 0 },
        assertTraces: 0,
      },
      "truthy, proPrice present → then branch": {
        input: { isPro: true, proPrice: 99, basicPrice: 9 },
        assertData: { amount: 99 },
        assertTraces: 0,
      },
      "falsy, basicPrice present → else branch": {
        input: { isPro: false, proPrice: 99, basicPrice: 9 },
        assertData: { amount: 9 },
        assertTraces: 0,
      },
    },
    "Ternary.catchFallback": {
      "truthy, proTool throws → catch fires": {
        input: { isPro: true, basicPrice: 9, proTool: { _error: "api down" } },
        assertData: { amount: -1 },
        assertTraces: 1,
      },
      "truthy, proTool succeeds → then branch": {
        input: { isPro: true, basicPrice: 9, proTool: { price: 99 } },
        assertData: { amount: 99 },
        assertTraces: 1,
      },
      "falsy → else branch": {
        input: { isPro: false, basicPrice: 9 },
        assertData: { amount: 9 },
        assertTraces: 0,
      },
    },
    "Ternary.refFallback": {
      "falsy, basicPrice null → || fb.defaultPrice fires": {
        input: { isPro: false, proPrice: 99, fb: { defaultPrice: 5 } },
        assertData: { amount: 5 },
        assertTraces: 1,
      },
      "truthy, proPrice present → then branch": {
        input: { isPro: true, proPrice: 99, fb: { defaultPrice: 5 } },
        assertData: { amount: 99 },
        // Runtime lazily skips fallback tool (0 traces);
        // compiler eagerly calls it (1 trace)
        assertTraces: (traces) => {
          assert.ok(
            traces.length === 0 || traces.length === 1,
            `expected 0 or 1 traces, got ${traces.length}`,
          );
        },
      },
      "falsy, basicPrice present → else branch": {
        input: { isPro: false, basicPrice: 9, fb: { defaultPrice: 5 } },
        assertData: { amount: 9 },
        // Runtime lazily skips fallback tool (0 traces);
        // compiler eagerly calls it (1 trace)
        assertTraces: (traces) => {
          assert.ok(
            traces.length === 0 || traces.length === 1,
            `expected 0 or 1 traces, got ${traces.length}`,
          );
        },
      },
    },
  },
});

// ── Tool branches (lazy evaluation) ───────────────────────────────────────

regressionTest("ternary: tool branches (lazy evaluation)", {
  bridge: bridge`
    version 1.5

    bridge Ternary.toolBranches {
      with test.multitool as proTool
      with test.multitool as basicTool
      with input as i
      with output as o

      proTool <- i.proTool
      basicTool <- i.basicTool

      o.price <- i.isPro ? proTool.price : basicTool.price
    }
  `,
  tools: tools,
  scenarios: {
    "Ternary.toolBranches": {
      "truthy → only chosen branch tool fires": {
        input: {
          isPro: true,
          proTool: { price: 99.99 },
          basicTool: { price: 9.99 },
        },
        assertData: { price: 99.99 },
        assertTraces: 1,
      },
      "falsy → only chosen branch tool fires": {
        input: {
          isPro: false,
          proTool: { price: 99.99 },
          basicTool: { price: 9.99 },
        },
        assertData: { price: 9.99 },
        assertTraces: 1,
      },
    },
  },
});

// ── Ternary in array mapping ──────────────────────────────────────────

regressionTest("ternary: array element mapping", {
  bridge: bridge`
    version 1.5

    bridge Query.products {
      with catalog.list as api
      with output as o

      o <- api.items[] as item {
        .name <- item.name
        .price <- item.isPro ? item.proPrice : item.basicPrice
      }
    }
  `,
  tools: {
    "catalog.list": async () => ({
      items: [
        { name: "Widget", isPro: true, proPrice: 99, basicPrice: 9 },
        { name: "Gadget", isPro: false, proPrice: 199, basicPrice: 19 },
      ],
    }),
  },
  scenarios: {
    "Query.products": {
      "ternary works inside array element mapping": {
        input: {},
        assertData: [
          { name: "Widget", price: 99 },
          { name: "Gadget", price: 19 },
        ],
        assertTraces: 1,
      },
      "all items truthy": {
        input: {},
        tools: {
          "catalog.list": async () => ({
            items: [{ name: "A", isPro: true, proPrice: 50, basicPrice: 5 }],
          }),
        },
        assertData: [{ name: "A", price: 50 }],
        assertTraces: 1,
      },
      "all items falsy": {
        input: {},
        tools: {
          "catalog.list": async () => ({
            items: [{ name: "B", isPro: false, proPrice: 50, basicPrice: 5 }],
          }),
        },
        assertData: [{ name: "B", price: 5 }],
        assertTraces: 1,
      },
      "empty items array": {
        input: {},
        tools: {
          "catalog.list": async () => ({ items: [] }),
        },
        assertData: [],
        assertTraces: 1,
      },
    },
  },
});

// ── Alias ternary: geo + panic gate ───────────────────────────────────

regressionTest("alias ternary: panic gate on age check", {
  bridge: bridge`
    version 1.5

    bridge Query.location {
      with geoApi as geo
      with input as i
      with output as o

      alias ageChecked <- (i.age >= 18) ? i : null ?? panic "Must be 18 or older"

      geo.q <- ageChecked?.city

      o.lat <- geo[0].lat
      o.lon <- geo[0].lon
    }
  `,
  tools: {
    geoApi: async () => [{ lat: 47.37, lon: 8.54 }],
  },
  scenarios: {
    "Query.location": {
      "alias ternary + ?? panic fires on false branch → null": {
        input: { age: 15, city: "Zurich" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "Must be 18 or older");
        },
        assertTraces: 0,
      },
      "alias ternary + ?? panic does NOT fire when condition is true": {
        input: { age: 25, city: "Zurich" },
        assertData: { lat: 47.37, lon: 8.54 },
        assertTraces: 1,
      },
    },
  },
});

// ── Alias ternary: fallback variants ──────────────────────────────────

regressionTest("alias ternary: fallback variants", {
  bridge: bridge`
    version 1.5

    bridge AliasTernary.literalFallback {
      with input as i
      with output as o

      alias grade <- i.score >= 50 ? i.grade : null || "F"
      o.grade <- grade
    }

    bridge AliasTernary.refFallback {
      with test.multitool as fb
      with input as i
      with output as o

      fb <- i.fb
      alias grade <- i.score >= 50 ? i.grade : null || fb.grade
      o.grade <- grade
    }

    bridge AliasTernary.catchFallback {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a
      alias result <- a.ok ? a.value : a.alt catch "safe"
      o.val <- result
    }

    bridge AliasTernary.stringPanic {
      with input as i
      with output as o

      alias result <- "hello" == i.secret ? "access granted" : null ?? panic "wrong secret"
      o.msg <- result
    }
  `,
  tools: tools,
  scenarios: {
    "AliasTernary.literalFallback": {
      "score below threshold → fallback literal": {
        input: { score: 30 },
        assertData: { grade: "F" },
        assertTraces: 0,
      },
      "score above threshold → then branch": {
        input: { score: 80, grade: "A" },
        assertData: { grade: "A" },
        assertTraces: 0,
      },
    },
    "AliasTernary.refFallback": {
      "score below threshold → fallback ref": {
        input: { score: 30, fb: { grade: "F" } },
        assertData: { grade: "F" },
        assertTraces: 1,
      },
      "score above threshold → then branch": {
        input: { score: 80, grade: "A", fb: { grade: "F" } },
        assertData: { grade: "A" },
        assertTraces: 0,
      },
    },
    "AliasTernary.catchFallback": {
      "tool throws → catch fallback fires": {
        input: { a: { _error: "boom" } },
        assertData: { val: "safe" },
        assertTraces: 1,
      },
      "tool succeeds with truthy condition → then branch": {
        input: { a: { ok: true, value: "good" } },
        assertData: { val: "good" },
        assertTraces: 1,
      },
      "tool succeeds with falsy condition → else branch": {
        input: { a: { ok: false, value: "good", alt: "other" } },
        assertData: { val: "other" },
        assertTraces: 1,
      },
    },
    "AliasTernary.stringPanic": {
      "wrong secret → panic fires": {
        input: { secret: "world" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "wrong secret");
        },
        assertTraces: 0,
      },
      "correct secret → access granted": {
        input: { secret: "hello" },
        assertData: { msg: "access granted" },
        assertTraces: 0,
      },
    },
  },
});
