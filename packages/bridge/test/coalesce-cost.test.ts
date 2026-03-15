import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { bridge } from "@stackables/bridge";

// ═══════════════════════════════════════════════════════════════════════════
// Coalesce & cost-based resolution
//
//   • || chains evaluate sequentially (left to right) with short-circuit
//   • ?? chains use nullish coalescing (only null/undefined trigger next)
//   • Overdefinition uses cost-based ordering
//   • ?. modifier converts tool errors to undefined
//
// All tools are passthrough: output mirrors input. Wire `err` to throw.
// Scenarios exercise different traversal paths by varying the input.
// ═══════════════════════════════════════════════════════════════════════════

// ── || short-circuit evaluation ────────────────────────────────────────────

regressionTest("|| fallback chains", {
  bridge: bridge`
    version 1.5

    bridge Fallback.lookup {
      with test.multitool as a
      with test.multitool as b
      with test.multitool as c
      with input as i
      with output as o

      a <- i.a
      b <- i.b
      c <- i.c

      o.twoSource <- a.label || b.label
      o.threeSource <- a.label || b.label || c.label
      o.withLiteral <- a.label || b.label || "default"
      o.withCatch <- a.label || b.label || "null-default" catch "error-default"
    }
  `,
  tools: tools,
  scenarios: {
    "Fallback.lookup": {
      "a truthy → short-circuits all chains": {
        input: { a: { label: "A" } },
        allowDowngrade: true,
        assertData: {
          twoSource: "A",
          threeSource: "A",
          withLiteral: "A",
          withCatch: "A",
        },
        assertTraces: 1,
      },
      "a null, b truthy → b wins": {
        input: { b: { label: "B" } },
        allowDowngrade: true,
        assertData: {
          twoSource: "B",
          threeSource: "B",
          withLiteral: "B",
          withCatch: "B",
        },
        assertTraces: 2,
      },
      "all null → literal / third source fire": {
        input: { c: { label: "C" } },
        allowDowngrade: true,
        assertData: {
          threeSource: "C",
          withLiteral: "default",
          withCatch: "null-default",
        },
        assertTraces: 3,
      },
      "a throws → error propagates on twoSource, catch fires on withCatch": {
        input: { a: { _error: "boom" } },
        allowDowngrade: true,
        fields: ["withCatch"],
        assertData: { withCatch: "error-default" },
        assertTraces: 1,
      },
      "a throws → uncaught wires fail": {
        input: { a: { _error: "boom" } },
        allowDowngrade: true,
        assertError: /BridgeRuntimeError/,
        assertTraces: 1,
        assertGraphql: {
          twoSource: /boom/i,
          threeSource: /boom/i,
          withLiteral: /boom/i,
          withCatch: "error-default",
        },
      },
      "b throws → fallback error propagates": {
        input: { b: { _error: "boom" } },
        allowDowngrade: true,
        assertError: /BridgeRuntimeError/,
        assertTraces: 2,
        assertGraphql: {
          twoSource: /boom/i,
          threeSource: /boom/i,
          withLiteral: /boom/i,
          withCatch: "error-default",
        },
      },
      "c throws → third-position fallback error": {
        input: { c: { _error: "boom" } },
        allowDowngrade: true,
        assertError: /BridgeRuntimeError/,
        assertTraces: 3,
        assertGraphql: {
          twoSource: null,
          threeSource: /boom/i,
          withLiteral: "default",
          withCatch: "null-default",
        },
      },
    },
  },
});

// ── Cost-based resolution: overdefinition ────────────────────────────────

