/**
 * Custom Cloudflare Worker entrypoint for the docs site.
 *
 * Handles /api/share endpoints (KV-backed) directly, then delegates
 * everything else to Astro's handler for static asset serving.
 *
 * Uses @astrojs/cloudflare v13 custom entrypoint pattern:
 * https://docs.astro.build/en/guides/integrations-guide/cloudflare/
 */
import { handle } from "@astrojs/cloudflare/handler";

interface SharePayload {
  schema: string;
  bridge: string;
  queries: { name: string; query: string }[];
  context: string;
  /** @deprecated Legacy single-query field — kept for backward compat */
  query?: string;
}

const JSON_HEADERS: HeadersInit = {
  "Content-Type": "application/json",
};

/** 90-day TTL */
const TTL_SECONDS = 60 * 60 * 24 * 90;

async function handlePost(request: Request, env: Env): Promise<Response> {
  let body: SharePayload;
  try {
    body = (await request.json()) as SharePayload;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  if (
    typeof body.schema !== "string" ||
    typeof body.bridge !== "string" ||
    typeof body.context !== "string" ||
    (!Array.isArray(body.queries) && typeof body.query !== "string")
  ) {
    return new Response(JSON.stringify({ error: "invalid payload" }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  const size = JSON.stringify(body).length;
  if (size > 128 * 1024) {
    return new Response(JSON.stringify({ error: "payload too large" }), {
      status: 413,
      headers: JSON_HEADERS,
    });
  }

  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  await env.SHARES.put(id, JSON.stringify(body), {
    expirationTtl: TTL_SECONDS,
  });

  return new Response(JSON.stringify({ id }), { headers: JSON_HEADERS });
}

async function handleGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/share") {
      if (request.method === "POST") return handlePost(request, env);
      if (request.method === "GET") return handleGet(request, env);
      return new Response(null, { status: 405 });
    }

    // Delegate all other requests to Astro's handler
    return handle(request, env, ctx);
  },
};
