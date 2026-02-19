import { createHttpCall } from "./http-call.js";
import { upperCase } from "./upper-case.js";
import { lowerCase } from "./lower-case.js";
import { findObject } from "./find-object.js";
import { pickFirst } from "./pick-first.js";
import { toArray } from "./to-array.js";

/**
 * Standard built-in tools — available under the `std` namespace.
 *
 * Referenced in `.bridge` files as `std.upperCase`, `std.pickFirst`, etc.
 */
const httpCallFn = createHttpCall();

export const std = {
  httpCall: httpCallFn,
  upperCase,
  lowerCase,
  findObject,
  pickFirst,
  toArray,
} as const;

/**
 * Built-in tools bundle.
 *
 * Used as the base for `BridgeOptions.tools`. The `std` namespace is always
 * included; user-provided tools are merged on top.
 *
 * ```ts
 * import { builtinTools } from "@stackables/bridge";
 *
 * bridgeTransform(schema, instructions, {
 *   tools: { myCustomTool }  // std + httpCall are still available
 * });
 * ```
 */
export const builtinTools = {
  std,
} as const;

export { createHttpCall } from "./http-call.js";
export { upperCase } from "./upper-case.js";
export { lowerCase } from "./lower-case.js";
export { findObject } from "./find-object.js";
export { pickFirst } from "./pick-first.js";
export { toArray } from "./to-array.js";