regressionTest("overdefinition: cost-based prioritization", {
  bridge: bridge`
    version 1.5

    bridge Overdef.lookup {
      with test.multitool as api
      with test.multitool as a
      with test.multitool as b
      with context as ctx
      with input as i
      with output as o

      api <- i.api
      a <- i.a
      b <- i.b

      o.inputBeats <- api.label
      o.inputBeats <- i.hint

      o.contextBeats <- api.label
      o.contextBeats <- ctx.defaultLabel

      o.sameCost <- a.label
      o.sameCost <- b.label
    }

    bridge AliasOverdef.lookup {
      with test.multitool as api
      with input as i
      with output as o

      alias cached <- i.hint
      api <- i.api

      o.label <- api.label
      o.label <- cached
    }
  `,
  tools: tools,
  scenarios: {
    "Overdef.lookup": {
      "input beats tool — zero-cost short-circuit": {
        input: { api: { label: "expensive" }, hint: "cheap" },
        fields: ["inputBeats"],
        assertData: { inputBeats: "cheap" },
        assertTraces: 0,
      },
      "input null → tool fires": {
        input: {
          api: { label: "from-api" },
          a: { label: "A" },
          b: { label: "B" },
        },
        fields: ["inputBeats"],
        assertData: { inputBeats: "from-api" },
        assertTraces: 1,
      },
      "context beats tool": {
        input: { api: { label: "expensive" } },
        fields: ["contextBeats"],
        context: { defaultLabel: "from-context" },
        assertData: { contextBeats: "from-context" },
        assertTraces: 0,
      },
      "context null → tool fires": {
        input: { api: { label: "from-api" } },
        fields: ["contextBeats"],
        assertData: { contextBeats: "from-api" },
        assertTraces: 1,
      },
      "same-cost tools use authored order": {
        input: { a: { label: "from-A" }, b: { label: "from-B" } },
        allowDowngrade: true,
        fields: ["sameCost"],
        assertData: { sameCost: "from-A" },
        assertTraces: 1,
      },
      "first same-cost null → second fires": {
        input: { b: { label: "from-B" } },
        allowDowngrade: true,
        fields: ["sameCost"],
        assertData: { sameCost: "from-B" },
        assertTraces: 2,
      },
      "api throws → error when no cheaper override": {
        input: { api: { _error: "boom" } },
        fields: ["inputBeats"],
        assertError: /BridgeRuntimeError/,
        assertTraces: 1,
        assertGraphql: () => {},
      },
      "api throws → contextBeats error": {
        input: { api: { _error: "boom" } },
        fields: ["contextBeats"],
        assertError: /BridgeRuntimeError/,
        assertTraces: 1,
        assertGraphql: () => {},
      },
      "a throws → sameCost error": {
        input: { a: { _error: "boom" } },
        allowDowngrade: true,
        fields: ["sameCost"],
        assertError: /BridgeRuntimeError/,
        assertTraces: 2,
        assertGraphql: {
          sameCost: /boom/i,
        },
      },
      "a null, b throws → sameCost fails": {
        input: { b: { _error: "boom" } },
        allowDowngrade: true,
        fields: ["sameCost"],
        assertError: /BridgeRuntimeError/,
        assertTraces: 2,
        assertGraphql: {
          sameCost: /boom/i,
        },
      },
    },
    "AliasOverdef.lookup": {
      "alias treated as zero-cost": {
        input: { api: { label: "expensive" }, hint: "cached" },
        allowDowngrade: true,
        assertData: { label: "cached" },
        assertTraces: 0,
      },
      "alias null → tool fires": {
        input: { api: { label: "from-api" } },
        allowDowngrade: true,
        assertData: { label: "from-api" },
        assertTraces: 1,
      },
      "api throws → error when alias null": {
        input: { api: { _error: "boom" } },
        allowDowngrade: true,
        assertError: /BridgeRuntimeError/,
        assertTraces: 1,
        assertGraphql: {
          label: /boom/i,
        },
      },
    },
  },
});

// ── Cost tiers: sync vs async and explicit cost ─────────────────────────

regressionTest("overdefinition: sync beats async", {
  bridge: bridge`
    version 1.5

    bridge SyncAsync.lookup {
      with test.async.multitool as slow
      with test.sync.multitool as fast
      with input as i
      with output as o

      slow <- i.data
      fast <- i.data

      o.label <- slow.label
      o.label <- fast.label
    }
  `,
  tools: tools,
  scenarios: {
    "SyncAsync.lookup": {
      "sync tool (cost 1) tried before async (cost 2)": {
        input: { data: { label: "hello" } },
        allowDowngrade: true,
        assertData: { label: "hello" },
        // sync tool fires first (cost 1) and succeeds → async never called
        assertTraces: 1,
      },
      "sync null → async fires": {
        input: { data: {} },
        allowDowngrade: true,
        assertData: { label: undefined },
        assertTraces: 2,
      },
    },
  },
});

regressionTest("overdefinition: explicit cost override", {
  bridge: bridge`
    version 1.5

    bridge ExplCost.lookup {
      with test.async.multitool as expensive
      with test.cheap.multitool as cheap
      with input as i
      with output as o

      expensive <- i.data
      cheap <- i.data

      o.label <- expensive.label
      o.label <- cheap.label
    }
  `,
  tools: tools,
  scenarios: {
    "ExplCost.lookup": {
      "cost-0 tool tried before async tool": {
        input: { data: { label: "win" } },
        allowDowngrade: true,
        assertData: { label: "win" },
        assertTraces: 1,
      },
      "cost-0 null → async fires": {
        input: { data: {} },
        allowDowngrade: true,
        assertData: { label: undefined },
        assertTraces: 2,
      },
    },
  },
});

// ── ?. safe execution modifier ────────────────────────────────────────────

