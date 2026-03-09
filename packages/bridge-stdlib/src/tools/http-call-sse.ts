import type { StreamToolCallFn, ToolMetadata } from "@stackables/bridge-types";

/**
 * Create an SSE (Server-Sent Events) HTTP tool — a stream tool that makes
 * an HTTP request and yields each SSE `data:` frame as a parsed JSON object.
 *
 * Designed for APIs that return `text/event-stream` responses (e.g. OpenAI,
 * Deepseek, Anthropic streaming completions).
 *
 * Input shape matches `httpCall`:
 *   { baseUrl, method?, path?, headers?, ...shorthandFields }
 *
 * Routing rules (same as httpCall):
 *   - GET: shorthand fields → query string parameters
 *   - POST/PUT/PATCH/DELETE: shorthand fields → JSON body
 *   - `headers` object passed as HTTP headers
 *   - `baseUrl` + `path` concatenated for the URL
 *
 * Each yielded value is the parsed JSON from one `data:` line.
 * Lines with `data: [DONE]` terminate the stream.
 *
 * @param fetchFn - Fetch implementation (override for testing)
 */
export function createHttpCallSSE(
  fetchFn: typeof fetch = globalThis.fetch,
): StreamToolCallFn & { bridge: ToolMetadata } {
  async function* httpCallSSE(
    input: Record<string, any>,
  ): AsyncGenerator<unknown, void, undefined> {
    const {
      baseUrl = "",
      method = "POST",
      path = "",
      headers: inputHeaders = {},
      cache: _cache,
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

    const response = await fetchFn(url.toString(), { method, headers, body });

    if (!response.ok) {
      throw new Error(
        `httpCallSSE: HTTP ${response.status} ${response.statusText}`,
      );
    }

    if (!response.body) {
      throw new Error("httpCallSSE: response has no readable body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines (\n\n)
        const segments = buffer.split("\n\n");
        // Keep the last (possibly incomplete) segment in the buffer
        buffer = segments.pop()!;

        for (const segment of segments) {
          if (!segment.trim()) continue;

          for (const line of segment.split("\n")) {
            if (!line.startsWith("data:")) continue;

            const data = line.slice(5).trimStart();
            if (data === "[DONE]") return;

            try {
              yield JSON.parse(data);
            } catch {
              // Non-JSON data line — skip
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  httpCallSSE.bridge = { stream: true } as const;
  return httpCallSSE;
}
