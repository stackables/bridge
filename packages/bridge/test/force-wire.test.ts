import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import assert from "node:assert";

// ── Force statement: regression tests ───────────────────────────────────────

regressionTest("force statement: end-to-end execution", {
  bridge: `version 1.5

bridge Query.search {
  with test.multitool as m
  with test.multitool as audit
  with input as i
  with output as o

  m.title <- i.q
  audit.action <- i.q
  audit._error <- i.err
  force audit
  o.title <- m.title
}

bridge Mutation.createUser {
  with test.multitool as u
  with test.multitool as audit
  with input as i
  with output as o

  u.id = "usr_123"
  audit.action = "createUser"
  audit.userName <- i.name
  force audit
  o.id <- u.id
}

bridge Mutation.fire {
  with test.multitool as se
  with input as i
  with output as o

  se.action <- i.action
  force se
  o.ok = "true"
}`,
  tools: tools,
  scenarios: {
    "Query.search": {
      "forced tool runs even when its output is not queried": {
        input: { q: "test" },
        assertData: { title: "test" },
        assertTraces: 2,
      },
      "critical forced tool error throws": {
        input: { q: "test", err: "audit service unavailable" },
        assertError: /audit service unavailable/,
        assertTraces: (a) => {
          assert.ok(
            a.length >= 1,
            "Expected at least 1 trace for the failing tool",
          );
        },
      },
    },

    "Mutation.createUser": {
      "forced tool receives correct input from multiple wires": {
        input: { name: "Alice", role: "admin" },
        assertData: { id: "usr_123" },
        assertTraces: 2,
      },
    },

    "Mutation.fire": {
      "force without output wires (204 No Content scenario)": {
        input: { action: "deploy" },
        assertData: { ok: true },
        assertTraces: 1,
      },
    },
  },
});

// ── Fire-and-forget: force with catch null ──────────────────────────────────

regressionTest("force with catch null (fire-and-forget)", {
  bridge: `version 1.5

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
  tools: {
    mainApi: async (_params: { q: string }) => ({ title: "OK" }),
    "audit.log": async () => {
      throw new Error("audit service unavailable");
    },
  },
  scenarios: {
    "Query.search": {
      "fire-and-forget error does NOT break the response": {
        input: { q: "test" },
        assertData: { title: "OK" },
        assertTraces: 2,
      },
    },
  },
});
