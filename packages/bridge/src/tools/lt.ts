/** Less than. Returns `true` if `a < b`, `false` otherwise. */
export function lt(opts: { a: number; b: number }): boolean {
  return Number(opts.a) < Number(opts.b);
}
