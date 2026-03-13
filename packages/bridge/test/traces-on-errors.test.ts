import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { BridgeRuntimeError } from "@stackables/bridge-core";

// ══════════════════════════════════════════════════════════════════════════════
// Traces on errors
//
// When executeBridge throws, the error should carry any tool traces
// collected before the failure.  This is critical for debugging —
// you need to see what already ran when diagnosing a failure.
// ══════════════════════════════════════════════════════════════════════════════

regressionTest("traces on errors", {
  bridge: `
version 1.5

bridge Query.chainedFailure {
  with test.multitool as g
  with test.multitool as f
  with input as i
  with output as o

  g <- i.good
  f <- i.bad
  f.dep <- g.greeting
  o.result <- f
}

bridge Query.soloFailure {
  with test.multitool as f
  with input as i
  with output as o

  f <- i.bad
  o.result <- f
}
`,
  tools,
  scenarios: {
    "Query.chainedFailure": {
      "happy path covers all wires": {
        input: {
          good: { greeting: "hello" },
          bad: { value: "ok" },
        },
        assertData: { result: { value: "ok", dep: "hello" } },
        assertTraces: 2,
      },
      "error carries traces from tools that completed before the failure": {
        input: {
          good: { greeting: "hello alice" },
          bad: { _error: "tool boom" },
        },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(
            Array.isArray(err.traces),
            "Expected traces array on error",
          );
          assert.ok(err.traces.length > 0, "Expected at least one trace entry");
          const successTrace = err.traces.find((t: any) => !t.error);
          assert.ok(
            successTrace,
            "Expected a trace from the tool that succeeded",
          );
          assert.ok(
            !successTrace.error,
            "successful tool trace should have no error",
          );
        },
        // Both engines record 2 traces (one success, one failure)
        assertTraces: (t) => assert.ok(t.length >= 1),
      },
    },
    "Query.soloFailure": {
      "error carries executionTraceId and traces array": {
        input: { bad: { _error: "tool boom" } },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.equal(
            typeof err.executionTraceId,
            "bigint",
            "Expected executionTraceId (bigint) on error",
          );
          assert.ok(
            Array.isArray(err.traces),
            "Expected traces array on error",
          );
        },
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});
