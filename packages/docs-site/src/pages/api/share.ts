/** Payload stored per share */
export interface SharePayload {
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

/** 90-day TTL — shares are not permanent but long-lived enough to be useful */
const TTL_SECONDS = 60 * 60 * 24 * 90;

export const prerender = false;

export async function POST(context: any) {
  const env = context.locals.runtime.env as Env;
  const request = context.request as Request;

  let body: SharePayload;
  try {
    body = (await request.json()) as SharePayload;
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: JSON_HEADERS,
    });
  }

  // Basic validation — accept both legacy single-query and new multi-query formats
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
  await env.SHARES.put(id, JSON.stringify(body), {
    expirationTtl: TTL_SECONDS,
  });

  return new Response(JSON.stringify({ id }), { headers: JSON_HEADERS });
}

export async function GET(context: any) {
  const env = context.locals.runtime.env as Env;
  const request = context.request as Request;

  const url = new URL(request.url);
  const id = url.searchParams.get('id')

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
