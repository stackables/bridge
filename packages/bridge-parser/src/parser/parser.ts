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
  MemoizeKw,
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
  DefineDef,
  Instruction,
  ToolDef,
} from "@stackables/bridge-core";
import { buildBody } from "./ast-builder.ts";

// ── Reserved-word guards (mirroring the regex parser) ──────────────────────

const RESERVED_KEYWORDS = new Set([
  "bridge",
  "with",
  "as",
  "memoize",
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
      this.MANY(() =>
        this.OR([
          { ALT: () => this.SUBRULE(this.toolOnError) },
          {
            ALT: () =>
              this.SUBRULE(this.elementLine, { LABEL: "toolSelfWire" }),
          },
          {
            ALT: () =>
              this.SUBRULE(this.scopeSpreadLine, {
                LABEL: "toolSpreadLine",
              }),
          },
          { ALT: () => this.SUBRULE(this.bridgeBodyLine) },
        ]),
      );
      this.CONSUME(RCurly);
    });
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
   *   alias <name> <- <wireRHS>
   *
   * Creates a local __local binding that caches the result of the source
   * expression. Subsequent wires can reference the alias as a handle.
   * Uses the same wire RHS syntax as regular pull wires.
   */
  public bridgeNodeAlias = this.RULE("bridgeNodeAlias", () => {
    this.CONSUME(AliasKw);
    this.SUBRULE(this.nameToken, { LABEL: "nodeAliasName" });
    this.CONSUME(Arrow, { LABEL: "aliasArrow" });
    this.OR([
      {
        // String literal as source: alias name <- "..." [op operand]*
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
        // [not] (parenExpr | sourceExpr) [op operand]* [? then : else]
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
    // Optional array mapping: [] as <iter> { ... }
    this.OPTION(() => this.SUBRULE(this.arrayMapping));
    // || / ?? coalesce chain (mixed order)
    this.MANY(() => {
      this.SUBRULE4(this.coalesceChainItem, { LABEL: "aliasCoalesceItem" });
    });
    // catch error fallback
    this.OPTION2(() => {
      this.CONSUME(CatchKw);
      this.SUBRULE3(this.coalesceAlternative, { LABEL: "aliasCatchAlt" });
    });
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
    this.OPTION7(() => {
      this.CONSUME(MemoizeKw, { LABEL: "memoizeKw" });
    });
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
        // Path scoping block: target { lines: .field <- source, .field = value, .field { ... }, alias name <- ..., ...source }
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
        { ALT: () => this.SUBRULE(this.elementToolWithDecl) },
        { ALT: () => this.SUBRULE(this.elementHandleWire) },
        { ALT: () => this.SUBRULE(this.elementLine) },
        {
          ALT: () =>
            this.SUBRULE(this.scopeSpreadLine, {
              LABEL: "elemMapSpreadLine",
            }),
        },
      ]),
    );
    this.CONSUME(RCurly);
  });

  /**
   * Block-scoped binding inside array mapping:
   *   alias <name> <- <sourceExpr> [|| alt]* [catch fallback]
   * Evaluates the source once per element and binds the result to <name>.
   */
  public elementWithDecl = this.RULE("elementWithDecl", () => {
    this.CONSUME(AliasKw);
    this.SUBRULE(this.nameToken, { LABEL: "elemWithAlias" });
    this.CONSUME(Arrow, { LABEL: "elemArrow" });
    this.SUBRULE(this.sourceExpr, { LABEL: "elemWithSource" });
    // || / ?? coalesce chain (mixed order)
    this.MANY(() => {
      this.SUBRULE(this.coalesceChainItem, { LABEL: "elemCoalesceItem" });
    });
    // catch error fallback
    this.OPTION(() => {
      this.CONSUME(CatchKw);
      this.SUBRULE(this.coalesceAlternative, { LABEL: "elemCatchAlt" });
    });
  });

  /**
   * Loop-scoped tool binding inside array mapping:
   *   with std.httpCall as http
   */
  public elementToolWithDecl = this.RULE("elementToolWithDecl", () => {
    this.CONSUME(WithKw);
    this.SUBRULE(this.dottedName, { LABEL: "refName" });
    this.OPTION(() => {
      this.CONSUME(VersionTag, { LABEL: "refVersion" });
    });
    this.OPTION2(() => {
      this.CONSUME(AsKw);
      this.SUBRULE(this.nameToken, { LABEL: "refAlias" });
    });
    this.OPTION3(() => {
      this.CONSUME(MemoizeKw, { LABEL: "memoizeKw" });
    });
  });

  /**
   * Writable handle wire inside array mapping:
   *   http.value <- item.id
   *   http.value = "x"
   */
  public elementHandleWire = this.RULE("elementHandleWire", () => {
    this.SUBRULE(this.addressPath, { LABEL: "target" });
    this.OR([
      {
        ALT: () => {
          this.CONSUME(Equals, { LABEL: "equalsOp" });
          this.SUBRULE(this.bareValue, { LABEL: "constValue" });
        },
      },
      {
        ALT: () => {
          this.CONSUME(Arrow, { LABEL: "arrow" });
          this.OR2([
            {
              ALT: () => {
                this.CONSUME(StringLiteral, { LABEL: "stringSource" });
              },
            },
            {
              ALT: () => {
                this.OPTION(() => {
                  this.CONSUME(NotKw, { LABEL: "notPrefix" });
                });
                this.OR3([
                  {
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
                this.MANY2(() => {
                  this.SUBRULE(this.exprOperator, { LABEL: "exprOp" });
                  this.SUBRULE(this.exprOperand, { LABEL: "exprRight" });
                });
                this.OPTION3(() => {
                  this.CONSUME(QuestionMark, { LABEL: "ternaryOp" });
                  this.SUBRULE(this.ternaryBranch, { LABEL: "thenBranch" });
                  this.CONSUME(Colon, { LABEL: "ternaryColon" });
                  this.SUBRULE2(this.ternaryBranch, { LABEL: "elseBranch" });
                });
              },
            },
          ]);
          this.MANY(() => {
            this.SUBRULE(this.coalesceChainItem, { LABEL: "coalesceItem" });
          });
          this.OPTION5(() => {
            this.CONSUME(CatchKw);
            this.SUBRULE3(this.coalesceAlternative, { LABEL: "catchAlt" });
          });
        },
      },
    ]);
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
          // Optional array mapping: [] as <iter> { ... }
          this.OPTION6(() =>
            this.SUBRULE(this.arrayMapping, { LABEL: "scopeArrayMapping" }),
          );
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
   *   ... <- sourceExpr
   *
   * Wires all fields of the source to the current scope target path.
   * Equivalent to writing `target <- sourceExpr` at the outer level.
   */
  public scopeSpreadLine = this.RULE("scopeSpreadLine", () => {
    this.CONSUME(Spread);
    this.CONSUME(Arrow);
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
      {
        ALT: () => {
          this.CONSUME(ContinueKw, { LABEL: "continueKw" });
          this.OPTION(() => {
            this.CONSUME4(NumberLiteral, { LABEL: "continueLevel" });
          });
        },
      },
      {
        ALT: () => {
          this.CONSUME(BreakKw, { LABEL: "breakKw" });
          this.OPTION2(() => {
            this.CONSUME5(NumberLiteral, { LABEL: "breakLevel" });
          });
        },
      },
      { ALT: () => this.CONSUME3(StringLiteral, { LABEL: "stringLit" }) },
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numberLit" }) },
      { ALT: () => this.CONSUME(TrueLiteral, { LABEL: "trueLit" }) },
      { ALT: () => this.CONSUME(FalseLiteral, { LABEL: "falseLit" }) },
      { ALT: () => this.CONSUME(NullLiteral, { LABEL: "nullLit" }) },
      {
        ALT: () => this.SUBRULE(this.jsonInlineObject, { LABEL: "objectLit" }),
      },
      {
        ALT: () => this.SUBRULE(this.jsonInlineArray, { LABEL: "arrayLit" }),
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
    // Optional array mapping on source-based coalesce alternatives
    this.OPTION(() =>
      this.SUBRULE(this.arrayMapping, { LABEL: "altArrayMapping" }),
    );
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
          return (prev.endLine ?? prev.startLine ?? 0) === (la.startLine ?? 0);
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
        { ALT: () => this.CONSUME(Dot) },
        { ALT: () => this.CONSUME(Equals) },
        { ALT: () => this.SUBRULE(this.jsonInlineObject) },
        { ALT: () => this.SUBRULE(this.jsonInlineArray) },
      ]);
    });
    this.CONSUME(RCurly);
  });

  /** Inline JSON array — used in coalesce alternatives */
  public jsonInlineArray = this.RULE("jsonInlineArray", () => {
    this.CONSUME(LSquare);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(StringLiteral) },
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(Comma) },
        { ALT: () => this.CONSUME(TrueLiteral) },
        { ALT: () => this.CONSUME(FalseLiteral) },
        { ALT: () => this.CONSUME(NullLiteral) },
        { ALT: () => this.SUBRULE(this.jsonInlineObject) },
        { ALT: () => this.SUBRULE(this.jsonInlineArray) },
      ]);
    });
    this.CONSUME(RSquare);
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

