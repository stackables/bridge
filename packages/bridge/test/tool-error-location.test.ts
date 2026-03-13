import assert from "node:assert/strict";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { BridgeRuntimeError } from "@stackables/bridge-core";
import { bridge } from "@stackables/bridge";

/**
 * Returns the source text segment that would be underlined with ^^^^^ carets
 * in the formatted error output.  Uses the `bridgeLoc` + `bridgeSource`
 * attached to the error by the execution engine.
 */
function locatedSegment(
  err: BridgeRuntimeError & { bridgeSource?: string },
): string {
  const loc = err.bridgeLoc;
  const source = err.bridgeSource;
  if (!loc || !source) return "<no source location>";
  const line = source.split("\n")[loc.startLine - 1] ?? "";
  return loc.endLine === loc.startLine
    ? line.slice(loc.startColumn - 1, loc.endColumn)
    : line.slice(loc.startColumn - 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool error location
//
// When a tool throws, the resulting BridgeRuntimeError must carry `bridgeLoc`
// pointing at the closest wire that pulls FROM the errored tool — so the error
// can be displayed with source context.
//
// Uses test.multitool with `_error` in input to trigger failures.
// ══════════════════════════════════════════════════════════════════════════════

// ── Non-timeout tests ───────────────────────────────────────────────────────

regressionTest("tool error location", {
  bridge: bridge`
    version 1.5

    bridge Query.basicError {
      with test.multitool as api
      with input as i
      with output as o

      api <- i
      o.result <- api
    }

    bridge Query.outputWire {
      with test.multitool as api
      with input as i
      with output as o

      api <- i
      o.result <- api.body
    }

    bridge Query.chainError {
      with test.multitool as api
      with test.multitool as e
      with input as i
      with output as o

      api <- i
      e <- api
      o.result <- e
    }

    tool apiDef from test.multitool {
      ._error = "Failed to fetch"
    }

    bridge Query.toolDefError {
      with apiDef
      with input as i
      with output as o

      apiDef.path <- i.path
      o.result <- apiDef.body
    }

    bridge Query.syncError {
      with test.sync.multitool as s
      with input as i
      with output as o

      s <- i
      o.result <- s
    }
  `,
  tools,
  scenarios: {
    "Query.basicError": {
      "tool error carries bridgeLoc": {
        input: { _error: "Failed to fetch" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
          assert.match(err.message, /Failed to fetch/);
        },
        // Error scenarios: the tool always throws so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
    "Query.outputWire": {
      "tool error points at the output wire that pulls from it": {
        input: { _error: "Failed to fetch" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
          // The caret underlines the `api.body` source reference in `o.result <- api.body`
          assert.equal(locatedSegment(err), "api.body");
        },
        // Error scenarios: the tool always throws so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
    "Query.chainError": {
      "tool error in chain points at the closest pulling wire": {
        input: { _error: "Failed to fetch" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
          // The caret underlines `api` in `e <- api`, not `e` in `o.result <- e`
          assert.equal(locatedSegment(err), "api");
        },
        // Error scenarios: the tool always throws so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
    "Query.toolDefError": {
      "ToolDef-backed tool error carries bridgeLoc": {
        input: { path: "/data" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(
            err.bridgeLoc,
            "Expected bridgeLoc on ToolDef-backed tool error",
          );
          assert.match(err.message, /Failed to fetch/);
        },
        // Error scenarios: the ToolDef always injects _error so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
    "Query.syncError": {
      "sync tool error carries bridgeLoc": {
        input: { _error: "Sync tool failed" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(err.bridgeLoc, "Expected bridgeLoc on sync tool error");
          assert.match(err.message, /Sync tool failed/);
        },
        // Error scenarios: the tool always throws so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});

// ── Timeout tests ───────────────────────────────────────────────────────────

regressionTest("timeout error location", {
  toolTimeoutMs: 200,
  bridge: bridge`
    version 1.5

    bridge Query.timeout {
      with test.async.multitool as api
      with input as i
      with output as o

      api <- i
      o.result <- api.body
    }

    tool apiDef from test.async.multitool {
      ._delay = 500
    }

    bridge Query.timeoutToolDef {
      with apiDef
      with input as i
      with output as o

      apiDef.path <- i.path
      o.result <- apiDef.body
    }
  `,
  tools,
  scenarios: {
    "Query.timeout": {
      "timeout error carries bridgeLoc of the pulling wire": {
        input: { _delay: 500 },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(err.bridgeLoc, "Expected bridgeLoc on timeout error");
          assert.match(err.message, /timed out/);
        },
        // Error scenarios: the tool always times out so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
    "Query.timeoutToolDef": {
      "ToolDef timeout error carries bridgeLoc": {
        input: { path: "/data" },
        assertError: (err: any) => {
          assert.ok(err instanceof BridgeRuntimeError);
          assert.ok(
            err.bridgeLoc,
            "Expected bridgeLoc on ToolDef timeout error",
          );
          assert.match(err.message, /timed out/);
        },
        // Error scenarios: the ToolDef always injects _delay so no traces are guaranteed
        assertTraces: (t) => assert.ok(t.length >= 0),
      },
    },
  },
});
