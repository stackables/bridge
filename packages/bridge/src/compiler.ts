/**
 * Bridge Compiler — parser, serializer, and language service.
 *
 * Turns `.bridge` source text into `Instruction[]` (JSON AST) and provides
 * IDE intelligence (diagnostics, completions, hover).  The only external
 * dependency is Chevrotain.
 *
 * ```ts
 * import { parseBridge, BridgeLanguageService } from "@stackables/bridge/compiler";
 * ```
 */

// ── Parser ──────────────────────────────────────────────────────────────────

export {
  parseBridgeChevrotain as parseBridge,
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
} from "./parser/index.ts";
export type { BridgeDiagnostic, BridgeParseResult } from "./parser/index.ts";
export { BridgeLexer, allTokens } from "./parser/index.ts";

// ── Serializer ──────────────────────────────────────────────────────────────

export { serializeBridge } from "./bridge-format.ts";

// ── Language service ────────────────────────────────────────────────────────

export { BridgeLanguageService } from "./language-service.ts";
export type {
  BridgeCompletion,
  BridgeHover,
  CompletionKind,
  Position,
  Range,
} from "./language-service.ts";
