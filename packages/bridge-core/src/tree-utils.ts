/**
 * Pure utility functions used by the execution engine.
 */

// ── Constant coercion ───────────────────────────────────────────────────────

const constantCache = new Map<string, unknown>();
export function coerceConstant(raw: string | unknown): unknown {
  if (typeof raw !== "string") return raw;
  const cached = constantCache.get(raw);
  if (cached !== undefined) return cached;
  let result: unknown;
  const trimmed = raw.trim();
  if (trimmed === "true") result = true;
  else if (trimmed === "false") result = false;
  else if (trimmed === "null") result = null;
  else if (
    trimmed.length >= 2 &&
    trimmed.charCodeAt(0) === 0x22 /* " */ &&
    trimmed.charCodeAt(trimmed.length - 1) === 0x22 /* " */
  ) {
    // JSON-encoded string — decode escape sequences safely
    result = decodeJsonString(trimmed);
  } else {
    const num = Number(trimmed);
    if (trimmed !== "" && !isNaN(num) && isFinite(num)) result = num;
    else result = raw;
  }
  // Hard cap to prevent unbounded growth over long-lived processes.
  if (constantCache.size > 10_000) constantCache.clear();
  constantCache.set(raw, result);
  return result;
}

/**
 * Decode a JSON-encoded string literal (e.g. `'"hello"'` → `"hello"`).
 * Handles standard JSON escape sequences without using `JSON.parse`.
 */
function decodeJsonString(s: string): string {
  // Strip outer quotes
  const inner = s.slice(1, -1);
  let result = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      // If backslash is the last character, treat it as a literal backslash.
      if (i + 1 >= inner.length) {
        result += "\\";
        break;
      }
      i++;
      const ch = inner[i];
      if (ch === '"') result += '"';
      else if (ch === "\\") result += "\\";
      else if (ch === "/") result += "/";
      else if (ch === "n") result += "\n";
      else if (ch === "r") result += "\r";
      else if (ch === "t") result += "\t";
      else if (ch === "b") result += "\b";
      else if (ch === "f") result += "\f";
      else if (ch === "u") {
        const hex = inner.slice(i + 1, i + 5);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          result += "\\u";
        }
      } else {
        result += "\\" + ch;
      }
    } else {
      result += inner[i];
    }
  }
  return result;
}

// ── Nested property helpers ─────────────────────────────────────────────────

export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Set a value at a nested path, creating intermediate objects/arrays as needed */
export function setNested(obj: any, path: string[], value: any): void {
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe assignment key: ${key}`);
    const nextKey = path[i + 1];
    if (obj[key] == null) {
      obj[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    obj = obj[key];
    if (typeof obj !== "object" || obj === null) {
      throw new Error(
        `Cannot set nested property: value at "${key}" is not an object`,
      );
    }
  }
  if (path.length > 0) {
    const finalKey = path[path.length - 1];
    if (UNSAFE_KEYS.has(finalKey))
      throw new Error(`Unsafe assignment key: ${finalKey}`);
    obj[finalKey] = value;
  }
}

// ── Timing ──────────────────────────────────────────────────────────────────

export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}
