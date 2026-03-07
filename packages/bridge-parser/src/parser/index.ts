/**
 * Chevrotain-based parser for the Bridge DSL.
 *
 * Re-exports the public parse function as well as the lexer for direct access.
 */
export {
  parseBridgeChevrotain,
  parseBridgeCst,
  parseBridgeDiagnostics,
  PARSER_VERSION,
} from "./parser.ts";
export type {
  BridgeDiagnostic,
  BridgeParseResult,
  ParseBridgeOptions,
} from "./parser.ts";
export { BridgeLexer, allTokens } from "./lexer.ts";
