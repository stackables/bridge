/**
 * @stackables/bridge-stdlib — Bridge standard library tools.
 *
 * Contains the `std` namespace tools (httpCall, string helpers, array helpers,
 * audit) that ship with Bridge.  Referenced in `.bridge` files as
 * `std.httpCall`, `std.str.toUpperCase`, etc.
 *
 * Separated from core so it can be versioned independently.
 */
import { audit } from "./tools/audit.js";
import { createHttpCall } from "./tools/http-call.js";
import * as arrays from "./tools/arrays.js";
import * as strings from "./tools/strings.js";
/**
 * Standard library version.
 *
 * The bridge `version X.Y` header declares the minimum compatible std version.
 * At runtime the engine compares this constant against the bridge's declared
 * version to verify compatibility (same major, equal-or-higher minor).
 */
export const STD_VERSION = "1.5.0";
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
};
/**
 * All known built-in tool names as "namespace.tool" strings.
 *
 * Useful for LSP/IDE autocomplete and diagnostics.
 */
export const builtinToolNames = Object.keys(std).map((k) => `std.${k}`);
export { createHttpCall } from "./tools/http-call.js";
