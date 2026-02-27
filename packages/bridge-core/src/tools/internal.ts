/** Add two numbers. Returns `a + b`. */
export function add(opts: { a: number; b: number }): number {
  return Number(opts.a) + Number(opts.b);
}
/** Subtract two numbers. Returns `a - b`. */
export function subtract(opts: { a: number; b: number }): number {
  return Number(opts.a) - Number(opts.b);
}
/** Multiply two numbers. Returns `a * b`. */
export function multiply(opts: { a: number; b: number }): number {
  return Number(opts.a) * Number(opts.b);
}
/** Divide two numbers. Returns `a / b`. */
export function divide(opts: { a: number; b: number }): number {
  return Number(opts.a) / Number(opts.b);
}
/** Strict equality. Returns `true` if `a === b`, `false` otherwise. */
export function eq(opts: { a: any; b: any }): boolean {
  return opts.a === opts.b;
}
/** Strict inequality. Returns `true` if `a !== b`, `false` otherwise. */
export function neq(opts: { a: any; b: any }): boolean {
  return opts.a !== opts.b;
}
/** Greater than. Returns `true` if `a > b`, `false` otherwise. */
export function gt(opts: { a: number; b: number }): boolean {
  return Number(opts.a) > Number(opts.b);
}
/** Greater than or equal. Returns `true` if `a >= b`, `false` otherwise. */
export function gte(opts: { a: number; b: number }): boolean {
  return Number(opts.a) >= Number(opts.b);
}
/** Less than. Returns `true` if `a < b`, `false` otherwise. */
export function lt(opts: { a: number; b: number }): boolean {
  return Number(opts.a) < Number(opts.b);
}
/** Less than or equal. Returns `true` if `a <= b`, `false` otherwise. */
export function lte(opts: { a: number; b: number }): boolean {
  return Number(opts.a) <= Number(opts.b);
}
/** Logical NOT. Returns `true` if `a` is falsy. */
export function not(opts: { a: any }): boolean {
  return !opts.a;
}
/** Logical AND. Returns `true` if both `a` and `b` are truthy. */
export function and(opts: { a: any; b: any }): boolean {
  return Boolean(opts.a) && Boolean(opts.b);
}
/** Logical OR. Returns `true` if either `a` or `b` is truthy. */
export function or(opts: { a: any; b: any }): boolean {
  return Boolean(opts.a) || Boolean(opts.b);
}
/** String concatenation. Joins all parts into a single string. */
export function concat(opts: { parts: unknown[] }): { value: string } {
  const result = (opts.parts ?? [])
    .map((v) => (v == null ? "" : String(v)))
    .join("");
  return { value: result };
}
