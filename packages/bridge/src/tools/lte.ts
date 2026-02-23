/** Less than or equal. Returns `true` if `a <= b`, `false` otherwise. */
export function lte(opts: { a: number; b: number }): boolean {
  return Number(opts.a) <= Number(opts.b);
}
