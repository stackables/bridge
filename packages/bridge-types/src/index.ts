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
 * Tool call function — the signature for registered tool functions.
 *
 * Receives a fully-built nested input object and an optional `ToolContext`
 * providing access to the engine's logger and other services.
 *
 * Example (httpCall):
 *   input = { baseUrl: "https://...", method: "GET", path: "/geocode",
 *             headers: { apiKey: "..." }, q: "Berlin" }
 */
export type ToolCallFn = (
  input: Record<string, any>,
  context?: ToolContext,
) => Promise<Record<string, any>>;

/**
 * Recursive tool map — supports namespaced tools via nesting.
 *
 * Example:
 *   { std: { upperCase, lowerCase }, httpCall: createHttpCall(), myCompany: { myTool } }
 *
 * Lookup is dot-separated: "std.str.toUpperCase" → tools.std.str.toUpperCase
 */
export type ToolMap = {
  [key: string]: ToolCallFn | ((...args: any[]) => any) | ToolMap;
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
