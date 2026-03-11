/**
 * Data-driven regression test harness.
 *
 * Runs every scenario against both the runtime interpreter and the AOT
 * compiler, with built-in log/trace capture and parse→serialise→parse
 * round-trip validation.
 *
 * @module
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  parseBridgeFormat as parseBridge,
  serializeBridge,
  type BridgeDocument,
} from "../../src/index.ts";
import { executeBridge as executeRuntime } from "@stackables/bridge-core";
import { executeBridge as executeCompiled } from "@stackables/bridge-compiler";
import type { ToolTrace } from "@stackables/bridge-core";
import {
  buildTraversalManifest,
  decodeExecutionTrace,
} from "@stackables/bridge-core";
import type { Bridge } from "@stackables/bridge-core";
import { omitLoc } from "./parse-test-utils.ts";

// ── Round-trip normalisation ────────────────────────────────────────────────

/** Strip locations and sort wire arrays so order differences don't fail. */
function normalizeDoc(doc: unknown): unknown {
  const stripped = omitLoc(doc) as any;
  for (const instr of stripped?.instructions ?? []) {
    if (Array.isArray(instr.wires)) {
      instr.wires.sort((a: any, b: any) =>
        JSON.stringify(a) < JSON.stringify(b) ? -1 : 1,
      );
    }
  }
  return stripped;
}

// ── Log capture ─────────────────────────────────────────────────────────────

export type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  args: any[];
};

function createCapturingLogger() {
  const logs: LogEntry[] = [];
  return {
    logs,
    logger: {
      debug: (...args: any[]) => logs.push({ level: "debug", args }),
      info: (...args: any[]) => logs.push({ level: "info", args }),
      warn: (...args: any[]) => logs.push({ level: "warn", args }),
      error: (...args: any[]) => logs.push({ level: "error", args }),
    },
  };
}

// ── Types ───────────────────────────────────────────────────────────────────

export type Scenario = {
  input: Record<string, any>;
  fields?: string[];
  tools?: Record<string, any>;
  context?: Record<string, any>;
  /**
   * Allow the compiled engine to downgrade (fall back) to the runtime
   * interpreter for this scenario.
   *
   * - When **not set** (default): if the compiler downgrades, the test
   *   fails — the compiler should handle this bridge.
   * - When **set to `true`**: the test verifies that the downgrade
   *   actually happened (by checking for the warning log).
   */
  allowDowngrade?: boolean;
  assertData?: (data: any) => void;
  assertError?: (error: any) => void;
  assertLogs?: (logs: LogEntry[]) => void;
  assertTraces?: (traces: ToolTrace[]) => void;
};

export type RegressionTest = {
  bridge: string;
  tools?: Record<string, any>;
  context?: Record<string, any>;
  scenarios: Record<string, Record<string, Scenario>>;
  /** When true, error traversal entries must also be covered by scenarios. */
  requireErrorCoverage?: boolean;
};

// ── Engine registry ─────────────────────────────────────────────────────────

const engines = [
  { name: "runtime", execute: executeRuntime },
  { name: "compiled", execute: executeCompiled },
] as const;

// ── Harness ─────────────────────────────────────────────────────────────────

