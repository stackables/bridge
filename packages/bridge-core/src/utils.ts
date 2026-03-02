/**
 * Shared utilities for the Bridge runtime.
 */

import { BridgeTimeoutError } from "./tree-types.ts";

/**
 * Split a dotted path string into path segments, expanding array indices.
 * e.g. "items[0].name" → ["items", "0", "name"]
 */
export function parsePath(text: string): string[] {
  const parts: string[] = [];
  for (const segment of text.split(".")) {
    const match = segment.match(/^([^[]+)(?:\[(\d*)\])?$/);
    if (match) {
      parts.push(match[1]);
      if (match[2] !== undefined && match[2] !== "") {
        parts.push(match[2]);
      }
    } else {
      parts.push(segment);
    }
  }
  return parts;
}

/** Race a promise against a timeout.  Rejects with BridgeTimeoutError on expiry. */
export function raceTimeout<T>(
  promise: Promise<T>,
  ms: number,
  toolName: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeTimeoutError(toolName, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
