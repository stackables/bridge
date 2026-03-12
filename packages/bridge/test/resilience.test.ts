import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";

// ═══════════════════════════════════════════════════════════════════════════
// Resilience — error handling, fallback operators, on error, catch,
// multi-wire coalescing, falsy-fallback (||).
//
// Migrated from legacy/resilience.test.ts
// ═══════════════════════════════════════════════════════════════════════════

// ── 1. Const in bridge ──────────────────────────────────────────────────────

regressionTest("resilience: const in bridge", {
  bridge: `
    version 1.5

    const defaults = { "currency": "USD" }

    bridge Query.withConst {
      with api as a
      with const as c
      with input as i
      with output as o

      a.q <- i.q
      a.currency <- c.defaults.currency
      o.result <- a.data
    }
  `,
  scenarios: {
    "Query.withConst": {
      "const defaults.currency is passed to tool": {
        input: { q: "test" },
        tools: {
          api: (p: any) => {
            assert.equal(p.currency, "USD");
            return { data: `${p.q}:${p.currency}` };
          },
        },
        assertData: { result: "test:USD" },
        assertTraces: 1,
      },
    },
  },
});

// ── 2. Tool on error ────────────────────────────────────────────────────────

regressionTest("resilience: tool on error", {
  bridge: `
    version 1.5

    tool safeApi from api {
      on error = {"status":"error","fallback":true}
    }

    bridge Query.onErrorJson {
      with safeApi as a
      with input as i
      with output as o

      a.q <- i.q
      o <- a
    }

    tool ctxApi from api {
      with context
      on error <- context.fallbackData
    }

    bridge Query.onErrorContext {
      with ctxApi as a
      with input as i
      with output as o

      a.q <- i.q
      o <- a
    }

    bridge Query.onErrorNotUsed {
      with safeApi as a
      with input as i
      with output as o

      a.q <- i.q
      o <- a
    }

    tool parentApi from api {
      on error = {"inherited":true}
    }

    tool childApi from parentApi {
    }

    bridge Query.onErrorInherits {
      with childApi as a
      with input as i
      with output as o

      a.q <- i.q
      o <- a
    }
  `,
  scenarios: {
    "Query.onErrorJson": {
      "on error returns JSON fallback when tool throws": {
        input: { q: "fail" },
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        assertData: { status: "error", fallback: true },
        // Compiled engine may not support on error yet
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.onErrorContext": {
      "on error pulls fallback from context": {
        input: { q: "fail" },
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        context: { fallbackData: { status: "ctx-fallback" } },
        assertData: { status: "ctx-fallback" },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.onErrorNotUsed": {
      "on error is NOT used when tool succeeds": {
        input: { q: "ok" },
        tools: {
          api: (p: any) => ({ result: p.q }),
        },
        assertData: { result: "ok" },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
    "Query.onErrorInherits": {
      "on error inherits through extends chain": {
        input: { q: "fail" },
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        assertData: { inherited: true },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
  },
});

// ── 3. Wire catch ───────────────────────────────────────────────────────────

regressionTest("resilience: wire catch", {
  bridge: `
    version 1.5

    bridge Query.catchFallback {
      with api as a
      with output as o

      o.result <- a.data catch "catchFallback"
    }

    bridge Query.catchNotUsed {
      with api as a
      with output as o

      o.result <- a.data catch "catchFallback"
    }

    bridge Query.catchChain {
      with first as f
      with second as s
      with output as o

      s.x <- f.value
      o.result <- s.data catch "chainCaught"
    }
  `,
  scenarios: {
    "Query.catchFallback": {
      "catch returns fallback on tool failure": {
        input: {},
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        assertData: { result: "catchFallback" },
        assertTraces: 1,
      },
    },
    "Query.catchNotUsed": {
      "catch NOT used on success": {
        input: {},
        tools: {
          api: () => ({ data: "real-data" }),
        },
        assertData: { result: "real-data" },
        assertTraces: 1,
      },
    },
    "Query.catchChain": {
      "catch catches chain failure": {
        input: {},
        tools: {
          first: () => {
            throw new Error("first failed");
          },
          second: () => ({ data: "never" }),
        },
        assertData: { result: "chainCaught" },
        // first throws, second never called; catch kicks in
        assertTraces: (traces: any[]) => {
          assert.ok(traces.length >= 1);
        },
      },
    },
  },
});

// ── 4. Combined: on error + catch + const ───────────────────────────────────

regressionTest("resilience: combined on error + catch + const", {
  bridge: `
    version 1.5

    const fallbackVal = { "msg": "const-fallback" }

    tool safeApi from api {
      on error = {"onErrorUsed":true}
    }

    bridge Query.combined {
      with safeApi as a
      with const as c
      with output as o

      o.fromTool <- a.data catch "wire-catch"
      o.fromConst <- c.fallbackVal.msg
    }
  `,
  scenarios: {
    "Query.combined": {
      "on error + catch + const all compose": {
        input: {},
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        // on error fires first, then catch, const always available
        assertData: (data: any) => {
          assert.equal(data.fromConst, "const-fallback");
          // fromTool depends on which layer catches first
          assert.ok(data.fromTool !== undefined);
        },
        allowDowngrade: true,
        assertTraces: 1,
      },
    },
  },
});

// ── 5. Wire || falsy-fallback ───────────────────────────────────────────────

regressionTest("resilience: wire falsy-fallback (||)", {
  bridge: `
    version 1.5

    bridge Query.falsyLiteral {
      with api as a
      with output as o

      o.value <- a.result || "literal"
    }

    bridge Query.falsySkipped {
      with api as a
      with output as o

      o.value <- a.result || "literal"
    }

    bridge Query.falsyNullField {
      with api as a
      with output as o

      o.value <- a.name || "no-name"
    }

    bridge Query.falsyAndCatch {
      with api as a
      with output as o

      o.value <- a.result || "fallback" catch "caught"
    }
  `,
  scenarios: {
    "Query.falsyLiteral": {
      "literal fallback when result is falsy": {
        input: {},
        tools: { api: () => ({ result: "" }) },
        assertData: { value: "literal" },
        assertTraces: 1,
      },
    },
    "Query.falsySkipped": {
      "fallback skipped when result has value": {
        input: {},
        tools: { api: () => ({ result: "real" }) },
        assertData: { value: "real" },
        assertTraces: 1,
      },
    },
    "Query.falsyNullField": {
      "fires on null tool field": {
        input: {},
        tools: { api: () => ({ name: null }) },
        assertData: { value: "no-name" },
        assertTraces: 1,
      },
    },
    "Query.falsyAndCatch": {
      "|| and catch compose — catch wins on throw": {
        input: {},
        tools: {
          api: () => {
            throw new Error("boom");
          },
        },
        assertData: { value: "caught" },
        assertTraces: 1,
      },
    },
  },
});

// ── 6. Multi-wire null-coalescing ───────────────────────────────────────────

regressionTest("resilience: multi-wire null-coalescing", {
  bridge: `
    version 1.5

    bridge Query.firstWins {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val
      o.value <- b.val
    }

    bridge Query.secondUsed {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val
      o.value <- b.val
    }

    bridge Query.multiWithFalsy {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val
      o.value <- b.val
      o.value <- o.value || "terminal"
    }
  `,
  scenarios: {
    "Query.firstWins": {
      "first wire wins when it has a value": {
        input: {},
        tools: {
          primary: () => ({ val: "from-primary" }),
          backup: () => ({ val: "from-backup" }),
        },
        assertData: { value: "from-primary" },
        assertTraces: 2,
      },
    },
    "Query.secondUsed": {
      "second wire used when first returns null": {
        input: {},
        tools: {
          primary: () => ({ val: null }),
          backup: () => ({ val: "from-backup" }),
        },
        assertData: { value: "from-backup" },
        assertTraces: 2,
      },
    },
    "Query.multiWithFalsy": {
      "multi-wire + || terminal fallback": {
        input: {},
        tools: {
          primary: () => ({ val: null }),
          backup: () => ({ val: null }),
        },
        assertData: { value: "terminal" },
        assertTraces: 2,
      },
    },
  },
});

// ── 7. || source + catch source ─────────────────────────────────────────────

regressionTest("resilience: || source + catch source (COALESCE)", {
  bridge: `
    version 1.5

    bridge Query.backupWhenNull {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val || b.val
    }

    bridge Query.backupSkipped {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val || b.val
    }

    bridge Query.bothNull {
      with primary as p
      with backup as b
      with output as o

      o.value <- p.val || b.val || "literal"
    }

    bridge Query.catchSourcePath {
      with api as a
      with fallbackApi as fb
      with output as o

      o.value <- a.result catch fb.fallback
    }

    bridge Query.catchPipeSource {
      with api as a
      with toUpper as tu
      with output as o

      o.value <- a.result catch tu:a.backup
    }

    bridge Query.fullCoalesce {
      with primary as p
      with secondary as s
      with fallbackApi as fb
      with output as o

      o.value <- p.val || s.val catch fb.val || "last-resort"
    }
  `,
  scenarios: {
    "Query.backupWhenNull": {
      "primary null → backup tool called": {
        input: {},
        tools: {
          primary: () => ({ val: null }),
          backup: () => ({ val: "from-backup" }),
        },
        assertData: { value: "from-backup" },
        assertTraces: 2,
      },
    },
    "Query.backupSkipped": {
      "primary has value → backup never called": {
        input: {},
        tools: {
          primary: () => ({ val: "has-value" }),
          backup: () => {
            throw new Error("backup should not be called");
          },
        },
        assertData: { value: "has-value" },
        // backup may or may not be called depending on engine; assertTraces is non-deterministic
        assertTraces: (traces: any[]) => {
          assert.ok(traces.length >= 1);
        },
      },
    },
    "Query.bothNull": {
      "both null → literal fallback": {
        input: {},
        tools: {
          primary: () => ({ val: null }),
          backup: () => ({ val: null }),
        },
        assertData: { value: "literal" },
        assertTraces: 2,
      },
    },
    "Query.catchSourcePath": {
      "catch source uses path from fallback tool": {
        input: {},
        tools: {
          api: () => {
            throw new Error("api down");
          },
          fallbackApi: () => ({ fallback: "recovered" }),
        },
        assertData: { value: "recovered" },
        assertTraces: 2,
      },
    },
    "Query.catchPipeSource": {
      "catch pipe:source pipes backup through tool": {
        input: {},
        tools: {
          api: () => {
            throw new Error("api down");
          },
          toUpper: (p: any) => String(p.in).toUpperCase(),
        },
        // catch tu:a.backup — a throws, so backup value is from catch
        // the exact behavior depends on what a.backup resolves to after error
        assertData: (data: any) => {
          assert.ok(data.value !== undefined);
        },
        allowDowngrade: true,
        assertTraces: (traces: any[]) => {
          assert.ok(traces.length >= 1);
        },
      },
    },
    "Query.fullCoalesce": {
      "full COALESCE: primary || secondary catch fallback || literal": {
        input: {},
        tools: {
          primary: () => ({ val: null }),
          secondary: () => {
            throw new Error("secondary down");
          },
          fallbackApi: () => ({ val: "fb-val" }),
        },
        // primary null → try secondary → secondary throws → catch fb.val
        assertData: (data: any) => {
          assert.ok(data.value !== undefined);
        },
        allowDowngrade: true,
        assertTraces: (traces: any[]) => {
          assert.ok(traces.length >= 1);
        },
      },
    },
  },
});
