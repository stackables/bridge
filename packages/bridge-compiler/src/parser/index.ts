/**
 * Chevrotain-based parser for the Bridge DSL.
 *
 * Re-exports the public parse function as well as the lexer for direct access.
 */
export {
  parseBridgeChevrotain,
  parseBridgeDiagnostics,
  PARSER_VERSION,
} from "./parser.ts";
export type { BridgeDiagnostic, BridgeParseResult } from "./parser.ts";
export { BridgeLexer, allTokens } from "./lexer.ts";
