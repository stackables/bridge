/**
 * Client-side helpers for the share API.
 *
 * Both the local Vite dev server (via @cloudflare/vite-plugin + Miniflare) and
 * the deployed Cloudflare Worker serve the /api/share endpoints.
 */

export type PlaygroundMode = "graphql" | "standalone";

export interface SharePayload {
  mode?: PlaygroundMode;
  schema: string;
  bridge: string;
  queries: { name: string; query: string }[];
  context: string;
  /** Standalone-mode per-query state (parallel array to queries). */
  standaloneQueries?: {
    operation: string;
    outputFields: string;
    inputJson: string;
  }[];
}

export async function saveShare(payload: SharePayload): Promise<string> {
  const resp = await fetch("/api/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }
  const { id } = (await resp.json()) as { id: string };
  return id;
}

export async function loadShare(id: string): Promise<SharePayload> {
  const resp = await fetch(`/api/share?id=${encodeURIComponent(id)}`);
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }
  const raw = (await resp.json()) as Record<string, unknown>;
  // Normalize legacy single-query payloads to the current multi-query format.
  if (!raw.queries && typeof raw.query === "string") {
    return {
      schema: raw.schema as string,
      bridge: raw.bridge as string,
      queries: [{ name: "Query 1", query: raw.query }],
      context: raw.context as string,
    };
  }
  return raw as unknown as SharePayload;
}

/** Build the full share URL for a given ID. */
export function shareUrl(id: string): string {
  const base = window.location.origin + window.location.pathname;
  return `${base}?s=${id}`;
}

/** Read the `?s=` share ID from the current URL, if present. */
export function getShareIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("s");
}

/** Remove the `?s=` param from the URL bar without triggering a page reload. */
export function clearShareIdFromUrl(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("s");
  window.history.replaceState(null, "", url.toString());
}
