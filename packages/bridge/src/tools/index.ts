import { audit } from "./audit.ts";
import { concat } from "./concat.ts";
import { createHttpCall } from "./http-call.ts";
import { upperCase } from "./upper-case.ts";
import { lowerCase } from "./lower-case.ts";
import { findObject } from "./find-object.ts";
import { pickFirst } from "./pick-first.ts";
import { toArray } from "./to-array.ts";
import { multiply } from "./multiply.ts";
import { divide } from "./divide.ts";
import { add } from "./add.ts";
import { subtract } from "./subtract.ts";
import { eq } from "./eq.ts";
import { neq } from "./neq.ts";
import { gt } from "./gt.ts";
import { gte } from "./gte.ts";
import { lt } from "./lt.ts";
import { lte } from "./lte.ts";

/**
 * Standard built-in tools — available under the `std` namespace.
 *
 * Referenced in `.bridge` files as `std.upperCase`, `std.pickFirst`, etc.
 */
const httpCallFn = createHttpCall();

export const std = {
  audit,
  concat,
  httpCall: httpCallFn,
  upperCase,
  lowerCase,
  findObject,
  pickFirst,
  toArray,
} as const;

/**
 * Math and comparison tools — available under the `math` namespace.
 *
 * Used by the parser to desugar infix expressions (e.g. `o.total <- i.price * i.qty`).
 * Can also be used explicitly as pipe transforms.
 */
export const math = {
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
 * Used as the base for `BridgeOptions.tools`. The `std` and `math` namespaces
 * are always included; user-provided tools are merged on top.
 *
 * ```ts
 * import { builtinTools } from "@stackables/bridge";
 *
 * bridgeTransform(schema, instructions, {
 *   tools: { myCustomTool }  // std + math + httpCall are still available
 * });
 * ```
 */
export const builtinTools = {
  std,
  math,
} as const;

export { audit } from "./audit.ts";

/**
 * All known built-in tool names as "namespace.tool" strings.
 *
 * Useful for LSP/IDE autocomplete and diagnostics. Derived at module
 * load time from the `std` and `math` objects — no manual sync needed.
 *
 * ```ts
 * builtinToolNames
 * // ["std.httpCall", "std.upperCase", ..., "math.multiply", ...]
 * ```
 */
export const builtinToolNames: readonly string[] = [
  ...Object.keys(std).map((k) => `std.${k}`),
  ...Object.keys(math).map((k) => `math.${k}`),
];

export { createHttpCall } from "./http-call.ts";
export { concat } from "./concat.ts";
export { upperCase } from "./upper-case.ts";
export { lowerCase } from "./lower-case.ts";
export { findObject } from "./find-object.ts";
export { pickFirst } from "./pick-first.ts";
export { toArray } from "./to-array.ts";
export { multiply } from "./multiply.ts";
export { divide } from "./divide.ts";
export { add } from "./add.ts";
export { subtract } from "./subtract.ts";
export { eq } from "./eq.ts";
export { neq } from "./neq.ts";
export { gt } from "./gt.ts";
export { gte } from "./gte.ts";
export { lt } from "./lt.ts";
export { lte } from "./lte.ts";
