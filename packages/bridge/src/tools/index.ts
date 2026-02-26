import { audit } from "./audit.ts";
import { createHttpCall } from "./http-call.ts";
import { concat } from "./concat.ts";
import * as arrays from "./arrays.ts";
import * as strings from "./strings.ts";
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
import { assert } from "./assert.ts";
import { not } from "./not.ts";

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
  concat,
  assert,
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
  not,
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
 * // ["std.httpCall", "std.str.toUpperCase", ..., "math.multiply", ...]
 * ```
 */
export const builtinToolNames: readonly string[] = [
  ...Object.keys(std).map((k) => `std.${k}`),
  ...Object.keys(math).map((k) => `math.${k}`),
];

export { createHttpCall } from "./http-call.ts";
