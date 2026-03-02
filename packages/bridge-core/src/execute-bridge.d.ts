import type { Logger } from "./tree-types.ts";
import type { ToolTrace, TraceLevel } from "./tracing.ts";
import type { BridgeDocument, ToolMap } from "./types.ts";
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
export declare function executeBridge<T = unknown>(options: ExecuteBridgeOptions): Promise<ExecuteBridgeResult<T>>;
//# sourceMappingURL=execute-bridge.d.ts.map