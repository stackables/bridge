import type { ToolMetadata } from "@stackables/bridge-types";

const syncUtility = {
  sync: true,
  trace: false,
} satisfies ToolMetadata;

export function toLowerCase(opts: { in: string }) {
  return opts.in?.toLowerCase();
}

toLowerCase.bridge = syncUtility;

export function toUpperCase(opts: { in: string }) {
  return opts.in?.toUpperCase();
}

toUpperCase.bridge = syncUtility;

export function trim(opts: { in: string }) {
  return opts.in?.trim();
}

trim.bridge = syncUtility;

export function length(opts: { in: string }) {
  return opts.in?.length;
}

length.bridge = syncUtility;
