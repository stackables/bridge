import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

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

const pass = async (input: Record<string, any>) => {
  if (input.err) throw new Error(String(input.err));
  return input;
};

// ── || short-circuit evaluation ────────────────────────────────────────────

regressionTest("|| fallback chains", {
  bridge: `
    version 1.5

    bridge Fallback.lookup {
      with a as a
      with b as b
      with c as c
      with input as i
      with output as o

      a.label <- i.aLabel
      a.err <- i.aErr
      b.label <- i.bLabel
      b.err <- i.bErr
      c.label <- i.cLabel
      c.err <- i.cErr
      o.twoSource <- a.label || b.label
      o.threeSource <- a.label || b.label || c.label
      o.withLiteral <- a.label || b.label || "default"
      o.withCatch <- a.label || b.label || "null-default" catch "error-default"
    }
  `,
  tools: { a: pass, b: pass, c: pass },
  requireErrorCoverage: true,
  scenarios: {
    "Fallback.lookup": {
      "a truthy → short-circuits all chains": {
        input: { aLabel: "A" },
        allowDowngrade: true,
        assertData: (d) => {
          assert.equal(d.twoSource, "A");
          assert.equal(d.threeSource, "A");
          assert.equal(d.withLiteral, "A");
          assert.equal(d.withCatch, "A");
        },
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["a"],
          ),
      },
      "a null, b truthy → b wins": {
        input: { bLabel: "B" },
        allowDowngrade: true,
        assertData: (d) => {
          assert.equal(d.twoSource, "B");
          assert.equal(d.threeSource, "B");
          assert.equal(d.withLiteral, "B");
        },
      },
      "all null → literal / third source fire": {
        input: { cLabel: "C" },
        allowDowngrade: true,
        assertData: (d) => {
          assert.equal(d.threeSource, "C");
          assert.equal(d.withLiteral, "default");
          assert.equal(d.withCatch, "null-default");
        },
      },
      "a throws → error propagates on twoSource, catch fires on withCatch": {
        input: { aErr: "boom" },
        allowDowngrade: true,
        fields: ["withCatch"],
        assertData: (d) => assert.equal(d.withCatch, "error-default"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["a"],
          ),
      },
      "a throws → uncaught wires fail": {
        input: { aErr: "boom" },
        allowDowngrade: true,
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
      "b throws → fallback error propagates": {
        input: { bErr: "boom" },
        allowDowngrade: true,
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
      "c throws → third-position fallback error": {
        input: { cErr: "boom" },
        allowDowngrade: true,
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
    },
  },
});

// ── Cost-based resolution: overdefinition ────────────────────────────────

regressionTest("overdefinition: cost-based prioritization", {
  bridge: `
    version 1.5

    bridge Overdef.lookup {
      with api as api
      with a as a
      with b as b
      with context as ctx
      with input as i
      with output as o

      api.label <- i.apiLabel
      api.err <- i.apiErr
      a.label <- i.aLabel
      a.err <- i.aErr
      b.label <- i.bLabel
      b.err <- i.bErr

      o.inputBeats <- api.label
      o.inputBeats <- i.hint

      o.contextBeats <- api.label
      o.contextBeats <- ctx.defaultLabel

      o.sameCost <- a.label
      o.sameCost <- b.label
    }

    bridge AliasOverdef.lookup {
      with api as api
      with input as i
      with output as o

      alias i.hint as cached
      api.label <- i.apiLabel
      api.err <- i.apiErr
      o.label <- api.label
      o.label <- cached
    }
  `,
  tools: { api: pass, a: pass, b: pass },
  requireErrorCoverage: true,
  scenarios: {
    "Overdef.lookup": {
      "input beats tool — zero-cost short-circuit": {
        input: { apiLabel: "expensive", hint: "cheap" },
        fields: ["inputBeats"],
        assertData: (d) => assert.equal(d.inputBeats, "cheap"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            [],
          ),
      },
      "input null → tool fires": {
        input: { apiLabel: "from-api", aLabel: "A", bLabel: "B" },
        fields: ["inputBeats"],
        assertData: (d) => assert.equal(d.inputBeats, "from-api"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["api"],
          ),
      },
      "context beats tool": {
        input: { apiLabel: "expensive" },
        fields: ["contextBeats"],
        context: { defaultLabel: "from-context" },
        assertData: (d) => assert.equal(d.contextBeats, "from-context"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            [],
          ),
      },
      "context null → tool fires": {
        input: { apiLabel: "from-api" },
        fields: ["contextBeats"],
        assertData: (d) => assert.equal(d.contextBeats, "from-api"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["api"],
          ),
      },
      "same-cost tools use authored order": {
        input: { aLabel: "from-A", bLabel: "from-B" },
        fields: ["sameCost"],
        assertData: (d) => assert.equal(d.sameCost, "from-A"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["a"],
          ),
      },
      "first same-cost null → second fires": {
        input: { bLabel: "from-B" },
        fields: ["sameCost"],
        assertData: (d) => assert.equal(d.sameCost, "from-B"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["a", "b"],
          ),
      },
      "api throws → error when no cheaper override": {
        input: { apiErr: "boom" },
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
      "a throws → sameCost error": {
        input: { aErr: "boom" },
        fields: ["sameCost"],
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
      "a null, b throws → sameCost fails": {
        input: { bErr: "boom" },
        fields: ["sameCost"],
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
    },
    "AliasOverdef.lookup": {
      "alias treated as zero-cost": {
        input: { apiLabel: "expensive", hint: "cached" },
        allowDowngrade: true,
        assertData: (d) => assert.equal(d.label, "cached"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            [],
          ),
      },
      "alias null → tool fires": {
        input: { apiLabel: "from-api" },
        allowDowngrade: true,
        assertData: (d) => assert.equal(d.label, "from-api"),
        assertTraces: (t) =>
          assert.deepStrictEqual(
            t.map((x) => x.tool),
            ["api"],
          ),
      },
      "api throws → error when alias null": {
        input: { apiErr: "boom" },
        allowDowngrade: true,
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
    },
  },
});

// ── ?. safe execution modifier ────────────────────────────────────────────

regressionTest("?. safe execution modifier", {
  bridge: `
    version 1.5

    const lorem = {
      "ipsum": "dolor sit amet",
      "consetetur": 8.9
    }

    bridge Safe.lookup {
      with a as a
      with b as b
      with const
      with input as i
      with output as o

      a.label <- i.aLabel
      a.err <- i.aErr
      b.label <- i.bLabel
      b.err <- i.bErr
      o.bare <- a?.label
      o.withLiteral <- a?.label || "fallback"
      o.withToolFallback <- a?.label || b.label || "last-resort"
      o.constChained <- const.lorem.ipsums?.kala || "A" || "B"
      o.constMixed <- const.lorem.kala || const.lorem.ipsums?.mees ?? "C"
    }
  `,
  tools: { a: pass, b: pass },
  requireErrorCoverage: true,
  scenarios: {
    "Safe.lookup": {
      "tool throws → ?. swallows, fallbacks fire": {
        input: { aErr: "HTTP 500" },
        allowDowngrade: true,
        fields: ["bare", "withLiteral", "withToolFallback"],
        assertData: (d) => {
          assert.equal(d.bare, undefined);
          assert.equal(d.withLiteral, "fallback");
          assert.equal(d.withToolFallback, "last-resort");
        },
      },
      "tool succeeds → value passes through": {
        input: { aLabel: "OK" },
        allowDowngrade: true,
        fields: ["bare", "withLiteral", "withToolFallback"],
        assertData: (d) => {
          assert.equal(d.bare, "OK");
          assert.equal(d.withLiteral, "OK");
          assert.equal(d.withToolFallback, "OK");
        },
      },
      "?. on non-existent const paths": {
        input: {},
        allowDowngrade: true,
        fields: ["constChained", "constMixed"],
        assertData: (d) => {
          assert.equal(d.constChained, "A");
          assert.equal(d.constMixed, "C");
        },
      },
      "b throws in fallback position → error propagates": {
        input: { aErr: "any", bErr: "boom" },
        allowDowngrade: true,
        fields: ["withToolFallback"],
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
    },
  },
});

// ── Mixed || and ?? chains ──────────────────────────────────────────────────

regressionTest("mixed || and ?? chains", {
  bridge: `
    version 1.5

    bridge Mixed.lookup {
      with a as a
      with b as b
      with c as c
      with input as i
      with output as o

      a.label <- i.aLabel
      a.err <- i.aErr
      b.label <- i.bLabel
      b.err <- i.bErr
      c.label <- i.cLabel
      c.err <- i.cErr
      o.nullishThenFalsy <- a.label ?? b.label || "fallback"
      o.falsyThenNullish <- a.label || b.label ?? "default"
      o.fourItem <- a.label ?? b.label || c.label ?? "last"
    }
  `,
  tools: { a: pass, b: pass, c: pass },
  requireErrorCoverage: true,
  scenarios: {
    "Mixed.lookup": {
      "a truthy → all chains short-circuit": {
        input: { aLabel: "A" },
        allowDowngrade: true,
        assertData: (d) => {
          assert.equal(d.nullishThenFalsy, "A");
          assert.equal(d.falsyThenNullish, "A");
          assert.equal(d.fourItem, "A");
        },
      },
      "a null, b truthy → b wins nullish/falsy gates": {
        input: { bLabel: "B" },
        allowDowngrade: true,
        fields: ["nullishThenFalsy", "falsyThenNullish"],
        assertData: (d) => {
          assert.equal(d.nullishThenFalsy, "B");
          assert.equal(d.falsyThenNullish, "B");
        },
      },
      "a null, b falsy → both chains fall through ?? but diverge at ||": {
        input: { bLabel: "" },
        allowDowngrade: true,
        fields: ["nullishThenFalsy", "falsyThenNullish"],
        assertData: (d) => {
          assert.equal(d.nullishThenFalsy, "fallback"); // ?? passes b="", then || drops it
          assert.equal(d.falsyThenNullish, ""); // || picks b="", then ?? keeps it (not null)
        },
      },
      'a="", b null → ?? keeps a but || still drops it': {
        input: { aLabel: "" },
        allowDowngrade: true,
        fields: ["nullishThenFalsy", "falsyThenNullish"],
        assertData: (d) => {
          assert.equal(d.nullishThenFalsy, "fallback"); // ?? keeps "", but || drops it
          assert.equal(d.falsyThenNullish, "default"); // || drops "", b=null, ?? drops null
        },
      },
      "four-item: all fall through → literal": {
        input: { bLabel: 0 },
        allowDowngrade: true,
        fields: ["fourItem"],
        assertData: (d) => assert.equal(d.fourItem, "last"),
      },
      "four-item: c truthy → stops at c": {
        input: { bLabel: 0, cLabel: "C" },
        allowDowngrade: true,
        fields: ["fourItem"],
        assertData: (d) => assert.equal(d.fourItem, "C"),
      },
      "a throws → error on all wires": {
        input: { aErr: "boom" },
        allowDowngrade: true,
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
      "b throws → fallback error": {
        input: { bErr: "boom" },
        allowDowngrade: true,
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
      "c throws → fallback:1 error on fourItem": {
        input: { cErr: "boom" },
        allowDowngrade: true,
        fields: ["fourItem"],
        assertError: (e) => assert.equal(e.name, "BridgeRuntimeError"),
      },
    },
  },
});
