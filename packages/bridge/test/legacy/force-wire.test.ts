import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "../utils/dual-run.ts";

// ── Legacy force-wire tests ─────────────────────────────────────────────────
// Tests that require timing assertions or engine-specific skips.

forEachEngine("force statement: legacy tests", (run, { engine }) => {
  test("forced tool runs in parallel with demand-driven tools", async () => {
    let mainStart = 0;
    let auditStart = 0;
    const t0 = performance.now();

    const { data } = await run(
      `version 1.5
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.q
audit.action <- i.q
force audit
o.title <- m.title

}`,
      "Query.search",
      { q: "test" },
      {
        mainApi: async () => {
          mainStart = performance.now() - t0;
          await new Promise((r) => setTimeout(r, 50));
          return { title: "result" };
        },
        "audit.log": async () => {
          auditStart = performance.now() - t0;
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true };
        },
      },
    );

    assert.equal(data.title, "result");
    assert.ok(
      Math.abs(mainStart - auditStart) < 20,
      `main and audit should start in parallel (Δ=${Math.abs(mainStart - auditStart).toFixed(1)}ms)`,
    );
  });

  test(
    "fire-and-forget (catch null) error does NOT break the response",
    { skip: engine === "runtime" },
    async () => {
      const { data } = await run(
        `version 1.5
bridge Query.search {
  with mainApi as m
  with audit.log as audit
  with input as i
  with output as o

m.q <- i.q
audit.action <- i.q
force audit catch null
o.title <- m.title

}`,
        "Query.search",
        { q: "test" },
        {
          mainApi: async () => ({ title: "OK" }),
          "audit.log": async () => {
            throw new Error("audit service unavailable");
          },
        },
      );

      assert.equal(data.title, "OK");
    },
  );
});
