/**
 * Client-side helpers for the share API.
 *
 * Both the local Vite dev server (via @cloudflare/vite-plugin + Miniflare) and
 * the deployed Cloudflare Worker serve the /api/share endpoints.
 */

export interface SharePayload {
  schema: string;
  bridge: string;
  query: string;
  context: string;
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
  const resp = await fetch(`/api/share/${encodeURIComponent(id)}`);
  if (!resp.ok) {
    const err = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<SharePayload>;
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
