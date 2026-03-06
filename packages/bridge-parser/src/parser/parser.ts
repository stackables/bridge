/**
 * Chevrotain CstParser + imperative CST→AST visitor for the Bridge DSL.
 *
 * Drop-in replacement for the regex-based `parseBridge()` in bridge-format.ts.
 * Produces the *exact same* AST types (`Instruction[]`).
 */
import { CstParser, type CstNode, type IToken } from "chevrotain";
import {
  allTokens,
  Identifier,
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
  Arrow,
  ForceKw,
  AliasKw,
  AndKw,
  OrKw,
  NotKw,
  ThrowKw,
  PanicKw,
  ContinueKw,
  BreakKw,
  NullCoalesce,
  ErrorCoalesce,
  SafeNav,
  CatchKw,
  LParen,
  RParen,
  LCurly,
  RCurly,
  LSquare,
  RSquare,
  Equals,
  Spread,
  Dot,
  Colon,
  Comma,
  StringLiteral,
  NumberLiteral,
  PathToken,
  TrueLiteral,
  FalseLiteral,
  NullLiteral,
  Star,
  Slash,
  Plus,
  Minus,
  GreaterEqual,
  LessEqual,
  DoubleEquals,
  NotEquals,
  GreaterThan,
  LessThan,
  QuestionMark,
  VersionTag,
  BridgeLexer,
} from "./lexer.ts";

import type {
  Bridge,
  BridgeDocument,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  HandleBinding,
  Instruction,
  NodeRef,
  ToolDef,
  ToolDep,
  ToolWire,
  Wire,
  WireFallback,
} from "@stackables/bridge-core";
import { SELF_MODULE } from "@stackables/bridge-core";

// ── Reserved-word guards (mirroring the regex parser) ──────────────────────

const RESERVED_KEYWORDS = new Set([
  "bridge",
  "with",
  "as",
  "from",
  "const",
  "tool",
  "version",
  "define",
  "alias",
  "throw",
  "panic",
  "continue",
  "break",
]);
const SOURCE_IDENTIFIERS = new Set(["input", "output", "context"]);

