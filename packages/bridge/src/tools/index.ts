import { audit } from "./audit.ts";
import { createHttpCall } from "./http-call.ts";
import * as arrays from "./arrays.ts";
import * as strings from "./strings.ts";
import { assert } from "./assert.ts";
import * as internal from "./internal.ts";

/**
 * Standard built-in tools — available under the `std` namespace.
 *
 * Referenced in `.bridge` files as `std.str.toUpperCase`, `std.arr.first`, etc.
 */
const httpCallFn = createHttpCall();

export const std = {
  str: strings,
  arr: arrays,
  audit,
  httpCall: httpCallFn,
  assert,
} as const;

export { internal };

/**
 * Built-in tools bundle.
 *
 * Used as the base for `BridgeOptions.tools`. The `std` and `internal` namespaces
 * are always included; user-provided tools are merged on top.
 *
 * ```ts
 * import { builtinTools } from "@stackables/bridge";
 *
 * bridgeTransform(schema, instructions, {
 *   tools: { myCustomTool }  // std + internal + httpCall are still available
 * });
 * ```
 */
export const builtinTools = {
  std,
  internal,
} as const;

export { audit } from "./audit.ts";

/**
 * All known built-in tool names as "namespace.tool" strings.
 *
 * Useful for LSP/IDE autocomplete and diagnostics. Derived at module
 * load time from the `std` and `internal` objects — no manual sync needed.
 *
 * ```ts
 * builtinToolNames
 * // ["std.httpCall", "std.str.toUpperCase", ..., "internal.multiply", ...]
 * ```
 */
export const builtinToolNames: readonly string[] = [
  ...Object.keys(std).map((k) => `std.${k}`),
  ...Object.keys(internal).map((k) => `internal.${k}`),
];

export { createHttpCall } from "./http-call.ts";
