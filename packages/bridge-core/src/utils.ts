/**
 * Shared utilities for the Bridge runtime.
 */

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
