import type { CacheStore, ToolCallFn } from "@stackables/bridge-types";
/**
 * Parse TTL (in seconds) from HTTP response headers.
 *
 * Priority: `Cache-Control: s-maxage` > `Cache-Control: max-age` > `Expires`.
 * Returns 0 if the response is uncacheable (no-store, no-cache, or no headers).
 */
declare function parseCacheTTL(response: Response): number;
/**
 * Create an httpCall tool function — the built-in REST API tool.
 *
 * Receives a fully-built input object from the engine and makes an HTTP call.
 * The engine resolves all wires (from tool definition + bridge wires) before calling.
 *
 * Expected input shape:
 *   { baseUrl, method?, path?, headers?, cache?, ...shorthandFields }
 *
 * Routing rules:
 *   - GET: shorthand fields → query string parameters
 *   - POST/PUT/PATCH/DELETE: shorthand fields → JSON body
 *   - `headers` object passed as HTTP headers
 *   - `baseUrl` + `path` concatenated for the URL
 *
 * Cache modes:
 *   - `cache = "auto"` (default) — respect HTTP Cache-Control / Expires headers
 *   - `cache = 0` — disable caching entirely
 *   - `cache = <seconds>` — explicit TTL override, ignores response headers
 *
 * @param fetchFn - Fetch implementation (override for testing)
 * @param cacheStore - Pluggable cache store (default: in-memory LRU, 1024 entries)
 */
export declare function createHttpCall(fetchFn?: typeof fetch, cacheStore?: CacheStore): ToolCallFn;
/** Exported for testing. */
export { parseCacheTTL };
//# sourceMappingURL=http-call.d.ts.map