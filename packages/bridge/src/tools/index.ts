import { createHttpCall } from "./http-call.js";
import { upperCase } from "./upper-case.js";
import { lowerCase } from "./lower-case.js";
import { findObject } from "./find-object.js";
import { pickFirst } from "./pick-first.js";
import { toArray } from "./to-array.js";
import { multiply } from "./multiply.js";
import { divide } from "./divide.js";
import { add } from "./add.js";
import { subtract } from "./subtract.js";
import { eq } from "./eq.js";
import { neq } from "./neq.js";
import { gt } from "./gt.js";
import { gte } from "./gte.js";
import { lt } from "./lt.js";
import { lte } from "./lte.js";

/**
 * Standard built-in tools — available under the `std` namespace.
 *
 * Referenced in `.bridge` files as `std.upperCase`, `std.pickFirst`, etc.
 * Math and comparison tools are used by the parser to desugar infix expressions.
 */
const httpCallFn = createHttpCall();

export const std = {
  httpCall: httpCallFn,
  upperCase,
  lowerCase,
  findObject,
  pickFirst,
  toArray,
  multiply,
  divide,
  add,
  subtract,
  eq,
  neq,
  gt,
  gte,
  lt,
  lte,
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
export { multiply } from "./multiply.js";
export { divide } from "./divide.js";
export { add } from "./add.js";
export { subtract } from "./subtract.js";
export { eq } from "./eq.js";
export { neq } from "./neq.js";
export { gt } from "./gt.js";
export { gte } from "./gte.js";
export { lt } from "./lt.js";
export { lte } from "./lte.js";
