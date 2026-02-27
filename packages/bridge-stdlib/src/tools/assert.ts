import type { ToolContext } from "@stackables/bridge-types";

export function assert(input: { in: any }, _context?: ToolContext) {
  if (!input.in) {
    throw new Error("Assertion failed: input is falsy");
  }
  return input.in;
}
