/** Logical OR. Returns `true` if either `a` or `b` is truthy. */
export function or(opts: { a: any; b: any }): boolean {
  return Boolean(opts.a) || Boolean(opts.b);
}
