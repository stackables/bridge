import type { ToolCallFn } from "./types.js";

/**
 * Create an httpCall tool function — the built-in REST API tool.
 *
 * Receives a fully-built input object from the engine and makes an HTTP call.
 * The engine resolves all wires (from tool definition + bridge wires) before calling.
 *
 * Expected input shape:
 *   { baseUrl, method?, path?, headers?, ...shorthandFields }
 *
 * Routing rules:
 *   - GET: shorthand fields → query string parameters
 *   - POST/PUT/PATCH/DELETE: shorthand fields → JSON body
 *   - `headers` object passed as HTTP headers
 *   - `baseUrl` + `path` concatenated for the URL
 *
 * @param fetchFn - Fetch implementation (override for testing)
 */
export function createHttpCall(
  fetchFn: typeof fetch = globalThis.fetch,
): ToolCallFn {
  return async (input) => {
    const {
      baseUrl = "",
      method = "GET",
      path = "",
      headers: inputHeaders = {},
      ...rest
    } = input;

    // Build URL
    const url = new URL(baseUrl + path);

    // Collect headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(inputHeaders)) {
      if (value != null) headers[key] = String(value);
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
    let body: string | undefined;
    if (method !== "GET") {
      const bodyObj: Record<string, any> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (value != null) bodyObj[key] = value;
      }
      if (Object.keys(bodyObj).length > 0) {
        body = JSON.stringify(bodyObj);
        headers["Content-Type"] ??= "application/json";
      }
    }

    const response = await fetchFn(url.toString(), {
      method,
      headers,
      body,
    });

    return response.json() as Promise<Record<string, any>>;
  };
}
