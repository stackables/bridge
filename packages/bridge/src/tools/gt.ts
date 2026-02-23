/** Greater than. Returns `true` if `a > b`, `false` otherwise. */
export function gt(opts: { a: number; b: number }): boolean {
  return Number(opts.a) > Number(opts.b);
}
