import { ExecutionTree } from "./ExecutionTree.ts";
import { TraceCollector } from "./tracing.ts";
import type { Logger } from "./tree-types.ts";
import type { ToolTrace, TraceLevel } from "./tracing.ts";
import type { BridgeDocument, ToolMap } from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import {
  std as bundledStd,
  STD_VERSION as BUNDLED_STD_VERSION,
} from "@stackables/bridge-stdlib";
import { resolveStd, checkHandleVersions } from "./version-check.ts";

export type ExecuteBridgeOptions = {
  /** Parsed bridge document (from `parseBridge` or `parseBridgeDiagnostics`). */
  document: BridgeDocument;
  /**
   * Which bridge to execute, as `"Type.field"`.
   * Mirrors the `bridge Type.field { ... }` declaration.
   * Example: `"Query.searchTrains"` or `"Mutation.sendEmail"`.
   */
  operation: string;
  /** Input arguments — equivalent to GraphQL field arguments. */
  input?: Record<string, unknown>;
  /**
   * Tool functions available to the engine.
   *
   * Supports namespaced nesting: `{ myNamespace: { myTool } }`.
   * The built-in `std` namespace is always included; user tools are
   * merged on top (shallow).
   *
   * To provide a specific version of std (e.g. when the bridge file
   * targets an older major), use a versioned namespace key:
   * ```ts
   * tools: { "std@1.5": oldStdNamespace }
   * ```
   */
  tools?: ToolMap;
  /** Context available via `with context as ctx` inside the bridge. */
  context?: Record<string, unknown>;
  /**
   * Enable tool-call tracing.
   * - `"off"` (default) — no collection, zero overhead
   * - `"basic"` — tool, fn, timing, errors; no input/output
   * - `"full"` — everything including input and output
   */
  trace?: TraceLevel;
  /** Structured logger for engine events. */
  logger?: Logger;
  /** External abort signal — cancels execution when triggered. */
  signal?: AbortSignal;
  /**
   * Hard timeout for tool calls in milliseconds.
   * Tools that exceed this duration throw a `BridgeTimeoutError`.
   * Default: 15_000 (15 seconds). Set to `0` to disable.
   */
  toolTimeoutMs?: number;
  /**
   * Maximum shadow-tree nesting depth.
   * Default: 30. Increase for deeply nested array mappings.
   */
  maxDepth?: number;
};

export type ExecuteBridgeResult<T = unknown> = {
  data: T;
  traces: ToolTrace[];
};

/**
 * Execute a bridge operation without GraphQL.
 *
 * Runs a bridge file's data-wiring logic standalone — no schema, no server,
 * no HTTP layer required. Useful for CLI tools, background jobs, tests, and
 * any context where you want Bridge's declarative data-fetching outside of
 * a GraphQL server.
 *
 * @example
 * ```ts
 * import { parseBridge, executeBridge } from "@stackables/bridge";
 * import { readFileSync } from "node:fs";
 *
 * const document = parseBridge(readFileSync("my.bridge", "utf8"));
 * const { data } = await executeBridge({
 *   document,
 *   operation: "Query.myField",
 *   input: { city: "Berlin" },
 * });
 * console.log(data);
 * ```
 */
export async function executeBridge<T = unknown>(
  options: ExecuteBridgeOptions,
): Promise<ExecuteBridgeResult<T>> {
  const { document: doc, operation, input = {}, context = {} } = options;

  const parts = operation.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid operation "${operation}" — expected "Type.field" (e.g. "Query.myField")`,
    );
  }

  const [type, field] = parts as [string, string];
  const trunk = { module: SELF_MODULE, type, field };

  const userTools = options.tools ?? {};

  // Resolve which std to use: bundled, or a versioned namespace from tools
  const { namespace: activeStd, version: activeStdVersion } = resolveStd(
    doc.version,
    bundledStd,
    BUNDLED_STD_VERSION,
    userTools,
  );

  const allTools: ToolMap = { std: activeStd, ...userTools };

  // Verify all @version-tagged handles can be satisfied
  checkHandleVersions(doc.instructions, allTools, activeStdVersion);

  const tree = new ExecutionTree(trunk, doc, allTools, context);

  if (options.logger) tree.logger = options.logger;
  if (options.signal) tree.signal = options.signal;
  if (options.toolTimeoutMs !== undefined && Number.isFinite(options.toolTimeoutMs) && options.toolTimeoutMs >= 0) {
    tree.toolTimeoutMs = Math.floor(options.toolTimeoutMs);
  }
  if (options.maxDepth !== undefined && Number.isFinite(options.maxDepth) && options.maxDepth >= 0) {
    tree.maxDepth = Math.floor(options.maxDepth);
  }

  const traceLevel = options.trace ?? "off";
  if (traceLevel !== "off") {
    tree.tracer = new TraceCollector(traceLevel);
  }

  const data = await tree.run(input);

  return { data: data as T, traces: tree.getTraces() };
}
