import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
} from "@stackables/bridge-parser";
import type { Wire } from "@stackables/bridge-core";
import { assertDeepStrictEqualIgnoringLoc } from "./utils/parse-test-utils.ts";
import { forEachEngine } from "./utils/dual-run.ts";

// ═══════════════════════════════════════════════════════════════════════════
// v2.0 Execution Semantics:
//   • || chains evaluate sequentially (left to right) with short-circuit
//   • Overdefinition uses cost-based ordering (zero-cost/already-resolved → expensive)
//   • Backup tools are NEVER called when a earlier source returns a truthy value
// ═══════════════════════════════════════════════════════════════════════════

// ── Short-circuit: || chains ──────────────────────────────────────────────

forEachEngine("|| sequential short-circuit", (run, { engine }) => {
  test(
    "primary succeeds → backup is never called",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
      const callLog: string[] = [];
      const tools = {
        primary: async () => {
          callLog.push("primary");
          return { label: "P" };
        },
        backup: async () => {
          callLog.push("backup");
          return { label: "B" };
        },
      };

      const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
      assert.equal(data.label, "P");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        ["primary"],
        "backup should never be called",
      );
    },
  );

  test("primary returns null → backup is called", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => {
        callLog.push("primary");
        return { label: null };
      },
      backup: async () => {
        callLog.push("backup");
        return { label: "B" };
      },
    };

    const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
    assert.equal(data.label, "B");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary", "backup"],
      "backup called after primary returned null",
    );
  });

  test(
    "3-source chain: first truthy wins, later sources skipped",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with svcC as c
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
c.q <- i.q
o.label <- a.label || b.label || c.label

}`;
      const callLog: string[] = [];
      const tools = {
        svcA: async () => {
          callLog.push("A");
          return { label: null };
        },
        svcB: async () => {
          callLog.push("B");
          return { label: "from-B" };
        },
        svcC: async () => {
          callLog.push("C");
          return { label: "from-C" };
        },
      };

      const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
      assert.equal(data.label, "from-B");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        ["A", "B"],
        "C should never be called",
      );
    },
  );

  test("|| with literal fallback: both null → literal, no extra calls", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "default"

}`;
    const callLog: string[] = [];
    const tools = {
      primary: async () => {
        callLog.push("primary");
        return { label: null };
      },
      backup: async () => {
        callLog.push("backup");
        return { label: null };
      },
    };

    const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
    assert.equal(data.label, "default");
    assertDeepStrictEqualIgnoringLoc(
      callLog,
      ["primary", "backup"],
      "both called, then literal fires",
    );
  });

  test(
    "strict throw exits || chain — backup not called (no catch)",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label

}`;
      const callLog: string[] = [];
      const tools = {
        primary: async () => {
          callLog.push("primary");
          throw new Error("boom");
        },
        backup: async () => {
          callLog.push("backup");
          return { label: "B" };
        },
      };

      await assert.rejects(
        () => run(bridgeText, "Query.lookup", { q: "x" }, tools),
        { message: /boom/ },
      );
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        ["primary"],
        "backup never called — strict throw exits chain",
      );
    },
  );

  test(
    "|| + catch combined: strict throw → catch fires",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

p.q <- i.q
b.q <- i.q
o.label <- p.label || b.label || "null-default" catch "error-default"

}`;
      const callLog: string[] = [];
      const tools = {
        primary: async () => {
          callLog.push("primary");
          throw new Error("down");
        },
        backup: async () => {
          callLog.push("backup");
          throw new Error("also down");
        },
      };

      const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
      assert.equal(data.label, "error-default");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        ["primary"],
        "strict throw exits || — catch fires immediately",
      );
    },
  );
});

// ── Cost-based resolution: overdefinition ────────────────────────────────

forEachEngine(
  "overdefinition: cost-based prioritization",
  (run, { engine }) => {
    test("input beats tool even when tool wire is authored first", async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- i.hint

}`;
      const callLog: string[] = [];
      const tools = {
        expensiveApi: async () => {
          callLog.push("expensiveApi");
          return { label: "expensive" };
        },
      };

      const { data } = await run(
        bridgeText,
        "Query.lookup",
        { q: "x", hint: "cheap" },
        tools,
      );
      assert.equal(data.label, "cheap");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        [],
        "zero-cost input should short-circuit before the API is called",
      );
    });

    test("input is null → falls through to tool call", async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- i.hint

}`;
      const callLog: string[] = [];
      const tools = {
        expensiveApi: async () => {
          callLog.push("expensiveApi");
          return { label: "from-api" };
        },
      };

      const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
      assert.equal(data.label, "from-api");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        ["expensiveApi"],
        "API should run only when zero-cost sources are nullish",
      );
    });

    test("context beats tool even when tool wire is authored first", async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with context as ctx
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label
o.label <- ctx.defaultLabel

}`;
      const callLog: string[] = [];
      const tools = {
        expensiveApi: async () => {
          callLog.push("expensiveApi");
          return { label: "expensive" };
        },
      };

      const { data } = await run(
        bridgeText,
        "Query.lookup",
        { q: "x" },
        tools,
        { context: { defaultLabel: "from-context" } },
      );
      assert.equal(data.label, "from-context");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        [],
        "zero-cost context should short-circuit before the API is called",
      );
    });

    test(
      "resolved alias beats tool even when tool wire is authored first",
      { skip: engine === "compiled" },
      async () => {
        const bridgeText = `version 1.5
