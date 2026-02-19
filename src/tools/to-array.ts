/**
 * Wraps a single value in an array.
 *
 * If `opts.in` is already an array it is returned as-is.
 */
export function toArray(opts: { in: any }) {
    return Array.isArray(opts.in) ? opts.in : [opts.in];
}
