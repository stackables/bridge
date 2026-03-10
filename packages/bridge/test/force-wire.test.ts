import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDeepStrictEqualIgnoringLoc } from "./utils/parse-test-utils.ts";
import { forEachEngine } from "./utils/dual-run.ts";

// ── End-to-end: forced tool runs without output demand ──────────────────────

forEachEngine("force statement: end-to-end execution", (run, { engine }) => {
  test("forced tool runs even when its output is not queried", async () => {
    let auditCalled = false;
    let auditInput: any = null;

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
        mainApi: async () => ({ title: "Hello World" }),
        "audit.log": async (input: any) => {
          auditCalled = true;
          auditInput = input;
          return { ok: true };
        },
      },
    );

    assert.equal(data.title, "Hello World");
    assert.ok(
      auditCalled,
      "audit tool must be called even though output is not queried",
    );
    assertDeepStrictEqualIgnoringLoc(auditInput, { action: "test" });
  });

  test("forced tool receives correct input from multiple wires", async () => {
    let auditInput: any = null;

    const { data } = await run(
      `version 1.5
bridge Mutation.createUser {
  with userApi.create as u
  with audit.log as audit
  with input as i
  with output as o

u.name <- i.name
audit.action = "createUser"
audit.userName <- i.name
force audit
o.id <- u.id

}`,
      "Mutation.createUser",
      { name: "Alice", role: "admin" },
      {
        "userApi.create": async () => ({ id: "usr_123" }),
        "audit.log": async (input: any) => {
          auditInput = input;
          return { ok: true };
        },
      },
    );

    assert.equal(data.id, "usr_123");
    assert.ok(auditInput, "audit tool must be called");
    assert.equal(auditInput.action, "createUser", "constant wire feeds audit");
    assert.equal(auditInput.userName, "Alice", "pull wire feeds audit");
  });

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

  test("force without output wires (204 No Content scenario)", async () => {
    let sideEffectCalled = false;

    const { data } = await run(
      `version 1.5
bridge Mutation.fire {
  with sideEffect as se
  with input as i
  with output as o

se.action <- i.action
force se
o.ok = "true"

}`,
      "Mutation.fire",
      { action: "deploy" },
      {
        sideEffect: async () => {
          sideEffectCalled = true;
          return null;
        },
      },
    );

    assert.strictEqual(data.ok, true);
    assert.ok(
      sideEffectCalled,
      "side-effect tool must run even with no output wires",
    );
  });

  test("critical forced tool error throws", async () => {
    await assert.rejects(
      () =>
        run(
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
            mainApi: async () => ({ title: "OK" }),
            "audit.log": async () => {
              throw new Error("audit service unavailable");
            },
          },
        ),
      { message: /audit service unavailable/ },
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
