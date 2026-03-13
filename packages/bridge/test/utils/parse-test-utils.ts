import assert from "node:assert/strict";

export function omitLoc(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => omitLoc(entry));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        key === "loc" ||
        key.endsWith("Loc") ||
        key === "source" ||
        key === "filename"
      ) {
        continue;
      }
      result[key] = omitLoc(entry);
    }
    return result;
  }

  return value;
}

export function assertDeepStrictEqualIgnoringLoc(
  actual: unknown,
  expected: unknown,
  message?: string,
): void {
  assert.deepStrictEqual(omitLoc(actual), omitLoc(expected), message);
}
