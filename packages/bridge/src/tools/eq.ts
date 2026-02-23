/** Strict equality. Returns `1` if `a === b`, `0` otherwise. */
export function eq(opts: { a: any; b: any }): number {
  return opts.a === opts.b ? 1 : 0;
}
