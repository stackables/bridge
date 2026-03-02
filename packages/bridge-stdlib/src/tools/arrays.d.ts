export declare function filter(opts: {
    in: any[];
    [key: string]: any;
}): any[];
export declare function find(opts: {
    in: any[];
    [key: string]: any;
}): any;
/**
 * Returns the first element of the array in `opts.in`.
 *
 * By default silently returns `undefined` for empty arrays.
 * Set `opts.strict` to `true` (or the string "true") to throw when
 * the array is empty or contains more than one element.
 */
export declare function first(opts: {
    in: any[];
    strict?: boolean | string;
}): any;
/**
 * Wraps a single value in an array.
 *
 * If `opts.in` is already an array it is returned as-is.
 */
export declare function toArray(opts: {
    in: any;
}): any[];
//# sourceMappingURL=arrays.d.ts.map