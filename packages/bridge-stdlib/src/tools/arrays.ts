import type { ToolMetadata } from "@stackables/bridge-types";

const syncUtility = {
  sync: true,
  trace: false,
} satisfies ToolMetadata;

export function filter(opts: { in: any[]; [key: string]: any }) {
  const { in: arr, ...criteria } = opts;
  if (!Array.isArray(arr)) return undefined;
  return arr.filter((obj) => {
    if (obj == null || typeof obj !== "object") return false;
    for (const [key, value] of Object.entries(criteria)) {
      if (obj[key] !== value) {
        return false;
      }
    }
    return true;
  });
}

filter.bridge = syncUtility;

export function find(opts: { in: any[]; [key: string]: any }) {
  const { in: arr, ...criteria } = opts;
  if (!Array.isArray(arr)) return undefined;
  return arr.find((obj) => {
    if (obj == null || typeof obj !== "object") return false;
    for (const [key, value] of Object.entries(criteria)) {
      if (obj[key] !== value) {
        return false;
      }
    }
    return true;
  });
}

find.bridge = syncUtility;

/**
 * Returns the first element of the array in `opts.in`.
 *
 * By default silently returns `undefined` for empty arrays.
 * Set `opts.strict` to `true` (or the string "true") to throw when
 * the array is empty or contains more than one element.
 */
export function first(opts: { in: any[]; strict?: boolean | string }) {
  const arr = opts.in;
  const strict = opts.strict === true || opts.strict === "true";

  if (strict) {
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error("pickFirst: expected a non-empty array");
    }
    if (arr.length > 1) {
      throw new Error(
        `pickFirst: expected exactly one element but got ${arr.length}`,
      );
    }
  }

  return Array.isArray(arr) ? arr[0] : undefined;
}

first.bridge = syncUtility;

/**
 * Wraps a single value in an array.
 *
 * If `opts.in` is already an array it is returned as-is.
 */
export function toArray(opts: { in: any }) {
  return Array.isArray(opts.in) ? opts.in : [opts.in];
}

toArray.bridge = syncUtility;
