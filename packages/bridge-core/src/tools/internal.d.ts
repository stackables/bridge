/** Add two numbers. Returns `a + b`. */
export declare function add(opts: {
    a: number;
    b: number;
}): number;
/** Subtract two numbers. Returns `a - b`. */
export declare function subtract(opts: {
    a: number;
    b: number;
}): number;
/** Multiply two numbers. Returns `a * b`. */
export declare function multiply(opts: {
    a: number;
    b: number;
}): number;
/** Divide two numbers. Returns `a / b`. */
export declare function divide(opts: {
    a: number;
    b: number;
}): number;
/** Strict equality. Returns `true` if `a === b`, `false` otherwise. */
export declare function eq(opts: {
    a: any;
    b: any;
}): boolean;
/** Strict inequality. Returns `true` if `a !== b`, `false` otherwise. */
export declare function neq(opts: {
    a: any;
    b: any;
}): boolean;
/** Greater than. Returns `true` if `a > b`, `false` otherwise. */
export declare function gt(opts: {
    a: number;
    b: number;
}): boolean;
/** Greater than or equal. Returns `true` if `a >= b`, `false` otherwise. */
export declare function gte(opts: {
    a: number;
    b: number;
}): boolean;
/** Less than. Returns `true` if `a < b`, `false` otherwise. */
export declare function lt(opts: {
    a: number;
    b: number;
}): boolean;
/** Less than or equal. Returns `true` if `a <= b`, `false` otherwise. */
export declare function lte(opts: {
    a: number;
    b: number;
}): boolean;
/** Logical NOT. Returns `true` if `a` is falsy. */
export declare function not(opts: {
    a: any;
}): boolean;
/** Logical AND. Returns `true` if both `a` and `b` are truthy. */
export declare function and(opts: {
    a: any;
    b: any;
}): boolean;
/** Logical OR. Returns `true` if either `a` or `b` is truthy. */
export declare function or(opts: {
    a: any;
    b: any;
}): boolean;
/** String concatenation. Joins all parts into a single string. */
export declare function concat(opts: {
    parts: unknown[];
}): {
    value: string;
};
//# sourceMappingURL=internal.d.ts.map