export type ParseBridgeOptions = {
  /** Optional logical filename associated with the parsed source. */
  filename?: string;
};

// ═══════════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════════

export function parseBridgeChevrotain(
  text: string,
  options: ParseBridgeOptions = {},
): BridgeDocument {
  return internalParse(text, undefined, options);
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
export function parseBridgeDiagnostics(
  text: string,
  options: ParseBridgeOptions = {},
): BridgeParseResult {
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
  let document: BridgeDocument = { source: text, instructions: [] };
  let startLines = new Map<Instruction, number>();
  try {
    const result = toBridgeAst(cst, []);
    document = {
      version: result.version,
      source: text,
      ...(options.filename ? { filename: options.filename } : {}),
      instructions: result.instructions,
    };
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
  options: ParseBridgeOptions = {},
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
  return {
    version: result.version,
    source: text,
    ...(options.filename ? { filename: options.filename } : {}),
    instructions: result.instructions,
  };
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

  // Tool blocks reuse bridgeBodyLine for with-declarations and handle-targeted wires
  const bodyLines = subs(node, "bridgeBodyLine");
  const selfWireNodes = subs(node, "toolSelfWire");
  const spreadNodes = subs(node, "toolSpreadLine");
  // Extract on error from toolOnError CST nodes
  let onError: ToolDef["onError"];
  for (const child of (node.children.toolOnError as CstNode[]) ?? []) {
    const oc = child.children;
    if (oc.equalsOp) {
      const value = extractJsonValue(sub(child, "errorValue")!);
      onError = { value };
    } else if (oc.arrowOp) {
      const errorSource = extractDottedName(sub(child, "errorSource")!);
      onError = { source: errorSource };
    }
  }

  // Build Statement[] body
  const bodyResult = buildBody(
    bodyLines,
    "Tools",
    toolName,
    previousInstructions,
    {
      forbiddenHandleKinds: new Set(["input", "output"]),
      selfWireNodes,
      spreadNodes,
    },
  );

  return {
    kind: "tool",
    name: toolName,
    fn: isKnownTool ? undefined : source,
    extends: isKnownTool ? source : undefined,
    handles: bodyResult.handles,
    ...(onError ? { onError } : {}),
    body: bodyResult.body,
  };
}

// ── Define ──────────────────────────────────────────────────────────────

function buildDefineDef(node: CstNode): DefineDef {
  const name = extractNameToken(sub(node, "defineName")!);
  const lineNum = line(findFirstToken(sub(node, "defineName")!));
  assertNotReserved(name, lineNum, "define name");

  const bodyLines = subs(node, "bridgeBodyLine");
  // Build Statement[] body
  const bodyResult = buildBody(bodyLines, "Define", name, []);

  return {
    kind: "define",
    name,
    handles: bodyResult.handles,
    body: bodyResult.body,
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

  // Build Statement[] body
  const bodyResult = buildBody(
    bodyLines,
    typeName,
    fieldName,
    previousInstructions,
  );

  const instructions: Instruction[] = [];
  instructions.push({
    kind: "bridge",
    type: typeName,
    field: fieldName,
    handles: bodyResult.handles,
    body: bodyResult.body,
  });
  return instructions;
}

