/**
 * @stackables/bridge-types — Shared type definitions for the Bridge ecosystem.
 *
 * These types are used by both bridge-core (engine) and bridge-stdlib (standard
 * library tools). They live in a separate package to break the circular
 * dependency between core and stdlib.
 */

/**
 * Tool context — runtime services available to every tool call.
 *
 * Passed as the second argument to every ToolCallFn.
 */
export type ToolContext = {
  /** Structured logger — same instance configured via `BridgeOptions.logger`.
   *  Defaults to silent no-ops when no logger is configured. */
  logger: {
    debug?: (...args: any[]) => void;
    info?: (...args: any[]) => void;
    warn?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
  };
  /** External abort signal — allows the caller to cancel execution mid-flight.
   *  When aborted, the engine short-circuits before starting new tool calls
   *  and propagates the signal to tool implementations via this context field. */
  signal?: AbortSignal;
};

/**
 * Scalar tool call function — the default signature for registered tools.
 *
 * Receives a fully-built nested input object and an optional `ToolContext`
 * providing access to the engine's logger and other services.
 *
 * Example (httpCall):
 *   input = { baseUrl: "https://...", method: "GET", path: "/geocode",
 *             headers: { apiKey: "..." }, q: "Berlin" }
 */
export type ScalarToolCallFn<
  Input extends Record<string, any> = Record<string, any>,
  Output = any,
> = (input: Input, context?: ToolContext) => Output | Promise<Output>;

/**
 * Batch tool call function — opt-in signature for tools declared with
 * `{ batch: true }` or `{ batch: { ... } }` metadata.
 *
 * The engine passes a plain array of input objects to the tool. The returned
 * array must preserve the same ordering and length.
 */
export type BatchToolCallFn<
  Input extends Record<string, any> = Record<string, any>,
  Output = any,
> = (inputs: Input[], context?: ToolContext) => Output[] | Promise<Output[]>;

/** Backward-compatible alias for the standard scalar tool signature. */
export type ToolCallFn<
  Input extends Record<string, any> = Record<string, any>,
  Output = any,
> = ScalarToolCallFn<Input, Output>;

export interface BatchToolMetadata {
  /** Maximum number of queued calls to flush in a single engine batch. */
  maxBatchSize?: number;
  /** Flush strategy for queued calls. Prototype only supports microtasks. */
  flush?: "microtask";
}

/**
 * Optional metadata that can be attached to any tool function as a `.bridge` property.
 *
 * Used by the engine and observability layer to optimise execution and control telemetry.
 *
 * ```ts
 * myTool.bridge = {
 *   sync: true,
 *   trace: false,
 *   log: { execution: false, errors: "error" },
 * } satisfies ToolMetadata;
 * ```
 */
export interface ToolMetadata {
  // ─── Execution ────────────────────────────────────────────────────────

  /**
   * If true, the tool is a purely synchronous function.
   * The compiler will bypass Promise wrappers and `await` for maximum throughput.
   * Default: false
   */
  sync?: boolean;

  /**
   * If set, the tool is invoked in batch mode and always receives an array of
   * input objects instead of a single input object.
   *
   * The tool must return an array of results with the same ordering and
   * length as the input batch.
   */
  batch?: true | BatchToolMetadata;

  // ─── Observability ────────────────────────────────────────────────────

  /**
   * Should the engine emit OpenTelemetry spans for this tool?
   * Set to false for high-frequency utility functions to prevent trace spam.
   * Default: true
   */
  trace?: boolean;

  /**
   * Granular control over the engine's automatic logging.
   * If set to false, disables ALL logging for this tool.
   */
  log?:
    | boolean
    | {
        /**
         * Log successful invocations (inputs, outputs, latency).
         * Set to false to hide trace spam from loops.
         * Default: true (or your global default log level)
         */
        execution?: boolean | "debug" | "info";

        /**
         * Log exceptions thrown by the tool.
         * Default: true
         */
        errors?: boolean | "warn" | "error";
      };
}

/** Scalar tool function with optional `.bridge` metadata attached. */
export type ScalarToolFn<
  Input extends Record<string, any> = Record<string, any>,
  Output = any,
> = ScalarToolCallFn<Input, Output> & {
  bridge?: ToolMetadata;
};

/** Batch tool function with optional `.bridge` metadata attached. */
export type BatchToolFn<
  Input extends Record<string, any> = Record<string, any>,
  Output = any,
> = BatchToolCallFn<Input, Output> & {
  bridge?: ToolMetadata;
};

/**
 * Recursive tool map — supports namespaced tools via nesting.
 *
 * Example:
 *   { std: { upperCase, lowerCase }, httpCall: createHttpCall(), myCompany: { myTool } }
 *
 * Lookup is dot-separated: "std.str.toUpperCase" → tools.std.str.toUpperCase
 */
export type ToolMap = {
  [key: string]:
    | ToolCallFn
    | BatchToolCallFn
    | ScalarToolFn
    | BatchToolFn
    | ((...args: any[]) => any)
    | ToolMap;
};

/**
 * Pluggable cache store for httpCall.
 *
 * Default: in-memory Map with TTL eviction.
 * Override: pass any key-value store (Redis, Memcached, etc.) to `createHttpCall`.
 *
 * ```ts
 * const httpCall = createHttpCall(fetch, myRedisStore);
 * ```
 */
export type CacheStore = {
  get(key: string): Promise<any | undefined> | any | undefined;
  set(key: string, value: any, ttlSeconds: number): Promise<void> | void;
};

export type SourceLocation = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};