bridge Query.lookup {
  with expensiveApi as api
  with input as i
  with output as o

alias i.hint as cached
api.q <- i.q
o.label <- api.label
o.label <- cached

}`;
        const callLog: string[] = [];
        const tools = {
          expensiveApi: async () => {
            callLog.push("api");
            return { label: "expensive" };
          },
        };

        const { data } = await run(
          bridgeText,
          "Query.lookup",
          { q: "x", hint: "cached" },
          tools,
        );
        assert.equal(data.label, "cached");
        assertDeepStrictEqualIgnoringLoc(
          callLog,
          [],
          "resolved aliases should be treated like zero-cost values",
        );
      },
    );

    test("two tool sources with same cost preserve authored order as tie-break", async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label
o.label <- b.label

}`;
      const callLog: string[] = [];
      const tools = {
        svcA: async () => {
          callLog.push("A");
          return { label: "from-A" };
        },
        svcB: async () => {
          callLog.push("B");
          return { label: "from-B" };
        },
      };

      const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
      assert.equal(data.label, "from-A");
      assertDeepStrictEqualIgnoringLoc(
        callLog,
        ["A"],
        "same-cost tool sources should still use authored order as a tie-break",
      );
    });
  },
);

// ── Edge cases ───────────────────────────────────────────────────────────

forEachEngine("coalesce edge cases", (run, { engine }) => {
  test("single source: no sorting or short-circuit needed", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with myApi as api
  with input as i
  with output as o

api.q <- i.q
o.label <- api.label

}`;
    const tools = {
      myApi: async () => ({ label: "hello" }),
    };

    const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
    assert.equal(data.label, "hello");
  });

  test(
    "?. with || fallback: error → undefined, null → falls through to literal",
    { skip: engine === "compiled" },
    async () => {
      const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a?.label || b.label || "last-resort"

}`;
      const tools = {
        svcA: async () => {
          throw new Error("A down");
        },
        svcB: async () => ({ label: null }),
      };

      const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
      assert.equal(data.label, "last-resort");
    },
  );

  test("independent targets still resolve concurrently", async () => {
    const bridgeText = `version 1.5
bridge Query.lookup {
  with svcA as a
  with svcB as b
  with input as i
  with output as o

a.q <- i.q
b.q <- i.q
o.label <- a.label
o.score <- b.score

}`;
    const timeline: { tool: string; event: string; time: number }[] = [];
    const start = Date.now();
    const tools = {
      svcA: async () => {
        timeline.push({ tool: "A", event: "start", time: Date.now() - start });
        await new Promise((r) => setTimeout(r, 50));
        timeline.push({ tool: "A", event: "end", time: Date.now() - start });
        return { label: "A" };
      },
      svcB: async () => {
        timeline.push({ tool: "B", event: "start", time: Date.now() - start });
        await new Promise((r) => setTimeout(r, 50));
        timeline.push({ tool: "B", event: "end", time: Date.now() - start });
        return { score: 42 };
      },
    };

    const { data } = await run(bridgeText, "Query.lookup", { q: "x" }, tools);
    assert.equal(data.label, "A");
    assert.equal(data.score, 42);

    const startEvents = timeline.filter((e) => e.event === "start");
    assert.equal(startEvents.length, 2);
    const gap = Math.abs(startEvents[0].time - startEvents[1].time);
    assert.ok(gap < 30, `tools should start concurrently (gap: ${gap}ms)`);
  });
});

// ── ?. Safe execution modifier ────────────────────────────────────────────