function assertNotReserved(name: string, lineNum: number, label: string) {
  if (RESERVED_KEYWORDS.has(name.toLowerCase())) {
    throw new Error(
      `Line ${lineNum}: "${name}" is a reserved keyword and cannot be used as a ${label}`,
    );
  }
  if (SOURCE_IDENTIFIERS.has(name.toLowerCase())) {
    throw new Error(
      `Line ${lineNum}: "${name}" is a reserved source identifier and cannot be used as a ${label}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Grammar (CstParser)
// ═══════════════════════════════════════════════════════════════════════════

class BridgeParser extends CstParser {
  constructor(opts: { recovery?: boolean } = {}) {
    super(allTokens, {
      recoveryEnabled: opts.recovery ?? false,
      maxLookahead: 4,
    });
    this.performSelfAnalysis();
  }

  // ── Top-level ──────────────────────────────────────────────────────────

  public program = this.RULE("program", () => {
    this.SUBRULE(this.versionDecl);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.SUBRULE(this.toolBlock) },
        { ALT: () => this.SUBRULE(this.bridgeBlock) },
        { ALT: () => this.SUBRULE(this.defineBlock) },
        { ALT: () => this.SUBRULE(this.constDecl) },
      ]);
    });
  });

  /** version 1.5 */
  public versionDecl = this.RULE("versionDecl", () => {
    this.CONSUME(VersionKw);
    this.CONSUME(NumberLiteral, { LABEL: "ver" });
  });

  // ── Tool block ─────────────────────────────────────────────────────────

  public toolBlock = this.RULE("toolBlock", () => {
    this.CONSUME(ToolKw);
    this.SUBRULE(this.dottedName, { LABEL: "toolName" });
    this.CONSUME(FromKw);
    this.SUBRULE2(this.dottedName, { LABEL: "toolSource" });
    this.OPTION(() => {
      this.CONSUME(LCurly);
      this.MANY(() => this.SUBRULE(this.toolBodyLine));
      this.CONSUME(RCurly);
    });
  });

  /**
   * A single line inside a tool block.
   *
   * Ambiguity fix: `.target = value` and `.target <- source` share the
   * prefix `Dot dottedPath`, so we merge them into one alternative that
   * parses the prefix then branches on `=` vs `<-`.
   *
   * `on error` and `with` have distinct first tokens so they stay separate.
   */
  public toolBodyLine = this.RULE("toolBodyLine", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.toolOnError) },
      { ALT: () => this.SUBRULE(this.toolWithDecl) },
      { ALT: () => this.SUBRULE(this.toolWire) }, // merged constant + pull
    ]);
  });

  /**
   * Tool wire (merged): .target = value | .target <- source
   *
   * Parses the common prefix `.dottedPath` then branches on operator.
   */
  public toolWire = this.RULE("toolWire", () => {
    this.CONSUME(Dot);
    this.SUBRULE(this.dottedPath, { LABEL: "target" });
    this.OR([
      {
        ALT: () => {
          this.CONSUME(Equals, { LABEL: "equalsOp" });
          this.SUBRULE(this.bareValue, { LABEL: "value" });
        },
      },
      {
        ALT: () => {
          this.CONSUME(Arrow, { LABEL: "arrowOp" });
          this.SUBRULE(this.dottedName, { LABEL: "source" });
        },
      },
    ]);
  });

  /** on error = <value> | on error <- <source> */
  public toolOnError = this.RULE("toolOnError", () => {
    this.CONSUME(OnKw);
    this.CONSUME(ErrorKw);
    this.OR([
      {
        ALT: () => {
          this.CONSUME(Equals, { LABEL: "equalsOp" });
          this.SUBRULE(this.jsonValue, { LABEL: "errorValue" });
        },
      },
      {
        ALT: () => {
          this.CONSUME(Arrow, { LABEL: "arrowOp" });
          this.SUBRULE(this.dottedName, { LABEL: "errorSource" });
        },
      },
    ]);
  });

  /** with context [as alias] | with const [as alias] | with <tool> as <alias> */
  public toolWithDecl = this.RULE("toolWithDecl", () => {
    this.CONSUME(WithKw);
    this.OR([
      {
        ALT: () => {
          this.CONSUME(ContextKw, { LABEL: "contextKw" });
          this.OPTION(() => {
            this.CONSUME(AsKw);
            this.SUBRULE(this.nameToken, { LABEL: "alias" });
          });
        },
      },
      {
        ALT: () => {
          this.CONSUME(ConstKw, { LABEL: "constKw" });
          this.OPTION2(() => {
            this.CONSUME2(AsKw);
            this.SUBRULE2(this.nameToken, { LABEL: "constAlias" });
          });
        },
      },
      {
        // General tool reference — GATE excludes keywords handled above
        GATE: () => {
          const la = this.LA(1);
          return la.tokenType !== ContextKw && la.tokenType !== ConstKw;
        },
        ALT: () => {
          this.SUBRULE(this.dottedName, { LABEL: "toolName" });
          this.OPTION3(() => {
            this.CONSUME(VersionTag, { LABEL: "toolVersion" });
          });
          this.CONSUME3(AsKw);
          this.SUBRULE3(this.nameToken, { LABEL: "toolAlias" });
        },
      },
    ]);
  });

  // ── Bridge block ───────────────────────────────────────────────────────

  public bridgeBlock = this.RULE("bridgeBlock", () => {
    this.CONSUME(BridgeKw);
    this.SUBRULE(this.nameToken, { LABEL: "typeName" });
    this.CONSUME(Dot);
    this.SUBRULE2(this.nameToken, { LABEL: "fieldName" });
    this.OR([
      {
        // Passthrough shorthand: bridge Type.field with <name>
        ALT: () => {
          this.CONSUME(WithKw, { LABEL: "passthroughWith" });
          this.SUBRULE(this.dottedName, { LABEL: "passthroughName" });
        },
      },
      {
        // Full bridge block: bridge Type.field { ... }
        ALT: () => {
          this.CONSUME(LCurly);
          this.MANY(() => this.SUBRULE(this.bridgeBodyLine));
          this.CONSUME(RCurly);
        },
      },
    ]);
  });

  /**
   * A line inside a bridge/define body.
   *
   * Ambiguity fix: `target = value` and `target <- source` share the prefix
   * `addressPath`, so they're merged into `bridgeWire`.
   * `with` declarations start with WithKw and are unambiguous.
   * `alias` declarations start with AliasKw and are unambiguous.
   */
  public bridgeBodyLine = this.RULE("bridgeBodyLine", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.bridgeNodeAlias) },
      { ALT: () => this.SUBRULE(this.bridgeWithDecl) },
      { ALT: () => this.SUBRULE(this.bridgeForce) },
      { ALT: () => this.SUBRULE(this.bridgeWire) }, // merged constant + pull
    ]);
  });

  /**
   * Node alias at bridge body level:
   *   alias <sourceExpr> as <name>
   *
   * Creates a local __local binding that caches the result of the source
   * expression. Subsequent wires can reference the alias as a handle.
   */
  public bridgeNodeAlias = this.RULE("bridgeNodeAlias", () => {
    this.CONSUME(AliasKw);
    this.OR([
      {
        // String literal as source: alias "..." [op operand]* [? then : else] as name
        ALT: () => {
          this.CONSUME(StringLiteral, { LABEL: "aliasStringSource" });
          // Optional expression chain after string literal
          this.MANY3(() => {
            this.SUBRULE2(this.exprOperator, { LABEL: "aliasStringExprOp" });
            this.SUBRULE2(this.exprOperand, { LABEL: "aliasStringExprRight" });
          });
          // Optional ternary after string literal expression
          this.OPTION5(() => {
            this.CONSUME2(QuestionMark, { LABEL: "aliasStringTernaryOp" });
            this.SUBRULE3(this.ternaryBranch, {
              LABEL: "aliasStringThenBranch",
            });
            this.CONSUME2(Colon, { LABEL: "aliasStringTernaryColon" });
            this.SUBRULE4(this.ternaryBranch, {
              LABEL: "aliasStringElseBranch",
            });
          });
        },
      },
      {
        // [not] (parenExpr | sourceExpr) [op operand]* [? then : else] as name
        ALT: () => {
          this.OPTION3(() => {
            this.CONSUME(NotKw, { LABEL: "aliasNotPrefix" });
          });
          this.OR2([
            {
              ALT: () => {
                this.SUBRULE(this.parenExpr, { LABEL: "aliasFirstParen" });
              },
            },
            {
              ALT: () => {
                this.SUBRULE(this.sourceExpr, { LABEL: "nodeAliasSource" });
              },
            },
          ]);
          // Optional expression chain: op operand pairs
          this.MANY2(() => {
            this.SUBRULE(this.exprOperator, { LABEL: "aliasExprOp" });
            this.SUBRULE(this.exprOperand, { LABEL: "aliasExprRight" });
          });
          // Optional ternary: ? thenBranch : elseBranch
          this.OPTION4(() => {
            this.CONSUME(QuestionMark, { LABEL: "aliasTernaryOp" });
            this.SUBRULE(this.ternaryBranch, { LABEL: "aliasThenBranch" });
            this.CONSUME(Colon, { LABEL: "aliasTernaryColon" });
            this.SUBRULE2(this.ternaryBranch, { LABEL: "aliasElseBranch" });
          });
        },
      },
    ]);
    // || / ?? coalesce chain (mixed order)
    this.MANY(() => {
      this.SUBRULE4(this.coalesceChainItem, { LABEL: "aliasCoalesceItem" });
    });
    // catch error fallback
    this.OPTION2(() => {
      this.CONSUME(CatchKw);
      this.SUBRULE3(this.coalesceAlternative, { LABEL: "aliasCatchAlt" });
    });
    this.CONSUME(AsKw);
    this.SUBRULE(this.nameToken, { LABEL: "nodeAliasName" });
  });

  /** force <handle> [?? null] */
  public bridgeForce = this.RULE("bridgeForce", () => {
    this.CONSUME(ForceKw);
    this.SUBRULE(this.nameToken, { LABEL: "forcedHandle" });
    this.OPTION(() => {
      this.CONSUME(CatchKw, { LABEL: "forceCatchKw" });
      this.CONSUME(NullLiteral, { LABEL: "forceNullFallback" });
    });
  });

  /** with input/output/context/const/tool [as handle] */
  public bridgeWithDecl = this.RULE("bridgeWithDecl", () => {
    this.CONSUME(WithKw);
    this.OR([
      {
        ALT: () => {
          this.CONSUME(InputKw, { LABEL: "inputKw" });
          this.OPTION(() => {
            this.CONSUME(AsKw);
            this.SUBRULE(this.nameToken, { LABEL: "inputAlias" });
          });
        },
      },
      {
        ALT: () => {
          this.CONSUME(OutputKw, { LABEL: "outputKw" });
          this.OPTION2(() => {
            this.CONSUME2(AsKw);
            this.SUBRULE2(this.nameToken, { LABEL: "outputAlias" });
          });
        },
      },
      {
        ALT: () => {
          this.CONSUME(ContextKw, { LABEL: "contextKw" });
          this.OPTION3(() => {
            this.CONSUME3(AsKw);
            this.SUBRULE3(this.nameToken, { LABEL: "contextAlias" });
          });
        },
      },
      {
        ALT: () => {
          this.CONSUME(ConstKw, { LABEL: "constKw" });
          this.OPTION4(() => {
            this.CONSUME4(AsKw);
            this.SUBRULE4(this.nameToken, { LABEL: "constAlias" });
          });
        },
      },
      {
        // tool or define: with <name> [as <handle>]
        // GATE excludes keywords handled by specific alternatives above
        GATE: () => {
          const la = this.LA(1);
          return (
            la.tokenType !== InputKw &&
            la.tokenType !== OutputKw &&
            la.tokenType !== ContextKw &&
            la.tokenType !== ConstKw
          );
        },
        ALT: () => {
          this.SUBRULE(this.dottedName, { LABEL: "refName" });
          this.OPTION6(() => {
            this.CONSUME(VersionTag, { LABEL: "refVersion" });
          });
          this.OPTION5(() => {
            this.CONSUME5(AsKw);
            this.SUBRULE5(this.nameToken, { LABEL: "refAlias" });
          });
        },
      },
    ]);
  });

  /**
   * Merged bridge wire (constant, pull/expression, or path scoping block):
   *   target = value
   *   target <-[!] sourceExpr [op operand]* [[] as iter { ...elements... }]
   *                           [|| alt]* [?? fallback]
   *   target { .field <- source | .field = value | .field { ... } }
   */
  public bridgeWire = this.RULE("bridgeWire", () => {
    this.SUBRULE(this.addressPath, { LABEL: "target" });
    this.OR([
      {
        // Constant wire: target = value
        ALT: () => {
          this.CONSUME(Equals, { LABEL: "equalsOp" });
          this.SUBRULE(this.bareValue, { LABEL: "constValue" });
        },
      },
      {
        // Pull wire: target <-[!] sourceExpr [op operand]* [modifiers]
        ALT: () => {
          this.CONSUME(Arrow, { LABEL: "arrow" });
          this.OR2([
            {
              // String literal as source (template or plain): target <- "..."
              ALT: () => {
                this.CONSUME(StringLiteral, { LABEL: "stringSource" });
              },
            },
            {
              // Normal source expression with optional `not` prefix
              ALT: () => {
                this.OPTION4(() => {
                  this.CONSUME(NotKw, { LABEL: "notPrefix" });
                });
                this.OR6([
                  {
                    // Parenthesized sub-expression as first source
                    ALT: () => {
                      this.SUBRULE(this.parenExpr, { LABEL: "firstParenExpr" });
                    },
                  },
                  {
                    ALT: () => {
                      this.SUBRULE(this.sourceExpr, { LABEL: "firstSource" });
                    },
                  },
                ]);
                // Optional expression chain: operator + operand, repeatable
                this.MANY2(() => {
                  this.SUBRULE(this.exprOperator, { LABEL: "exprOp" });
                  this.SUBRULE(this.exprOperand, { LABEL: "exprRight" });
                });
                // Optional ternary: ? thenBranch : elseBranch
                this.OPTION3(() => {
                  this.CONSUME(QuestionMark, { LABEL: "ternaryOp" });
                  this.SUBRULE(this.ternaryBranch, { LABEL: "thenBranch" });
                  this.CONSUME(Colon, { LABEL: "ternaryColon" });
                  this.SUBRULE2(this.ternaryBranch, { LABEL: "elseBranch" });
                });
              },
            },
          ]);
          // Optional array mapping: [] as <iter> { ... }
          this.OPTION(() => this.SUBRULE(this.arrayMapping));
          // || / ?? coalesce chain (mixed order)
          this.MANY(() => {
            this.SUBRULE(this.coalesceChainItem, { LABEL: "coalesceItem" });
          });
          // catch error fallback
          this.OPTION5(() => {
            this.CONSUME(CatchKw);
            this.SUBRULE3(this.coalesceAlternative, { LABEL: "catchAlt" });
          });
        },
      },
      {
        // Path scoping block: target { lines: .field <- source, .field = value, .field { ... }, alias ... as ..., ...source }
        ALT: () => {
          this.CONSUME(LCurly, { LABEL: "scopeBlock" });
          this.MANY3(() =>
            this.OR3([
              {
                ALT: () =>
                  this.SUBRULE(this.bridgeNodeAlias, { LABEL: "scopeAlias" }),
              },
              { ALT: () => this.SUBRULE(this.pathScopeLine) },
              { ALT: () => this.SUBRULE(this.scopeSpreadLine) },
            ]),
          );
          this.CONSUME(RCurly);
        },
      },
    ]);
  });

  /** [] as <iter> { ...element lines / local with-bindings... } */
  public arrayMapping = this.RULE("arrayMapping", () => {
    this.CONSUME(LSquare);
    this.CONSUME(RSquare);
    this.CONSUME(AsKw);
    this.SUBRULE(this.nameToken, { LABEL: "iterName" });
    this.CONSUME(LCurly);
    this.MANY(() =>
      this.OR([
        { ALT: () => this.SUBRULE(this.elementWithDecl) },
        { ALT: () => this.SUBRULE(this.elementLine) },
      ]),
    );
    this.CONSUME(RCurly);
  });

  /**
   * Block-scoped binding inside array mapping:
   *   alias <sourceExpr> as <name>
   * Evaluates the source once per element and binds the result to <name>.
   */
  public elementWithDecl = this.RULE("elementWithDecl", () => {
    this.CONSUME(AliasKw);
    this.SUBRULE(this.sourceExpr, { LABEL: "elemWithSource" });
    this.CONSUME(AsKw);
    this.SUBRULE(this.nameToken, { LABEL: "elemWithAlias" });
  });

  /**
   * Element line inside array mapping:
   *   .field = value
   *   .field <- source [op operand]*
   *   .field <- source [|| ...] [?? ...]
   *   .field <- source[] as iter { ...nested elements... }   (nested array)
   */
  public elementLine = this.RULE("elementLine", () => {
    this.CONSUME(Dot);
    this.SUBRULE(this.dottedPath, { LABEL: "elemTarget" });
    this.OR([
      {
        ALT: () => {
          this.CONSUME(Equals, { LABEL: "elemEquals" });
          this.SUBRULE(this.bareValue, { LABEL: "elemValue" });
        },
      },
      {
        ALT: () => {
          this.CONSUME(Arrow, { LABEL: "elemArrow" });
          this.OR2([
            {
              // String literal as source (template or plain): .field <- "..."
              ALT: () => {
                this.CONSUME(StringLiteral, { LABEL: "elemStringSource" });
              },
            },
            {
              // Normal source expression with optional `not` prefix
              ALT: () => {
                this.OPTION4(() => {
                  this.CONSUME(NotKw, { LABEL: "elemNotPrefix" });
                });
                this.OR4([
                  {
                    ALT: () => {
                      this.SUBRULE2(this.parenExpr, {
                        LABEL: "elemFirstParenExpr",
                      });
                    },
                  },
                  {
                    ALT: () => {
                      this.SUBRULE(this.sourceExpr, { LABEL: "elemSource" });
                    },
                  },
                ]);
                // Optional expression chain
                this.MANY2(() => {
                  this.SUBRULE(this.exprOperator, { LABEL: "elemExprOp" });
                  this.SUBRULE(this.exprOperand, { LABEL: "elemExprRight" });
                });
                // Optional ternary: ? thenBranch : elseBranch
                this.OPTION3(() => {
                  this.CONSUME(QuestionMark, { LABEL: "elemTernaryOp" });
                  this.SUBRULE(this.ternaryBranch, { LABEL: "elemThenBranch" });
                  this.CONSUME(Colon, { LABEL: "elemTernaryColon" });
                  this.SUBRULE2(this.ternaryBranch, {
                    LABEL: "elemElseBranch",
                  });
                });
              },
            },
          ]);
          // Optional nested array mapping: [] as <iter> { ... }
          this.OPTION2(() =>
            this.SUBRULE(this.arrayMapping, { LABEL: "nestedArrayMapping" }),
          );
          // || / ?? coalesce chain (mixed order, only when no nested array mapping)
          this.MANY(() => {
            this.SUBRULE2(this.coalesceChainItem, {
              LABEL: "elemCoalesceItem",
            });
          });
          // catch error fallback
          this.OPTION5(() => {
            this.CONSUME(CatchKw);
            this.SUBRULE3(this.coalesceAlternative, { LABEL: "elemCatchAlt" });
          });
        },
      },
      {
        // Path scope block: .field { lines: .subField <- source, ...source, .subField = value, ... }
        ALT: () => {
          this.CONSUME(LCurly, { LABEL: "elemScopeBlock" });
          this.MANY3(() =>
            this.OR3([
              {
                ALT: () =>
                  this.SUBRULE(this.pathScopeLine, { LABEL: "elemScopeLine" }),
              },
              {
                ALT: () =>
                  this.SUBRULE(this.scopeSpreadLine, {
                    LABEL: "elemSpreadLine",
                  }),
              },
            ]),
          );
          this.CONSUME(RCurly);
        },
      },
    ]);
  });

  /**
   * Path scope line: .target = value | .target <- source | .target { ... }
   *
   * Used inside path scoping blocks to build deeply nested objects
   * without repeating the full target path. Supports the same source
   * syntax as bridge wires (pipes, expressions, ternary, fallbacks).
   */
  public pathScopeLine = this.RULE("pathScopeLine", () => {
    this.CONSUME(Dot);
    this.SUBRULE(this.dottedPath, { LABEL: "scopeTarget" });
    this.OR([
      {
        // Constant: .field = value
        ALT: () => {
          this.CONSUME(Equals, { LABEL: "scopeEquals" });
          this.SUBRULE(this.bareValue, { LABEL: "scopeValue" });
        },
      },
      {
        // Pull wire: .field <- source [modifiers]
        ALT: () => {
          this.CONSUME(Arrow, { LABEL: "scopeArrow" });
          this.OR2([
            {
              ALT: () => {
                this.CONSUME(StringLiteral, { LABEL: "scopeStringSource" });
              },
            },
            {
              ALT: () => {
                this.OPTION3(() => {
                  this.CONSUME(NotKw, { LABEL: "scopeNotPrefix" });
                });
                this.OR5([
                  {
                    ALT: () => {
                      this.SUBRULE3(this.parenExpr, {
                        LABEL: "scopeFirstParenExpr",
                      });
                    },
                  },
                  {
                    ALT: () => {
                      this.SUBRULE(this.sourceExpr, { LABEL: "scopeSource" });
                    },
                  },
                ]);
                this.MANY(() => {
                  this.SUBRULE(this.exprOperator, { LABEL: "scopeExprOp" });
                  this.SUBRULE(this.exprOperand, { LABEL: "scopeExprRight" });
                });
                this.OPTION(() => {
                  this.CONSUME(QuestionMark, { LABEL: "scopeTernaryOp" });
                  this.SUBRULE(this.ternaryBranch, {
                    LABEL: "scopeThenBranch",
                  });
                  this.CONSUME(Colon, { LABEL: "scopeTernaryColon" });
                  this.SUBRULE2(this.ternaryBranch, {
                    LABEL: "scopeElseBranch",
                  });
                });
              },
            },
          ]);
          // || / ?? coalesce chain (mixed order)
          this.MANY2(() => {
            this.SUBRULE3(this.coalesceChainItem, {
              LABEL: "scopeCoalesceItem",
            });
          });
          // catch error fallback
          this.OPTION5(() => {
            this.CONSUME(CatchKw);
            this.SUBRULE3(this.coalesceAlternative, { LABEL: "scopeCatchAlt" });
          });
        },
      },
      {
        // Nested scope: .field { ... }
        ALT: () => {
          this.CONSUME(LCurly);
          this.MANY3(() =>
            this.OR3([
              {
                ALT: () =>
                  this.SUBRULE(this.bridgeNodeAlias, { LABEL: "scopeAlias" }),
              },
              { ALT: () => this.SUBRULE(this.pathScopeLine) },
              { ALT: () => this.SUBRULE(this.scopeSpreadLine) },
            ]),
          );
          this.CONSUME(RCurly);
        },
      },
    ]);
  });

  /**
   * Spread line inside a path scope block:
   *   ...sourceExpr
   *
   * Wires all fields of the source to the current scope target path.
   * Equivalent to writing `target <- sourceExpr` at the outer level.
   */
  public scopeSpreadLine = this.RULE("scopeSpreadLine", () => {
    this.CONSUME(Spread);
    this.SUBRULE(this.sourceExpr, { LABEL: "spreadSource" });
  });

  /** A coalesce alternative: either a JSON literal or a source expression */
  public coalesceAlternative = this.RULE("coalesceAlternative", () => {
    // Need to distinguish literal values from source references.
    // Literals start with StringLiteral, NumberLiteral,
    // TrueLiteral, FalseLiteral, NullLiteral, or LCurly (inline JSON object).
    // Sources start with Identifier or keyword-as-name (nameToken) which are
    // handle references.
    //
    // Potential ambiguity: TrueLiteral/FalseLiteral/NullLiteral could be
    // either a literal or a handle name. But the regex parser treats them as
    // literals in || and ?? position (isJsonLiteral check).
    // Identifiers are always source refs. So we use BACKTRACK for safety.
    //
    // Control flow keywords: throw "msg", panic "msg", continue, break
    this.OR([
      {
        ALT: () => {
          this.CONSUME(ThrowKw, { LABEL: "throwKw" });
          this.CONSUME(StringLiteral, { LABEL: "throwMsg" });
        },
      },
      {
        ALT: () => {
          this.CONSUME(PanicKw, { LABEL: "panicKw" });
          this.CONSUME2(StringLiteral, { LABEL: "panicMsg" });
        },
      },
      { ALT: () => this.CONSUME(ContinueKw, { LABEL: "continueKw" }) },
      { ALT: () => this.CONSUME(BreakKw, { LABEL: "breakKw" }) },
      { ALT: () => this.CONSUME3(StringLiteral, { LABEL: "stringLit" }) },
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numberLit" }) },
      { ALT: () => this.CONSUME(TrueLiteral, { LABEL: "trueLit" }) },
      { ALT: () => this.CONSUME(FalseLiteral, { LABEL: "falseLit" }) },
      { ALT: () => this.CONSUME(NullLiteral, { LABEL: "nullLit" }) },
      {
        ALT: () => this.SUBRULE(this.jsonInlineObject, { LABEL: "objectLit" }),
      },
      { ALT: () => this.SUBRULE(this.sourceExpr, { LABEL: "sourceAlt" }) },
    ]);
  });

  /**
   * A single item in a coalesce chain: either `|| alt` or `?? alt`.
   * Grouping both operators into one rule preserves their relative order
   * when mixing `||` and `??` in a single wire.
   */
  public coalesceChainItem = this.RULE("coalesceChainItem", () => {
    this.OR([
      { ALT: () => this.CONSUME(NullCoalesce, { LABEL: "falsyOp" }) },
      { ALT: () => this.CONSUME(ErrorCoalesce, { LABEL: "nullishOp" }) },
    ]);
    this.SUBRULE(this.coalesceAlternative, { LABEL: "altValue" });
  });

  // ── Define block ───────────────────────────────────────────────────────

  public defineBlock = this.RULE("defineBlock", () => {
    this.CONSUME(DefineKw);
    this.SUBRULE(this.nameToken, { LABEL: "defineName" });
    this.CONSUME(LCurly);
    this.MANY(() => this.SUBRULE(this.bridgeBodyLine));
    this.CONSUME(RCurly);
  });

  // ── Const declaration ──────────────────────────────────────────────────

  /** const <name> = <jsonValue> */
  public constDecl = this.RULE("constDecl", () => {
    this.CONSUME(ConstKw);
    this.SUBRULE(this.nameToken, { LABEL: "constName" });
    this.CONSUME(Equals);
    this.SUBRULE(this.jsonValue, { LABEL: "constValue" });
  });

  // ── Shared sub-rules ──────────────────────────────────────────────────

  /** Source expression: [pipe:]*address  (pipe chain or simple ref) */
  public sourceExpr = this.RULE("sourceExpr", () => {
    this.SUBRULE(this.addressPath, { LABEL: "head" });
    this.MANY(() => {
      this.CONSUME(Colon);
      this.SUBRULE2(this.addressPath, { LABEL: "pipeSegment" });
    });
  });

  /** Expression operator: arithmetic, comparison, or boolean */
  public exprOperator = this.RULE("exprOperator", () => {
    this.OR([
      { ALT: () => this.CONSUME(Star, { LABEL: "star" }) },
      { ALT: () => this.CONSUME(Slash, { LABEL: "slash" }) },
      { ALT: () => this.CONSUME(Plus, { LABEL: "plus" }) },
      { ALT: () => this.CONSUME(Minus, { LABEL: "minus" }) },
      { ALT: () => this.CONSUME(DoubleEquals, { LABEL: "doubleEquals" }) },
      { ALT: () => this.CONSUME(NotEquals, { LABEL: "notEquals" }) },
      { ALT: () => this.CONSUME(GreaterEqual, { LABEL: "greaterEqual" }) },
      { ALT: () => this.CONSUME(LessEqual, { LABEL: "lessEqual" }) },
      { ALT: () => this.CONSUME(GreaterThan, { LABEL: "greaterThan" }) },
      { ALT: () => this.CONSUME(LessThan, { LABEL: "lessThan" }) },
      { ALT: () => this.CONSUME(AndKw, { LABEL: "andKw" }) },
      { ALT: () => this.CONSUME(OrKw, { LABEL: "orKw" }) },
    ]);
  });

  /** Expression operand: a source reference, a literal value, or a parenthesized sub-expression */
  public exprOperand = this.RULE("exprOperand", () => {
    this.OR([
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numberLit" }) },
      { ALT: () => this.CONSUME(StringLiteral, { LABEL: "stringLit" }) },
      { ALT: () => this.CONSUME(TrueLiteral, { LABEL: "trueLit" }) },
      { ALT: () => this.CONSUME(FalseLiteral, { LABEL: "falseLit" }) },
      { ALT: () => this.CONSUME(NullLiteral, { LABEL: "nullLit" }) },
      { ALT: () => this.SUBRULE(this.parenExpr, { LABEL: "parenExpr" }) },
      { ALT: () => this.SUBRULE(this.sourceExpr, { LABEL: "sourceRef" }) },
    ]);
  });

  /** Parenthesized sub-expression: ( [not] source [op operand]* ) */
  public parenExpr = this.RULE("parenExpr", () => {
    this.CONSUME(LParen);
    this.OPTION(() => {
      this.CONSUME(NotKw, { LABEL: "parenNotPrefix" });
    });
    this.SUBRULE(this.sourceExpr, { LABEL: "parenSource" });
    this.MANY(() => {
      this.SUBRULE(this.exprOperator, { LABEL: "parenExprOp" });
      this.SUBRULE(this.exprOperand, { LABEL: "parenExprRight" });
    });
    this.CONSUME(RParen);
  });

  /**
   * Ternary branch: the then/else operand in `cond ? then : else`.
   * Restricted to simple address paths and literals (no pipe chains)
   * to avoid ambiguity with the `:` separator.
   */
  public ternaryBranch = this.RULE("ternaryBranch", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral, { LABEL: "stringLit" }) },
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numberLit" }) },
      { ALT: () => this.CONSUME(TrueLiteral, { LABEL: "trueLit" }) },
      { ALT: () => this.CONSUME(FalseLiteral, { LABEL: "falseLit" }) },
      { ALT: () => this.CONSUME(NullLiteral, { LABEL: "nullLit" }) },
      { ALT: () => this.SUBRULE(this.addressPath, { LABEL: "sourceRef" }) },
    ]);
  });

  /**
   * Address path: a dotted reference with optional array indices.
   * Examples: o.lat, i.name, g.items[0].position.lat, o
   *
   * Note: empty brackets `[]` are NOT consumed here — they belong to
   * the array mapping rule. The GATE on MANY prevents entering when `[`
   * is followed by `]` (empty brackets).
   *
   * Line-boundary guard: stops consuming dots that cross a newline,
   * so `.id` on the next line isn't greedily absorbed as a path continuation
   * inside element blocks.
   */
  public addressPath = this.RULE("addressPath", () => {
    this.SUBRULE(this.nameToken, { LABEL: "root" });
    this.MANY({
      GATE: () => {
        const la = this.LA(1);
        if (la.tokenType === Dot || la.tokenType === SafeNav) {
          // Don't continue across a line break — prevents greedy path
          // consumption in multi-line contexts like element blocks.
          // LA(0) gives the last consumed token.
          const prev = this.LA(0);
          if (
            prev &&
            la.startLine != null &&
            prev.endLine != null &&
            la.startLine > prev.endLine
          ) {
            return false;
          }
          return true;
        }
        if (la.tokenType === LSquare) {
          const la2 = this.LA(2);
          return la2.tokenType === NumberLiteral;
        }
        return false;
      },
      DEF: () => {
        this.OR([
          {
            ALT: () => {
              this.CONSUME(Dot);
              this.SUBRULE(this.pathSegment, { LABEL: "segment" });
            },
          },
          {
            ALT: () => {
              this.CONSUME(SafeNav, { LABEL: "safeNav" });
              this.SUBRULE2(this.pathSegment, { LABEL: "segment" });
            },
          },
          {
            ALT: () => {
              this.CONSUME(LSquare);
              this.CONSUME(NumberLiteral, { LABEL: "arrayIndex" });
              this.CONSUME(RSquare);
            },
          },
        ]);
      },
    });
  });

  /** Segment after a dot: any identifier or keyword usable in a path */
  public pathSegment = this.RULE("pathSegment", () => {
    this.OR([
      { ALT: () => this.CONSUME(Identifier) },
      { ALT: () => this.CONSUME(InputKw) },
      { ALT: () => this.CONSUME(OutputKw) },
      { ALT: () => this.CONSUME(ContextKw) },
      { ALT: () => this.CONSUME(ConstKw) },
      { ALT: () => this.CONSUME(ErrorKw) },
      { ALT: () => this.CONSUME(OnKw) },
      { ALT: () => this.CONSUME(FromKw) },
      { ALT: () => this.CONSUME(AsKw) },
      { ALT: () => this.CONSUME(ToolKw) },
      { ALT: () => this.CONSUME(BridgeKw) },
      { ALT: () => this.CONSUME(DefineKw) },
      { ALT: () => this.CONSUME(WithKw) },
      { ALT: () => this.CONSUME(VersionKw) },
      { ALT: () => this.CONSUME(TrueLiteral) },
      { ALT: () => this.CONSUME(FalseLiteral) },
      { ALT: () => this.CONSUME(NullLiteral) },
      { ALT: () => this.CONSUME(AndKw) },
      { ALT: () => this.CONSUME(OrKw) },
      { ALT: () => this.CONSUME(NotKw) },
    ]);
  });

  /** Dotted name: identifier segments separated by dots */
  public dottedName = this.RULE("dottedName", () => {
    this.SUBRULE(this.nameToken, { LABEL: "first" });
    this.MANY({
      GATE: () => {
        const la = this.LA(1);
        if (la.tokenType !== Dot) return false;
        const prev = this.LA(0);
        if (
          prev &&
          la.startLine != null &&
          prev.endLine != null &&
          la.startLine > prev.endLine
        )
          return false;
        return true;
      },
      DEF: () => {
        this.CONSUME(Dot);
        this.SUBRULE2(this.nameToken, { LABEL: "rest" });
      },
    });
  });

  /** Dotted path (within tool block): segments after a leading dot */
  public dottedPath = this.RULE("dottedPath", () => {
    this.SUBRULE(this.pathSegment, { LABEL: "first" });
    this.MANY({
      GATE: () => {
        const la = this.LA(1);
        if (la.tokenType !== Dot) return false;
        const prev = this.LA(0);
        if (
          prev &&
          la.startLine != null &&
          prev.endLine != null &&
          la.startLine > prev.endLine
        )
          return false;
        return true;
      },
      DEF: () => {
        this.CONSUME(Dot);
        this.SUBRULE2(this.pathSegment, { LABEL: "rest" });
      },
    });
  });

  /** A name token: Identifier or certain keywords usable as names.
   *  Note: true/false/null are NOT allowed here to avoid ambiguity with
   *  literals in coalesceAlternative. They ARE allowed in pathSegment. */
  public nameToken = this.RULE("nameToken", () => {
    this.OR([
      { ALT: () => this.CONSUME(Identifier) },
      { ALT: () => this.CONSUME(InputKw) },
      { ALT: () => this.CONSUME(OutputKw) },
      { ALT: () => this.CONSUME(ContextKw) },
      { ALT: () => this.CONSUME(ConstKw) },
      { ALT: () => this.CONSUME(ErrorKw) },
      { ALT: () => this.CONSUME(OnKw) },
      { ALT: () => this.CONSUME(FromKw) },
      { ALT: () => this.CONSUME(AsKw) },
      { ALT: () => this.CONSUME(ToolKw) },
      { ALT: () => this.CONSUME(BridgeKw) },
      { ALT: () => this.CONSUME(DefineKw) },
      { ALT: () => this.CONSUME(WithKw) },
      { ALT: () => this.CONSUME(VersionKw) },
      { ALT: () => this.CONSUME(AliasKw) },
    ]);
  });

  /** Bare value: string, number, path, boolean, null, or unquoted identifier */
  public bareValue = this.RULE("bareValue", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral) },
      { ALT: () => this.CONSUME(NumberLiteral) },
      { ALT: () => this.CONSUME(PathToken) },
      { ALT: () => this.CONSUME(TrueLiteral) },
      { ALT: () => this.CONSUME(FalseLiteral) },
      { ALT: () => this.CONSUME(NullLiteral) },
      { ALT: () => this.CONSUME(Identifier) },
      { ALT: () => this.CONSUME(InputKw) },
      { ALT: () => this.CONSUME(OutputKw) },
      { ALT: () => this.CONSUME(ErrorKw) },
      { ALT: () => this.CONSUME(OnKw) },
      { ALT: () => this.CONSUME(FromKw) },
      { ALT: () => this.CONSUME(AsKw) },
      { ALT: () => this.CONSUME(AliasKw) },
    ]);
  });

  /** JSON value: string, number, boolean, null, object, or array */
  public jsonValue = this.RULE("jsonValue", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral, { LABEL: "string" }) },
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "number" }) },
      { ALT: () => this.CONSUME(TrueLiteral, { LABEL: "true" }) },
      { ALT: () => this.CONSUME(FalseLiteral, { LABEL: "false" }) },
      { ALT: () => this.CONSUME(NullLiteral, { LABEL: "null" }) },
      { ALT: () => this.SUBRULE(this.jsonObject, { LABEL: "object" }) },
      { ALT: () => this.SUBRULE(this.jsonArray, { LABEL: "array" }) },
    ]);
  });

  /** JSON object: { ... } — we accept any tokens inside and reconstruct in the visitor */
  public jsonObject = this.RULE("jsonObject", () => {
    this.CONSUME(LCurly);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(StringLiteral) },
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(Colon) },
        { ALT: () => this.CONSUME(Comma) },
        { ALT: () => this.CONSUME(TrueLiteral) },
        { ALT: () => this.CONSUME(FalseLiteral) },
        { ALT: () => this.CONSUME(NullLiteral) },
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(LSquare) },
        { ALT: () => this.CONSUME(RSquare) },
        { ALT: () => this.CONSUME(Dot) },
        { ALT: () => this.CONSUME(Equals) },
        { ALT: () => this.CONSUME(AndKw) },
        { ALT: () => this.CONSUME(OrKw) },
        { ALT: () => this.CONSUME(NotKw) },
        // Nested objects
        { ALT: () => this.SUBRULE(this.jsonObject) },
      ]);
    });
    this.CONSUME(RCurly);
  });

  /** JSON array: [ ... ] */
  public jsonArray = this.RULE("jsonArray", () => {
    this.CONSUME(LSquare);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(StringLiteral) },
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(Colon) },
        { ALT: () => this.CONSUME(Comma) },
        { ALT: () => this.CONSUME(TrueLiteral) },
        { ALT: () => this.CONSUME(FalseLiteral) },
        { ALT: () => this.CONSUME(NullLiteral) },
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(Dot) },
        { ALT: () => this.SUBRULE(this.jsonObject) },
        { ALT: () => this.SUBRULE(this.jsonArray) },
      ]);
    });
    this.CONSUME(RSquare);
  });

  /** Inline JSON object — used in coalesce alternatives */
  public jsonInlineObject = this.RULE("jsonInlineObject", () => {
    this.CONSUME(LCurly);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(StringLiteral) },
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(Colon) },
        { ALT: () => this.CONSUME(Comma) },
        { ALT: () => this.CONSUME(TrueLiteral) },
        { ALT: () => this.CONSUME(FalseLiteral) },
        { ALT: () => this.CONSUME(NullLiteral) },
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(LSquare) },
        { ALT: () => this.CONSUME(RSquare) },
        { ALT: () => this.CONSUME(Dot) },
        { ALT: () => this.CONSUME(Equals) },
        { ALT: () => this.SUBRULE(this.jsonInlineObject) },
      ]);
    });
    this.CONSUME(RCurly);
  });
}

// Singleton parser instances (Chevrotain best practice)
// Strict instance: throws on first error (used by parseBridgeChevrotain)
const parserInstance = new BridgeParser();
// Lenient instance: error recovery enabled (used by parseBridgeDiagnostics)
const diagParserInstance = new BridgeParser({ recovery: true });

const BRIDGE_VERSION = "1.5";
/** Minimum major version the parser can handle (inclusive). */
const BRIDGE_MIN_MAJOR = 1;
/** Maximum major version the parser can handle (inclusive). */
const BRIDGE_MAX_MAJOR = 1;

/** Exported parser version metadata for runtime use. */
export const PARSER_VERSION = {
  /** Current bridge language version */
  current: BRIDGE_VERSION,
  /** Minimum supported major version (inclusive) */
  minMajor: BRIDGE_MIN_MAJOR,
  /** Maximum supported major version (inclusive) */
  maxMajor: BRIDGE_MAX_MAJOR,
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════════

export function parseBridgeChevrotain(text: string): BridgeDocument {
  return internalParse(text);
}

export function parseBridgeCst(text: string): CstNode {
  const lexResult = BridgeLexer.tokenize(text);
  if (lexResult.errors.length > 0) {
    const e = lexResult.errors[0];
    throw new Error(`Line ${e.line}: Unexpected character "${e.message}"`);
  }

  parserInstance.input = lexResult.tokens;
  const cst = parserInstance.program();
  if (parserInstance.errors.length > 0) {
    const e = parserInstance.errors[0];
    throw new Error(e.message);
  }

  return cst;
}

// ── Diagnostic types ──────────────────────────────────────────────────────

export type BridgeDiagnostic = {
  message: string;
  severity: "error" | "warning";
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
};

export type BridgeParseResult = {
  document: BridgeDocument;
  diagnostics: BridgeDiagnostic[];
  /** 1-based start line for each top-level instruction */
  startLines: Map<Instruction, number>;
};

/**
 * Parse a Bridge DSL text and return both the AST and all diagnostics.
 * Uses Chevrotain's error recovery — always returns a (possibly partial) AST
 * even when the file has errors. Designed for LSP/IDE use.
 */
export function parseBridgeDiagnostics(text: string): BridgeParseResult {
  const diagnostics: BridgeDiagnostic[] = [];

  // 1. Lex
  const lexResult = BridgeLexer.tokenize(text);
  for (const e of lexResult.errors) {
    diagnostics.push({
      message: e.message,
      severity: "error",
      range: {
        start: { line: (e.line ?? 1) - 1, character: (e.column ?? 1) - 1 },
        end: {
          line: (e.line ?? 1) - 1,
          character: (e.column ?? 1) - 1 + e.length,
        },
      },
    });
  }

  // 2. Parse with Chevrotain error recovery (builds partial CST past errors)
  diagParserInstance.input = lexResult.tokens;
  const cst = diagParserInstance.program();
  for (const e of diagParserInstance.errors) {
    const t = e.token;
    diagnostics.push({
      message: e.message,
      severity: "error",
      range: {
        start: {
          line: (t.startLine ?? 1) - 1,
          character: (t.startColumn ?? 1) - 1,
        },
        end: {
          line: (t.endLine ?? t.startLine ?? 1) - 1,
          character: t.endColumn ?? t.startColumn ?? 1,
        },
      },
    });
  }

  // 3. Visit → AST (semantic errors thrown as "Line N: ..." messages)
  let document: BridgeDocument = { instructions: [] };
  let startLines = new Map<Instruction, number>();
  try {
    const result = toBridgeAst(cst, []);
    document = { version: result.version, instructions: result.instructions };
    startLines = result.startLines;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const m = msg.match(/^Line (\d+):/);
    const errorLine = m ? parseInt(m[1]) - 1 : 0;
    diagnostics.push({
      message: msg.replace(/^Line \d+:\s*/, ""),
      severity: "error",
      range: {
        start: { line: errorLine, character: 0 },
        end: { line: errorLine, character: 999 },
      },
    });
  }

  return { document, diagnostics, startLines };
}

function internalParse(
  text: string,
  previousInstructions?: Instruction[],
): BridgeDocument {
  // 1. Lex
  const lexResult = BridgeLexer.tokenize(text);
  if (lexResult.errors.length > 0) {
    const e = lexResult.errors[0];
    throw new Error(`Line ${e.line}: Unexpected character "${e.message}"`);
  }

  // 2. Parse
  parserInstance.input = lexResult.tokens;
  const cst = parserInstance.program();
  if (parserInstance.errors.length > 0) {
    const e = parserInstance.errors[0];
    throw new Error(e.message);
  }

  // 3. Visit → AST
  const result = toBridgeAst(cst, previousInstructions);
  return { version: result.version, instructions: result.instructions };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CST → AST transformation (imperative visitor)
// ═══════════════════════════════════════════════════════════════════════════

// ── Token / CST node helpers ────────────────────────────────────────────

function sub(node: CstNode, ruleName: string): CstNode | undefined {
  const nodes = node.children[ruleName] as CstNode[] | undefined;
  return nodes?.[0];
}

function subs(node: CstNode, ruleName: string): CstNode[] {
  return (node.children[ruleName] as CstNode[] | undefined) ?? [];
}

function tok(node: CstNode, tokenName: string): IToken | undefined {
  const tokens = node.children[tokenName] as IToken[] | undefined;
  return tokens?.[0];
}

function toks(node: CstNode, tokenName: string): IToken[] {
  return (node.children[tokenName] as IToken[] | undefined) ?? [];
}

function line(token: IToken | undefined): number {
  return token?.startLine ?? 0;
}

/* ── extractNameToken: get string from nameToken CST node ── */
function extractNameToken(node: CstNode): string {
  const c = node.children;
  for (const key of Object.keys(c)) {
    const tokens = c[key] as IToken[] | undefined;
    if (tokens?.[0]) return tokens[0].image;
  }
  return "";
}

/* ── extractDottedName: reassemble from dottedName CST node ── */
function extractDottedName(node: CstNode): string {
  const first = extractNameToken(sub(node, "first")!);
  const rest = subs(node, "rest").map((n) => extractNameToken(n));
  return [first, ...rest].join(".");
}

/* ── extractPathSegment: get string from pathSegment ── */
function extractPathSegment(node: CstNode): string {
  for (const key of Object.keys(node.children)) {
    const tokens = node.children[key] as IToken[] | undefined;
    if (tokens?.[0]) return tokens[0].image;
  }
  return "";
}

/* ── extractDottedPathStr: reassemble from dottedPath CST node ── */
function extractDottedPathStr(node: CstNode): string {
  const first = extractPathSegment(sub(node, "first")!);
  const rest = subs(node, "rest").map((n) => extractPathSegment(n));
  return [first, ...rest].join(".");
}

/* ── extractAddressPath: get root + segments preserving order ── */
function extractAddressPath(node: CstNode): {
  root: string;
  segments: string[];
  safe?: boolean;
  rootSafe?: boolean;
  segmentSafe?: boolean[];
} {
  const root = extractNameToken(sub(node, "root")!);
  type Seg = { offset: number; value: string };
  const items: Seg[] = [];
  const safeNavTokens = (node.children.safeNav as IToken[] | undefined) ?? [];
  const hasSafeNav = safeNavTokens.length > 0;

  // Also collect Dot token offsets
  const dotTokens = (node.children.Dot as IToken[] | undefined) ?? [];

  for (const seg of subs(node, "segment")) {
    items.push({
      offset:
        seg.location?.startOffset ?? findFirstToken(seg)?.startOffset ?? 0,
      value: extractPathSegment(seg),
    });
  }
  for (const idxTok of toks(node, "arrayIndex")) {
    if (idxTok.image.includes(".")) {
      throw new Error(
        `Line ${idxTok.startLine}: Array indices must be integers, found "${idxTok.image}"`,
      );
    }
    items.push({ offset: idxTok.startOffset, value: idxTok.image });
  }
  items.sort((a, b) => a.offset - b.offset);

  // For each segment, determine if it was preceded by a SafeNav token.
  // Collect all separators (Dot + SafeNav) sorted by offset, then correlate with segments.
  const allSeps: { offset: number; isSafe: boolean }[] = [
    ...dotTokens.map((t) => ({ offset: t.startOffset, isSafe: false })),
    ...safeNavTokens.map((t) => ({ offset: t.startOffset, isSafe: true })),
  ].sort((a, b) => a.offset - b.offset);

  // Match separators to segments: each separator precedes the next segment
  const segmentSafe: boolean[] = [];
  let rootSafe = false;
  let sepIdx = -1;
  for (let i = 0; i < items.length; i++) {
    const segOffset = items[i].offset;
    while (
      sepIdx + 1 < allSeps.length &&
      allSeps[sepIdx + 1].offset < segOffset
    ) {
      sepIdx++;
    }
    const isSafe = sepIdx >= 0 ? allSeps[sepIdx].isSafe : false;
    if (i === 0) {
      rootSafe = isSafe;
    }
    segmentSafe.push(isSafe);
  }

  return {
    root,
    segments: items.map((i) => i.value),
    ...(hasSafeNav ? { safe: true } : {}),
    ...(rootSafe ? { rootSafe } : {}),
    ...(segmentSafe.some((s) => s) ? { segmentSafe } : {}),
  };
}

function findFirstToken(node: CstNode): IToken | undefined {
  for (const key of Object.keys(node.children)) {
    const child = node.children[key];
    if (Array.isArray(child) && child.length > 0) {
      const first = child[0];
      if ("image" in first) return first as IToken;
      if ("children" in first) return findFirstToken(first as CstNode);
    }
  }
  return undefined;
}

/* ── parsePath: split "a.b[0].c" → ["a","b","0","c"] ── */
function parsePath(text: string): string[] {
  return text.split(/\.|\[|\]/).filter(Boolean);
}

/* ── Collect all tokens recursively from a CST node ── */
function collectTokens(node: CstNode, out: IToken[]): void {
  for (const key of Object.keys(node.children)) {
    const children = node.children[key];
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if ("image" in child) out.push(child as IToken);
      else if ("children" in child) collectTokens(child as CstNode, out);
    }
  }
}

function reconstructJson(node: CstNode): string {
  const tokens: IToken[] = [];
  collectTokens(node, tokens);
  tokens.sort((a, b) => a.startOffset - b.startOffset);
  // Reconstruct with original spacing preserved (using offsets to insert whitespace)
  if (tokens.length === 0) return "";
  let result = tokens[0].image;
  for (let i = 1; i < tokens.length; i++) {
    const gap =
      tokens[i].startOffset -
      (tokens[i - 1].startOffset + tokens[i - 1].image.length);
    if (gap > 0) result += " ".repeat(gap);
    result += tokens[i].image;
  }
  return result;
}

/* ── extractBareValue: get the string from a bareValue CST node ── */
function extractBareValue(node: CstNode): string {
  for (const key of Object.keys(node.children)) {
    const tokens = node.children[key] as IToken[] | undefined;
    if (tokens?.[0]) {
      let val = tokens[0].image;
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      return val;
    }
  }
  return "";
}

/* ── parseTemplateString: split a string into text and ref segments ── */
type TemplateSeg =
  | { kind: "text"; value: string }
  | { kind: "ref"; path: string };

function parseTemplateString(raw: string): TemplateSeg[] | null {
  // raw is the content between quotes (already stripped of outer quotes)
  const segs: TemplateSeg[] = [];
  let i = 0;
  let hasRef = false;
  let text = "";
  while (i < raw.length) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      if (raw[i + 1] === "{") {
        text += "{";
        i += 2;
        continue;
      }
      // preserve other escapes as-is
      text += raw[i] + raw[i + 1];
      i += 2;
      continue;
    }
    if (raw[i] === "{") {
      const end = raw.indexOf("}", i + 1);
      if (end === -1) {
        // unclosed brace — treat as literal text
        text += raw[i];
        i++;
        continue;
      }
      const ref = raw.slice(i + 1, end).trim();
      if (ref.length === 0) {
        text += "{}";
        i = end + 1;
        continue;
      }
      if (text.length > 0) {
        segs.push({ kind: "text", value: text });
        text = "";
      }
      segs.push({ kind: "ref", path: ref });
      hasRef = true;
      i = end + 1;
      continue;
    }
    text += raw[i];
    i++;
  }
  if (text.length > 0) segs.push({ kind: "text", value: text });
  return hasRef ? segs : null;
}

/* ── extractJsonValue: from a jsonValue CST node ── */
function extractJsonValue(node: CstNode): string {
  const c = node.children;
  if (c.string) return (c.string as IToken[])[0].image; // keep quotes for JSON.parse
  if (c.number) return (c.number as IToken[])[0].image;
  if (c.integer) return (c.integer as IToken[])[0].image;
  if (c.true) return "true";
  if (c.false) return "false";
  if (c.null) return "null";
  if (c.object) return reconstructJson((c.object as CstNode[])[0]);
  if (c.array) return reconstructJson((c.array as CstNode[])[0]);
  return "";
}

// ── Handle resolution type ──────────────────────────────────────────────

type HandleResolution = {
  module: string;
  type: string;
  field: string;
  instance?: number;
};

// ═══════════════════════════════════════════════════════════════════════════
//  Recursive element-line processor (supports nested array-in-array mapping)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process element lines inside an array mapping block.
 * When an element line itself contains a nested `[] as iter { ... }` block,
 * this function registers the inner iterator and recurses into the nested
 * element lines, building wires with the correct concatenated paths.
 */
function processElementLines(
  elemLines: CstNode[],
  arrayToPath: string[],
  iterName: string,
  bridgeType: string,
  bridgeField: string,
  wires: Wire[],
  arrayIterators: Record<string, string>,
  buildSourceExpr: (
    node: CstNode,
    lineNum: number,
    iterName?: string,
  ) => NodeRef,
  extractCoalesceAlt: (
    altNode: CstNode,
    lineNum: number,
    iterName?: string,
  ) =>
    | { literal: string }
    | { sourceRef: NodeRef }
    | { control: ControlFlowInstruction },
  desugarExprChain?: (
    leftRef: NodeRef,
    exprOps: CstNode[],
    exprRights: CstNode[],
    lineNum: number,
    iterName?: string,
    safe?: boolean,
  ) => NodeRef,
  extractTernaryBranchFn?: (
    branchNode: CstNode,
    lineNum: number,
    iterName?: string,
  ) => { kind: "literal"; value: string } | { kind: "ref"; ref: NodeRef },
  processLocalBindings?: (withDecls: CstNode[], iterName: string) => () => void,
  desugarTemplateStringFn?: (
    segs: TemplateSeg[],
    lineNum: number,
    iterName?: string,
  ) => NodeRef,
  desugarNotFn?: (
    sourceRef: NodeRef,
    lineNum: number,
    safe?: boolean,
  ) => NodeRef,
  resolveParenExprFn?: (
    parenNode: CstNode,
    lineNum: number,
    iterName?: string,
    safe?: boolean,
  ) => NodeRef,
): void {
  function extractCoalesceAltIterAware(
    altNode: CstNode,
    lineNum: number,
  ):
    | { literal: string }
    | { sourceRef: NodeRef }
    | { control: ControlFlowInstruction } {
    const c = altNode.children;
    if (c.sourceAlt) {
      const srcNode = (c.sourceAlt as CstNode[])[0];
      const headNode = sub(srcNode, "head");
      if (headNode) {
        const { root, segments } = extractAddressPath(headNode);
        const pipeSegs = subs(srcNode, "pipeSegment");
        if (root === iterName && pipeSegs.length === 0) {
          return {
            sourceRef: {
              module: SELF_MODULE,
              type: bridgeType,
              field: bridgeField,
              element: true,
              path: segments,
            },
          };
        }
      }
    }
    return extractCoalesceAlt(altNode, lineNum, iterName);
  }

  for (const elemLine of elemLines) {
    const elemC = elemLine.children;
    const elemLineNum = line(findFirstToken(elemLine));
    const elemTargetPathStr = extractDottedPathStr(
      sub(elemLine, "elemTarget")!,
    );
    const elemToPath = [...arrayToPath, ...parsePath(elemTargetPathStr)];

    if (elemC.elemEquals) {
      const value = extractBareValue(sub(elemLine, "elemValue")!);
      wires.push({
        value,
        to: {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: elemToPath,
        },
      });
    } else if (elemC.elemArrow) {
      // ── String source in element context: .field <- "..." ──
      const elemStrToken = (
        elemC.elemStringSource as IToken[] | undefined
      )?.[0];
      if (elemStrToken && desugarTemplateStringFn) {
        const raw = elemStrToken.image.slice(1, -1);
        const segs = parseTemplateString(raw);

        const elemToRef: NodeRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          path: elemToPath,
        };

        // Process coalesce modifiers
        const fallbacks: WireFallback[] = [];
        const fallbackInternalWires: Wire[] = [];
        for (const item of subs(elemLine, "elemCoalesceItem")) {
          const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
          const altNode = sub(item, "altValue")!;
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(altNode, elemLineNum);
          if ("literal" in altResult) {
            fallbacks.push({ type, value: altResult.literal });
          } else if ("control" in altResult) {
            fallbacks.push({ type, control: altResult.control });
          } else {
            fallbacks.push({ type, ref: altResult.sourceRef });
            fallbackInternalWires.push(...wires.splice(preLen));
          }
        }
        let catchFallback: string | undefined;
        let catchControl: ControlFlowInstruction | undefined;
        let catchFallbackRef: NodeRef | undefined;
        let catchFallbackInternalWires: Wire[] = [];
        const catchAlt = sub(elemLine, "elemCatchAlt");
        if (catchAlt) {
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(catchAlt, elemLineNum);
          if ("literal" in altResult) {
            catchFallback = altResult.literal;
          } else if ("control" in altResult) {
            catchControl = altResult.control;
          } else {
            catchFallbackRef = altResult.sourceRef;
            catchFallbackInternalWires = wires.splice(preLen);
          }
        }

        const lastAttrs = {
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          ...(catchFallback ? { catchFallback } : {}),
          ...(catchFallbackRef ? { catchFallbackRef } : {}),
          ...(catchControl ? { catchControl } : {}),
        };

        if (segs) {
          const concatOutRef = desugarTemplateStringFn(
            segs,
            elemLineNum,
            iterName,
          );
          const elemToRefWithElement: NodeRef = { ...elemToRef, element: true };
          wires.push({
            from: concatOutRef,
            to: elemToRefWithElement,
            pipe: true,
            ...lastAttrs,
          });
        } else {
          wires.push({ value: raw, to: elemToRef, ...lastAttrs });
        }
        wires.push(...fallbackInternalWires);
        wires.push(...catchFallbackInternalWires);
        continue;
      }

      const elemSourceNode = sub(elemLine, "elemSource");
      const elemFirstParenNode = sub(elemLine, "elemFirstParenExpr");

      // Check if iterator-relative source (only for non-paren sources)
      let elemHeadNode: CstNode | undefined;
      let elemPipeSegs: CstNode[] = [];
      let elemSrcRoot: string = "";
      let elemSrcSegs: string[] = [];
      let elemSafe: boolean = false;
      if (elemSourceNode) {
        elemHeadNode = sub(elemSourceNode, "head")!;
        elemPipeSegs = subs(elemSourceNode, "pipeSegment");
        const extracted = extractAddressPath(elemHeadNode);
        elemSrcRoot = extracted.root;
        elemSrcSegs = extracted.segments;
        elemSafe = !!extracted.rootSafe;
      }

      // ── Nested array mapping: .legs <- j.legs[] as l { ... } ──
      const nestedArrayNode = (
        elemC.nestedArrayMapping as CstNode[] | undefined
      )?.[0];
      if (nestedArrayNode) {
        // Emit the pass-through wire for the inner array source
        let innerFromRef: NodeRef;
        if (elemSrcRoot === iterName && elemPipeSegs.length === 0) {
          innerFromRef = {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: elemSrcSegs,
          };
        } else {
          innerFromRef = buildSourceExpr(
            elemSourceNode!,
            elemLineNum,
            iterName,
          );
        }
        const innerToRef: NodeRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          path: elemToPath,
        };
        wires.push({ from: innerFromRef, to: innerToRef });

        // Register the inner iterator
        const innerIterName = extractNameToken(
          sub(nestedArrayNode, "iterName")!,
        );
        assertNotReserved(innerIterName, elemLineNum, "iterator handle");
        // Key by the joined path for nested arrays (e.g. "legs" or "journeys.legs")
        const iterKey = elemToPath.join(".");
        arrayIterators[iterKey] = innerIterName;

        // Recurse into nested element lines
        const nestedWithDecls = subs(nestedArrayNode, "elementWithDecl");
        const nestedCleanup = processLocalBindings?.(
          nestedWithDecls,
          innerIterName,
        );
        processElementLines(
          subs(nestedArrayNode, "elementLine"),
          elemToPath,
          innerIterName,
          bridgeType,
          bridgeField,
          wires,
          arrayIterators,
          buildSourceExpr,
          extractCoalesceAlt,
          desugarExprChain,
          extractTernaryBranchFn,
          processLocalBindings,
          desugarTemplateStringFn,
          desugarNotFn,
          resolveParenExprFn,
        );
        nestedCleanup?.();
        continue;
      }

      // ── Element pull wire (expression or plain) ──
      const elemToRef: NodeRef = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
        path: elemToPath,
      };

      const sourceParts: { ref: NodeRef; isPipeFork: boolean }[] = [];

      const elemExprOps = subs(elemLine, "elemExprOp");

      // Compute condition ref (expression chain result or plain source)
      let elemCondRef: NodeRef;
      let elemCondIsPipeFork: boolean;
      if (elemFirstParenNode && resolveParenExprFn) {
        // First source is a parenthesized sub-expression
        const parenRef = resolveParenExprFn(
          elemFirstParenNode,
          elemLineNum,
          iterName,
          elemSafe || undefined,
        );
        if (elemExprOps.length > 0 && desugarExprChain) {
          const elemExprRights = subs(elemLine, "elemExprRight");
          elemCondRef = desugarExprChain(
            parenRef,
            elemExprOps,
            elemExprRights,
            elemLineNum,
            iterName,
            elemSafe || undefined,
          );
        } else {
          elemCondRef = parenRef;
        }
        elemCondIsPipeFork = true;
      } else if (elemExprOps.length > 0 && desugarExprChain) {
        // Expression in element line — desugar then merge with fallback path
        const elemExprRights = subs(elemLine, "elemExprRight");
        let leftRef: NodeRef;
        if (elemSrcRoot === iterName && elemPipeSegs.length === 0) {
          leftRef = {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: elemSrcSegs,
          };
        } else {
          leftRef = buildSourceExpr(elemSourceNode!, elemLineNum, iterName);
        }
        elemCondRef = desugarExprChain(
          leftRef,
          elemExprOps,
          elemExprRights,
          elemLineNum,
          iterName,
          elemSafe || undefined,
        );
        elemCondIsPipeFork = true;
      } else if (elemSrcRoot === iterName && elemPipeSegs.length === 0) {
        elemCondRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: elemSrcSegs,
        };
        elemCondIsPipeFork = false;
      } else {
        elemCondRef = buildSourceExpr(elemSourceNode!, elemLineNum, iterName);
        elemCondIsPipeFork =
          elemCondRef.instance != null &&
          elemCondRef.path.length === 0 &&
          elemPipeSegs.length > 0;
      }

      // ── Apply `not` prefix if present (element context) ──
      if ((elemC.elemNotPrefix as IToken[] | undefined)?.[0] && desugarNotFn) {
        elemCondRef = desugarNotFn(
          elemCondRef,
          elemLineNum,
          elemSafe || undefined,
        );
        elemCondIsPipeFork = true;
      }

      // ── Ternary wire in element context ──
      const elemTernaryOp = (elemC.elemTernaryOp as IToken[] | undefined)?.[0];
      if (elemTernaryOp && extractTernaryBranchFn) {
        const thenNode = sub(elemLine, "elemThenBranch")!;
        const elseNode = sub(elemLine, "elemElseBranch")!;
        const thenBranch = extractTernaryBranchFn(
          thenNode,
          elemLineNum,
          iterName,
        );
        const elseBranch = extractTernaryBranchFn(
          elseNode,
          elemLineNum,
          iterName,
        );

        // Process coalesce alternatives.
        const elemFallbacks: WireFallback[] = [];
        const elemFallbackInternalWires: Wire[] = [];
        for (const item of subs(elemLine, "elemCoalesceItem")) {
          const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
          const altNode = sub(item, "altValue")!;
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(altNode, elemLineNum);
          if ("literal" in altResult) {
            elemFallbacks.push({ type, value: altResult.literal });
          } else if ("control" in altResult) {
            elemFallbacks.push({ type, control: altResult.control });
          } else {
            elemFallbacks.push({ type, ref: altResult.sourceRef });
            elemFallbackInternalWires.push(...wires.splice(preLen));
          }
        }

        // Process catch error fallback.
        let elemCatchFallback: string | undefined;
        let elemCatchControl: ControlFlowInstruction | undefined;
        let elemCatchFallbackRef: NodeRef | undefined;
        let elemCatchFallbackInternalWires: Wire[] = [];
        const elemCatchAlt = sub(elemLine, "elemCatchAlt");
        if (elemCatchAlt) {
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(
            elemCatchAlt,
            elemLineNum,
          );
          if ("literal" in altResult) {
            elemCatchFallback = altResult.literal;
          } else if ("control" in altResult) {
            elemCatchControl = altResult.control;
          } else {
            elemCatchFallbackRef = altResult.sourceRef;
            elemCatchFallbackInternalWires = wires.splice(preLen);
          }
        }

        wires.push({
          cond: elemCondRef,
          ...(thenBranch.kind === "ref"
            ? { thenRef: thenBranch.ref }
            : { thenValue: thenBranch.value }),
          ...(elseBranch.kind === "ref"
            ? { elseRef: elseBranch.ref }
            : { elseValue: elseBranch.value }),
          ...(elemFallbacks.length > 0 ? { fallbacks: elemFallbacks } : {}),
          ...(elemCatchFallback !== undefined
            ? { catchFallback: elemCatchFallback }
            : {}),
          ...(elemCatchFallbackRef !== undefined
            ? { catchFallbackRef: elemCatchFallbackRef }
            : {}),
          ...(elemCatchControl ? { catchControl: elemCatchControl } : {}),
          to: elemToRef,
        });
        wires.push(...elemFallbackInternalWires);
        wires.push(...elemCatchFallbackInternalWires);
        continue;
      }

      sourceParts.push({ ref: elemCondRef, isPipeFork: elemCondIsPipeFork });

      // Coalesce alternatives (|| and ??)
      const fallbacks: WireFallback[] = [];
      const fallbackInternalWires: Wire[] = [];
      for (const item of subs(elemLine, "elemCoalesceItem")) {
        const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
        const altNode = sub(item, "altValue")!;
        const preLen = wires.length;
        const altResult = extractCoalesceAltIterAware(altNode, elemLineNum);
        if ("literal" in altResult) {
          fallbacks.push({ type, value: altResult.literal });
        } else if ("control" in altResult) {
          fallbacks.push({ type, control: altResult.control });
        } else {
          fallbacks.push({ type, ref: altResult.sourceRef });
          fallbackInternalWires.push(...wires.splice(preLen));
        }
      }

      // catch error fallback
      let catchFallback: string | undefined;
      let catchControl: ControlFlowInstruction | undefined;
      let catchFallbackRef: NodeRef | undefined;
      let catchFallbackInternalWires: Wire[] = [];
      const catchAlt = sub(elemLine, "elemCatchAlt");
      if (catchAlt) {
        const preLen = wires.length;
        const altResult = extractCoalesceAltIterAware(catchAlt, elemLineNum);
        if ("literal" in altResult) {
          catchFallback = altResult.literal;
        } else if ("control" in altResult) {
          catchControl = altResult.control;
        } else {
          catchFallbackRef = altResult.sourceRef;
          catchFallbackInternalWires = wires.splice(preLen);
        }
      }

      // Emit wire
      const { ref: fromRef, isPipeFork } = sourceParts[0];
      const wireAttrs = {
        ...(isPipeFork ? { pipe: true as const } : {}),
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
        ...(catchFallback ? { catchFallback } : {}),
        ...(catchFallbackRef ? { catchFallbackRef } : {}),
        ...(catchControl ? { catchControl } : {}),
      };
      wires.push({ from: fromRef, to: elemToRef, ...wireAttrs });
      wires.push(...fallbackInternalWires);
      wires.push(...catchFallbackInternalWires);
    } else if (elemC.elemScopeBlock) {
      // ── Path scope block inside array mapping: .field { lines: .sub <- ..., ...source } ──
      const scopeLines = subs(elemLine, "elemScopeLine");
      // Process spread lines at the top level of this scope block
      const spreadLines = subs(elemLine, "elemSpreadLine");
      for (const spreadLine of spreadLines) {
        const spreadLineNum = line(findFirstToken(spreadLine));
        const sourceNode = sub(spreadLine, "spreadSource")!;
        const fromRef = buildSourceExpr(sourceNode, spreadLineNum, iterName);
        // Propagate safe navigation (?.) flag from source expression
        const headNode = sub(sourceNode, "head")!;
        const pipeNodes = subs(sourceNode, "pipeSegment");
        const actualNode =
          pipeNodes.length > 0 ? pipeNodes[pipeNodes.length - 1]! : headNode;
        const { safe: spreadSafe } = extractAddressPath(actualNode);
        wires.push({
          from: fromRef,
          to: {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: elemToPath,
          },
          spread: true as const,
          ...(spreadSafe ? { safe: true as const } : {}),
        });
      }
      processElementScopeLines(
        scopeLines,
        elemToPath,
        [],
        iterName,
        bridgeType,
        bridgeField,
        wires,
        buildSourceExpr,
        extractCoalesceAlt,
        desugarExprChain,
        extractTernaryBranchFn,
        desugarTemplateStringFn,
        desugarNotFn,
        resolveParenExprFn,
      );
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively flatten path-scope blocks (`pathScopeLine` CST nodes) that
 * appear inside an array-mapping block.  Mirrors `processScopeLines` in
 * `buildBridgeBody` but emits element-context wires (same as
 * `processElementLines`).
 */
function processElementScopeLines(
  scopeLines: CstNode[],
  arrayToPath: string[],
  pathPrefix: string[],
  iterName: string,
  bridgeType: string,
  bridgeField: string,
  wires: Wire[],
  buildSourceExpr: (
    node: CstNode,
    lineNum: number,
    iterName?: string,
  ) => NodeRef,
  extractCoalesceAlt: (
    altNode: CstNode,
    lineNum: number,
    iterName?: string,
  ) =>
    | { literal: string }
    | { sourceRef: NodeRef }
    | { control: ControlFlowInstruction },
  desugarExprChain?: (
    leftRef: NodeRef,
    exprOps: CstNode[],
    exprRights: CstNode[],
    lineNum: number,
    iterName?: string,
    safe?: boolean,
  ) => NodeRef,
  extractTernaryBranchFn?: (
    branchNode: CstNode,
    lineNum: number,
    iterName?: string,
  ) => { kind: "literal"; value: string } | { kind: "ref"; ref: NodeRef },
  desugarTemplateStringFn?: (
    segs: TemplateSeg[],
    lineNum: number,
    iterName?: string,
  ) => NodeRef,
  desugarNotFn?: (
    sourceRef: NodeRef,
    lineNum: number,
    safe?: boolean,
  ) => NodeRef,
  resolveParenExprFn?: (
    parenNode: CstNode,
    lineNum: number,
    iterName?: string,
    safe?: boolean,
  ) => NodeRef,
): void {
  function extractCoalesceAltIterAware(
    altNode: CstNode,
    lineNum: number,
  ):
    | { literal: string }
    | { sourceRef: NodeRef }
    | { control: ControlFlowInstruction } {
    const c = altNode.children;
    if (c.sourceAlt) {
      const srcNode = (c.sourceAlt as CstNode[])[0];
      const headNode = sub(srcNode, "head");
      if (headNode) {
        const { root, segments } = extractAddressPath(headNode);
        const pipeSegs = subs(srcNode, "pipeSegment");
        if (root === iterName && pipeSegs.length === 0) {
          return {
            sourceRef: {
              module: SELF_MODULE,
              type: bridgeType,
              field: bridgeField,
              element: true,
              path: segments,
            },
          };
        }
      }
    }
    return extractCoalesceAlt(altNode, lineNum, iterName);
  }

  for (const scopeLine of scopeLines) {
    const sc = scopeLine.children;
    const scopeLineNum = line(findFirstToken(scopeLine));
    const targetStr = extractDottedPathStr(sub(scopeLine, "scopeTarget")!);
    const scopeSegs = parsePath(targetStr);
    const fullSegs = [...pathPrefix, ...scopeSegs];

    // ── Nested scope: .field { ... } ──
    const nestedScopeLines = subs(scopeLine, "pathScopeLine");
    const nestedSpreadLines = subs(scopeLine, "scopeSpreadLine");
    if (
      (nestedScopeLines.length > 0 || nestedSpreadLines.length > 0) &&
      !sc.scopeEquals &&
      !sc.scopeArrow
    ) {
      // Process spread lines inside this nested scope block: ...sourceExpr
      const spreadToPath = [...arrayToPath, ...fullSegs];
      for (const spreadLine of nestedSpreadLines) {
        const spreadLineNum = line(findFirstToken(spreadLine));
        const sourceNode = sub(spreadLine, "spreadSource")!;
        const fromRef = buildSourceExpr(sourceNode, spreadLineNum, iterName);
        // Propagate safe navigation (?.) flag from source expression
        const headNode = sub(sourceNode, "head")!;
        const pipeNodes = subs(sourceNode, "pipeSegment");
        const actualNode =
          pipeNodes.length > 0 ? pipeNodes[pipeNodes.length - 1]! : headNode;
        const { safe: spreadSafe } = extractAddressPath(actualNode);
        wires.push({
          from: fromRef,
          to: {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: spreadToPath,
          },
          spread: true as const,
          ...(spreadSafe ? { safe: true as const } : {}),
        });
      }
      processElementScopeLines(
        nestedScopeLines,
        arrayToPath,
        fullSegs,
        iterName,
        bridgeType,
        bridgeField,
        wires,
        buildSourceExpr,
        extractCoalesceAlt,
        desugarExprChain,
        extractTernaryBranchFn,
        desugarTemplateStringFn,
        desugarNotFn,
        resolveParenExprFn,
      );
      continue;
    }

    const elemToPath = [...arrayToPath, ...fullSegs];

    // ── Constant wire: .field = value ──
    if (sc.scopeEquals) {
      const value = extractBareValue(sub(scopeLine, "scopeValue")!);
      wires.push({
        value,
        to: {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: elemToPath,
        },
      });
      continue;
    }

    // ── Pull wire: .field <- source [modifiers] ──
    if (sc.scopeArrow) {
      const elemToRef: NodeRef = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
        path: elemToPath,
      };

      // String source (template or plain): .field <- "..."
      const stringSourceToken = (
        sc.scopeStringSource as IToken[] | undefined
      )?.[0];
      if (stringSourceToken && desugarTemplateStringFn) {
        const raw = stringSourceToken.image.slice(1, -1);
        const segs = parseTemplateString(raw);

        const fallbacks: WireFallback[] = [];
        const fallbackInternalWires: Wire[] = [];
        for (const item of subs(scopeLine, "scopeCoalesceItem")) {
          const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
          const altNode = sub(item, "altValue")!;
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(altNode, scopeLineNum);
          if ("literal" in altResult) {
            fallbacks.push({ type, value: altResult.literal });
          } else if ("control" in altResult) {
            fallbacks.push({ type, control: altResult.control });
          } else {
            fallbacks.push({ type, ref: altResult.sourceRef });
            fallbackInternalWires.push(...wires.splice(preLen));
          }
        }
        let catchFallback: string | undefined;
        let catchControl: ControlFlowInstruction | undefined;
        let catchFallbackRef: NodeRef | undefined;
        let catchFallbackInternalWires: Wire[] = [];
        const catchAlt = sub(scopeLine, "scopeCatchAlt");
        if (catchAlt) {
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(catchAlt, scopeLineNum);
          if ("literal" in altResult) catchFallback = altResult.literal;
          else if ("control" in altResult) catchControl = altResult.control;
          else {
            catchFallbackRef = altResult.sourceRef;
            catchFallbackInternalWires = wires.splice(preLen);
          }
        }
        const lastAttrs = {
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          ...(catchFallback ? { catchFallback } : {}),
          ...(catchFallbackRef ? { catchFallbackRef } : {}),
          ...(catchControl ? { catchControl } : {}),
        };
        if (segs) {
          const concatOutRef = desugarTemplateStringFn(
            segs,
            scopeLineNum,
            iterName,
          );
          wires.push({
            from: concatOutRef,
            to: { ...elemToRef, element: true },
            pipe: true,
            ...lastAttrs,
          });
        } else {
          wires.push({ value: raw, to: elemToRef, ...lastAttrs });
        }
        wires.push(...fallbackInternalWires);
        wires.push(...catchFallbackInternalWires);
        continue;
      }

      // Normal source expression
      const scopeSourceNode = sub(scopeLine, "scopeSource");
      const scopeFirstParenNode = sub(scopeLine, "scopeFirstParenExpr");
      let scopeHeadNode: CstNode | undefined;
      let scopePipeSegs: CstNode[] = [];
      let srcRoot: string = "";
      let srcSegs: string[] = [];
      let scopeSafe: boolean = false;
      if (scopeSourceNode) {
        scopeHeadNode = sub(scopeSourceNode, "head")!;
        scopePipeSegs = subs(scopeSourceNode, "pipeSegment");
        const extracted = extractAddressPath(scopeHeadNode);
        srcRoot = extracted.root;
        srcSegs = extracted.segments;
        scopeSafe = !!extracted.rootSafe;
      }

      const exprOps = subs(scopeLine, "scopeExprOp");
      let condRef: NodeRef;
      let condIsPipeFork: boolean;
      if (scopeFirstParenNode && resolveParenExprFn) {
        const parenRef = resolveParenExprFn(
          scopeFirstParenNode,
          scopeLineNum,
          iterName,
          scopeSafe || undefined,
        );
        if (exprOps.length > 0 && desugarExprChain) {
          const exprRights = subs(scopeLine, "scopeExprRight");
          condRef = desugarExprChain(
            parenRef,
            exprOps,
            exprRights,
            scopeLineNum,
            iterName,
            scopeSafe || undefined,
          );
        } else {
          condRef = parenRef;
        }
        condIsPipeFork = true;
      } else if (exprOps.length > 0 && desugarExprChain) {
        const exprRights = subs(scopeLine, "scopeExprRight");
        let leftRef: NodeRef;
        if (srcRoot === iterName && scopePipeSegs.length === 0) {
          leftRef = {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: srcSegs,
          };
        } else {
          leftRef = buildSourceExpr(scopeSourceNode!, scopeLineNum, iterName);
        }
        condRef = desugarExprChain(
          leftRef,
          exprOps,
          exprRights,
          scopeLineNum,
          iterName,
          scopeSafe || undefined,
        );
        condIsPipeFork = true;
      } else if (srcRoot === iterName && scopePipeSegs.length === 0) {
        condRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: srcSegs,
        };
        condIsPipeFork = false;
      } else {
        condRef = buildSourceExpr(scopeSourceNode!, scopeLineNum, iterName);
        condIsPipeFork =
          condRef.instance != null &&
          condRef.path.length === 0 &&
          scopePipeSegs.length > 0;
      }

      // ── Apply `not` prefix if present (scope context) ──
      if ((sc.scopeNotPrefix as IToken[] | undefined)?.[0] && desugarNotFn) {
        condRef = desugarNotFn(condRef, scopeLineNum, scopeSafe || undefined);
        condIsPipeFork = true;
      }

      // Ternary wire: .field <- cond ? then : else
      const scopeTernaryOp = (sc.scopeTernaryOp as IToken[] | undefined)?.[0];
      if (scopeTernaryOp && extractTernaryBranchFn) {
        const thenNode = sub(scopeLine, "scopeThenBranch")!;
        const elseNode = sub(scopeLine, "scopeElseBranch")!;
        const thenBranch = extractTernaryBranchFn(
          thenNode,
          scopeLineNum,
          iterName,
        );
        const elseBranch = extractTernaryBranchFn(
          elseNode,
          scopeLineNum,
          iterName,
        );

        const fallbacks: WireFallback[] = [];
        const fallbackInternalWires: Wire[] = [];
        for (const item of subs(scopeLine, "scopeCoalesceItem")) {
          const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
          const altNode = sub(item, "altValue")!;
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(altNode, scopeLineNum);
          if ("literal" in altResult) {
            fallbacks.push({ type, value: altResult.literal });
          } else if ("control" in altResult) {
            fallbacks.push({ type, control: altResult.control });
          } else {
            fallbacks.push({ type, ref: altResult.sourceRef });
            fallbackInternalWires.push(...wires.splice(preLen));
          }
        }
        let catchFallback: string | undefined;
        let catchControl: ControlFlowInstruction | undefined;
        let catchFallbackRef: NodeRef | undefined;
        let catchFallbackInternalWires: Wire[] = [];
        const catchAlt = sub(scopeLine, "scopeCatchAlt");
        if (catchAlt) {
          const preLen = wires.length;
          const altResult = extractCoalesceAltIterAware(catchAlt, scopeLineNum);
          if ("literal" in altResult) catchFallback = altResult.literal;
          else if ("control" in altResult) catchControl = altResult.control;
          else {
            catchFallbackRef = altResult.sourceRef;
            catchFallbackInternalWires = wires.splice(preLen);
          }
        }
        wires.push({
          cond: condRef,
          ...(thenBranch.kind === "ref"
            ? { thenRef: thenBranch.ref }
            : { thenValue: thenBranch.value }),
          ...(elseBranch.kind === "ref"
            ? { elseRef: elseBranch.ref }
            : { elseValue: elseBranch.value }),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          ...(catchFallback !== undefined ? { catchFallback } : {}),
          ...(catchFallbackRef !== undefined ? { catchFallbackRef } : {}),
          ...(catchControl ? { catchControl } : {}),
          to: elemToRef,
        });
        wires.push(...fallbackInternalWires);
        wires.push(...catchFallbackInternalWires);
        continue;
      }

      const sourceParts: { ref: NodeRef; isPipeFork: boolean }[] = [];
      sourceParts.push({ ref: condRef, isPipeFork: condIsPipeFork });

      // Coalesce alternatives (|| and ??)
      const fallbacks: WireFallback[] = [];
      const fallbackInternalWires: Wire[] = [];
      for (const item of subs(scopeLine, "scopeCoalesceItem")) {
        const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
        const altNode = sub(item, "altValue")!;
        const preLen = wires.length;
        const altResult = extractCoalesceAltIterAware(altNode, scopeLineNum);
        if ("literal" in altResult) {
          fallbacks.push({ type, value: altResult.literal });
        } else if ("control" in altResult) {
          fallbacks.push({ type, control: altResult.control });
        } else {
          fallbacks.push({ type, ref: altResult.sourceRef });
          fallbackInternalWires.push(...wires.splice(preLen));
        }
      }

      let catchFallback: string | undefined;
      let catchControl: ControlFlowInstruction | undefined;
      let catchFallbackRef: NodeRef | undefined;
      let catchFallbackInternalWires: Wire[] = [];
      const catchAlt = sub(scopeLine, "scopeCatchAlt");
      if (catchAlt) {
        const preLen = wires.length;
        const altResult = extractCoalesceAltIterAware(catchAlt, scopeLineNum);
        if ("literal" in altResult) catchFallback = altResult.literal;
        else if ("control" in altResult) catchControl = altResult.control;
        else {
          catchFallbackRef = altResult.sourceRef;
          catchFallbackInternalWires = wires.splice(preLen);
        }
      }

      const { ref: fromRef, isPipeFork: isPipe } = sourceParts[0];
      const wireAttrs = {
        ...(isPipe ? { pipe: true as const } : {}),
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
        ...(catchFallback ? { catchFallback } : {}),
        ...(catchFallbackRef ? { catchFallbackRef } : {}),
        ...(catchControl ? { catchControl } : {}),
      };
      wires.push({ from: fromRef, to: elemToRef, ...wireAttrs });
      wires.push(...fallbackInternalWires);
      wires.push(...catchFallbackInternalWires);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main AST builder
// ═══════════════════════════════════════════════════════════════════════════

function toBridgeAst(
  cst: CstNode,
  previousInstructions?: Instruction[],
): {
  version: string;
  instructions: Instruction[];
  startLines: Map<Instruction, number>;
} {
  const instructions: Instruction[] = [];
  const startLines = new Map<Instruction, number>();

  // If called from passthrough expansion, seed with prior context
  const contextInstructions: Instruction[] = previousInstructions
    ? [...previousInstructions]
    : [];

  // ── Version check ──
  const versionDecl = sub(cst, "versionDecl");
  if (!versionDecl) {
    throw new Error(
      `Missing version declaration. Bridge files must begin with: version ${BRIDGE_VERSION}`,
    );
  }
  const versionTok = tok(versionDecl, "ver");
  const versionNum = versionTok?.image;
  if (!versionNum) {
    throw new Error(
      `Missing version number. Bridge files must begin with: version ${BRIDGE_VERSION}`,
    );
  }
  // Accept any version whose major falls within the supported range.
  // When the parser supports multiple majors (e.g. 1.x through 2.x),
  // bridge files from any of them are valid syntax.
  const vParts = versionNum.split(".");
  const vMajor = parseInt(vParts[0], 10);
  const supportedRange =
    BRIDGE_MIN_MAJOR === BRIDGE_MAX_MAJOR
      ? `${BRIDGE_MIN_MAJOR}.x`
      : `${BRIDGE_MIN_MAJOR}.x – ${BRIDGE_MAX_MAJOR}.x`;
  if (isNaN(vMajor) || vMajor < BRIDGE_MIN_MAJOR || vMajor > BRIDGE_MAX_MAJOR) {
    throw new Error(
      `Unsupported bridge major version "${versionNum}". This parser supports version ${supportedRange}`,
    );
  }

  // Store the declared version (lives on BridgeDocument, not in instructions).
  const version = versionNum;

  // Process in source order (same as old parser: all blocks sequentially)
  // Chevrotain stores them by rule name, so we need to interleave by offset.
  type TaggedNode = { offset: number; kind: string; node: CstNode };
  const tagged: TaggedNode[] = [];
  for (const n of subs(cst, "constDecl"))
    tagged.push({
      offset: findFirstToken(n)?.startOffset ?? 0,
      kind: "const",
      node: n,
    });
  for (const n of subs(cst, "toolBlock"))
    tagged.push({
      offset: findFirstToken(n)?.startOffset ?? 0,
      kind: "tool",
      node: n,
    });
  for (const n of subs(cst, "defineBlock"))
    tagged.push({
      offset: findFirstToken(n)?.startOffset ?? 0,
      kind: "define",
      node: n,
    });
  for (const n of subs(cst, "bridgeBlock"))
    tagged.push({
      offset: findFirstToken(n)?.startOffset ?? 0,
      kind: "bridge",
      node: n,
    });
  tagged.sort((a, b) => a.offset - b.offset);

  for (const item of tagged) {
    const startLine = findFirstToken(item.node)?.startLine ?? 1;
    switch (item.kind) {
      case "const": {
        const inst = buildConstDef(item.node);
        instructions.push(inst);
        startLines.set(inst, startLine);
        break;
      }
      case "tool": {
        const inst = buildToolDef(item.node, [
          ...contextInstructions,
          ...instructions,
        ]);
        instructions.push(inst);
        startLines.set(inst, startLine);
        break;
      }
      case "define": {
        const inst = buildDefineDef(item.node);
        instructions.push(inst);
        startLines.set(inst, startLine);
        break;
      }
      case "bridge": {
        const newInsts = buildBridge(item.node, [
          ...contextInstructions,
          ...instructions,
        ]);
        for (const bi of newInsts) {
          instructions.push(bi);
          startLines.set(bi, startLine);
        }
        break;
      }
    }
  }

  return { version, instructions, startLines };
}

// ── Const ───────────────────────────────────────────────────────────────

function buildConstDef(node: CstNode): ConstDef {
  const nameNode = sub(node, "constName")!;
  const name = extractNameToken(nameNode);
  const lineNum = line(findFirstToken(nameNode));
  assertNotReserved(name, lineNum, "const name");
  const valueNode = sub(node, "constValue")!;
  const raw = extractJsonValue(valueNode);

  // Validate JSON
  try {
    JSON.parse(raw);
  } catch {
    throw new Error(
      `Line ${lineNum}: Invalid JSON value for const "${name}": ${raw}`,
    );
  }

  return { kind: "const", name, value: raw };
}

// ── Tool ────────────────────────────────────────────────────────────────

function buildToolDef(
  node: CstNode,
  previousInstructions: Instruction[],
): ToolDef {
  const toolName = extractDottedName(sub(node, "toolName")!);
  const source = extractDottedName(sub(node, "toolSource")!);
  const lineNum = line(findFirstToken(sub(node, "toolName")!));
  assertNotReserved(toolName, lineNum, "tool name");

  const isKnownTool = previousInstructions.some(
    (inst) => inst.kind === "tool" && inst.name === source,
  );

  const deps: ToolDep[] = [];
  const wires: ToolWire[] = [];

  for (const bodyLine of subs(node, "toolBodyLine")) {
    const c = bodyLine.children;

    // toolWithDecl
    const withNode = (c.toolWithDecl as CstNode[] | undefined)?.[0];
    if (withNode) {
      const wc = withNode.children;
      if (wc.contextKw) {
        const alias = wc.alias
          ? extractNameToken((wc.alias as CstNode[])[0])
          : "context";
        deps.push({ kind: "context", handle: alias });
      } else if (wc.constKw) {
        const alias = wc.constAlias
          ? extractNameToken((wc.constAlias as CstNode[])[0])
          : "const";
        deps.push({ kind: "const", handle: alias });
      } else if (wc.toolName) {
        const tName = extractDottedName((wc.toolName as CstNode[])[0]);
        const tAlias = extractNameToken((wc.toolAlias as CstNode[])[0]);
        const tVersion = (
          wc.toolVersion as IToken[] | undefined
        )?.[0]?.image.slice(1);
        deps.push({
          kind: "tool",
          handle: tAlias,
          tool: tName,
          ...(tVersion ? { version: tVersion } : {}),
        });
      }
      continue;
    }

    // toolOnError
    const onError = (c.toolOnError as CstNode[] | undefined)?.[0];
    if (onError) {
      const oc = onError.children;
      if (oc.equalsOp) {
        const value = extractJsonValue(sub(onError, "errorValue")!);
        wires.push({ kind: "onError", value });
      } else if (oc.arrowOp) {
        const source = extractDottedName(sub(onError, "errorSource")!);
        wires.push({ kind: "onError", source });
      }
      continue;
    }

    // toolWire (merged constant + pull)
    const wireNode = (c.toolWire as CstNode[] | undefined)?.[0];
    if (wireNode) {
      const wc = wireNode.children;
      const target = extractDottedPathStr(sub(wireNode, "target")!);
      if (wc.equalsOp) {
        const value = extractBareValue(sub(wireNode, "value")!);
        wires.push({ target, kind: "constant", value });
      } else if (wc.arrowOp) {
        const source = extractDottedName(sub(wireNode, "source")!);
        wires.push({ target, kind: "pull", source });
      }
      continue;
    }
  }

  return {
    kind: "tool",
    name: toolName,
    fn: isKnownTool ? undefined : source,
    extends: isKnownTool ? source : undefined,
    deps,
    wires,
  };
}

// ── Define ──────────────────────────────────────────────────────────────

function buildDefineDef(node: CstNode): DefineDef {
  const name = extractNameToken(sub(node, "defineName")!);
  const lineNum = line(findFirstToken(sub(node, "defineName")!));
  assertNotReserved(name, lineNum, "define name");

  const bodyLines = subs(node, "bridgeBodyLine");
  const { handles, wires, arrayIterators, pipeHandles, forces } =
    buildBridgeBody(bodyLines, "Define", name, [], lineNum);

  return {
    kind: "define",
    name,
    handles,
    wires,
    ...(Object.keys(arrayIterators).length > 0 ? { arrayIterators } : {}),
    ...(pipeHandles.length > 0 ? { pipeHandles } : {}),
    ...(forces.length > 0 ? { forces } : {}),
  };
}

// ── Bridge ──────────────────────────────────────────────────────────────

function buildBridge(
  node: CstNode,
  previousInstructions: Instruction[],
): Instruction[] {
  const typeName = extractNameToken(sub(node, "typeName")!);
  const fieldName = extractNameToken(sub(node, "fieldName")!);

  // Passthrough shorthand
  if (node.children.passthroughWith) {
    const passthroughName = extractDottedName(sub(node, "passthroughName")!);
    const sHandle = passthroughName.includes(".")
      ? passthroughName.substring(passthroughName.lastIndexOf(".") + 1)
      : passthroughName;

    const expandedText = [
      `version ${BRIDGE_VERSION}`,
      `bridge ${typeName}.${fieldName} {`,
      `  with ${passthroughName} as ${sHandle}`,
      `  with input`,
      `  with output as __out`,
      `  ${sHandle} <- input`,
      `  __out <- ${sHandle}`,
      `}`,
    ].join("\n");

    const result = internalParse(expandedText, previousInstructions);
    const bridgeInst = result.instructions.find(
      (i): i is Bridge => i.kind === "bridge",
    );
    if (bridgeInst) bridgeInst.passthrough = passthroughName;
    return result.instructions;
  }

  // Full bridge block
  const bodyLines = subs(node, "bridgeBodyLine");
  const { handles, wires, arrayIterators, pipeHandles, forces } =
    buildBridgeBody(bodyLines, typeName, fieldName, previousInstructions, 0);

  // Inline define invocations
  const instanceCounters = new Map<string, number>();
  for (const hb of handles) {
    if (hb.kind !== "tool") continue;
    const name = hb.name;
    const lastDot = name.lastIndexOf(".");
    if (lastDot !== -1) {
      const key = `${name.substring(0, lastDot)}:${name.substring(lastDot + 1)}`;
      instanceCounters.set(key, (instanceCounters.get(key) ?? 0) + 1);
    } else {
      const key = `Tools:${name}`;
      instanceCounters.set(key, (instanceCounters.get(key) ?? 0) + 1);
    }
  }

  const nextForkSeqRef = {
    value:
      pipeHandles.length > 0
        ? Math.max(
            ...pipeHandles
              .map((p) => {
                const parts = p.key.split(":");
                return parseInt(parts[parts.length - 1]) || 0;
              })
              .filter((n) => n >= 100000)
              .map((n) => n - 100000 + 1),
            0,
          )
        : 0,
  };

  for (const hb of handles) {
    if (hb.kind !== "define") continue;
    const def = previousInstructions.find(
      (inst): inst is DefineDef =>
        inst.kind === "define" && inst.name === hb.name,
    );
    if (!def) {
      throw new Error(
        `Define "${hb.name}" referenced by handle "${hb.handle}" not found`,
      );
    }
    inlineDefine(
      hb.handle,
      def,
      typeName,
      fieldName,
      wires,
      pipeHandles,
      handles,
      instanceCounters,
      nextForkSeqRef,
    );
  }

  const instructions: Instruction[] = [];
  instructions.push({
    kind: "bridge",
    type: typeName,
    field: fieldName,
    handles,
    wires,
    arrayIterators:
      Object.keys(arrayIterators).length > 0 ? arrayIterators : undefined,
    pipeHandles: pipeHandles.length > 0 ? pipeHandles : undefined,
    forces: forces.length > 0 ? forces : undefined,
  });
  return instructions;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Bridge/Define body builder
// ═══════════════════════════════════════════════════════════════════════════

function buildBridgeBody(
  bodyLines: CstNode[],
  bridgeType: string,
  bridgeField: string,
  previousInstructions: Instruction[],
  _lineOffset: number,
): {
  handles: HandleBinding[];
  wires: Wire[];
  arrayIterators: Record<string, string>;
  pipeHandles: NonNullable<Bridge["pipeHandles"]>;
  forces: NonNullable<Bridge["forces"]>;
} {
  const handleRes = new Map<string, HandleResolution>();
  const handleBindings: HandleBinding[] = [];
  const instanceCounters = new Map<string, number>();
  const wires: Wire[] = [];
  const arrayIterators: Record<string, string> = {};
  let nextForkSeq = 0;
  const pipeHandleEntries: NonNullable<Bridge["pipeHandles"]> = [];

  // ── Step 1: Process with-declarations ─────────────────────────────────

  for (const bodyLine of bodyLines) {
    const withNode = (
      bodyLine.children.bridgeWithDecl as CstNode[] | undefined
    )?.[0];
    if (!withNode) continue;
    const wc = withNode.children;
    const lineNum = line(findFirstToken(withNode));

    const checkDuplicate = (handle: string) => {
      if (handleRes.has(handle)) {
        throw new Error(`Line ${lineNum}: Duplicate handle name "${handle}"`);
      }
    };

    if (wc.inputKw) {
      const handle = wc.inputAlias
        ? extractNameToken((wc.inputAlias as CstNode[])[0])
        : "input";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "input" });
      handleRes.set(handle, {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
      });
    } else if (wc.outputKw) {
      const handle = wc.outputAlias
        ? extractNameToken((wc.outputAlias as CstNode[])[0])
        : "output";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "output" });
      handleRes.set(handle, {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
      });
    } else if (wc.contextKw) {
      const handle = wc.contextAlias
        ? extractNameToken((wc.contextAlias as CstNode[])[0])
        : "context";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "context" });
      handleRes.set(handle, {
        module: SELF_MODULE,
        type: "Context",
        field: "context",
      });
    } else if (wc.constKw) {
      const handle = wc.constAlias
        ? extractNameToken((wc.constAlias as CstNode[])[0])
        : "const";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "const" });
      handleRes.set(handle, {
        module: SELF_MODULE,
        type: "Const",
        field: "const",
      });
    } else if (wc.refName) {
      const name = extractDottedName((wc.refName as CstNode[])[0]);
      const versionTag = (
        wc.refVersion as IToken[] | undefined
      )?.[0]?.image.slice(1);
      const lastDot = name.lastIndexOf(".");
      const defaultHandle = lastDot !== -1 ? name.substring(lastDot + 1) : name;
      const handle = wc.refAlias
        ? extractNameToken((wc.refAlias as CstNode[])[0])
        : defaultHandle;

      checkDuplicate(handle);
      if (wc.refAlias) assertNotReserved(handle, lineNum, "handle alias");

      // Check if it's a define reference
      const defineDef = previousInstructions.find(
        (inst): inst is DefineDef =>
          inst.kind === "define" && inst.name === name,
      );
      if (defineDef) {
        handleBindings.push({ handle, kind: "define", name });
        handleRes.set(handle, {
          module: `__define_${handle}`,
          type: bridgeType,
          field: bridgeField,
        });
      } else if (lastDot !== -1) {
        const modulePart = name.substring(0, lastDot);
        const fieldPart = name.substring(lastDot + 1);
        const key = `${modulePart}:${fieldPart}`;
        const instance = (instanceCounters.get(key) ?? 0) + 1;
        instanceCounters.set(key, instance);
        handleBindings.push({
          handle,
          kind: "tool",
          name,
          ...(versionTag ? { version: versionTag } : {}),
        });
        handleRes.set(handle, {
          module: modulePart,
          type: bridgeType,
          field: fieldPart,
          instance,
        });
      } else {
        const key = `Tools:${name}`;
        const instance = (instanceCounters.get(key) ?? 0) + 1;
        instanceCounters.set(key, instance);
        handleBindings.push({
          handle,
          kind: "tool",
          name,
          ...(versionTag ? { version: versionTag } : {}),
        });
        handleRes.set(handle, {
          module: SELF_MODULE,
          type: "Tools",
          field: name,
          instance,
        });
      }
    }
  }

  // ── Helper: resolve address ────────────────────────────────────────────

  function resolveAddress(
    root: string,
    segments: string[],
    lineNum: number,
  ): NodeRef {
    const resolution = handleRes.get(root);
    if (!resolution) {
      if (segments.length === 0) {
        throw new Error(
          `Line ${lineNum}: Undeclared reference "${root}". Add 'with output as o' for output fields, or 'with ${root}' for a tool.`,
        );
      }
      throw new Error(
        `Line ${lineNum}: Undeclared handle "${root}". Add 'with ${root}' or 'with ${root} as ${root}' to the bridge header.`,
      );
    }
    const ref: NodeRef = {
      module: resolution.module,
      type: resolution.type,
      field: resolution.field,
      path: [...segments],
    };
    if (resolution.instance != null) ref.instance = resolution.instance;
    return ref;
  }

  function assertNoTargetIndices(ref: NodeRef, lineNum: number): void {
    if (ref.path.some((seg) => /^\d+$/.test(seg))) {
      throw new Error(
        `Line ${lineNum}: Explicit array index in wire target is not supported. Use array mapping (\`[] as iter { }\`) instead.`,
      );
    }
  }

  // ── Helper: process block-scoped with-declarations inside array maps ──

  /**
   * Process `with <source> as <alias>` declarations inside an array mapping.
   * For each declaration:
   * 1. Build the source ref (iterator-aware: pipe:it becomes a pipe fork ref)
   * 2. Create a __local trunk for the alias
   * 3. Register the alias in handleRes so subsequent element lines can reference it
   * 4. Emit a wire from source to the local trunk
   *
   * Returns a cleanup function that removes local aliases from handleRes.
   */
  function processLocalBindings(
    withDecls: CstNode[],
    iterName: string,
  ): () => void {
    const addedAliases: string[] = [];
    for (const withDecl of withDecls) {
      const lineNum = line(findFirstToken(withDecl));
      const sourceNode = sub(withDecl, "elemWithSource")!;
      const alias = extractNameToken(sub(withDecl, "elemWithAlias")!);
      assertNotReserved(alias, lineNum, "local binding alias");
      if (handleRes.has(alias)) {
        throw new Error(`Line ${lineNum}: Duplicate handle name "${alias}"`);
      }

      // Build source ref — iterator-aware (handles pipe:iter and plain iter refs)
      const headNode = sub(sourceNode, "head")!;
      const pipeSegs = subs(sourceNode, "pipeSegment");
      const { root: srcRoot, segments: srcSegs } = extractAddressPath(headNode);

      let sourceRef: NodeRef;
      if (srcRoot === iterName && pipeSegs.length === 0) {
        // Iterator-relative plain ref (e.g. `with it.data as d`)
        sourceRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: srcSegs,
        };
      } else if (pipeSegs.length > 0) {
        // Pipe expression — the last segment may be iterator-relative.
        // Resolve data source (last part), then build pipe fork chain.
        const allParts = [headNode, ...pipeSegs];
        const actualSourceNode = allParts[allParts.length - 1];
        const pipeChainNodes = allParts.slice(0, -1);

        const { root: dataSrcRoot, segments: dataSrcSegs } =
          extractAddressPath(actualSourceNode);

        let prevOutRef: NodeRef;
        if (dataSrcRoot === iterName) {
          // Iterator-relative pipe source (e.g. `pipe:it` or `pipe:it.field`)
          prevOutRef = {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: dataSrcSegs,
          };
        } else {
          prevOutRef = resolveAddress(dataSrcRoot, dataSrcSegs, lineNum);
        }

        // Build pipe fork chain (same logic as buildSourceExpr)
        const reversed = [...pipeChainNodes].reverse();
        for (let idx = 0; idx < reversed.length; idx++) {
          const pNode = reversed[idx];
          const { root: handleName, segments: handleSegs } =
            extractAddressPath(pNode);
          if (!handleRes.has(handleName)) {
            throw new Error(
              `Line ${lineNum}: Undeclared handle in pipe: "${handleName}". Add 'with <tool> as ${handleName}' to the bridge header.`,
            );
          }
          const fieldName = handleSegs.length > 0 ? handleSegs.join(".") : "in";
          const res = handleRes.get(handleName)!;
          const forkInstance = 100000 + nextForkSeq++;
          const forkKey = `${res.module}:${res.type}:${res.field}:${forkInstance}`;
          pipeHandleEntries.push({
            key: forkKey,
            handle: handleName,
            baseTrunk: {
              module: res.module,
              type: res.type,
              field: res.field,
              instance: res.instance,
            },
          });
          const forkInRef: NodeRef = {
            module: res.module,
            type: res.type,
            field: res.field,
            instance: forkInstance,
            path: parsePath(fieldName),
          };
          const forkRootRef: NodeRef = {
            module: res.module,
            type: res.type,
            field: res.field,
            instance: forkInstance,
            path: [],
          };
          wires.push({
            from: prevOutRef,
            to: forkInRef,
            pipe: true,
          });
          prevOutRef = forkRootRef;
        }
        sourceRef = prevOutRef;
      } else {
        sourceRef = buildSourceExpr(sourceNode, lineNum);
      }

      // Create __local trunk for the alias
      const localRes: HandleResolution = {
        module: "__local",
        type: "Shadow",
        field: alias,
      };
      handleRes.set(alias, localRes);
      addedAliases.push(alias);

      // Emit wire from source to local trunk
      const localToRef: NodeRef = {
        module: "__local",
        type: "Shadow",
        field: alias,
        path: [],
      };
      wires.push({ from: sourceRef, to: localToRef });
    }
    return () => {
      for (const alias of addedAliases) {
        handleRes.delete(alias);
      }
    };
  }

  // ── Helper: build source expression ────────────────────────────────────

  function buildSourceExprSafe(
    sourceNode: CstNode,
    lineNum: number,
    iterName?: string,
  ): { ref: NodeRef; safe?: boolean } {
    const headNode = sub(sourceNode, "head")!;
    const pipeNodes = subs(sourceNode, "pipeSegment");

    if (pipeNodes.length === 0) {
      const { root, segments, safe, rootSafe, segmentSafe } =
        extractAddressPath(headNode);
      let ref: NodeRef;
      if (iterName && root === iterName) {
        ref = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: segments,
        };
      } else {
        ref = resolveAddress(root, segments, lineNum);
      }
      return {
        ref: {
          ...ref,
          ...(rootSafe ? { rootSafe: true } : {}),
          ...(segmentSafe ? { pathSafe: segmentSafe } : {}),
        },
        safe,
      };
    }

    // Pipe chain: all parts in order [head, ...pipeSegments]
    // The LAST part is the actual data source; everything before is a pipe handle.
    const allParts = [headNode, ...pipeNodes];
    const actualSourceNode = allParts[allParts.length - 1];
    const pipeChainNodes = allParts.slice(0, -1);

    // Validate all pipe handles
    for (const pipeNode of pipeChainNodes) {
      const { root } = extractAddressPath(pipeNode);
      if (!handleRes.has(root)) {
        throw new Error(
          `Line ${lineNum}: Undeclared handle in pipe: "${root}". Add 'with <tool> as ${root}' to the bridge header.`,
        );
      }
    }

    const {
      root: srcRoot,
      segments: srcSegments,
      safe,
      rootSafe: srcRootSafe,
      segmentSafe: srcSegmentSafe,
    } = extractAddressPath(actualSourceNode);
    let prevOutRef: NodeRef;
    if (iterName && srcRoot === iterName) {
      prevOutRef = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
        element: true,
        path: srcSegments,
      };
    } else {
      prevOutRef = resolveAddress(srcRoot, srcSegments, lineNum);
    }

    // Process pipe handles right-to-left (innermost first)
    const reversed = [...pipeChainNodes].reverse();
    for (let idx = 0; idx < reversed.length; idx++) {
      const pNode = reversed[idx];
      const { root: handleName, segments: handleSegs } =
        extractAddressPath(pNode);
      const fieldName = handleSegs.length > 0 ? handleSegs.join(".") : "in";
      const res = handleRes.get(handleName)!;
      const forkInstance = 100000 + nextForkSeq++;
      const forkKey = `${res.module}:${res.type}:${res.field}:${forkInstance}`;
      pipeHandleEntries.push({
        key: forkKey,
        handle: handleName,
        baseTrunk: {
          module: res.module,
          type: res.type,
          field: res.field,
          instance: res.instance,
        },
      });
      const forkInRef: NodeRef = {
        module: res.module,
        type: res.type,
        field: res.field,
        instance: forkInstance,
        path: parsePath(fieldName),
      };
      const forkRootRef: NodeRef = {
        module: res.module,
        type: res.type,
        field: res.field,
        instance: forkInstance,
        path: [],
      };
      wires.push({
        from: prevOutRef,
        to: forkInRef,
        pipe: true,
      });
      prevOutRef = forkRootRef;
    }
    return {
      ref: {
        ...prevOutRef,
        ...(srcRootSafe ? { rootSafe: true } : {}),
        ...(srcSegmentSafe ? { pathSafe: srcSegmentSafe } : {}),
      },
      safe,
    };
  }

  /** Backward-compat wrapper — returns just the NodeRef. */
  function buildSourceExpr(
    sourceNode: CstNode,
    lineNum: number,
    iterName?: string,
  ): NodeRef {
    return buildSourceExprSafe(sourceNode, lineNum, iterName).ref;
  }

  // ── Helper: desugar template string into synthetic internal.concat fork ─────

  function desugarTemplateString(
    segs: TemplateSeg[],
    lineNum: number,
    iterName?: string,
  ): NodeRef {
    const forkInstance = 100000 + nextForkSeq++;
    const forkModule = SELF_MODULE;
    const forkType = "Tools";
    const forkField = "concat";
    const forkKey = `${forkModule}:${forkType}:${forkField}:${forkInstance}`;
    pipeHandleEntries.push({
      key: forkKey,
      handle: `__concat_${forkInstance}`,
      baseTrunk: {
        module: forkModule,
        type: forkType,
        field: forkField,
      },
    });

    for (let idx = 0; idx < segs.length; idx++) {
      const seg = segs[idx];
      const partRef: NodeRef = {
        module: forkModule,
        type: forkType,
        field: forkField,
        instance: forkInstance,
        path: ["parts", String(idx)],
      };
      if (seg.kind === "text") {
        wires.push({ value: seg.value, to: partRef });
      } else {
        // Parse the ref path: e.g. "i.id" → root="i", segments=["id"]
        const dotParts = seg.path.split(".");
        const root = dotParts[0];
        const segments = dotParts.slice(1);

        // Check for iterator-relative refs
        if (iterName && root === iterName) {
          const fromRef: NodeRef = {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: segments,
          };
          wires.push({ from: fromRef, to: partRef });
        } else {
          const fromRef = resolveAddress(root, segments, lineNum);
          wires.push({ from: fromRef, to: partRef });
        }
      }
    }

    return {
      module: forkModule,
      type: forkType,
      field: forkField,
      instance: forkInstance,
      path: ["value"],
    };
  }

  // ── Helper: extract coalesce alternative ───────────────────────────────

  function extractCoalesceAlt(
    altNode: CstNode,
    lineNum: number,
    iterName?: string,
  ):
    | { literal: string }
    | { sourceRef: NodeRef }
    | { control: ControlFlowInstruction } {
    const c = altNode.children;
    // Control flow keywords
    if (c.throwKw) {
      const msg = (c.throwMsg as IToken[])[0].image;
      return { control: { kind: "throw", message: JSON.parse(msg) } };
    }
    if (c.panicKw) {
      const msg = (c.panicMsg as IToken[])[0].image;
      return { control: { kind: "panic", message: JSON.parse(msg) } };
    }
    if (c.continueKw) return { control: { kind: "continue" } };
    if (c.breakKw) return { control: { kind: "break" } };
    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      const segs = parseTemplateString(raw.slice(1, -1));
      if (segs)
        return { sourceRef: desugarTemplateString(segs, lineNum, iterName) };
      return { literal: raw };
    }
    if (c.numberLit) return { literal: (c.numberLit as IToken[])[0].image };
    if (c.intLit) return { literal: (c.intLit as IToken[])[0].image };
    if (c.trueLit) return { literal: "true" };
    if (c.falseLit) return { literal: "false" };
    if (c.nullLit) return { literal: "null" };
    if (c.objectLit)
      return { literal: reconstructJson((c.objectLit as CstNode[])[0]) };
    if (c.sourceAlt) {
      const srcNode = (c.sourceAlt as CstNode[])[0];
      return { sourceRef: buildSourceExpr(srcNode, lineNum) };
    }
    throw new Error(`Line ${lineNum}: Invalid coalesce alternative`);
  }

  // ── Helper: extract ternary branch ────────────────────────────────────

  /**
   * Resolve a ternaryBranch CST node to either a NodeRef (source) or a
   * raw literal string suitable for JSON.parse (kept verbatim for numbers
   * / booleans / null; kept with quotes for strings so JSON.parse works).
   */
  function extractTernaryBranch(
    branchNode: CstNode,
    lineNum: number,
    iterName?: string,
  ): { kind: "literal"; value: string } | { kind: "ref"; ref: NodeRef } {
    const c = branchNode.children;
    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      const segs = parseTemplateString(raw.slice(1, -1));
      if (segs)
        return {
          kind: "ref",
          ref: desugarTemplateString(segs, lineNum, iterName),
        };
      return { kind: "literal", value: raw };
    }
    if (c.numberLit)
      return { kind: "literal", value: (c.numberLit as IToken[])[0].image };
    if (c.trueLit) return { kind: "literal", value: "true" };
    if (c.falseLit) return { kind: "literal", value: "false" };
    if (c.nullLit) return { kind: "literal", value: "null" };
    if (c.sourceRef) {
      const addrNode = (c.sourceRef as CstNode[])[0];
      const { root, segments } = extractAddressPath(addrNode);
      // Iterator-relative ref in element context
      if (iterName && root === iterName) {
        return {
          kind: "ref",
          ref: {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: segments,
          },
        };
      }
      return { kind: "ref", ref: resolveAddress(root, segments, lineNum) };
    }
    throw new Error(`Line ${lineNum}: Invalid ternary branch`);
  }

  // ── Helper: operator symbol → std tool function name ──────────────────

  /** Map infix operator token to the std tool that implements it. */
  const OP_TO_FN: Record<string, string> = {
    "*": "multiply",
    "/": "divide",
    "+": "add",
    "-": "subtract",
    "==": "eq",
    "!=": "neq",
    ">": "gt",
    ">=": "gte",
    "<": "lt",
    "<=": "lte",
    // and/or are handled as native condAnd/condOr wires, not tool forks
  };

  /** Operator precedence: higher number = binds tighter. */
  const OP_PREC: Record<string, number> = {
    "*": 4,
    "/": 4,
    "+": 3,
    "-": 3,
    "==": 2,
    "!=": 2,
    ">": 2,
    ">=": 2,
    "<": 2,
    "<=": 2,
    and: 1,
    or: 0,
  };

  function extractExprOpStr(opNode: CstNode): string {
    const c = opNode.children;
    if (c.star) return "*";
    if (c.slash) return "/";
    if (c.plus) return "+";
    if (c.minus) return "-";
    if (c.doubleEquals) return "==";
    if (c.notEquals) return "!=";
    if (c.greaterEqual) return ">=";
    if (c.lessEqual) return "<=";
    if (c.greaterThan) return ">";
    if (c.lessThan) return "<";
    if (c.andKw) return "and";
    if (c.orKw) return "or";
    throw new Error("Invalid expression operator");
  }

  /**
   * Resolve an exprOperand CST node to either a NodeRef (source) or
   * a literal string value suitable for a constant wire.
   */
  function resolveExprOperand(
    operandNode: CstNode,
    lineNum: number,
    iterName?: string,
  ):
    | { kind: "ref"; ref: NodeRef; safe?: boolean }
    | { kind: "literal"; value: string } {
    const c = operandNode.children;
    if (c.numberLit)
      return { kind: "literal", value: (c.numberLit as IToken[])[0].image };
    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      const content = raw.slice(1, -1);
      const segs = parseTemplateString(content);
      if (segs)
        return {
          kind: "ref",
          ref: desugarTemplateString(segs, lineNum, iterName),
        };
      return { kind: "literal", value: content };
    }
    if (c.trueLit) return { kind: "literal", value: "1" };
    if (c.falseLit) return { kind: "literal", value: "0" };
    if (c.nullLit) return { kind: "literal", value: "0" };
    if (c.sourceRef) {
      const srcNode = (c.sourceRef as CstNode[])[0];

      // Check for element/iterator-relative refs
      if (iterName) {
        const headNode = sub(srcNode, "head")!;
        const pipeSegs = subs(srcNode, "pipeSegment");
        const { root, segments, safe } = extractAddressPath(headNode);
        if (root === iterName && pipeSegs.length === 0) {
          return {
            kind: "ref",
            safe,
            ref: {
              module: SELF_MODULE,
              type: bridgeType,
              field: bridgeField,
              element: true,
              path: segments,
            },
          };
        }
      }

      const { ref, safe } = buildSourceExprSafe(srcNode, lineNum);
      return { kind: "ref", ref, safe };
    }
    if (c.parenExpr) {
      const parenNode = (c.parenExpr as CstNode[])[0];
      const ref = resolveParenExpr(parenNode, lineNum, iterName);
      return { kind: "ref", ref };
    }
    throw new Error(`Line ${lineNum}: Invalid expression operand`);
  }

  /**
   * Resolve a parenthesized sub-expression `( [not] source [op operand]* )`
   * into a single NodeRef by recursively desugaring the inner chain.
   */
  function resolveParenExpr(
    parenNode: CstNode,
    lineNum: number,
    iterName?: string,
    safe?: boolean,
  ): NodeRef {
    const pc = parenNode.children;
    const innerSourceNode = sub(parenNode, "parenSource")!;
    const innerOps = subs(parenNode, "parenExprOp");
    const innerRights = subs(parenNode, "parenExprRight");
    const hasNot = !!(pc.parenNotPrefix as IToken[] | undefined)?.length;

    // Build the inner source ref (handling iterator-relative refs)
    let innerRef: NodeRef;
    let innerSafe = safe;
    if (iterName) {
      const headNode = sub(innerSourceNode, "head")!;
      const pipeSegs = subs(innerSourceNode, "pipeSegment");
      const { root, segments, safe: srcSafe } = extractAddressPath(headNode);
      if (root === iterName && pipeSegs.length === 0) {
        innerRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: segments,
        };
        if (srcSafe) innerSafe = true;
      } else {
        const result = buildSourceExprSafe(innerSourceNode, lineNum);
        innerRef = result.ref;
        if (result.safe) innerSafe = true;
      }
    } else {
      const result = buildSourceExprSafe(innerSourceNode, lineNum);
      innerRef = result.ref;
      if (result.safe) innerSafe = true;
    }

    // Desugar the inner expression chain if there are operators
    let resultRef: NodeRef;
    if (innerOps.length > 0) {
      resultRef = desugarExprChain(
        innerRef,
        innerOps,
        innerRights,
        lineNum,
        iterName,
        innerSafe,
      );
    } else {
      resultRef = innerRef;
    }

    // Apply not prefix if present
    if (hasNot) {
      resultRef = desugarNot(resultRef, lineNum, innerSafe);
    }

    return resultRef;
  }

  /**
   * Desugar an infix expression chain into synthetic tool wires,
   * respecting operator precedence (* / before + - before comparisons).
   *
   * Given:  leftRef + rightA * rightB > 5
   * Produces: leftRef + (rightA * rightB) > 5
   *
   * Each binary node creates a synthetic tool fork (like pipe desugaring):
   *   __expr fork instance → { a: left, b: right } → result
   */
  function desugarExprChain(
    leftRef: NodeRef,
    exprOps: CstNode[],
    exprRights: CstNode[],
    lineNum: number,
    iterName?: string,
    safe?: boolean,
  ): NodeRef {
    // Build flat operand/operator lists for the precedence parser.
    // operands[0] = leftRef, operands[i+1] = resolved exprRights[i]
    type Operand =
      | { kind: "ref"; ref: NodeRef; safe?: boolean }
      | { kind: "literal"; value: string };
    const operands: Operand[] = [{ kind: "ref", ref: leftRef, safe }];
    const ops: string[] = [];

    for (let i = 0; i < exprOps.length; i++) {
      ops.push(extractExprOpStr(exprOps[i]));
      operands.push(resolveExprOperand(exprRights[i], lineNum, iterName));
    }

    // Emit a synthetic fork for a single binary operation and return
    // an operand pointing to the fork's result.
    function emitFork(left: Operand, opStr: string, right: Operand): Operand {
      // Derive safe flag per operand
      const leftSafe = left.kind === "ref" && !!left.safe;
      const rightSafe = right.kind === "ref" && !!right.safe;

      // ── Short-circuit and/or: emit condAnd/condOr wire ──
      if (opStr === "and" || opStr === "or") {
        const forkInstance = 100000 + nextForkSeq++;
        const forkField = opStr === "and" ? "__and" : "__or";
        const forkTrunkModule = SELF_MODULE;
        const forkTrunkType = "Tools";
        const forkKey = `${forkTrunkModule}:${forkTrunkType}:${forkField}:${forkInstance}`;
        pipeHandleEntries.push({
          key: forkKey,
          handle: `__expr_${forkInstance}`,
          baseTrunk: {
            module: forkTrunkModule,
            type: forkTrunkType,
            field: forkField,
          },
        });

        const toRef: NodeRef = {
          module: forkTrunkModule,
          type: forkTrunkType,
          field: forkField,
          instance: forkInstance,
          path: [],
        };

        // Build the leftRef for the condAnd/condOr
        const leftRef =
          left.kind === "ref"
            ? left.ref
            : (() => {
                // Literal left: emit a constant wire and reference it
                const litInstance = 100000 + nextForkSeq++;
                const litField = "__lit";
                const litKey = `${forkTrunkModule}:${forkTrunkType}:${litField}:${litInstance}`;
                pipeHandleEntries.push({
                  key: litKey,
                  handle: `__expr_${litInstance}`,
                  baseTrunk: {
                    module: forkTrunkModule,
                    type: forkTrunkType,
                    field: litField,
                  },
                });
                const litRef: NodeRef = {
                  module: forkTrunkModule,
                  type: forkTrunkType,
                  field: litField,
                  instance: litInstance,
                  path: [],
                };
                wires.push({ value: left.value, to: litRef });
                return litRef;
              })();

        // Build right side
        const rightSide =
          right.kind === "ref"
            ? { rightRef: right.ref }
            : { rightValue: right.value };

        const safeAttr = leftSafe ? { safe: true as const } : {};
        const rightSafeAttr = rightSafe ? { rightSafe: true as const } : {};

        if (opStr === "and") {
          wires.push({
            condAnd: { leftRef, ...rightSide, ...safeAttr, ...rightSafeAttr },
            to: toRef,
          });
        } else {
          wires.push({
            condOr: { leftRef, ...rightSide, ...safeAttr, ...rightSafeAttr },
            to: toRef,
          });
        }

        return { kind: "ref", ref: toRef };
      }

      // ── Standard math/comparison: emit synthetic tool fork ──
      const fnName = OP_TO_FN[opStr];
      if (!fnName)
        throw new Error(`Line ${lineNum}: Unknown operator "${opStr}"`);

      const forkInstance = 100000 + nextForkSeq++;
      const forkTrunkModule = SELF_MODULE;
      const forkTrunkType = "Tools";
      const forkTrunkField = fnName;

      const forkKey = `${forkTrunkModule}:${forkTrunkType}:${forkTrunkField}:${forkInstance}`;
      pipeHandleEntries.push({
        key: forkKey,
        handle: `__expr_${forkInstance}`,
        baseTrunk: {
          module: forkTrunkModule,
          type: forkTrunkType,
          field: forkTrunkField,
        },
      });

      const makeTarget = (slot: string): NodeRef => ({
        module: forkTrunkModule,
        type: forkTrunkType,
        field: forkTrunkField,
        instance: forkInstance,
        path: [slot],
      });

      // Wire left → fork.a (propagate safe flag from operand)
      if (left.kind === "literal") {
        wires.push({ value: left.value, to: makeTarget("a") });
      } else {
        const safeAttr = leftSafe ? { safe: true as const } : {};
        wires.push({
          from: left.ref,
          to: makeTarget("a"),
          pipe: true,
          ...safeAttr,
        });
      }

      // Wire right → fork.b (propagate safe flag from operand)
      if (right.kind === "literal") {
        wires.push({ value: right.value, to: makeTarget("b") });
      } else {
        const safeAttr = rightSafe ? { safe: true as const } : {};
        wires.push({
          from: right.ref,
          to: makeTarget("b"),
          pipe: true,
          ...safeAttr,
        });
      }

      return {
        kind: "ref",
        ref: {
          module: forkTrunkModule,
          type: forkTrunkType,
          field: forkTrunkField,
          instance: forkInstance,
          path: [],
        },
      };
    }

    // Reduce all operators at a given precedence level (left-to-right).
    // Modifies operands/ops arrays in place, collapsing matched pairs.
    function reduceLevel(prec: number): void {
      let i = 0;
      while (i < ops.length) {
        if ((OP_PREC[ops[i]] ?? 0) === prec) {
          const result = emitFork(operands[i], ops[i], operands[i + 1]);
          operands.splice(i, 2, result);
          ops.splice(i, 1);
        } else {
          i++;
        }
      }
    }

    // Process in precedence order: * / first, then + -, then comparisons, then and, then or.
    reduceLevel(4); // * /
    reduceLevel(3); // + -
    reduceLevel(2); // == != > >= < <=
    reduceLevel(1); // and
    reduceLevel(0); // or

    // After full reduction, operands[0] holds the final result.
    const final = operands[0];
    if (final.kind !== "ref") {
      throw new Error(
        `Line ${lineNum}: Expression must contain at least one source reference`,
      );
    }
    return final.ref;
  }

  /**
   * Desugar a `not` prefix into a synthetic unary fork that calls `internal.not`.
   * Wraps the given ref:  not(sourceRef) → __expr fork with { a: sourceRef }
   */
  function desugarNot(
    sourceRef: NodeRef,
    _lineNum: number,
    safe?: boolean,
  ): NodeRef {
    const forkInstance = 100000 + nextForkSeq++;
    const forkTrunkModule = SELF_MODULE;
    const forkTrunkType = "Tools";
    const forkTrunkField = "not";

    const forkKey = `${forkTrunkModule}:${forkTrunkType}:${forkTrunkField}:${forkInstance}`;
    pipeHandleEntries.push({
      key: forkKey,
      handle: `__expr_${forkInstance}`,
      baseTrunk: {
        module: forkTrunkModule,
        type: forkTrunkType,
        field: forkTrunkField,
      },
    });

    const safeAttr = safe ? { safe: true as const } : {};
    wires.push({
      from: sourceRef,
      to: {
        module: forkTrunkModule,
        type: forkTrunkType,
        field: forkTrunkField,
        instance: forkInstance,
        path: ["a"],
      },
      pipe: true,
      ...safeAttr,
    });

    return {
      module: forkTrunkModule,
      type: forkTrunkType,
      field: forkTrunkField,
      instance: forkInstance,
      path: [],
    };
  }

  // ── Helper: recursively process path scoping block lines ───────────────
  // Flattens nested scope blocks into standard flat wires by prepending
  // the accumulated path prefix to each inner target.

  function processScopeLines(
    scopeLines: CstNode[],
    targetRoot: string,
    pathPrefix: string[],
  ): void {
    for (const scopeLine of scopeLines) {
      const sc = scopeLine.children;
      const scopeLineNum = line(findFirstToken(scopeLine));
      const targetStr = extractDottedPathStr(sub(scopeLine, "scopeTarget")!);
      const scopeSegs = parsePath(targetStr);
      const fullSegs = [...pathPrefix, ...scopeSegs];

      // ── Nested scope: .field { ... } ──
      const nestedScopeLines = subs(scopeLine, "pathScopeLine");
      const nestedSpreadLines = subs(scopeLine, "scopeSpreadLine");
      if (
        (nestedScopeLines.length > 0 || nestedSpreadLines.length > 0) &&
        !sc.scopeEquals &&
        !sc.scopeArrow
      ) {
        // Process alias declarations inside the nested scope block first
        const scopeAliases = subs(scopeLine, "scopeAlias");
        for (const aliasNode of scopeAliases) {
          const aliasLineNum = line(findFirstToken(aliasNode));
          const sourceNode = sub(aliasNode, "nodeAliasSource")!;
          const alias = extractNameToken(sub(aliasNode, "nodeAliasName")!);
          assertNotReserved(alias, aliasLineNum, "node alias");
          if (handleRes.has(alias)) {
            throw new Error(
              `Line ${aliasLineNum}: Duplicate handle name "${alias}"`,
            );
          }
          const { ref: sourceRef, safe: aliasSafe } = buildSourceExprSafe(
            sourceNode,
            aliasLineNum,
          );
          const localRes: HandleResolution = {
            module: "__local",
            type: "Shadow",
            field: alias,
          };
          handleRes.set(alias, localRes);
          const localToRef: NodeRef = {
            module: "__local",
            type: "Shadow",
            field: alias,
            path: [],
          };
          wires.push({
            from: sourceRef,
            to: localToRef,
            ...(aliasSafe ? { safe: true as const } : {}),
          });
        }
        // Process spread lines inside this nested scope block: ...sourceExpr
        const nestedToRef = resolveAddress(targetRoot, fullSegs, scopeLineNum);
        for (const spreadLine of nestedSpreadLines) {
          const spreadLineNum = line(findFirstToken(spreadLine));
          const sourceNode = sub(spreadLine, "spreadSource")!;
          const { ref: fromRef, safe: spreadSafe } = buildSourceExprSafe(
            sourceNode,
            spreadLineNum,
          );
          wires.push({
            from: fromRef,
            to: nestedToRef,
            spread: true as const,
            ...(spreadSafe ? { safe: true as const } : {}),
          });
        }
        processScopeLines(nestedScopeLines, targetRoot, fullSegs);
        continue;
      }

      const toRef = resolveAddress(targetRoot, fullSegs, scopeLineNum);
      assertNoTargetIndices(toRef, scopeLineNum);

      // ── Constant wire: .field = value ──
      if (sc.scopeEquals) {
        const value = extractBareValue(sub(scopeLine, "scopeValue")!);
        wires.push({ value, to: toRef });
        continue;
      }

      // ── Pull wire: .field <- source [modifiers] ──
      if (sc.scopeArrow) {
        // String source (template or plain): .field <- "..."
        const stringSourceToken = (
          sc.scopeStringSource as IToken[] | undefined
        )?.[0];
        if (stringSourceToken) {
          const raw = stringSourceToken.image.slice(1, -1);
          const segs = parseTemplateString(raw);

          const fallbacks: WireFallback[] = [];
          const fallbackInternalWires: Wire[] = [];
          for (const item of subs(scopeLine, "scopeCoalesceItem")) {
            const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
            const altNode = sub(item, "altValue")!;
            const preLen = wires.length;
            const altResult = extractCoalesceAlt(altNode, scopeLineNum);
            if ("literal" in altResult) {
              fallbacks.push({ type, value: altResult.literal });
            } else if ("control" in altResult) {
              fallbacks.push({ type, control: altResult.control });
            } else {
              fallbacks.push({ type, ref: altResult.sourceRef });
              fallbackInternalWires.push(...wires.splice(preLen));
            }
          }
          let catchFallback: string | undefined;
          let catchControl: ControlFlowInstruction | undefined;
          let catchFallbackRef: NodeRef | undefined;
          let catchFallbackInternalWires: Wire[] = [];
          const catchAlt = sub(scopeLine, "scopeCatchAlt");
          if (catchAlt) {
            const preLen = wires.length;
            const altResult = extractCoalesceAlt(catchAlt, scopeLineNum);
            if ("literal" in altResult) catchFallback = altResult.literal;
            else if ("control" in altResult) catchControl = altResult.control;
            else {
              catchFallbackRef = altResult.sourceRef;
              catchFallbackInternalWires = wires.splice(preLen);
            }
          }
          const lastAttrs = {
            ...(fallbacks.length > 0 ? { fallbacks } : {}),
            ...(catchFallback ? { catchFallback } : {}),
            ...(catchFallbackRef ? { catchFallbackRef } : {}),
            ...(catchControl ? { catchControl } : {}),
          };
          if (segs) {
            const concatOutRef = desugarTemplateString(segs, scopeLineNum);
            wires.push({
              from: concatOutRef,
              to: toRef,
              pipe: true,
              ...lastAttrs,
            });
          } else {
            wires.push({ value: raw, to: toRef, ...lastAttrs });
          }
          wires.push(...fallbackInternalWires);
          wires.push(...catchFallbackInternalWires);
          continue;
        }

        // Normal source expression
        const firstSourceNode = sub(scopeLine, "scopeSource");
        const scopeFirstParenNode = sub(scopeLine, "scopeFirstParenExpr");
        const sourceParts: { ref: NodeRef; isPipeFork: boolean }[] = [];
        const exprOps = subs(scopeLine, "scopeExprOp");

        // Extract safe flag from head node
        let scopeBlockSafe: boolean = false;
        if (firstSourceNode) {
          const headNode = sub(firstSourceNode, "head");
          if (headNode) {
            scopeBlockSafe = !!extractAddressPath(headNode).safe;
          }
        }

        let condRef: NodeRef;
        let condIsPipeFork: boolean;
        if (scopeFirstParenNode) {
          const parenRef = resolveParenExpr(
            scopeFirstParenNode,
            scopeLineNum,
            undefined,
            scopeBlockSafe || undefined,
          );
          if (exprOps.length > 0) {
            const exprRights = subs(scopeLine, "scopeExprRight");
            condRef = desugarExprChain(
              parenRef,
              exprOps,
              exprRights,
              scopeLineNum,
              undefined,
              scopeBlockSafe || undefined,
            );
          } else {
            condRef = parenRef;
          }
          condIsPipeFork = true;
        } else if (exprOps.length > 0) {
          const exprRights = subs(scopeLine, "scopeExprRight");
          const leftRef = buildSourceExpr(firstSourceNode!, scopeLineNum);
          condRef = desugarExprChain(
            leftRef,
            exprOps,
            exprRights,
            scopeLineNum,
            undefined,
            scopeBlockSafe || undefined,
          );
          condIsPipeFork = true;
        } else {
          const pipeSegs = subs(firstSourceNode!, "pipeSegment");
          condRef = buildSourceExpr(firstSourceNode!, scopeLineNum);
          condIsPipeFork =
            condRef.instance != null &&
            condRef.path.length === 0 &&
            pipeSegs.length > 0;
        }

        // ── Apply `not` prefix if present (scope context) ──
        if ((sc.scopeNotPrefix as IToken[] | undefined)?.[0]) {
          condRef = desugarNot(
            condRef,
            scopeLineNum,
            scopeBlockSafe || undefined,
          );
          condIsPipeFork = true;
        }

        // Ternary wire: .field <- cond ? then : else
        const scopeTernaryOp = (sc.scopeTernaryOp as IToken[] | undefined)?.[0];
        if (scopeTernaryOp) {
          const thenNode = sub(scopeLine, "scopeThenBranch")!;
          const elseNode = sub(scopeLine, "scopeElseBranch")!;
          const thenBranch = extractTernaryBranch(thenNode, scopeLineNum);
          const elseBranch = extractTernaryBranch(elseNode, scopeLineNum);
          const fallbacks: WireFallback[] = [];
          const fallbackInternalWires: Wire[] = [];
          for (const item of subs(scopeLine, "scopeCoalesceItem")) {
            const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
            const altNode = sub(item, "altValue")!;
            const preLen = wires.length;
            const altResult = extractCoalesceAlt(altNode, scopeLineNum);
            if ("literal" in altResult) {
              fallbacks.push({ type, value: altResult.literal });
            } else if ("control" in altResult) {
              fallbacks.push({ type, control: altResult.control });
            } else {
              fallbacks.push({ type, ref: altResult.sourceRef });
              fallbackInternalWires.push(...wires.splice(preLen));
            }
          }
          let catchFallback: string | undefined;
          let catchControl: ControlFlowInstruction | undefined;
          let catchFallbackRef: NodeRef | undefined;
          let catchFallbackInternalWires: Wire[] = [];
          const catchAlt = sub(scopeLine, "scopeCatchAlt");
          if (catchAlt) {
            const preLen = wires.length;
            const altResult = extractCoalesceAlt(catchAlt, scopeLineNum);
            if ("literal" in altResult) catchFallback = altResult.literal;
            else if ("control" in altResult) catchControl = altResult.control;
            else {
              catchFallbackRef = altResult.sourceRef;
              catchFallbackInternalWires = wires.splice(preLen);
            }
          }
          wires.push({
            cond: condRef,
            ...(thenBranch.kind === "ref"
              ? { thenRef: thenBranch.ref }
              : { thenValue: thenBranch.value }),
            ...(elseBranch.kind === "ref"
              ? { elseRef: elseBranch.ref }
              : { elseValue: elseBranch.value }),
            ...(fallbacks.length > 0 ? { fallbacks } : {}),
            ...(catchFallback !== undefined ? { catchFallback } : {}),
            ...(catchFallbackRef !== undefined ? { catchFallbackRef } : {}),
            ...(catchControl ? { catchControl } : {}),
            to: toRef,
          });
          wires.push(...fallbackInternalWires);
          wires.push(...catchFallbackInternalWires);
          continue;
        }

        sourceParts.push({ ref: condRef, isPipeFork: condIsPipeFork });

        // Coalesce alternatives (|| and ??)
        const fallbacks: WireFallback[] = [];
        const fallbackInternalWires: Wire[] = [];
        for (const item of subs(scopeLine, "scopeCoalesceItem")) {
          const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
          const altNode = sub(item, "altValue")!;
          const preLen = wires.length;
          const altResult = extractCoalesceAlt(altNode, scopeLineNum);
          if ("literal" in altResult) {
            fallbacks.push({ type, value: altResult.literal });
          } else if ("control" in altResult) {
            fallbacks.push({ type, control: altResult.control });
          } else {
            fallbacks.push({ type, ref: altResult.sourceRef });
            fallbackInternalWires.push(...wires.splice(preLen));
          }
        }

        let catchFallback: string | undefined;
        let catchControl: ControlFlowInstruction | undefined;
        let catchFallbackRef: NodeRef | undefined;
        let catchFallbackInternalWires: Wire[] = [];
        const catchAlt = sub(scopeLine, "scopeCatchAlt");
        if (catchAlt) {
          const preLen = wires.length;
          const altResult = extractCoalesceAlt(catchAlt, scopeLineNum);
          if ("literal" in altResult) catchFallback = altResult.literal;
          else if ("control" in altResult) catchControl = altResult.control;
          else {
            catchFallbackRef = altResult.sourceRef;
            catchFallbackInternalWires = wires.splice(preLen);
          }
        }

        const { ref: fromRef, isPipeFork: isPipe } = sourceParts[0];
        const wireAttrs = {
          ...(isPipe ? { pipe: true as const } : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          ...(catchFallback ? { catchFallback } : {}),
          ...(catchFallbackRef ? { catchFallbackRef } : {}),
          ...(catchControl ? { catchControl } : {}),
        };
        wires.push({ from: fromRef, to: toRef, ...wireAttrs });
        wires.push(...fallbackInternalWires);
        wires.push(...catchFallbackInternalWires);
      }
    }
  }

  // ── Step 1.5: Process top-level node alias declarations ────────────────
  // `with <sourceExpr> as <alias>` at bridge body level (pipe-based).
  // Also detect simple renames via bridgeWithDecl when the root is already
  // a declared handle (e.g. `with api.some.complex.field as alias`).

  for (const bodyLine of bodyLines) {
    const c = bodyLine.children;

    // Handle pipe-based node aliases: with uc:i.category as upper
    const nodeAliasNode = (c.bridgeNodeAlias as CstNode[] | undefined)?.[0];
    if (nodeAliasNode) {
      const lineNum = line(findFirstToken(nodeAliasNode));
      const alias = extractNameToken(sub(nodeAliasNode, "nodeAliasName")!);
      assertNotReserved(alias, lineNum, "node alias");
      if (handleRes.has(alias)) {
        throw new Error(`Line ${lineNum}: Duplicate handle name "${alias}"`);
      }

      // ── Extract coalesce modifiers FIRST (shared by ternary + pull paths) ──
      const aliasFallbacks: WireFallback[] = [];
      const aliasFallbackInternalWires: Wire[] = [];
      for (const item of subs(nodeAliasNode, "aliasCoalesceItem")) {
        const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
        const altNode = sub(item, "altValue")!;
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(altNode, lineNum);
        if ("literal" in altResult) {
          aliasFallbacks.push({ type, value: altResult.literal });
        } else if ("control" in altResult) {
          aliasFallbacks.push({ type, control: altResult.control });
        } else {
          aliasFallbacks.push({ type, ref: altResult.sourceRef });
          aliasFallbackInternalWires.push(...wires.splice(preLen));
        }
      }
      let aliasCatchFallback: string | undefined;
      let aliasCatchControl: ControlFlowInstruction | undefined;
      let aliasCatchFallbackRef: NodeRef | undefined;
      let aliasCatchFallbackInternalWires: Wire[] = [];
      const aliasCatchAlt = sub(nodeAliasNode, "aliasCatchAlt");
      if (aliasCatchAlt) {
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(aliasCatchAlt, lineNum);
        if ("literal" in altResult) {
          aliasCatchFallback = altResult.literal;
        } else if ("control" in altResult) {
          aliasCatchControl = altResult.control;
        } else {
          aliasCatchFallbackRef = altResult.sourceRef;
          aliasCatchFallbackInternalWires = wires.splice(preLen);
        }
      }
      const modifierAttrs = {
        ...(aliasFallbacks.length > 0 ? { fallbacks: aliasFallbacks } : {}),
        ...(aliasCatchFallback ? { catchFallback: aliasCatchFallback } : {}),
        ...(aliasCatchFallbackRef
          ? { catchFallbackRef: aliasCatchFallbackRef }
          : {}),
        ...(aliasCatchControl ? { catchControl: aliasCatchControl } : {}),
      };

      // ── Compute the source ref ──
      let sourceRef: NodeRef;
      let aliasSafe: boolean | undefined;

      const aliasStringToken = (
        nodeAliasNode.children.aliasStringSource as IToken[] | undefined
      )?.[0];
      if (aliasStringToken) {
        // String literal source: alias "template..." [op right]* as name
        const raw = aliasStringToken.image.slice(1, -1);
        const segs = parseTemplateString(raw);
        const stringExprOps = subs(nodeAliasNode, "aliasStringExprOp");
        // Produce a NodeRef for the string value (concat fork or template desugar)
        const strRef: NodeRef = segs
          ? desugarTemplateString(segs, lineNum)
          : desugarTemplateString([{ kind: "text", value: raw }], lineNum);
        if (stringExprOps.length > 0) {
          const stringExprRights = subs(nodeAliasNode, "aliasStringExprRight");
          sourceRef = desugarExprChain(
            strRef,
            stringExprOps,
            stringExprRights,
            lineNum,
          );
        } else {
          sourceRef = strRef;
        }
        // Ternary after string source (e.g. alias "a" == "b" ? x : y as name)
        const strTernaryOp = (
          nodeAliasNode.children.aliasStringTernaryOp as IToken[] | undefined
        )?.[0];
        if (strTernaryOp) {
          const thenNode = sub(nodeAliasNode, "aliasStringThenBranch")!;
          const elseNode = sub(nodeAliasNode, "aliasStringElseBranch")!;
          const thenBranch = extractTernaryBranch(thenNode, lineNum);
          const elseBranch = extractTernaryBranch(elseNode, lineNum);
          const ternaryToRef: NodeRef = {
            module: "__local",
            type: "Shadow",
            field: alias,
            path: [],
          };
          handleRes.set(alias, {
            module: "__local",
            type: "Shadow",
            field: alias,
          });
          wires.push({
            cond: sourceRef,
            ...(thenBranch.kind === "ref"
              ? { thenRef: thenBranch.ref }
              : { thenValue: thenBranch.value }),
            ...(elseBranch.kind === "ref"
              ? { elseRef: elseBranch.ref }
              : { elseValue: elseBranch.value }),
            ...modifierAttrs,
            to: ternaryToRef,
          });
          wires.push(...aliasFallbackInternalWires);
          wires.push(...aliasCatchFallbackInternalWires);
          continue;
        }
        aliasSafe = false;
      } else {
        // Normal expression source
        const firstParenNode = sub(nodeAliasNode, "aliasFirstParen");
        const firstSourceNode = sub(nodeAliasNode, "nodeAliasSource");
        const headNode = firstSourceNode
          ? sub(firstSourceNode, "head")
          : undefined;
        const isSafe = headNode
          ? !!extractAddressPath(headNode).rootSafe
          : false;
        const exprOps = subs(nodeAliasNode, "aliasExprOp");

        let condRef: NodeRef;
        if (firstParenNode) {
          const parenRef = resolveParenExpr(
            firstParenNode,
            lineNum,
            undefined,
            isSafe,
          );
          if (exprOps.length > 0) {
            const exprRights = subs(nodeAliasNode, "aliasExprRight");
            condRef = desugarExprChain(
              parenRef,
              exprOps,
              exprRights,
              lineNum,
              undefined,
              isSafe,
            );
          } else {
            condRef = parenRef;
          }
        } else if (exprOps.length > 0) {
          const exprRights = subs(nodeAliasNode, "aliasExprRight");
          const leftRef = buildSourceExpr(firstSourceNode!, lineNum);
          condRef = desugarExprChain(
            leftRef,
            exprOps,
            exprRights,
            lineNum,
            undefined,
            isSafe,
          );
        } else {
          const result = buildSourceExprSafe(firstSourceNode!, lineNum);
          condRef = result.ref;
          aliasSafe = result.safe;
        }

        // Apply `not` prefix if present
        if (
          (nodeAliasNode.children.aliasNotPrefix as IToken[] | undefined)?.[0]
        ) {
          condRef = desugarNot(condRef, lineNum, isSafe);
        }

        // Ternary
        const ternaryOp = (
          nodeAliasNode.children.aliasTernaryOp as IToken[] | undefined
        )?.[0];
        if (ternaryOp) {
          const thenNode = sub(nodeAliasNode, "aliasThenBranch")!;
          const elseNode = sub(nodeAliasNode, "aliasElseBranch")!;
          const thenBranch = extractTernaryBranch(thenNode, lineNum);
          const elseBranch = extractTernaryBranch(elseNode, lineNum);
          const ternaryToRef: NodeRef = {
            module: "__local",
            type: "Shadow",
            field: alias,
            path: [],
          };
          handleRes.set(alias, {
            module: "__local",
            type: "Shadow",
            field: alias,
          });
          wires.push({
            cond: condRef,
            ...(thenBranch.kind === "ref"
              ? { thenRef: thenBranch.ref }
              : { thenValue: thenBranch.value }),
            ...(elseBranch.kind === "ref"
              ? { elseRef: elseBranch.ref }
              : { elseValue: elseBranch.value }),
            ...modifierAttrs,
            to: ternaryToRef,
          });
          wires.push(...aliasFallbackInternalWires);
          wires.push(...aliasCatchFallbackInternalWires);
          continue;
        }

        sourceRef = condRef;
        if (aliasSafe === undefined) aliasSafe = isSafe || undefined;
      }

      // Create __local trunk for the alias
      const localRes: HandleResolution = {
        module: "__local",
        type: "Shadow",
        field: alias,
      };
      handleRes.set(alias, localRes);

      // Emit wire from source to local trunk
      const localToRef: NodeRef = {
        module: "__local",
        type: "Shadow",
        field: alias,
        path: [],
      };
      const aliasAttrs = {
        ...(aliasSafe ? { safe: true as const } : {}),
        ...modifierAttrs,
      };
      wires.push({ from: sourceRef, to: localToRef, ...aliasAttrs });
      wires.push(...aliasFallbackInternalWires);
      wires.push(...aliasCatchFallbackInternalWires);
    }
  }

  // ── Step 2: Process wire lines ─────────────────────────────────────────

  for (const bodyLine of bodyLines) {
    const c = bodyLine.children;
    if (c.bridgeWithDecl) continue; // already processed
    if (c.bridgeNodeAlias) continue; // already processed in Step 1.5
    if (c.bridgeForce) continue; // handled below

    const wireNode = (c.bridgeWire as CstNode[] | undefined)?.[0];
    if (!wireNode) continue;

    const wc = wireNode.children;
    const lineNum = line(findFirstToken(wireNode));

    // Parse target
    const { root: targetRoot, segments: targetSegs } = extractAddressPath(
      sub(wireNode, "target")!,
    );
    const toRef = resolveAddress(targetRoot, targetSegs, lineNum);
    assertNoTargetIndices(toRef, lineNum);

    // ── Constant wire: target = value ──
    if (wc.equalsOp) {
      const value = extractBareValue(sub(wireNode, "constValue")!);
      wires.push({ value, to: toRef });
      continue;
    }

    // ── Path scoping block: target { .field ... } ──
    if (wc.scopeBlock) {
      // Process alias declarations inside the scope block first
      const scopeAliases = subs(wireNode, "scopeAlias");
      for (const aliasNode of scopeAliases) {
        const aliasLineNum = line(findFirstToken(aliasNode));
        const sourceNode = sub(aliasNode, "nodeAliasSource")!;
        const alias = extractNameToken(sub(aliasNode, "nodeAliasName")!);
        assertNotReserved(alias, aliasLineNum, "node alias");
        if (handleRes.has(alias)) {
          throw new Error(
            `Line ${aliasLineNum}: Duplicate handle name "${alias}"`,
          );
        }
        const { ref: sourceRef, safe: aliasSafe } = buildSourceExprSafe(
          sourceNode,
          aliasLineNum,
        );
        const localRes: HandleResolution = {
          module: "__local",
          type: "Shadow",
          field: alias,
        };
        handleRes.set(alias, localRes);
        const localToRef: NodeRef = {
          module: "__local",
          type: "Shadow",
          field: alias,
          path: [],
        };
        wires.push({
          from: sourceRef,
          to: localToRef,
          ...(aliasSafe ? { safe: true as const } : {}),
        });
      }
      const scopeLines = subs(wireNode, "pathScopeLine");
      // Process spread lines inside the scope block: ...sourceExpr
      const spreadLines = subs(wireNode, "scopeSpreadLine");
      for (const spreadLine of spreadLines) {
        const spreadLineNum = line(findFirstToken(spreadLine));
        const sourceNode = sub(spreadLine, "spreadSource")!;
        const { ref: fromRef, safe: spreadSafe } = buildSourceExprSafe(
          sourceNode,
          spreadLineNum,
        );
        wires.push({
          from: fromRef,
          to: toRef,
          spread: true as const,
          ...(spreadSafe ? { safe: true as const } : {}),
        });
      }
      processScopeLines(scopeLines, targetRoot, targetSegs);
      continue;
    }

    // ── Pull wire: target <- source [modifiers] ──

    // ── String source (template or plain): target <- "..." ──
    const stringSourceToken = (wc.stringSource as IToken[] | undefined)?.[0];
    if (stringSourceToken) {
      const raw = stringSourceToken.image.slice(1, -1); // strip quotes
      const segs = parseTemplateString(raw);

      // Process coalesce modifiers
      const fallbacks: WireFallback[] = [];
      const fallbackInternalWires: Wire[] = [];
      for (const item of subs(wireNode, "coalesceItem")) {
        const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
        const altNode = sub(item, "altValue")!;
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(altNode, lineNum);
        if ("literal" in altResult) {
          fallbacks.push({ type, value: altResult.literal });
        } else if ("control" in altResult) {
          fallbacks.push({ type, control: altResult.control });
        } else {
          fallbacks.push({ type, ref: altResult.sourceRef });
          fallbackInternalWires.push(...wires.splice(preLen));
        }
      }
      let catchFallback: string | undefined;
      let catchControl: ControlFlowInstruction | undefined;
      let catchFallbackRef: NodeRef | undefined;
      let catchFallbackInternalWires: Wire[] = [];
      const catchAlt = sub(wireNode, "catchAlt");
      if (catchAlt) {
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(catchAlt, lineNum);
        if ("literal" in altResult) {
          catchFallback = altResult.literal;
        } else if ("control" in altResult) {
          catchControl = altResult.control;
        } else {
          catchFallbackRef = altResult.sourceRef;
          catchFallbackInternalWires = wires.splice(preLen);
        }
      }

      const lastAttrs = {
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
        ...(catchFallback ? { catchFallback } : {}),
        ...(catchFallbackRef ? { catchFallbackRef } : {}),
        ...(catchControl ? { catchControl } : {}),
      };

      if (segs) {
        // Template string — desugar to synthetic internal.concat fork
        const concatOutRef = desugarTemplateString(segs, lineNum);
        wires.push({ from: concatOutRef, to: toRef, pipe: true, ...lastAttrs });
      } else {
        // Plain string without interpolation — emit constant wire
        wires.push({ value: raw, to: toRef, ...lastAttrs });
      }
      wires.push(...fallbackInternalWires);
      wires.push(...catchFallbackInternalWires);
      continue;
    }

    // Array mapping?
    const arrayMappingNode = (wc.arrayMapping as CstNode[] | undefined)?.[0];
    if (arrayMappingNode) {
      const firstSourceNode = sub(wireNode, "firstSource");
      const firstParenNode = sub(wireNode, "firstParenExpr");
      const srcRef = firstParenNode
        ? resolveParenExpr(firstParenNode, lineNum)
        : buildSourceExpr(firstSourceNode!, lineNum);

      // Process coalesce modifiers on the array wire (same as plain pull wires)
      const arrayFallbacks: WireFallback[] = [];
      const arrayFallbackInternalWires: Wire[] = [];
      for (const item of subs(wireNode, "coalesceItem")) {
        const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
        const altNode = sub(item, "altValue")!;
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(altNode, lineNum);
        if ("literal" in altResult) {
          arrayFallbacks.push({ type, value: altResult.literal });
        } else if ("control" in altResult) {
          arrayFallbacks.push({ type, control: altResult.control });
        } else {
          arrayFallbacks.push({ type, ref: altResult.sourceRef });
          arrayFallbackInternalWires.push(...wires.splice(preLen));
        }
      }
      let arrayCatchFallback: string | undefined;
      let arrayCatchControl: ControlFlowInstruction | undefined;
      let arrayCatchFallbackRef: NodeRef | undefined;
      let arrayCatchFallbackInternalWires: Wire[] = [];
      const arrayCatchAlt = sub(wireNode, "catchAlt");
      if (arrayCatchAlt) {
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(arrayCatchAlt, lineNum);
        if ("literal" in altResult) {
          arrayCatchFallback = altResult.literal;
        } else if ("control" in altResult) {
          arrayCatchControl = altResult.control;
        } else {
          arrayCatchFallbackRef = altResult.sourceRef;
          arrayCatchFallbackInternalWires = wires.splice(preLen);
        }
      }
      const arrayWireAttrs = {
        ...(arrayFallbacks.length > 0 ? { fallbacks: arrayFallbacks } : {}),
        ...(arrayCatchFallback ? { catchFallback: arrayCatchFallback } : {}),
        ...(arrayCatchFallbackRef
          ? { catchFallbackRef: arrayCatchFallbackRef }
          : {}),
        ...(arrayCatchControl ? { catchControl: arrayCatchControl } : {}),
      };
      wires.push({ from: srcRef, to: toRef, ...arrayWireAttrs });
      wires.push(...arrayFallbackInternalWires);
      wires.push(...arrayCatchFallbackInternalWires);

      const iterName = extractNameToken(sub(arrayMappingNode, "iterName")!);
      assertNotReserved(iterName, lineNum, "iterator handle");
      const arrayToPath = toRef.path;
      arrayIterators[arrayToPath.join(".")] = iterName;

      // Process element lines (supports nested array mappings recursively)
      const elemWithDecls = subs(arrayMappingNode, "elementWithDecl");
      const cleanup = processLocalBindings(elemWithDecls, iterName);
      processElementLines(
        subs(arrayMappingNode, "elementLine"),
        arrayToPath,
        iterName,
        bridgeType,
        bridgeField,
        wires,
        arrayIterators,
        buildSourceExpr,
        extractCoalesceAlt,
        desugarExprChain,
        extractTernaryBranch,
        processLocalBindings,
        desugarTemplateString,
        desugarNot,
        resolveParenExpr,
      );
      cleanup();
      continue;
    }

    const firstSourceNode = sub(wireNode, "firstSource");
    const firstParenNode = sub(wireNode, "firstParenExpr");
    const sourceParts: { ref: NodeRef; isPipeFork: boolean }[] = [];

    // Check for safe navigation (?.) on the head address path
    const headNode = firstSourceNode ? sub(firstSourceNode, "head") : undefined;
    const isSafe = headNode ? !!extractAddressPath(headNode).rootSafe : false;

    const exprOps = subs(wireNode, "exprOp");

    // Compute condition ref (expression chain result or plain source)
    let condRef: NodeRef;
    let condIsPipeFork: boolean;
    if (firstParenNode) {
      // First source is a parenthesized sub-expression
      const parenRef = resolveParenExpr(
        firstParenNode,
        lineNum,
        undefined,
        isSafe,
      );
      if (exprOps.length > 0) {
        const exprRights = subs(wireNode, "exprRight");
        condRef = desugarExprChain(
          parenRef,
          exprOps,
          exprRights,
          lineNum,
          undefined,
          isSafe,
        );
      } else {
        condRef = parenRef;
      }
      condIsPipeFork = true;
    } else if (exprOps.length > 0) {
      // It's a math/comparison expression — desugar it.
      const exprRights = subs(wireNode, "exprRight");
      const leftRef = buildSourceExpr(firstSourceNode!, lineNum);
      condRef = desugarExprChain(
        leftRef,
        exprOps,
        exprRights,
        lineNum,
        undefined,
        isSafe,
      );
      condIsPipeFork = true;
    } else {
      const pipeSegs = subs(firstSourceNode!, "pipeSegment");
      condRef = buildSourceExpr(firstSourceNode!, lineNum);
      condIsPipeFork =
        condRef.instance != null &&
        condRef.path.length === 0 &&
        pipeSegs.length > 0;
    }

    // ── Apply `not` prefix if present ──
    if (wc.notPrefix) {
      condRef = desugarNot(condRef, lineNum, isSafe);
      condIsPipeFork = true;
    }

    // ── Ternary wire: cond ? thenBranch : elseBranch ──
    const ternaryOp = tok(wireNode, "ternaryOp");
    if (ternaryOp) {
      const thenNode = sub(wireNode, "thenBranch")!;
      const elseNode = sub(wireNode, "elseBranch")!;
      const thenBranch = extractTernaryBranch(thenNode, lineNum);
      const elseBranch = extractTernaryBranch(elseNode, lineNum);

      // Process coalesce alternatives.
      const fallbacks: WireFallback[] = [];
      const fallbackInternalWires: Wire[] = [];
      for (const item of subs(wireNode, "coalesceItem")) {
        const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
        const altNode = sub(item, "altValue")!;
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(altNode, lineNum);
        if ("literal" in altResult) {
          fallbacks.push({ type, value: altResult.literal });
        } else if ("control" in altResult) {
          fallbacks.push({ type, control: altResult.control });
        } else {
          fallbacks.push({ type, ref: altResult.sourceRef });
          fallbackInternalWires.push(...wires.splice(preLen));
        }
      }

      // Process catch error fallback.
      let catchFallback: string | undefined;
      let catchControl: ControlFlowInstruction | undefined;
      let catchFallbackRef: NodeRef | undefined;
      let catchFallbackInternalWires: Wire[] = [];
      const catchAlt = sub(wireNode, "catchAlt");
      if (catchAlt) {
        const preLen = wires.length;
        const altResult = extractCoalesceAlt(catchAlt, lineNum);
        if ("literal" in altResult) {
          catchFallback = altResult.literal;
        } else if ("control" in altResult) {
          catchControl = altResult.control;
        } else {
          catchFallbackRef = altResult.sourceRef;
          catchFallbackInternalWires = wires.splice(preLen);
        }
      }

      wires.push({
        cond: condRef,
        ...(thenBranch.kind === "ref"
          ? { thenRef: thenBranch.ref }
          : { thenValue: thenBranch.value }),
        ...(elseBranch.kind === "ref"
          ? { elseRef: elseBranch.ref }
          : { elseValue: elseBranch.value }),
        ...(fallbacks.length > 0 ? { fallbacks } : {}),
        ...(catchFallback !== undefined ? { catchFallback } : {}),
        ...(catchFallbackRef !== undefined ? { catchFallbackRef } : {}),
        ...(catchControl ? { catchControl } : {}),
        to: toRef,
      });
      wires.push(...fallbackInternalWires);
      wires.push(...catchFallbackInternalWires);
      continue;
    }

    sourceParts.push({ ref: condRef, isPipeFork: condIsPipeFork });

    const fallbacks: WireFallback[] = [];
    const fallbackInternalWires: Wire[] = [];
    let hasTruthyLiteralFallback = false;
    for (const item of subs(wireNode, "coalesceItem")) {
      const type = tok(item, "falsyOp") ? "falsy" as const : "nullish" as const;
      if (type === "falsy" && hasTruthyLiteralFallback) break;
      const altNode = sub(item, "altValue")!;
      const preLen = wires.length;
      const altResult = extractCoalesceAlt(altNode, lineNum);
      if ("literal" in altResult) {
        fallbacks.push({ type, value: altResult.literal });
        if (type === "falsy") {
          hasTruthyLiteralFallback = Boolean(JSON.parse(altResult.literal));
        }
      } else if ("control" in altResult) {
        fallbacks.push({ type, control: altResult.control });
      } else {
        fallbacks.push({ type, ref: altResult.sourceRef });
        fallbackInternalWires.push(...wires.splice(preLen));
      }
    }

    let catchFallback: string | undefined;
    let catchControl: ControlFlowInstruction | undefined;
    let catchFallbackRef: NodeRef | undefined;
    let catchFallbackInternalWires: Wire[] = [];
    const catchAlt = sub(wireNode, "catchAlt");
    if (catchAlt) {
      const preLen = wires.length;
      const altResult = extractCoalesceAlt(catchAlt, lineNum);
      if ("literal" in altResult) {
        catchFallback = altResult.literal;
      } else if ("control" in altResult) {
        catchControl = altResult.control;
      } else {
        catchFallbackRef = altResult.sourceRef;
        catchFallbackInternalWires = wires.splice(preLen);
      }
    }

    const { ref: fromRef, isPipeFork: isPipe } = sourceParts[0];
    const wireAttrs = {
      ...(isSafe ? { safe: true as const } : {}),
      ...(isPipe ? { pipe: true as const } : {}),
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
      ...(catchFallback ? { catchFallback } : {}),
      ...(catchFallbackRef ? { catchFallbackRef } : {}),
      ...(catchControl ? { catchControl } : {}),
    };
    wires.push({ from: fromRef, to: toRef, ...wireAttrs });
    wires.push(...fallbackInternalWires);
    wires.push(...catchFallbackInternalWires);
  }

  // ── Step 3: Collect force statements ──────────────────────────────────

  const forces: NonNullable<Bridge["forces"]> = [];
  for (const bodyLine of bodyLines) {
    const forceNode = (
      bodyLine.children.bridgeForce as CstNode[] | undefined
    )?.[0];
    if (!forceNode) continue;
    const lineNum = line(findFirstToken(forceNode));
    const handle = extractNameToken(sub(forceNode, "forcedHandle")!);
    const res = handleRes.get(handle);
    if (!res) {
      throw new Error(
        `Line ${lineNum}: Cannot force undeclared handle "${handle}". Add 'with ${handle}' to the bridge header.`,
      );
    }
    const fc = forceNode.children;
    const catchError = !!(fc.forceCatchKw as IToken[] | undefined)?.length;
    forces.push({
      handle,
      ...res,
      ...(catchError ? { catchError: true as const } : {}),
    });
  }

  return {
    handles: handleBindings,
    wires,
    arrayIterators,
    pipeHandles: pipeHandleEntries,
    forces,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  inlineDefine (matching the regex parser)
// ═══════════════════════════════════════════════════════════════════════════

function inlineDefine(
  defineHandle: string,
  defineDef: DefineDef,
  bridgeType: string,
  bridgeField: string,
  wires: Wire[],
  pipeHandleEntries: NonNullable<Bridge["pipeHandles"]>,
  handleBindings: HandleBinding[],
  instanceCounters: Map<string, number>,
  nextForkSeqRef: { value: number },
): void {
  const genericModule = `__define_${defineHandle}`;
  const inModule = `__define_in_${defineHandle}`;
  const outModule = `__define_out_${defineHandle}`;
  const defType = "Define";
  const defField = defineDef.name;

  const defCounters = new Map<string, number>();
  const trunkRemap = new Map<
    string,
    { module: string; type: string; field: string; instance: number }
  >();

  for (const hb of defineDef.handles) {
    if (
      hb.kind === "input" ||
      hb.kind === "output" ||
      hb.kind === "context" ||
      hb.kind === "const"
    )
      continue;
    if (hb.kind === "define") continue;
    const name = hb.kind === "tool" ? hb.name : "";
    if (!name) continue;

    const lastDot = name.lastIndexOf(".");
    let oldModule: string,
      oldType: string,
      oldField: string,
      instanceKey: string,
      bridgeKey: string;

    if (lastDot !== -1) {
      oldModule = name.substring(0, lastDot);
      oldType = defType;
      oldField = name.substring(lastDot + 1);
      instanceKey = `${oldModule}:${oldField}`;
      bridgeKey = instanceKey;
    } else {
      oldModule = SELF_MODULE;
      oldType = "Tools";
      oldField = name;
      instanceKey = `Tools:${name}`;
      bridgeKey = instanceKey;
    }

    const oldInstance = (defCounters.get(instanceKey) ?? 0) + 1;
    defCounters.set(instanceKey, oldInstance);
    const newInstance = (instanceCounters.get(bridgeKey) ?? 0) + 1;
    instanceCounters.set(bridgeKey, newInstance);

    const oldKey = `${oldModule}:${oldType}:${oldField}:${oldInstance}`;
    trunkRemap.set(oldKey, {
      module: oldModule,
      type: oldType,
      field: oldField,
      instance: newInstance,
    });
    handleBindings.push({
      handle: `${defineHandle}$${hb.handle}`,
      kind: "tool",
      name,
    });
  }

  // Remap existing bridge wires pointing at the generic define module
  for (const wire of wires) {
    if ("from" in wire) {
      if (wire.to.module === genericModule)
        wire.to = { ...wire.to, module: inModule };
      if (wire.from.module === genericModule)
        wire.from = { ...wire.from, module: outModule };
      if (wire.fallbacks) {
        wire.fallbacks = wire.fallbacks.map(f => f.ref && f.ref.module === genericModule ? { ...f, ref: { ...f.ref, module: outModule } } : f);
      }
      if (wire.catchFallbackRef?.module === genericModule)
        wire.catchFallbackRef = { ...wire.catchFallbackRef, module: outModule };
    }
    if ("value" in wire && wire.to.module === genericModule)
      wire.to = { ...wire.to, module: inModule };
  }

  const forkOffset = nextForkSeqRef.value;
  let maxDefForkSeq = 0;

  function remapRef(ref: NodeRef, side: "from" | "to"): NodeRef {
    if (
      ref.module === SELF_MODULE &&
      ref.type === defType &&
      ref.field === defField
    ) {
      const targetModule = side === "from" ? inModule : outModule;
      return {
        ...ref,
        module: targetModule,
        type: bridgeType,
        field: bridgeField,
      };
    }
    const key = `${ref.module}:${ref.type}:${ref.field}:${ref.instance ?? ""}`;
    const newTrunk = trunkRemap.get(key);
    if (newTrunk)
      return {
        ...ref,
        module: newTrunk.module,
        type: newTrunk.type,
        field: newTrunk.field,
        instance: newTrunk.instance,
      };
    if (ref.instance != null && ref.instance >= 100000) {
      const defSeq = ref.instance - 100000;
      if (defSeq + 1 > maxDefForkSeq) maxDefForkSeq = defSeq + 1;
      return { ...ref, instance: ref.instance + forkOffset };
    }
    return ref;
  }

  for (const wire of defineDef.wires) {
    const cloned: Wire = JSON.parse(JSON.stringify(wire));
    if ("from" in cloned) {
      cloned.from = remapRef(cloned.from, "from");
      cloned.to = remapRef(cloned.to, "to");
      if (cloned.fallbacks) {
        cloned.fallbacks = cloned.fallbacks.map(f => f.ref ? { ...f, ref: remapRef(f.ref, "from") } : f);
      }
      if (cloned.catchFallbackRef)
        cloned.catchFallbackRef = remapRef(cloned.catchFallbackRef, "from");
    } else {
      cloned.to = remapRef(cloned.to, "to");
    }
    wires.push(cloned);
  }

  nextForkSeqRef.value += maxDefForkSeq;

  if (defineDef.pipeHandles) {
    for (const ph of defineDef.pipeHandles) {
      const parts = ph.key.split(":");
      const phInstance = parseInt(parts[parts.length - 1]);
      let newKey = ph.key;
      if (phInstance >= 100000) {
        const newInst = phInstance + forkOffset;
        parts[parts.length - 1] = String(newInst);
        newKey = parts.join(":");
      }
      const bt = ph.baseTrunk;
      const btKey = `${bt.module}:${defType}:${bt.field}:${bt.instance ?? ""}`;
      const newBt = trunkRemap.get(btKey);
      const btKey2 = `${bt.module}:Tools:${bt.field}:${bt.instance ?? ""}`;
      const newBt2 = trunkRemap.get(btKey2);
      const resolvedBt = newBt ?? newBt2;
      pipeHandleEntries.push({
        key: newKey,
        handle: `${defineHandle}$${ph.handle}`,
        baseTrunk: resolvedBt
          ? {
              module: resolvedBt.module,
              type: resolvedBt.type,
              field: resolvedBt.field,
              instance: resolvedBt.instance,
            }
          : ph.baseTrunk,
      });
    }
  }
}
