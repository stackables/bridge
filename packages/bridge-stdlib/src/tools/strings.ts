import type { ToolMetadata } from "@stackables/bridge-types";

const syncUtility = {
  sync: true,
  trace: false,
} satisfies ToolMetadata;

export function toLowerCase(opts: { in: string }) {
  return typeof opts.in === "string" ? opts.in.toLowerCase() : undefined;
}

toLowerCase.bridge = syncUtility;

export function toUpperCase(opts: { in: string }) {
  return typeof opts.in === "string" ? opts.in.toUpperCase() : undefined;
}

toUpperCase.bridge = syncUtility;

export function trim(opts: { in: string }) {
  return typeof opts.in === "string" ? opts.in.trim() : undefined;
}

trim.bridge = syncUtility;

export function length(opts: { in: string }) {
  return typeof opts.in === "string" ? opts.in.length : undefined;
}

length.bridge = syncUtility;
