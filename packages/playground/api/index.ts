/**
 * Cloudflare Worker for the Bridge Playground.
 *
 * Handles two API routes backed by KV:
 *   POST /api/share        — save share payload, return { id }
 *   GET  /api/share/:id    — load share payload by ID
 *
 * All other requests fall through to the static assets (SPA).
 *
 * Uses @cloudflare/vite-plugin — both `pnpm dev` (Miniflare) and production
 * serve this Worker. See wrangler.jsonc for KV namespace setup.
 */

export interface Env {
  /** KV namespace bound as SHARES in wrangler.jsonc */
  SHARES: KVNamespace;
}

/** Payload stored per share */
export interface SharePayload {
  schema: string;
  bridge: string;
  query: string;
  context: string;
}

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
};

/** 90-day TTL — shares are not permanent but long-lived enough to be useful */
const TTL_SECONDS = 60 * 60 * 24 * 90;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── POST /api/share ──────────────────────────────────────────────────────
    if (url.pathname === "/api/share" && request.method === "POST") {
      let body: SharePayload;
      try {
        body = (await request.json()) as SharePayload;
      } catch {
        return new Response(JSON.stringify({ error: "invalid JSON" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }

      // Basic validation — all fields must be strings
      if (
        typeof body.schema !== "string" ||
        typeof body.bridge !== "string" ||
        typeof body.query  !== "string" ||
        typeof body.context !== "string"
      ) {
        return new Response(JSON.stringify({ error: "invalid payload" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }

      // Keep payloads reasonably sized (128 KiB total)
      const size = JSON.stringify(body).length;
      if (size > 128 * 1024) {
        return new Response(JSON.stringify({ error: "payload too large" }), {
          status: 413,
          headers: JSON_HEADERS,
        });
      }

      // 12-char alphanumeric ID from a UUID (collision probability negligible)
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      await env.SHARES.put(id, JSON.stringify(body), { expirationTtl: TTL_SECONDS });

      return new Response(JSON.stringify({ id }), { headers: JSON_HEADERS });
    }

    // ── GET /api/share/:id ───────────────────────────────────────────────────
    if (url.pathname.startsWith("/api/share/") && request.method === "GET") {
      const id = url.pathname.slice("/api/share/".length);
      if (!id || id.length > 64) {
        return new Response(JSON.stringify({ error: "invalid id" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }

      const value = await env.SHARES.get(id);
      if (value === null) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: JSON_HEADERS,
        });
      }

      return new Response(value, { headers: JSON_HEADERS });
    }

    // Everything else is handled by the static-assets layer before the Worker
    // is invoked, so reaching here means an unknown API path.
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: JSON_HEADERS,
    });
  },
} satisfies ExportedHandler<Env>;
