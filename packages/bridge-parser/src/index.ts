/**
 * @stackables/bridge-parser — Bridge DSL parser, serializer, and language service.
 *
 * Turns `.bridge` source text into `BridgeDocument` (JSON AST) and provides
 * IDE intelligence (diagnostics, completions, hover).
 */

// ── Parser ──────────────────────────────────────────────────────────────────

export {
  parseBridgeChevrotain as parseBridge,
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
  PARSER_VERSION,
} from "./parser/index.ts";
export type { BridgeDiagnostic, BridgeParseResult } from "./parser/index.ts";
export { BridgeLexer, allTokens } from "./parser/index.ts";

// ── Serializer ──────────────────────────────────────────────────────────────

export {
  parseBridge as parseBridgeFormat,
  serializeBridge,
} from "./bridge-format.ts";

// ── Formatter ───────────────────────────────────────────────────────────────

export { formatBridge } from "./bridge-printer.ts";

// ── Language service ────────────────────────────────────────────────────────

export { BridgeLanguageService } from "./language-service.ts";
export type {
  BridgeCompletion,
  BridgeHover,
  CompletionKind,
  Position,
  Range,
} from "./language-service.ts";
