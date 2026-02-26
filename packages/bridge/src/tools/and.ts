/** Logical AND. Returns `true` if both `a` and `b` are truthy. */
export function and(opts: { a: any; b: any }): boolean {
  return Boolean(opts.a) && Boolean(opts.b);
}
