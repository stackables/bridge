import { ExecutionTree, TraceCollector } from "./ExecutionTree.ts";
import { internal } from "./tools/index.ts";
import type { Logger, ToolTrace, TraceLevel } from "./ExecutionTree.ts";
import type { Instruction, ToolMap } from "./types.ts";
import { SELF_MODULE } from "./types.ts";

export type ExecuteBridgeOptions = {
  /** Parsed bridge instructions (from `parseBridgeDiagnostics`). */
  instructions: Instruction[];
  /**
   * Which bridge to execute, as `"Type.field"`.
   * Mirrors the `bridge Type.field { ... }` declaration.
   * Example: `"Query.searchTrains"` or `"Mutation.sendEmail"`.
   */
  operation: string;
  /** Input arguments — equivalent to GraphQL field arguments. */
  input?: Record<string, unknown>;
  /** Additional tools to merge with the built-in `std` namespace. */
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
 * import { parseBridgeDiagnostics, executeBridge } from "@stackables/bridge";
 * import { readFileSync } from "node:fs";
 *
 * const { instructions } = parseBridgeDiagnostics(readFileSync("my.bridge", "utf8"));
 * const { data } = await executeBridge({
 *   instructions,
 *   operation: "Query.myField",
 *   input: { city: "Berlin" },
 * });
 * console.log(data);
 * ```
 */
export async function executeBridge<T = unknown>(
  options: ExecuteBridgeOptions,
): Promise<ExecuteBridgeResult<T>> {
  const { instructions, operation, input = {}, context = {} } = options;

  const parts = operation.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid operation "${operation}" — expected "Type.field" (e.g. "Query.myField")`,
    );
  }

  const [type, field] = parts as [string, string];
  const trunk = { module: SELF_MODULE, type, field };

  const tree = new ExecutionTree(
    trunk,
    instructions,
    { internal, ...(options.tools ?? {}) },
    context,
  );

  if (options.logger) tree.logger = options.logger;
  if (options.signal) tree.signal = options.signal;

  const traceLevel = options.trace ?? "off";
  if (traceLevel !== "off") {
    tree.tracer = new TraceCollector(traceLevel);
  }

  const data = await tree.run(input);

  return { data: data as T, traces: tree.getTraces() };
}
