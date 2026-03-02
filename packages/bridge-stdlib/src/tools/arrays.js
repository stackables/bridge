export function filter(opts) {
    const { in: arr, ...criteria } = opts;
    return arr.filter((obj) => {
        for (const [key, value] of Object.entries(criteria)) {
            if (obj[key] !== value) {
                return false;
            }
        }
        return true;
    });
}
export function find(opts) {
    const { in: arr, ...criteria } = opts;
    return arr.find((obj) => {
        for (const [key, value] of Object.entries(criteria)) {
            if (obj[key] !== value) {
                return false;
            }
        }
        return true;
    });
}
/**
 * Returns the first element of the array in `opts.in`.
 *
 * By default silently returns `undefined` for empty arrays.
 * Set `opts.strict` to `true` (or the string "true") to throw when
 * the array is empty or contains more than one element.
 */
export function first(opts) {
    const arr = opts.in;
    const strict = opts.strict === true || opts.strict === "true";
    if (strict) {
        if (!Array.isArray(arr) || arr.length === 0) {
            throw new Error("pickFirst: expected a non-empty array");
        }
        if (arr.length > 1) {
            throw new Error(`pickFirst: expected exactly one element but got ${arr.length}`);
        }
    }
    return Array.isArray(arr) ? arr[0] : undefined;
}
/**
 * Wraps a single value in an array.
 *
 * If `opts.in` is already an array it is returned as-is.
 */
export function toArray(opts) {
    return Array.isArray(opts.in) ? opts.in : [opts.in];
}