describe("?. safe execution modifier (parser)", () => {
  test("parser detects ?. and sets safe flag on wire", () => {
    const doc = parseBridge(`version 1.5
bridge Query.lookup {
  with api.fetch as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const safePull = bridge.wires.find(
      (w) => "from" in w && "safe" in w && w.safe,
    );
    assert.ok(safePull, "has a wire with safe: true");
  });

  test("safe execution round-trips through serializer", () => {
    const src = `version 1.5

bridge Query.lookup {
  with api.fetch as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label catch "default"

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    assert.ok(serialized.includes("?."), "serialized contains ?.");
    assert.ok(serialized.includes("catch"), "serialized contains catch");
    const reparsed = parseBridge(serialized);
    const bridge = reparsed.instructions.find((i) => i.kind === "bridge")!;
    const safePull = bridge.wires.find(
      (w) => "from" in w && "safe" in w && w.safe,
    );
    assert.ok(safePull, "round-tripped wire has safe: true");
  });
});

forEachEngine("?. safe execution modifier", (run, { engine }) => {
  test(
    "?. swallows tool error and returns undefined",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.lookup {
  with failing.api as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`,
        "Query.lookup",
        { q: "test" },
        {
          "failing.api": async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.label, undefined);
    },
  );

  test(
    "?. with || fallback: error returns undefined then || kicks in",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.lookup {
  with failing.api as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label || "fallback"
}`,
        "Query.lookup",
        { q: "test" },
        {
          "failing.api": async () => {
            throw new Error("HTTP 500");
          },
        },
      );
      assert.equal(data.label, "fallback");
    },
  );

  test(
    "?. with chained || literals short-circuits at first truthy literal",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
const lorem = {
  "ipsum":"dolor sit amet",
  "consetetur":8.9
}

bridge Query.lookup {
  with const
  with output as o

  o.label <- const.lorem.ipsums?.kala || "A" || "B"
}`,
        "Query.lookup",
        {},
        {},
      );
      assert.equal(data.label, "A");
    },
  );

  test(
    "mixed || and ?? remains left-to-right with first truthy || winner",
    { skip: engine === "compiled" },
    async () => {
      const { data } = await run(
        `version 1.5
const lorem = {
  "ipsum": "dolor sit amet",
  "consetetur": 8.9
}

bridge Query.lookup {
  with const
  with output as o

  o.label <- const.lorem.kala || const.lorem.ipsums?.mees || "B" ?? "C"
}`,
        "Query.lookup",
        {},
        {},
      );
      assert.equal(data.label, "B");
    },
  );

  test("?. passes through value when tool succeeds", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with good.api as api
  with input as i
  with output as o

  api.q <- i.q
  o.label <- api?.label
}`,
      "Query.lookup",
      { q: "test" },
      {
        "good.api": async () => ({ label: "Hello" }),
      },
    );
    assert.equal(data.label, "Hello");
  });
});

// ── Mixed || and ?? chains ──────────────────────────────────────────────────

describe("mixed || and ?? chains (parser)", () => {
  test("mixed chain round-trips through serializer", () => {
    const src = `version 1.5

bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  o.label <- a.label ?? b.label || "fallback"

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, doc);
  });

  test("?? then || with literals round-trips", () => {
    const src = `version 1.5

bridge Query.lookup {
  with input as i
  with output as o

  o.label <- i.label ?? "nullish-default" || "falsy-default"

}`;
    const doc = parseBridge(src);
    const serialized = serializeBridge(doc);
    const reparsed = parseBridge(serialized);
    assertDeepStrictEqualIgnoringLoc(reparsed, doc);
  });

  test("parser produces correct fallbacks array for mixed chain", () => {
    const doc = parseBridge(`version 1.5

bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  o.label <- a.label ?? b.label || "default"
}`);
    const bridge = doc.instructions.find((i) => i.kind === "bridge")!;
    const wire = bridge.wires.find(
      (w) => "from" in w && (w as any).to.path[0] === "label" && !("pipe" in w),
    ) as Extract<Wire, { from: any }>;
    assert.ok(wire.fallbacks, "wire should have fallbacks");
    assert.equal(wire.fallbacks!.length, 2);
    assert.equal(wire.fallbacks![0].type, "nullish");
    assert.ok(wire.fallbacks![0].ref, "first fallback should be a ref");
    assert.equal(wire.fallbacks![1].type, "falsy");
    assert.equal(wire.fallbacks![1].value, '"default"');
  });
});

forEachEngine("mixed || and ?? chains", (run) => {
  test("A ?? B || C — nullish gate then falsy gate", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

  p.q <- i.q
  b.q <- i.q
  o.label <- p.label ?? b.label || "fallback"
}`,
      "Query.lookup",
      { q: "test" },
      {
        primary: async () => ({ label: null }),
        backup: async () => ({ label: "" }),
      },
    );
    assert.equal(data.label, "fallback");
  });

  test("A || B ?? C — falsy gate then nullish gate", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with primary as p
  with backup as b
  with input as i
  with output as o

  p.q <- i.q
  b.q <- i.q
  o.label <- p.label || b.label ?? "default"
}`,
      "Query.lookup",
      { q: "test" },
      {
        primary: async () => ({ label: "" }),
        backup: async () => ({ label: null }),
      },
    );
    assert.equal(data.label, "default");
  });

  test("A ?? B || C ?? D — four-item mixed chain", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with a as a
  with b as b
  with c as c
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  c.q <- i.q
  o.label <- a.label ?? b.label || c.label ?? "last"
}`,
      "Query.lookup",
      { q: "test" },
      {
        a: async () => ({ label: null }),
        b: async () => ({ label: 0 }),
        c: async () => ({ label: null }),
      },
    );
    assert.equal(data.label, "last");
  });

  test("mixed chain short-circuits when value becomes truthy", async () => {
    const { data } = await run(
      `version 1.5
bridge Query.lookup {
  with a as a
  with b as b
  with input as i
  with output as o

  a.q <- i.q
  b.q <- i.q
  o.label <- a.label ?? b.label || "unused"
}`,
      "Query.lookup",
      { q: "test" },
      {
        a: async () => ({ label: null }),
        b: async () => ({ label: "found" }),
      },
    );
    assert.equal(data.label, "found");
  });
});
