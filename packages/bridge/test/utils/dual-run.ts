/**
 * Dual-engine test runner.
 *
 * Provides a `forEachEngine(suiteName, fn)` helper that runs a test
 * suite against **both** the runtime interpreter (`@stackables/bridge-core`)
 * and the AOT compiler (`@stackables/bridge-compiler`).
 *
 * Usage:
 * ```ts
 * import { forEachEngine } from "./utils/dual-run.ts";
 *
 * forEachEngine("my feature", (run, { engine, executeFn }) => {
 *   test("basic case", async () => {
 *     const { data } = await run(`version 1.5 ...`, "Query.test", { q: "hi" }, tools);
 *     assert.equal(data.result, "hello");
 *   });
 * });
 * ```
 *
 * The `run()` helper calls `parseBridge → JSON round-trip → executeBridge()`
 * matching the existing test convention.
 *
 * @module
 */

import { describe } from "node:test";
import { parseBridgeFormat as parseBridge } from "../../src/index.ts";
import { executeBridge as executeRuntime } from "@stackables/bridge-core";
import { executeBridge as executeCompiled } from "@stackables/bridge-compiler";

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecuteFn = typeof executeRuntime;

export type RunFn = (
  bridgeText: string,
  operation: string,
  input: Record<string, unknown>,
  tools?: Record<string, any>,
  extra?: {
    context?: Record<string, unknown>;
    signal?: AbortSignal;
    toolTimeoutMs?: number;
    requestedFields?: string[];
    logger?: {
      info?: (...args: any[]) => void;
      warn?: (...args: any[]) => void;
    };
  },
) => Promise<{ data: any; traces: any[] }>;

export interface EngineContext {
  /** Which engine is being tested: `"runtime"` or `"compiled"` */
  engine: "runtime" | "compiled";
  /** Raw executeBridge function for advanced test cases */
  executeFn: ExecuteFn;
}

// ── Engine registry ─────────────────────────────────────────────────────────

const engines: { name: "runtime" | "compiled"; execute: ExecuteFn }[] = [
  { name: "runtime", execute: executeRuntime as ExecuteFn },
  { name: "compiled", execute: executeCompiled as ExecuteFn },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a test suite against both engines.
 *
 * Wraps the test body in `describe("[runtime] suiteName")` and
 * `describe("[compiled] suiteName")`, providing a `run()` helper
 * that parses bridge text and calls the appropriate `executeBridge`.
 */
export function forEachEngine(
  suiteName: string,
  body: (run: RunFn, ctx: EngineContext) => void,
): void {
  for (const { name, execute } of engines) {
    describe(`[${name}] ${suiteName}`, () => {
      const run: RunFn = (bridgeText, operation, input, tools = {}, extra) => {
        const raw = parseBridge(bridgeText);
        const document = JSON.parse(JSON.stringify(raw)) as ReturnType<
          typeof parseBridge
        >;
        return execute({
          document,
          operation,
          input,
          tools,
          context: extra?.context,
          signal: extra?.signal,
          toolTimeoutMs: extra?.toolTimeoutMs,
          requestedFields: extra?.requestedFields,
          logger: extra?.logger,
        } as any);
      };

      body(run, { engine: name, executeFn: execute as ExecuteFn });
    });
  }
}
