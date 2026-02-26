/**
 * Chevrotain Lexer for the Bridge DSL.
 *
 * Tokenizes .bridge source text into a stream consumed by the CstParser.
 * Comments and whitespace are automatically skipped (placed on hidden channels).
 */
import { createToken, Lexer } from "chevrotain";

// ── Whitespace & comments ──────────────────────────────────────────────────

export const Newline = createToken({
  name: "Newline",
  pattern: /\r?\n/,
  group: Lexer.SKIPPED,
});

export const WS = createToken({
  name: "WS",
  pattern: /[ \t]+/,
  group: Lexer.SKIPPED,
});

export const Comment = createToken({
  name: "Comment",
  pattern: /#[^\r\n]*/,
  group: Lexer.SKIPPED,
});

// ── Identifiers (defined first — keywords reference via longer_alt) ────────

export const Identifier = createToken({
  name: "Identifier",
  pattern: /[a-zA-Z_][\w-]*/,
});

// ── Keywords ───────────────────────────────────────────────────────────────

export const VersionKw = createToken({ name: "VersionKw", pattern: /version/i, longer_alt: Identifier });
export const ToolKw    = createToken({ name: "ToolKw",    pattern: /tool/i,    longer_alt: Identifier });
export const BridgeKw  = createToken({ name: "BridgeKw",  pattern: /bridge/i,  longer_alt: Identifier });
export const DefineKw  = createToken({ name: "DefineKw",  pattern: /define/i,  longer_alt: Identifier });
export const ConstKw   = createToken({ name: "ConstKw",   pattern: /const/i,   longer_alt: Identifier });
export const WithKw    = createToken({ name: "WithKw",    pattern: /with/i,    longer_alt: Identifier });
export const AsKw      = createToken({ name: "AsKw",      pattern: /as/i,      longer_alt: Identifier });
export const FromKw    = createToken({ name: "FromKw",    pattern: /from/i,    longer_alt: Identifier });
export const InputKw   = createToken({ name: "InputKw",   pattern: /input/i,   longer_alt: Identifier });
export const OutputKw  = createToken({ name: "OutputKw",  pattern: /output/i,  longer_alt: Identifier });
export const ContextKw = createToken({ name: "ContextKw", pattern: /context/i, longer_alt: Identifier });
export const OnKw      = createToken({ name: "OnKw",      pattern: /on/i,      longer_alt: Identifier });
export const ErrorKw   = createToken({ name: "ErrorKw",   pattern: /error/i,   longer_alt: Identifier });
export const ForceKw   = createToken({ name: "ForceKw",   pattern: /force/i,   longer_alt: Identifier });
export const AliasKw   = createToken({ name: "AliasKw",   pattern: /alias/i,   longer_alt: Identifier });
export const CatchKw   = createToken({ name: "CatchKw",   pattern: /catch/i,   longer_alt: Identifier });
export const AndKw     = createToken({ name: "AndKw",     pattern: /and/,      longer_alt: Identifier });
export const OrKw      = createToken({ name: "OrKw",      pattern: /or/,       longer_alt: Identifier });
export const NotKw     = createToken({ name: "NotKw",     pattern: /not/,      longer_alt: Identifier });

// ── Operators & punctuation ────────────────────────────────────────────────

export const Arrow         = createToken({ name: "Arrow",         pattern: /<-/ });
export const NullCoalesce  = createToken({ name: "NullCoalesce",  pattern: /\|\|/ });
export const ErrorCoalesce = createToken({ name: "ErrorCoalesce", pattern: /\?\?/ });
export const SafeNav       = createToken({ name: "SafeNav",       pattern: /\?\./ });
export const QuestionMark  = createToken({ name: "QuestionMark",  pattern: /\?/ });
export const GreaterEqual  = createToken({ name: "GreaterEqual",  pattern: />=/ });
export const LessEqual     = createToken({ name: "LessEqual",     pattern: /<=/ });
export const DoubleEquals  = createToken({ name: "DoubleEquals",  pattern: /==/ });
export const NotEquals     = createToken({ name: "NotEquals",     pattern: /!=/ });
export const GreaterThan   = createToken({ name: "GreaterThan",   pattern: />/ });
export const LessThan      = createToken({ name: "LessThan",      pattern: /</ });
export const Star          = createToken({ name: "Star",          pattern: /\*/ });
export const Plus          = createToken({ name: "Plus",          pattern: /\+/ });
export const LParen        = createToken({ name: "LParen",        pattern: /\(/ });
export const RParen        = createToken({ name: "RParen",        pattern: /\)/ });
export const LCurly        = createToken({ name: "LCurly",        pattern: /\{/ });
export const RCurly        = createToken({ name: "RCurly",        pattern: /\}/ });
export const LSquare       = createToken({ name: "LSquare",       pattern: /\[/ });
export const RSquare       = createToken({ name: "RSquare",       pattern: /\]/ });
export const Equals        = createToken({ name: "Equals",        pattern: /=/ });
export const Dot           = createToken({ name: "Dot",           pattern: /\./ });
export const Colon         = createToken({ name: "Colon",         pattern: /:/ });
export const Comma         = createToken({ name: "Comma",         pattern: /,/ });

// ── Literals ───────────────────────────────────────────────────────────────

export const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /"(?:[^"\\]|\\.)*"/,
});

export const NumberLiteral = createToken({
  name: "NumberLiteral",
  pattern: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/,
});

export const TrueLiteral  = createToken({ name: "TrueLiteral",  pattern: /true/,  longer_alt: Identifier });
export const FalseLiteral = createToken({ name: "FalseLiteral", pattern: /false/, longer_alt: Identifier });
export const NullLiteral  = createToken({ name: "NullLiteral",  pattern: /null/,  longer_alt: Identifier });

export const PathToken = createToken({
  name: "PathToken",
  pattern: /\/[\w./-]+/,
});

export const Slash = createToken({ name: "Slash", pattern: /\// });
export const Minus = createToken({ name: "Minus", pattern: /-/ });

// ── Token ordering ─────────────────────────────────────────────────────────

export const allTokens = [
  WS,
  Comment,
  Newline,
  Arrow,
  NullCoalesce,
  ErrorCoalesce,
  SafeNav,
  QuestionMark,
  GreaterEqual,
  LessEqual,
  DoubleEquals,
  NotEquals,
  GreaterThan,
  LessThan,
  Star,
  Plus,
  LParen,
  RParen,
  LCurly,
  RCurly,
  LSquare,
  RSquare,
  Equals,
  Dot,
  Colon,
  Comma,
  StringLiteral,
  // Keywords before Identifier (longer_alt prevents prefix stealing)
  VersionKw,
  ToolKw,
  BridgeKw,
  DefineKw,
  ConstKw,
  WithKw,
  AsKw,
  FromKw,
  InputKw,
  OutputKw,
  ContextKw,
  OnKw,
  ErrorKw,
  ForceKw,
  AliasKw,
  CatchKw,
  AndKw,
  OrKw,
  NotKw,
  TrueLiteral,
  FalseLiteral,
  NullLiteral,
  PathToken,
  Slash,
  NumberLiteral,
  Minus,
  Identifier,
];

export const BridgeLexer = new Lexer(allTokens, {
  ensureOptimizations: true,
  positionTracking: "full",
});
