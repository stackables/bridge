/**
 * Sparse Fieldsets — filter output fields based on a dot-separated pattern list.
 *
 * Patterns use dot-separated paths with a `*` wildcard that matches
 * any single segment at the end.  Examples:
 *
 *   `["id", "price", "legs.*"]`
 *
 * `"id"` matches the top-level `id` field.
 * `"legs.*"` matches any immediate child of `legs` (e.g. `legs.duration`).
 *
 * If `requestedFields` is `undefined` or empty, all fields are included.
 */

/**
 * Returns `true` when the given output field path is matched by at least
 * one pattern in `requestedFields`.
 *
 * A field is included when:
 *   - `requestedFields` is undefined/empty (no filter — include everything)
 *   - An exact pattern matches the field name (e.g. `"id"` matches `"id"`)
 *   - A parent pattern matches (e.g. `"legs"` matches `"legs"` and `"legs.duration"`)
 *   - A wildcard pattern matches (e.g. `"legs.*"` matches `"legs.duration"`)
 *   - The field is an ancestor of a requested deeper path
 *     (e.g. `"legs.duration"` means `"legs"` must be included)
 */
export function matchesRequestedFields(
  fieldPath: string,
  requestedFields: string[] | undefined,
): boolean {
  if (!requestedFields || requestedFields.length === 0) return true;

  for (const pattern of requestedFields) {
    // Exact match
    if (pattern === fieldPath) return true;

    // Pattern is a parent prefix of the field (e.g. pattern "legs" matches "legs.x")
    if (fieldPath.startsWith(pattern + ".")) return true;

    // Field is a parent prefix of the pattern (e.g. field "legs" is needed for pattern "legs.x")
    if (pattern.startsWith(fieldPath + ".")) return true;

    // Wildcard: "legs.*" matches "legs.duration" (one segment after the prefix)
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2); // strip ".*"
      if (fieldPath.startsWith(prefix + ".")) {
        // Ensure it's exactly one segment after the prefix
        const rest = fieldPath.slice(prefix.length + 1);
        if (!rest.includes(".")) return true;
      }
      // Also: field "legs" is an ancestor needed for "legs.*"
      if (fieldPath === prefix) return true;
    }
  }

  return false;
}

/**
 * Filter a set of top-level output field names against `requestedFields`.
 * Returns the filtered set.  If `requestedFields` is undefined/empty,
 * returns the original set unchanged.
 */
export function filterOutputFields(
  outputFields: Set<string>,
  requestedFields: string[] | undefined,
): Set<string> {
  if (!requestedFields || requestedFields.length === 0) return outputFields;
  const filtered = new Set<string>();
  for (const name of outputFields) {
    if (matchesRequestedFields(name, requestedFields)) {
      filtered.add(name);
    }
  }
  return filtered;
}
