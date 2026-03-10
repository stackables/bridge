/**
 * Tool error location tests.
 *
 * When a tool throws an error (e.g. "Failed to fetch"), the resulting
 * BridgeRuntimeError must carry `bridgeLoc` pointing at the closest
 * wire that pulls FROM the errored tool — so the error can be
 * displayed with source context.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { forEachEngine } from "./utils/dual-run.ts";
import { BridgeRuntimeError } from "@stackables/bridge-core";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A tool that always throws. */
async function failingTool(): Promise<never> {
  throw new Error("Failed to fetch");
}

/** Mark as sync so the engine can use the fast path. */
function failingSyncTool(): never {
  throw new Error("Sync tool failed");
}
(failingSyncTool as any).bridge = { sync: true };

/** A simple pass-through tool. */
async function echo(input: Record<string, any>) {
  return input;
}

/** A tool that takes longer than any reasonable timeout. */
async function slowTool(): Promise<{ ok: true }> {
  await new Promise((r) => setTimeout(r, 5000));
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

forEachEngine("tool error location", (run) => {
  test("tool error carries bridgeLoc of the pulling wire", async () => {
    // When httpCall throws, the error should point at `o.result <- api`
    await assert.rejects(
      () =>
        run(
          `version 1.5
bridge Query.test {
  with httpCall as api
  with input as i
  with output as o

  api.url <- i.url
  o.result <- api
}`,
          "Query.test",
          { url: "https://example.com" },
          { httpCall: failingTool },
        ),
      (err: unknown) => {
        assert.ok(
          err instanceof BridgeRuntimeError,
          `Expected BridgeRuntimeError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`,
        );
        assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
        assert.match(err.message, /Failed to fetch/);
        return true;
      },
    );
  });

  test("tool error points at the output wire that pulls from it", async () => {
    // The error should point at line 8: `o.result <- api.body`
    await assert.rejects(
      () =>
        run(
          `version 1.5
bridge Query.test {
  with httpCall as api
  with input as i
  with output as o

  api.url <- i.url
  o.result <- api.body
}`,
          "Query.test",
          { url: "https://example.com" },
          { httpCall: failingTool },
        ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeRuntimeError);
        assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
        // Line 8 is `o.result <- api.body`
        assert.equal(err.bridgeLoc!.startLine, 8);
        return true;
      },
    );
  });

  test("tool error in chain points at the closest pulling wire", async () => {
    // When httpCall throws, the closest wire pulling from it is
    // `echo <- api` (line 9), not `o.result <- echo` (line 10)
    await assert.rejects(
      () =>
        run(
          `version 1.5
bridge Query.test {
  with httpCall as api
  with echo as e
  with input as i
  with output as o

  api.url <- i.url
  e <- api
  o.result <- e
}`,
          "Query.test",
          { url: "https://example.com" },
          { httpCall: failingTool, echo },
        ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeRuntimeError);
        assert.ok(err.bridgeLoc, "Expected bridgeLoc on tool error");
        // Line 9 is `e <- api` — the closest wire that pulls from the errored tool
        assert.equal(
          err.bridgeLoc!.startLine,
          9,
          `Expected error on line 9 (e <- api), got line ${err.bridgeLoc!.startLine}`,
        );
        return true;
      },
    );
  });

  test("ToolDef-backed tool error carries bridgeLoc", async () => {
    await assert.rejects(
      () =>
        run(
          `version 1.5
tool api from httpCall {
  .baseUrl = "https://example.com"
}

bridge Query.test {
  with api
  with input as i
  with output as o

  api.path <- i.path
  o.result <- api.body
}`,
          "Query.test",
          { path: "/data" },
          { httpCall: failingTool },
        ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeRuntimeError);
        assert.ok(
          err.bridgeLoc,
          "Expected bridgeLoc on ToolDef-backed tool error",
        );
        assert.match(err.message, /Failed to fetch/);
        return true;
      },
    );
  });

  test("sync tool error carries bridgeLoc", async () => {
    await assert.rejects(
      () =>
        run(
          `version 1.5
bridge Query.test {
  with syncTool as s
  with input as i
  with output as o

  s.x <- i.x
  o.result <- s
}`,
          "Query.test",
          { x: 42 },
          { syncTool: failingSyncTool },
        ),
      (err: unknown) => {
        assert.ok(err instanceof BridgeRuntimeError);
        assert.ok(err.bridgeLoc, "Expected bridgeLoc on sync tool error");
        assert.match(err.message, /Sync tool failed/);
        return true;
      },
    );
  });

  test("timeout error carries bridgeLoc of the pulling wire", async () => {
    // BridgeTimeoutError must be wrapped into BridgeRuntimeError with
    // bridgeLoc — it's a tool error like any other.
    await assert.rejects(
      () =>
        run(
          `version 1.5
bridge Query.test {
  with httpCall as api
  with input as i
  with output as o

  api.url <- i.url
  o.result <- api.body
}`,
          "Query.test",
          { url: "https://example.com" },
          { httpCall: slowTool },
          { toolTimeoutMs: 10 },
        ),
      (err: unknown) => {
        assert.ok(
          err instanceof BridgeRuntimeError,
          `Expected BridgeRuntimeError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`,
        );
        assert.ok(err.bridgeLoc, "Expected bridgeLoc on timeout error");
        assert.match(err.message, /timed out/);
        return true;
      },
    );
  });

  test("timeout error from ToolDef-backed tool carries bridgeLoc", async () => {
    await assert.rejects(
      () =>
        run(
          `version 1.5
tool api from httpCall {
  .baseUrl = "https://example.com"
}

bridge Query.test {
  with api
  with input as i
  with output as o

  api.path <- i.path
  o.result <- api.body
}`,
          "Query.test",
          { path: "/data" },
          { httpCall: slowTool },
          { toolTimeoutMs: 10 },
        ),
      (err: unknown) => {
        assert.ok(
          err instanceof BridgeRuntimeError,
          `Expected BridgeRuntimeError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`,
        );
        assert.ok(err.bridgeLoc, "Expected bridgeLoc on ToolDef timeout error");
        assert.match(err.message, /timed out/);
        return true;
      },
    );
  });
});
