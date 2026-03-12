import assert from "node:assert/strict";
import { test } from "node:test";
import { BridgeAbortError, BridgePanicError } from "../src/index.ts";
import { regressionTest } from "./utils/regression.ts";
import { tools } from "./utils/bridge-tools.ts";
import { forEachEngine } from "./utils/dual-run.ts";

// ═══════════════════════════════════════════════════════════════════════════
// throw control flow
//
//   • throw on || gate fires when value is falsy
//   • throw on ?? gate fires when value is nullish
//   • throw on catch gate fires when source tool throws
//   • throw does NOT fire when conditions are not met
//
// All scenarios use test.multitool as passthrough tool (output = input).
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("throw control flow", {
  bridge: `
    version 1.5

    bridge Throw.test {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o.falsyThrow <- i.name || throw "name is required"
      o.nullishThrow <- i.name ?? throw "name cannot be null"
      o.catchThrow <- a.name catch throw "api call failed"
    }
  `,
  tools,
  scenarios: {
    "Throw.test": {
      "all values present → no throw": {
        input: { name: "Alice", a: { name: "from-api" } },
        assertData: {
          falsyThrow: "Alice",
          nullishThrow: "Alice",
          catchThrow: "from-api",
        },
        assertTraces: 1,
      },
      "falsy name → || throw fires, others succeed": {
        input: { name: "", a: { name: "ok" } },
        assertError: /name is required/,
        assertTraces: 1,
        assertGraphql: {
          falsyThrow: /name is required/i,
          nullishThrow: "",
          catchThrow: "ok",
        },
      },
      "null name → || and ?? both throw, catch succeeds": {
        input: { a: { name: "ok" } },
        assertError: /name is required|name cannot be null/,
        assertTraces: 1,
        assertGraphql: {
          falsyThrow: /name is required/i,
          nullishThrow: /name cannot be null/i,
          catchThrow: "ok",
        },
      },
      "tool throws → all three throw": {
        input: { a: { _error: "network error" } },
        assertError: /name is required|name cannot be null|api call failed/,
        assertTraces: 1,
        assertGraphql: {
          falsyThrow: /name is required/i,
          nullishThrow: /name cannot be null/i,
          catchThrow: /api call failed/i,
        },
      },
      "tool succeeds → catch throw does NOT fire": {
        input: { name: "x", a: { name: "from-api" } },
        assertData: {
          falsyThrow: "x",
          nullishThrow: "x",
          catchThrow: "from-api",
        },
        assertTraces: 1,
      },
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// panic control flow
//
//   • panic raises BridgePanicError (not a normal runtime error)
//   • panic bypasses catch gate (catch does NOT swallow panic)
//   • panic bypasses safe navigation (?.)
//
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("panic control flow", {
  bridge: `
    version 1.5

    bridge Panic.test {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o.basic <- i.name ?? panic "fatal error"
      o.catchBypass <- a.name ?? panic "fatal" catch "fallback"
      o.safeBypass <- a?.name ?? panic "must not be null"
    }
  `,
  tools,
  scenarios: {
    "Panic.test": {
      "all values present → no panic": {
        input: { name: "Alice", a: { name: "ok" } },
        allowDowngrade: true,
        assertData: { basic: "Alice", catchBypass: "ok", safeBypass: "ok" },
        assertTraces: 1,
      },
      "null name → basic panics, tool fields succeed": {
        input: { a: { name: "ok" } },
        allowDowngrade: true,
        assertError: (err: any) => {
          assert.ok(err instanceof BridgePanicError);
          assert.equal(err.message, "fatal error");
        },
        assertTraces: 1,
        assertGraphql: {
          basic: /fatal error/i,
          catchBypass: "ok",
          safeBypass: "ok",
        },
      },
      "null tool name → catch/safe panic, catch does not swallow": {
        input: { name: "present", a: { name: null } },
        allowDowngrade: true,
        assertError: (err: any) => {
          assert.ok(err instanceof BridgePanicError);
        },
        assertTraces: 1,
        assertGraphql: {
          basic: "present",
          catchBypass: /fatal/i,
          safeBypass: /must not be null/i,
        },
      },
      "tool error → catch fallback works, safe panics": {
        input: { name: "present", a: { _error: "HTTP 500" } },
        allowDowngrade: true,
        assertError: (err: any) => {
          assert.ok(err instanceof BridgePanicError);
        },
        assertTraces: 1,
        assertGraphql: {
          basic: "present",
          catchBypass: "fallback",
          safeBypass: /must not be null/i,
        },
      },
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// continue and break in arrays
//
//   • ?? continue skips null elements in array mapping
//   • ?? break halts array processing at null element
//   • ?? continue on root array wire returns [] when source is null
//   • catch continue on root array wire returns [] when source throws
//   • continue 2 skips current parent element
//   • break 2 breaks out of parent loop
//
// ═══════════════════════════════════════════════════════════════════════════

regressionTest("continue and break in arrays", {
  bridge: `
    version 1.5

    bridge ContinueSkip.items {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o <- a.items[] as item {
        .name <- item.name ?? continue
      }
    }

    bridge BreakHalt.items {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o <- a.items[] as item {
        .name <- item.name ?? break
      }
    }

    bridge RootNullContinue.items {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o <- a.items[] as item {
        .name <- item.name
      } ?? continue
    }

    bridge RootCatchContinue.items {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o <- a.items[] as item {
        .name <- item.name
      } catch continue
    }

    bridge Continue2.items {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o <- a.orders[] as order {
        .id <- order.id
        .items <- order.items[] as item {
          .sku <- item.sku ?? continue 2
          .price <- item.price
        }
      }
    }

    bridge Break2.items {
      with test.multitool as a
      with input as i
      with output as o

      a <- i.a

      o <- a.orders[] as order {
        .id <- order.id
        .items <- order.items[] as item {
          .sku <- item.sku
          .price <- item.price ?? break 2
        }
      }
    }
  `,
  tools,
  scenarios: {
    "ContinueSkip.items": {
      "continue skips null elements": {
        input: {
          a: {
            items: [
              { name: "Alice" },
              { name: null },
              { name: "Bob" },
              { name: null },
            ],
          },
        },
        assertData: [{ name: "Alice" }, { name: "Bob" }],
        assertTraces: 1,
      },
      "all elements present → nothing skipped": {
        input: {
          a: { items: [{ name: "Alice" }, { name: "Bob" }] },
        },
        assertData: [{ name: "Alice" }, { name: "Bob" }],
        assertTraces: 1,
      },
      "empty array → empty output": {
        input: { a: { items: [] } },
        assertData: [],
        assertTraces: 1,
      },
    },
    "BreakHalt.items": {
      "break halts at null element": {
        input: {
          a: {
            items: [
              { name: "Alice" },
              { name: "Bob" },
              { name: null },
              { name: "Carol" },
            ],
          },
        },
        assertData: [{ name: "Alice" }, { name: "Bob" }],
        assertTraces: 1,
      },
      "all elements present → nothing halted": {
        input: {
          a: { items: [{ name: "Alice" }, { name: "Bob" }] },
        },
        assertData: [{ name: "Alice" }, { name: "Bob" }],
        assertTraces: 1,
      },
      "empty array → empty output": {
        input: { a: { items: [] } },
        assertData: [],
        assertTraces: 1,
      },
    },
    "RootNullContinue.items": {
      "items present → normal iteration": {
        input: { a: { items: [{ name: "Alice" }] } },
        assertData: [{ name: "Alice" }],
        assertTraces: 1,
      },
      "items null → ?? continue returns []": {
        input: { a: { items: null } },
        assertData: [],
        assertTraces: 1,
      },
    },
    "RootCatchContinue.items": {
      "tool succeeds → normal iteration": {
        input: { a: { items: [{ name: "Alice" }] } },
        assertData: [{ name: "Alice" }],
        assertTraces: 1,
      },
      "tool throws → catch continue returns []": {
        input: { a: { _error: "service unavailable" } },
        assertData: [],
        assertTraces: 1,
      },
    },
    "Continue2.items": {
      "continue 2 skips parent element when inner item has null sku": {
        input: {
          a: {
            orders: [
              {
                id: 1,
                items: [
                  { sku: "A", price: 10 },
                  { sku: null, price: 99 },
                ],
              },
              { id: 2, items: [{ sku: "B", price: 20 }] },
            ],
          },
        },
        assertData: [{ id: 2, items: [{ sku: "B", price: 20 }] }],
        assertTraces: 1,
      },
      "all inner skus present → nothing skipped": {
        input: {
          a: {
            orders: [
              { id: 1, items: [{ sku: "A", price: 10 }] },
              { id: 2, items: [{ sku: "B", price: 20 }] },
            ],
          },
        },
        assertData: [
          { id: 1, items: [{ sku: "A", price: 10 }] },
          { id: 2, items: [{ sku: "B", price: 20 }] },
        ],
        assertTraces: 1,
      },
      "empty orders → empty output": {
        input: { a: { orders: [] } },
        assertData: [],
        assertTraces: 1,
      },
      "order with empty items → inner empty": {
        input: { a: { orders: [{ id: 1, items: [] }] } },
        assertData: [{ id: 1, items: [] }],
        assertTraces: 1,
      },
    },
    "Break2.items": {
      "break 2 breaks out of parent loop": {
        input: {
          a: {
            orders: [
              { id: 1, items: [{ sku: "A", price: 10 }] },
              {
                id: 2,
                items: [
                  { sku: "B", price: null },
                  { sku: "C", price: 30 },
                ],
              },
              { id: 3, items: [{ sku: "D", price: 40 }] },
            ],
          },
        },
        assertData: [{ id: 1, items: [{ sku: "A", price: 10 }] }],
        assertTraces: 1,
      },
      "all inner prices present → nothing halted": {
        input: {
          a: {
            orders: [
              { id: 1, items: [{ sku: "A", price: 10 }] },
              { id: 2, items: [{ sku: "B", price: 20 }] },
            ],
          },
        },
        assertData: [
          { id: 1, items: [{ sku: "A", price: 10 }] },
          { id: 2, items: [{ sku: "B", price: 20 }] },
        ],
        assertTraces: 1,
      },
      "empty orders → empty output": {
        input: { a: { orders: [] } },
        assertData: [],
        assertTraces: 1,
      },
      "order with empty items → inner empty": {
        input: { a: { orders: [{ id: 1, items: [] }] } },
        assertData: [{ id: 1, items: [] }],
        assertTraces: 1,
      },
    },
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// AbortSignal control flow
//
// These tests require per-scenario AbortSignal configuration which the
// regressionTest framework does not currently support. They use
// forEachEngine to test against both runtime and compiled engines.
//
//   • Aborted signal prevents tool execution (BridgeAbortError)
//   • Abort error bypasses catch gate
//   • Abort error bypasses safe navigation (?.)
//   • Signal is passed to tool context
//
// ═══════════════════════════════════════════════════════════════════════════

forEachEngine("AbortSignal control flow", (run) => {
  test("aborted signal prevents tool execution", async () => {
    const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name
}`;
    const controller = new AbortController();
    controller.abort();
    const abortTools = {
      api: async () => {
        throw new Error("should not be called");
      },
    };
    await assert.rejects(
      () =>
        run(src, "Query.test", {}, abortTools, {
          signal: controller.signal,
        }),
      (err: Error) => {
        assert.ok(err instanceof BridgeAbortError);
        return true;
      },
    );
  });

  test("abort error bypasses catch gate", async () => {
    const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name catch "fallback"
}`;
    const controller = new AbortController();
    controller.abort();
    const abortTools = {
      api: async () => ({ name: "test" }),
    };
    await assert.rejects(
      () =>
        run(src, "Query.test", {}, abortTools, {
          signal: controller.signal,
        }),
      (err: Error) => {
        assert.ok(err instanceof BridgeAbortError);
        return true;
      },
    );
  });

  test("abort error bypasses safe navigation (?.)", async () => {
    const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a?.name
}`;
    const controller = new AbortController();
    controller.abort();
    const abortTools = {
      api: async () => ({ name: "test" }),
    };
    await assert.rejects(
      () =>
        run(src, "Query.test", {}, abortTools, {
          signal: controller.signal,
        }),
      (err: Error) => {
        assert.ok(err instanceof BridgeAbortError);
        return true;
      },
    );
  });

  test("signal is passed to tool context", async () => {
    const src = `version 1.5
bridge Query.test {
  with api as a
  with output as o
  o.name <- a.name
}`;
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const signalTools = {
      api: async (_input: any, ctx: any) => {
        receivedSignal = ctx.signal;
        return { name: "test" };
      },
    };
    await run(src, "Query.test", {}, signalTools, {
      signal: controller.signal,
    });
    assert.ok(receivedSignal);
    assert.equal(receivedSignal, controller.signal);
  });
});
