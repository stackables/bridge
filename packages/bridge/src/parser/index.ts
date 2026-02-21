/**
 * Chevrotain-based parser for the Bridge DSL.
 *
 * Re-exports the public parse function as well as the lexer for direct access.
 */
export { parseBridgeChevrotain } from "./parser.js";
export { BridgeLexer, allTokens } from "./lexer.js";