regressionTest("?. safe execution modifier", {
  bridge: bridge`
    version 1.5

    const lorem = {
      "ipsum": "dolor sit amet",
      "consetetur": 8.9
    }

    bridge Safe.lookup {
      with test.multitool as a
      with test.multitool as b
      with const
      with input as i
      with output as o

      a <- i.a
      b <- i.b

      o.bare <- a?.label
      o.withLiteral <- a?.label || "fallback"
      o.withToolFallback <- a?.label || b.label || "last-resort"
      o.constChained <- const.lorem.ipsums?.kala || "A" || "B"
      o.constMixed <- const.lorem.kala || const.lorem.ipsums?.mees ?? "C"
    }
  `,
  tools: tools,
  scenarios: {
    "Safe.lookup": {
      "tool throws → ?. swallows, fallbacks fire": {
        input: { a: { _error: "HTTP 500" } },
        allowDowngrade: true,
        fields: ["bare", "withLiteral", "withToolFallback"],
        assertData: {
          withLiteral: "fallback",
          withToolFallback: "last-resort",
        },
        assertTraces: 2,
      },
      "tool succeeds → value passes through": {
        input: { a: { label: "OK" } },
        allowDowngrade: true,
        fields: ["bare", "withLiteral", "withToolFallback"],
        assertData: {
          bare: "OK",
          withLiteral: "OK",
          withToolFallback: "OK",
        },
        assertTraces: 1,
      },
      "?. on non-existent const paths": {
        input: {},
        allowDowngrade: true,
        fields: ["constChained", "constMixed"],
        assertData: {
          constChained: "A",
          constMixed: "C",
        },
        assertTraces: 0,
      },
      "b throws in fallback position → error propagates": {
        input: { a: { _error: "any" }, b: { _error: "boom" } },
        allowDowngrade: true,
        fields: ["withToolFallback"],
        assertError: /BridgeRuntimeError/,
        assertTraces: 2,
        assertGraphql: {
          withToolFallback: /boom/i,
        },
      },
    },
  },
});

// ── Mixed || and ?? chains ──────────────────────────────────────────────────

regressionTest("mixed || and ?? chains", {
  bridge: bridge`
    version 1.5

    bridge Mixed.lookup {
      with test.multitool as a
      with test.multitool as b
      with test.multitool as c
      with input as i
      with output as o

      a <- i.a
      b <- i.b
      c <- i.c

      o.nullishThenFalsy <- a.label ?? b.label || "fallback"
      o.falsyThenNullish <- a.label || b.label ?? "default"
      o.fourItem <- a.label ?? b.label || c.label ?? "last"
    }
  `,
  tools: tools,
  scenarios: {
    "Mixed.lookup": {
      "a truthy → all chains short-circuit": {
        input: { a: { label: "A" } },
        allowDowngrade: true,
        assertData: {
          nullishThenFalsy: "A",
          falsyThenNullish: "A",
          fourItem: "A",
        },
        assertTraces: 1,
      },
      "a null, b truthy → b wins nullish/falsy gates": {
        input: { b: { label: "B" } },
        allowDowngrade: true,
        fields: ["nullishThenFalsy", "falsyThenNullish"],
        assertData: {
          nullishThenFalsy: "B",
          falsyThenNullish: "B",
        },
        assertTraces: 2,
      },
      "a null, b falsy → both chains fall through ?? but diverge at ||": {
        input: { b: { label: "" } },
        allowDowngrade: true,
        fields: ["nullishThenFalsy", "falsyThenNullish"],
        assertData: {
          nullishThenFalsy: "fallback", // ?? passes b="", then || drops it
          falsyThenNullish: "", // || picks b="", then ?? keeps it (not null)
        },
        assertTraces: 2,
      },
      'a="", b null → ?? keeps a but || still drops it': {
        input: { a: { label: "" } },
        allowDowngrade: true,
        fields: ["nullishThenFalsy", "falsyThenNullish"],
        assertData: {
          nullishThenFalsy: "fallback", // ?? keeps "", but || drops it
          falsyThenNullish: "default", // || drops "", b=null, ?? drops null
        },
        assertTraces: 2,
      },
      "four-item: all fall through → literal": {
        input: { b: { label: 0 } },
        allowDowngrade: true,
        fields: ["fourItem"],
        assertData: { fourItem: "last" },
        assertTraces: 3,
      },
      "four-item: c truthy → stops at c": {
        input: { b: { label: 0 }, c: { label: "C" } },
        allowDowngrade: true,
        fields: ["fourItem"],
        assertData: { fourItem: "C" },
        assertTraces: 3,
      },
      "a throws → error on all wires": {
        input: { a: { _error: "boom" } },
        allowDowngrade: true,
        assertError: /BridgeRuntimeError/,
        assertTraces: 1,
        assertGraphql: {
          nullishThenFalsy: /boom/i,
          falsyThenNullish: /boom/i,
          fourItem: /boom/i,
        },
      },
      "b throws → fallback error": {
        input: { b: { _error: "boom" } },
        allowDowngrade: true,
        assertError: /BridgeRuntimeError/,
        assertTraces: 2,
        assertGraphql: {
          nullishThenFalsy: /boom/i,
          falsyThenNullish: /boom/i,
          fourItem: /boom/i,
        },
      },
      "c throws → fallback:1 error on fourItem": {
        input: { c: { _error: "boom" } },
        allowDowngrade: true,
        fields: ["fourItem"],
        assertError: /BridgeRuntimeError/,
        assertTraces: 3,
        assertGraphql: {
          fourItem: /boom/i,
        },
      },
    },
  },
});
