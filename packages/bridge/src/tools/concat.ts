export function concat(opts: { parts: unknown[] }): { value: string } {
  const result = (opts.parts ?? [])
    .map((v) => (v == null ? "" : String(v)))
    .join("");
  return { value: result };
}