export function regressionTest(name: string, data: RegressionTest) {
  describe(name, () => {
    let document: BridgeDocument;

    // Per-operation accumulated runtime trace bitmasks for coverage check
    const traceMasks = new Map<string, bigint>();

    test("parse → serialise → parse", () => {
      document = parseBridge(data.bridge);
      const serialised = serializeBridge(JSON.parse(JSON.stringify(document)));
      const parsed = parseBridge(serialised);

      assert.deepStrictEqual(
        normalizeDoc(document),
        normalizeDoc(parsed),
        "Document should be unchanged after serialise→parse round trip",
      );
    });

    for (const [operation, scenarios] of Object.entries(data.scenarios)) {
      describe(operation, () => {
        for (const [scenarioName, scenario] of Object.entries(scenarios)) {
          describe(scenarioName, () => {
            const tools = { ...data.tools, ...scenario.tools };
            const context = { ...data.context, ...scenario.context };

            for (const { name: engineName, execute } of engines) {
              test(engineName, async (t) => {
                const { logs, logger } = createCapturingLogger();
                const needsTraces = !!scenario.assertTraces;

                const executeOpts = {
                  document,
                  operation,
                  input: scenario.input,
                  tools,
                  context,
                  signal: t.signal,
                  toolTimeoutMs: 5_000,
                  requestedFields: scenario.fields,
                  logger,
                  trace: needsTraces ? ("full" as const) : ("off" as const),
                };

                try {
                  const {
                    data: resultData,
                    traces,
                    executionTraceId,
                  } = await execute(executeOpts);

                  if (scenario.assertError) {
                    assert.fail("Expected an error but execution succeeded");
                  }

                  // Accumulate runtime trace coverage
                  if (engineName === "runtime") {
                    traceMasks.set(
                      operation,
                      (traceMasks.get(operation) ?? 0n) | executionTraceId,
                    );
                  }

                  scenario.assertData?.(resultData);
                  scenario.assertTraces?.(traces);
                } catch (e: any) {
                  if (scenario.assertError) {
                    scenario.assertError(e);
                    scenario.assertTraces?.(e.traces ?? []);
                    // Accumulate trace from errors too
                    if (
                      engineName === "runtime" &&
                      e.executionTraceId != null
                    ) {
                      traceMasks.set(
                        operation,
                        (traceMasks.get(operation) ?? 0n) |
                          BigInt(e.executionTraceId),
                      );
                    }
                  } else {
                    throw e;
                  }
                }

                // Compiler downgrade detection (compiled engine only)
                if (engineName === "compiled") {
                  const downgraded = logs.some(
                    (l) =>
                      l.level === "warn" &&
                      l.args.some(
                        (a) =>
                          typeof a === "string" &&
                          a.includes("Falling back to core executeBridge"),
                      ),
                  );
                  if (scenario.allowDowngrade) {
                    assert.ok(
                      downgraded,
                      "Expected compiler to downgrade to runtime but it " +
                        "compiled natively (remove allowDowngrade?)",
                    );
                    t.todo("this scenario needs to be supported in compiler");
                  } else if (downgraded) {
                    assert.fail(
                      "Compiler unexpectedly downgraded to runtime: " +
                        logs
                          .filter((l) => l.level === "warn")
                          .map((l) => l.args.join(" "))
                          .join("; "),
                    );
                  }
                }

                scenario.assertLogs?.(logs);
              });
            }
          });
        }

        // After all scenarios for this operation, verify traversal coverage
        test("traversal coverage", () => {
          const [type, field] = operation.split(".") as [string, string];
          const bridge = document.instructions.find(
            (i): i is Bridge =>
              i.kind === "bridge" && i.type === type && i.field === field,
          );
          assert.ok(bridge, `Bridge ${operation} not found in document`);

          const manifest = buildTraversalManifest(bridge);
          const covered = traceMasks.get(operation) ?? 0n;
          // When requireErrorCoverage is set, all entries (including error
          // paths) must be exercised.  Otherwise only non-error entries are
          // mandatory — error entries represent exceptional paths that need
          // dedicated scenarios.
          const requiredBits = manifest
            .filter((e) => data.requireErrorCoverage || !e.error)
            .reduce((mask, e) => mask | (1n << BigInt(e.bitIndex)), 0n);
          const missed = decodeExecutionTrace(
            manifest,
            requiredBits & ~covered,
          );

          if (missed.length > 0) {
            const lines = missed.map(
              (e) =>
                `  - ${e.id} (${e.kind}${e.description ? `: ${e.description}` : ""})`,
            );
            assert.fail(
              `${missed.length} traversal path(s) not covered by any scenario:\n${lines.join("\n")}`,
            );
          }
        });
      });
    }
  });
}
