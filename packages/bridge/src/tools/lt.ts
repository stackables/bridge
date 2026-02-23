/** Less than. Returns `1` if `a < b`, `0` otherwise. */
export function lt(opts: { a: number; b: number }): number {
  return Number(opts.a) < Number(opts.b) ? 1 : 0;
}
