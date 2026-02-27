/**
 * Bridge Standard Library — built-in tool functions.
 *
 * Contains the `std` namespace tools (httpCall, string helpers, array helpers,
 * audit, assert) that ship with every Bridge installation.  These are the
 * user-facing tools referenced as `std.httpCall`, `std.str.toUpperCase`, etc.
 * in `.bridge` files.
 *
 * Separated from core so it can be versioned independently — the standard
 * library may gain new tools without requiring a core engine release.
 *
 * **Not included here:** internal tools (`add`, `multiply`, `eq`, `concat`, …)
 * which are core language primitives emitted by the parser and live in
 * `@stackables/bridge/core`.
 *
 * ```ts
 * import { std, createHttpCall } from "@stackables/bridge/stdlib";
 * ```
 */

// ── Standard tools ──────────────────────────────────────────────────────────

export {
  std,
  builtinToolNames,
  builtinTools,
  createHttpCall,
} from "./tools/index.ts";
export { audit } from "./tools/audit.ts";
export type { CacheStore } from "./types.ts";
