export function toLowerCase(opts: { in: string }) {
  return opts.in.toLowerCase();
}

export function toUpperCase(opts: { in: string }) {
  return opts.in.toUpperCase();
}

export function trim(opts: { in: string }) {
  return opts.in.trim();
}

export function length(opts: { in: string }) {
  return opts.in.length;
}
