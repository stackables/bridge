import { LRUCache } from "lru-cache";
/** Default in-memory LRU cache with per-entry TTL. */
function createMemoryCache(maxEntries = 1024) {
    const lru = new LRUCache({ max: maxEntries });
    return {
        get(key) {
            return lru.get(key);
        },
        set(key, value, ttlSeconds) {
            if (ttlSeconds <= 0)
                return;
            lru.set(key, value, { ttl: ttlSeconds * 1000 });
        },
    };
}
/**
 * Parse TTL (in seconds) from HTTP response headers.
 *
 * Priority: `Cache-Control: s-maxage` > `Cache-Control: max-age` > `Expires`.
 * Returns 0 if the response is uncacheable (no-store, no-cache, or no headers).
 */
function parseCacheTTL(response) {
    const cc = response.headers.get("cache-control");
    if (cc) {
        if (/\bno-store\b/i.test(cc) || /\bno-cache\b/i.test(cc))
            return 0;
        const sMax = cc.match(/\bs-maxage\s*=\s*(\d+)\b/i);
        if (sMax)
            return Number(sMax[1]);
        const max = cc.match(/\bmax-age\s*=\s*(\d+)\b/i);
        if (max)
            return Number(max[1]);
    }
    const expires = response.headers.get("expires");
    if (expires) {
        const delta = Math.floor((new Date(expires).getTime() - Date.now()) / 1000);
        return delta > 0 ? delta : 0;
    }
    return 0;
}
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
export function createHttpCall(fetchFn = globalThis.fetch, cacheStore = createMemoryCache()) {
    return async (input) => {
        const { baseUrl = "", method = "GET", path = "", headers: inputHeaders = {}, cache: cacheMode = "auto", ...rest } = input;
        // Build URL
        const url = new URL(baseUrl + path);
        // Collect headers
        const headers = {};
        for (const [key, value] of Object.entries(inputHeaders)) {
            if (value != null)
                headers[key] = String(value);
        }
        // GET: shorthand fields → query string
        if (method === "GET") {
            for (const [key, value] of Object.entries(rest)) {
                if (value != null) {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        // Non-GET: shorthand fields → JSON body
        let body;
        if (method !== "GET") {
            const bodyObj = {};
            for (const [key, value] of Object.entries(rest)) {
                if (value != null)
                    bodyObj[key] = value;
            }
            if (Object.keys(bodyObj).length > 0) {
                body = JSON.stringify(bodyObj);
                headers["Content-Type"] ??= "application/json";
            }
        }
        // cache = 0 → no caching at all
        const mode = String(cacheMode);
        if (mode === "0") {
            const response = await fetchFn(url.toString(), { method, headers, body });
            return response.json();
        }
        const cacheKey = method + " " + url.toString() + (body ?? "");
        // Check cache before fetching
        const cached = await cacheStore.get(cacheKey);
        if (cached !== undefined)
            return cached;
        const response = await fetchFn(url.toString(), { method, headers, body });
        const data = (await response.json());
        // Determine TTL
        const ttl = mode === "auto" ? parseCacheTTL(response) : Number(mode);
        if (ttl > 0) {
            await cacheStore.set(cacheKey, data, ttl);
        }
        return data;
    };
}
/** Exported for testing. */
export { parseCacheTTL };
