/**
 * Returns the first element of the array in `opts.in`.
 *
 * By default silently returns `undefined` for empty arrays.
 * Set `opts.strict` to `true` (or the string "true") to throw when
 * the array is empty or contains more than one element.
 */
export function pickFirst(opts: { in: any[]; strict?: boolean | string }) {
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
