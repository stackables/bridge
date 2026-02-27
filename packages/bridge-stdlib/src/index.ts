/**
 * @stackables/bridge-stdlib — Bridge standard library tools.
 *
 * Contains the `std` namespace tools (httpCall, string helpers, array helpers,
 * audit, assert) that ship with Bridge.  Referenced in `.bridge` files as
 * `std.httpCall`, `std.str.toUpperCase`, etc.
 *
 * Separated from core so it can be versioned independently.
 */
import { audit } from "./tools/audit.ts";
import { createHttpCall } from "./tools/http-call.ts";
import * as arrays from "./tools/arrays.ts";
import * as strings from "./tools/strings.ts";
import { assert } from "./tools/assert.ts";

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

/**
 * All known built-in tool names as "namespace.tool" strings.
 *
 * Useful for LSP/IDE autocomplete and diagnostics.
 */
export const builtinToolNames: readonly string[] = Object.keys(std).map(
  (k) => `std.${k}`,
);

export { audit } from "./tools/audit.ts";
export { createHttpCall } from "./tools/http-call.ts";
export { parseCacheTTL } from "./tools/http-call.ts";
