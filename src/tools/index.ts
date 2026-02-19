import { createHttpCall } from "./http-call.js";
import { upperCase } from "./upper-case.js";
import { lowerCase } from "./lower-case.js";
import { findObject } from "./find-object.js";
import { pickFirst } from "./pick-first.js";
import { toArray } from "./to-array.js";

/**
 * Built-in tools bundle.
 *
 * Used as the default value for `BridgeOptions.tools`.
 * If you provide your own `tools` object it replaces this entirely —
 * import and spread `builtinTools` if you still need them.
 *
 * ```ts
 * import { builtinTools } from "@stackables/bridge";
 *
 * bridgeTransform(schema, instructions, {
 *   tools: { ...builtinTools, myCustomTool }
 * });
 * ```
 */
export const builtinTools = {
  httpCall: createHttpCall(),
  upperCase,
  lowerCase,
  findObject,
  pickFirst,
  toArray,
} as const;

export { createHttpCall } from "./http-call.js";
export { upperCase } from "./upper-case.js";
export { lowerCase } from "./lower-case.js";
export { findObject } from "./find-object.js";
export { pickFirst } from "./pick-first.js";
export { toArray } from "./to-array.js";
