/** Greater than or equal. Returns `true` if `a >= b`, `false` otherwise. */
export function gte(opts: { a: number; b: number }): boolean {
  return Number(opts.a) >= Number(opts.b);
}
