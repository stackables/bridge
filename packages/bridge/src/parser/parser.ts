/**
 * Chevrotain CstParser + imperative CST→AST visitor for the Bridge DSL.
 *
 * Drop-in replacement for the regex-based `parseBridge()` in bridge-format.ts.
 * Produces the *exact same* AST types (`Instruction[]`).
 */
import { CstParser, CstNode, IToken } from "chevrotain";
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
  ForceArrow,
  NullCoalesce,
  ErrorCoalesce,
  LCurly,
  RCurly,
  LSquare,
  RSquare,
  Equals,
  Dot,
  Colon,
  Comma,
  StringLiteral,
  NumberLiteral,
  PathToken,
  TrueLiteral,
  FalseLiteral,
  NullLiteral,
  BridgeLexer,
} from "./lexer.js";

import type {
  Bridge,
  ConstDef,
  DefineDef,
  HandleBinding,
  Instruction,
  NodeRef,
  ToolDef,
  ToolDep,
  ToolWire,
  Wire,
} from "../types.js";
import { SELF_MODULE } from "../types.js";

// ── Reserved-word guards (mirroring the regex parser) ──────────────────────

const RESERVED_KEYWORDS = new Set([
  "bridge", "with", "as", "from", "const", "tool", "version", "define",
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

  /** version 1.4 */
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
      { ALT: () => this.SUBRULE(this.toolWire) },      // merged constant + pull
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
   */
  public bridgeBodyLine = this.RULE("bridgeBodyLine", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.bridgeWithDecl) },
      { ALT: () => this.SUBRULE(this.bridgeWire) },  // merged constant + pull
    ]);
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
          return la.tokenType !== InputKw && la.tokenType !== OutputKw
              && la.tokenType !== ContextKw && la.tokenType !== ConstKw;
        },
        ALT: () => {
          this.SUBRULE(this.dottedName, { LABEL: "refName" });
          this.OPTION5(() => {
            this.CONSUME5(AsKw);
            this.SUBRULE5(this.nameToken, { LABEL: "refAlias" });
          });
        },
      },
    ]);
  });

  /**
   * Merged bridge wire (constant or pull):
   *   target = value
   *   target <-[!] sourceExpr [[] as iter { ...elements... }]
   *                           [|| alt]* [?? fallback]
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
        // Pull wire: target <-[!] sourceExpr [modifiers]
        ALT: () => {
          this.OR2([
            { ALT: () => this.CONSUME(Arrow,      { LABEL: "arrow" }) },
            { ALT: () => this.CONSUME(ForceArrow, { LABEL: "forceArrow" }) },
          ]);
          this.SUBRULE(this.sourceExpr, { LABEL: "firstSource" });
          // Optional array mapping: [] as <iter> { ... }
          this.OPTION(() => this.SUBRULE(this.arrayMapping));
          // || coalesce chain
          this.MANY(() => {
            this.CONSUME(NullCoalesce);
            this.SUBRULE(this.coalesceAlternative, { LABEL: "nullAlt" });
          });
          // ?? error fallback
          this.OPTION2(() => {
            this.CONSUME(ErrorCoalesce);
            this.SUBRULE2(this.coalesceAlternative, { LABEL: "errorAlt" });
          });
        },
      },
    ]);
  });

  /** [] as <iter> { ...element lines... } */
  public arrayMapping = this.RULE("arrayMapping", () => {
    this.CONSUME(LSquare);
    this.CONSUME(RSquare);
    this.CONSUME(AsKw);
    this.SUBRULE(this.nameToken, { LABEL: "iterName" });
    this.CONSUME(LCurly);
    this.MANY(() => this.SUBRULE(this.elementLine));
    this.CONSUME(RCurly);
  });

  /**
   * Element line inside array mapping: .field = value | .field <- source [|| ...] [?? ...]
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
          this.SUBRULE(this.sourceExpr, { LABEL: "elemSource" });
          this.MANY(() => {
            this.CONSUME(NullCoalesce);
            this.SUBRULE(this.coalesceAlternative, { LABEL: "elemNullAlt" });
          });
          this.OPTION(() => {
            this.CONSUME(ErrorCoalesce);
            this.SUBRULE2(this.coalesceAlternative, { LABEL: "elemErrorAlt" });
          });
        },
      },
    ]);
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
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral, { LABEL: "stringLit" }) },
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "numberLit" }) },
      { ALT: () => this.CONSUME(TrueLiteral,   { LABEL: "trueLit" }) },
      { ALT: () => this.CONSUME(FalseLiteral,  { LABEL: "falseLit" }) },
      { ALT: () => this.CONSUME(NullLiteral,   { LABEL: "nullLit" }) },
      { ALT: () => this.SUBRULE(this.jsonInlineObject, { LABEL: "objectLit" }) },
      { ALT: () => this.SUBRULE(this.sourceExpr,  { LABEL: "sourceAlt" }) },
    ]);
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
        if (la.tokenType === Dot) {
          // Don't continue across a line break — prevents greedy path
          // consumption in multi-line contexts like element blocks.
          // LA(0) gives the last consumed token.
          const prev = this.LA(0);
          if (prev && la.startLine != null && prev.endLine != null
              && la.startLine > prev.endLine) {
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
        if (prev && la.startLine != null && prev.endLine != null
            && la.startLine > prev.endLine) return false;
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
        if (prev && la.startLine != null && prev.endLine != null
            && la.startLine > prev.endLine) return false;
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
    ]);
  });

  /** JSON value: string, number, boolean, null, object, or array */
  public jsonValue = this.RULE("jsonValue", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral, { LABEL: "string" }) },
      { ALT: () => this.CONSUME(NumberLiteral, { LABEL: "number" }) },
      { ALT: () => this.CONSUME(TrueLiteral,   { LABEL: "true" }) },
      { ALT: () => this.CONSUME(FalseLiteral,  { LABEL: "false" }) },
      { ALT: () => this.CONSUME(NullLiteral,   { LABEL: "null" }) },
      { ALT: () => this.SUBRULE(this.jsonObject, { LABEL: "object" }) },
      { ALT: () => this.SUBRULE(this.jsonArray,  { LABEL: "array" }) },
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

const BRIDGE_VERSION = "1.4";

// ═══════════════════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════════════════

export function parseBridgeChevrotain(text: string): Instruction[] {
  return internalParse(text);
}

// ── Diagnostic types ──────────────────────────────────────────────────────

export type BridgeDiagnostic = {
  message: string;
  severity: "error" | "warning";
  range: {
    start: { line: number; character: number };
    end:   { line: number; character: number };
  };
};

export type BridgeParseResult = {
  instructions: Instruction[];
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
        end:   { line: (e.line ?? 1) - 1, character: (e.column ?? 1) - 1 + e.length },
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
        start: { line: (t.startLine ?? 1) - 1, character: (t.startColumn ?? 1) - 1 },
        end:   { line: (t.endLine ?? t.startLine ?? 1) - 1, character: t.endColumn ?? t.startColumn ?? 1 },
      },
    });
  }

  // 3. Visit → AST (semantic errors thrown as "Line N: ..." messages)
  let instructions: Instruction[] = [];
  let startLines = new Map<Instruction, number>();
  try {
    const result = toBridgeAst(cst, []);
    instructions = result.instructions;
    startLines   = result.startLines;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    const m = msg.match(/^Line (\d+):/);
    const errorLine = m ? parseInt(m[1]) - 1 : 0;
    diagnostics.push({
      message: msg.replace(/^Line \d+:\s*/, ""),
      severity: "error",
      range: {
        start: { line: errorLine, character: 0 },
        end:   { line: errorLine, character: 999 },
      },
    });
  }

  return { instructions, diagnostics, startLines };
}

function internalParse(text: string, previousInstructions?: Instruction[]): Instruction[] {
  // 1. Lex
  const lexResult = BridgeLexer.tokenize(text);
  if (lexResult.errors.length > 0) {
    const e = lexResult.errors[0];
    throw new Error(
      `Line ${e.line}: Unexpected character "${e.message}"`,
    );
  }

  // 2. Parse
  parserInstance.input = lexResult.tokens;
  const cst = parserInstance.program();
  if (parserInstance.errors.length > 0) {
    const e = parserInstance.errors[0];
    throw new Error(e.message);
  }

  // 3. Visit → AST
  return toBridgeAst(cst, previousInstructions).instructions;
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
  const rest = subs(node, "rest").map(n => extractNameToken(n));
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
  const rest = subs(node, "rest").map(n => extractPathSegment(n));
  return [first, ...rest].join(".");
}

/* ── extractAddressPath: get root + segments preserving order ── */
function extractAddressPath(node: CstNode): { root: string; segments: string[] } {
  const root = extractNameToken(sub(node, "root")!);
  type Seg = { offset: number; value: string };
  const items: Seg[] = [];

  for (const seg of subs(node, "segment")) {
    const firstTok = findFirstToken(seg);
    items.push({ offset: firstTok?.startOffset ?? 0, value: extractPathSegment(seg) });
  }
  for (const idxTok of toks(node, "arrayIndex")) {
    if (idxTok.image.includes(".")) {
      throw new Error(`Line ${idxTok.startLine}: Array indices must be integers, found "${idxTok.image}"`);
    }
    items.push({ offset: idxTok.startOffset, value: idxTok.image });
  }
  items.sort((a, b) => a.offset - b.offset);
  return { root, segments: items.map(i => i.value) };
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

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/* ── parsePath: split "a.b[0].c" → ["a","b","0","c"] ── */
function parsePath(text: string): string[] {
  const parts: string[] = [];
  for (const segment of text.split(".")) {
    const match = segment.match(/^([^[]+)(?:\[(\d*)\])?$/);
    if (match) {
      parts.push(match[1]);
      if (match[2] !== undefined && match[2] !== "") parts.push(match[2]);
    } else {
      parts.push(segment);
    }
  }
  return parts;
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
    const gap = tokens[i].startOffset - (tokens[i - 1].startOffset + tokens[i - 1].image.length);
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

/* ── extractJsonValue: from a jsonValue CST node ── */
function extractJsonValue(node: CstNode): string {
  const c = node.children;
  if (c.string) return (c.string as IToken[])[0].image;  // keep quotes for JSON.parse
  if (c.number) return (c.number as IToken[])[0].image;
  if (c.integer) return (c.integer as IToken[])[0].image;
  if (c.true) return "true";
  if (c.false) return "false";
  if (c.null) return "null";
  if (c.object) return reconstructJson((c.object as CstNode[])[0]);
  if (c.array) return reconstructJson((c.array as CstNode[])[0]);
  return "";
}

/* ── extractJsonValueStr: same as above but strips outer quotes for const values ── */
function extractJsonValueStripped(node: CstNode): string {
  const c = node.children;
  if (c.string) return stripQuotes((c.string as IToken[])[0].image);
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
//  Main AST builder
// ═══════════════════════════════════════════════════════════════════════════

function toBridgeAst(cst: CstNode, previousInstructions?: Instruction[]): { instructions: Instruction[]; startLines: Map<Instruction, number> } {
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
  if (versionNum !== BRIDGE_VERSION) {
    throw new Error(
      `Unsupported bridge version "${versionNum}". This parser requires: version ${BRIDGE_VERSION}`,
    );
  }

  // Process in source order (same as old parser: all blocks sequentially)
  // Chevrotain stores them by rule name, so we need to interleave by offset.
  type TaggedNode = { offset: number; kind: string; node: CstNode };
  const tagged: TaggedNode[] = [];
  for (const n of subs(cst, "constDecl"))   tagged.push({ offset: findFirstToken(n)?.startOffset ?? 0, kind: "const",  node: n });
  for (const n of subs(cst, "toolBlock"))   tagged.push({ offset: findFirstToken(n)?.startOffset ?? 0, kind: "tool",   node: n });
  for (const n of subs(cst, "defineBlock")) tagged.push({ offset: findFirstToken(n)?.startOffset ?? 0, kind: "define", node: n });
  for (const n of subs(cst, "bridgeBlock")) tagged.push({ offset: findFirstToken(n)?.startOffset ?? 0, kind: "bridge", node: n });
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
        const inst = buildToolDef(item.node, [...contextInstructions, ...instructions]);
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
        const newInsts = buildBridge(item.node, [...contextInstructions, ...instructions]);
        for (const bi of newInsts) {
          instructions.push(bi);
          startLines.set(bi, startLine);
        }
        break;
      }
    }
  }

  return { instructions, startLines };
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
  try { JSON.parse(raw); } catch {
    throw new Error(`Line ${lineNum}: Invalid JSON value for const "${name}": ${raw}`);
  }

  return { kind: "const", name, value: raw };
}

// ── Tool ────────────────────────────────────────────────────────────────

function buildToolDef(node: CstNode, previousInstructions: Instruction[]): ToolDef {
  const toolName = extractDottedName(sub(node, "toolName")!);
  const source = extractDottedName(sub(node, "toolSource")!);
  const lineNum = line(findFirstToken(sub(node, "toolName")!));
  assertNotReserved(toolName, lineNum, "tool name");

  const isKnownTool = previousInstructions.some(
    inst => inst.kind === "tool" && inst.name === source,
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
        const alias = wc.alias ? extractNameToken((wc.alias as CstNode[])[0]) : "context";
        deps.push({ kind: "context", handle: alias });
      } else if (wc.constKw) {
        const alias = wc.constAlias ? extractNameToken((wc.constAlias as CstNode[])[0]) : "const";
        deps.push({ kind: "const", handle: alias });
      } else if (wc.toolName) {
        const tName = extractDottedName((wc.toolName as CstNode[])[0]);
        const tAlias = extractNameToken((wc.toolAlias as CstNode[])[0]);
        deps.push({ kind: "tool", handle: tAlias, tool: tName });
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
  const { handles, wires, arrayIterators, pipeHandles } = buildBridgeBody(
    bodyLines, "Define", name, [], lineNum,
  );

  return {
    kind: "define",
    name,
    handles,
    wires,
    ...(Object.keys(arrayIterators).length > 0 ? { arrayIterators } : {}),
    ...(pipeHandles.length > 0 ? { pipeHandles } : {}),
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
    const bridgeInst = result.find((i): i is Bridge => i.kind === "bridge");
    if (bridgeInst) bridgeInst.passthrough = passthroughName;
    return result;
  }

  // Full bridge block
  const bodyLines = subs(node, "bridgeBodyLine");
  const { handles, wires, arrayIterators, pipeHandles } = buildBridgeBody(
    bodyLines, typeName, fieldName, previousInstructions, 0,
  );

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

  const nextForkSeqRef = { value: pipeHandles.length > 0
    ? Math.max(
        ...pipeHandles.map(p => {
          const parts = p.key.split(":");
          return parseInt(parts[parts.length - 1]) || 0;
        }).filter(n => n >= 100000).map(n => n - 100000 + 1),
        0,
      )
    : 0
  };

  for (const hb of handles) {
    if (hb.kind !== "define") continue;
    const def = previousInstructions.find(
      (inst): inst is DefineDef => inst.kind === "define" && inst.name === hb.name,
    );
    if (!def) {
      throw new Error(`Define "${hb.name}" referenced by handle "${hb.handle}" not found`);
    }
    inlineDefine(hb.handle, def, typeName, fieldName, wires, pipeHandles, handles, instanceCounters, nextForkSeqRef);
  }

  const instructions: Instruction[] = [];
  instructions.push({
    kind: "bridge",
    type: typeName,
    field: fieldName,
    handles,
    wires,
    arrayIterators: Object.keys(arrayIterators).length > 0 ? arrayIterators : undefined,
    pipeHandles: pipeHandles.length > 0 ? pipeHandles : undefined,
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
    const withNode = (bodyLine.children.bridgeWithDecl as CstNode[] | undefined)?.[0];
    if (!withNode) continue;
    const wc = withNode.children;
    const lineNum = line(findFirstToken(withNode));

    const checkDuplicate = (handle: string) => {
      if (handleRes.has(handle)) {
        throw new Error(`Line ${lineNum}: Duplicate handle name "${handle}"`);
      }
    };

    if (wc.inputKw) {
      const handle = wc.inputAlias ? extractNameToken((wc.inputAlias as CstNode[])[0]) : "input";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "input" });
      handleRes.set(handle, { module: SELF_MODULE, type: bridgeType, field: bridgeField });
    } else if (wc.outputKw) {
      const handle = wc.outputAlias ? extractNameToken((wc.outputAlias as CstNode[])[0]) : "output";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "output" });
      handleRes.set(handle, { module: SELF_MODULE, type: bridgeType, field: bridgeField });
    } else if (wc.contextKw) {
      const handle = wc.contextAlias ? extractNameToken((wc.contextAlias as CstNode[])[0]) : "context";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "context" });
      handleRes.set(handle, { module: SELF_MODULE, type: "Context", field: "context" });
    } else if (wc.constKw) {
      const handle = wc.constAlias ? extractNameToken((wc.constAlias as CstNode[])[0]) : "const";
      checkDuplicate(handle);
      handleBindings.push({ handle, kind: "const" });
      handleRes.set(handle, { module: SELF_MODULE, type: "Const", field: "const" });
    } else if (wc.refName) {
      const name = extractDottedName((wc.refName as CstNode[])[0]);
      const lastDot = name.lastIndexOf(".");
      const defaultHandle = lastDot !== -1 ? name.substring(lastDot + 1) : name;
      const handle = wc.refAlias
        ? extractNameToken((wc.refAlias as CstNode[])[0])
        : defaultHandle;

      checkDuplicate(handle);
      if (wc.refAlias) assertNotReserved(handle, lineNum, "handle alias");

      // Check if it's a define reference
      const defineDef = previousInstructions.find(
        (inst): inst is DefineDef => inst.kind === "define" && inst.name === name,
      );
      if (defineDef) {
        handleBindings.push({ handle, kind: "define", name });
        handleRes.set(handle, { module: `__define_${handle}`, type: bridgeType, field: bridgeField });
      } else if (lastDot !== -1) {
        const modulePart = name.substring(0, lastDot);
        const fieldPart = name.substring(lastDot + 1);
        const key = `${modulePart}:${fieldPart}`;
        const instance = (instanceCounters.get(key) ?? 0) + 1;
        instanceCounters.set(key, instance);
        handleBindings.push({ handle, kind: "tool", name });
        handleRes.set(handle, { module: modulePart, type: bridgeType, field: fieldPart, instance });
      } else {
        const key = `Tools:${name}`;
        const instance = (instanceCounters.get(key) ?? 0) + 1;
        instanceCounters.set(key, instance);
        handleBindings.push({ handle, kind: "tool", name });
        handleRes.set(handle, { module: SELF_MODULE, type: "Tools", field: name, instance });
      }
    }
  }

  // ── Helper: resolve address ────────────────────────────────────────────

  function resolveAddress(root: string, segments: string[], lineNum: number): NodeRef {
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
    if (ref.path.some(seg => /^\d+$/.test(seg))) {
      throw new Error(
        `Line ${lineNum}: Explicit array index in wire target is not supported. Use array mapping (\`[] as iter { }\`) instead.`,
      );
    }
  }

  // ── Helper: build source expression ────────────────────────────────────

  function buildSourceExpr(sourceNode: CstNode, lineNum: number, forceOnOutermost: boolean): NodeRef {
    const headNode = sub(sourceNode, "head")!;
    const pipeNodes = subs(sourceNode, "pipeSegment");

    if (pipeNodes.length === 0) {
      const { root, segments } = extractAddressPath(headNode);
      return resolveAddress(root, segments, lineNum);
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

    const { root: srcRoot, segments: srcSegments } = extractAddressPath(actualSourceNode);
    let prevOutRef = resolveAddress(srcRoot, srcSegments, lineNum);

    // Process pipe handles right-to-left (innermost first)
    const reversed = [...pipeChainNodes].reverse();
    for (let idx = 0; idx < reversed.length; idx++) {
      const pNode = reversed[idx];
      const { root: handleName, segments: handleSegs } = extractAddressPath(pNode);
      const fieldName = handleSegs.length > 0 ? handleSegs.join(".") : "in";
      const res = handleRes.get(handleName)!;
      const forkInstance = 100000 + nextForkSeq++;
      const forkKey = `${res.module}:${res.type}:${res.field}:${forkInstance}`;
      pipeHandleEntries.push({
        key: forkKey,
        handle: handleName,
        baseTrunk: { module: res.module, type: res.type, field: res.field, instance: res.instance },
      });
      const forkInRef: NodeRef = {
        module: res.module, type: res.type, field: res.field,
        instance: forkInstance,
        path: parsePath(fieldName),
      };
      const forkRootRef: NodeRef = {
        module: res.module, type: res.type, field: res.field,
        instance: forkInstance,
        path: [],
      };
      const isOutermost = idx === reversed.length - 1;
      wires.push({
        from: prevOutRef,
        to: forkInRef,
        pipe: true,
        ...(forceOnOutermost && isOutermost ? { force: true as const } : {}),
      });
      prevOutRef = forkRootRef;
    }
    return prevOutRef;
  }

  // ── Helper: extract coalesce alternative ───────────────────────────────

  function extractCoalesceAlt(
    altNode: CstNode,
    lineNum: number,
  ): { literal: string } | { sourceRef: NodeRef } {
    const c = altNode.children;
    if (c.stringLit) return { literal: (c.stringLit as IToken[])[0].image };
    if (c.numberLit) return { literal: (c.numberLit as IToken[])[0].image };
    if (c.intLit)    return { literal: (c.intLit as IToken[])[0].image };
    if (c.trueLit)   return { literal: "true" };
    if (c.falseLit)  return { literal: "false" };
    if (c.nullLit)   return { literal: "null" };
    if (c.objectLit) return { literal: reconstructJson((c.objectLit as CstNode[])[0]) };
    if (c.sourceAlt) {
      const srcNode = (c.sourceAlt as CstNode[])[0];
      return { sourceRef: buildSourceExpr(srcNode, lineNum, false) };
    }
    throw new Error(`Line ${lineNum}: Invalid coalesce alternative`);
  }

  // ── Step 2: Process wire lines ─────────────────────────────────────────

  for (const bodyLine of bodyLines) {
    const c = bodyLine.children;
    if (c.bridgeWithDecl) continue; // already processed

    const wireNode = (c.bridgeWire as CstNode[] | undefined)?.[0];
    if (!wireNode) continue;

    const wc = wireNode.children;
    const lineNum = line(findFirstToken(wireNode));

    // Parse target
    const { root: targetRoot, segments: targetSegs } = extractAddressPath(sub(wireNode, "target")!);
    const toRef = resolveAddress(targetRoot, targetSegs, lineNum);
    assertNoTargetIndices(toRef, lineNum);

    // ── Constant wire: target = value ──
    if (wc.equalsOp) {
      const value = extractBareValue(sub(wireNode, "constValue")!);
      wires.push({ value, to: toRef });
      continue;
    }

    // ── Pull wire: target <-[!] source [modifiers] ──
    const force = !!wc.forceArrow;

    // Array mapping?
    const arrayMappingNode = (wc.arrayMapping as CstNode[] | undefined)?.[0];
    if (arrayMappingNode) {
      const firstSourceNode = sub(wireNode, "firstSource")!;
      const srcRef = buildSourceExpr(firstSourceNode, lineNum, force);
      wires.push({ from: srcRef, to: toRef });

      const iterName = extractNameToken(sub(arrayMappingNode, "iterName")!);
      assertNotReserved(iterName, lineNum, "iterator handle");
      const arrayToPath = toRef.path;
      arrayIterators[arrayToPath[0]] = iterName;

      // Process element lines
      for (const elemLine of subs(arrayMappingNode, "elementLine")) {
        const elemC = elemLine.children;
        const elemLineNum = line(findFirstToken(elemLine));
        const elemTargetPathStr = extractDottedPathStr(sub(elemLine, "elemTarget")!);
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
          const elemSourceNode = sub(elemLine, "elemSource")!;
          const elemToRef: NodeRef = {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            path: elemToPath,
          };

          // Check if iterator-relative source
          const elemHeadNode = sub(elemSourceNode, "head")!;
          const elemPipeSegs = subs(elemSourceNode, "pipeSegment");
          const { root: elemSrcRoot, segments: elemSrcSegs } = extractAddressPath(elemHeadNode);

          const sourceParts: { ref: NodeRef; isPipeFork: boolean }[] = [];

          if (elemSrcRoot === iterName && elemPipeSegs.length === 0) {
            sourceParts.push({
              ref: {
                module: SELF_MODULE,
                type: bridgeType,
                field: bridgeField,
                element: true,
                path: elemSrcSegs,
              },
              isPipeFork: false,
            });
          } else {
            const ref = buildSourceExpr(elemSourceNode, elemLineNum, false);
            const isPipeFork = ref.instance != null && ref.path.length === 0 && elemPipeSegs.length > 0;
            sourceParts.push({ ref, isPipeFork });
          }

          // || alternatives
          let nullFallback: string | undefined;
          for (const alt of subs(elemLine, "elemNullAlt")) {
            const altResult = extractCoalesceAlt(alt, elemLineNum);
            if ("literal" in altResult) {
              nullFallback = altResult.literal;
            } else {
              sourceParts.push({ ref: altResult.sourceRef, isPipeFork: false });
            }
          }

          // ?? fallback
          let fallback: string | undefined;
          let fallbackRef: NodeRef | undefined;
          let fallbackInternalWires: Wire[] = [];
          const errorAlt = sub(elemLine, "elemErrorAlt");
          if (errorAlt) {
            const preLen = wires.length;
            const altResult = extractCoalesceAlt(errorAlt, elemLineNum);
            if ("literal" in altResult) {
              fallback = altResult.literal;
            } else {
              fallbackRef = altResult.sourceRef;
              fallbackInternalWires = wires.splice(preLen);
            }
          }

          // Emit wires
          for (let ci = 0; ci < sourceParts.length; ci++) {
            const { ref: fromRef, isPipeFork } = sourceParts[ci];
            const isLast = ci === sourceParts.length - 1;
            const lastAttrs = isLast
              ? {
                  ...(nullFallback ? { nullFallback } : {}),
                  ...(fallback ? { fallback } : {}),
                  ...(fallbackRef ? { fallbackRef } : {}),
                }
              : {};
            if (isPipeFork) {
              wires.push({ from: fromRef, to: elemToRef, pipe: true, ...lastAttrs });
            } else {
              wires.push({ from: fromRef, to: elemToRef, ...lastAttrs });
            }
          }
          wires.push(...fallbackInternalWires);
        }
      }
      continue;
    }

    // ── Regular pull wire (non-array) ──
    const firstSourceNode = sub(wireNode, "firstSource")!;
    const sourceParts: { ref: NodeRef; isPipeFork: boolean }[] = [];

    const headAddr = sub(firstSourceNode, "head")!;
    const pipeSegs = subs(firstSourceNode, "pipeSegment");
    const firstRef = buildSourceExpr(firstSourceNode, lineNum, force);
    const isPipeFork = firstRef.instance != null && firstRef.path.length === 0 && pipeSegs.length > 0;
    sourceParts.push({ ref: firstRef, isPipeFork });

    let nullFallback: string | undefined;
    for (const alt of subs(wireNode, "nullAlt")) {
      const altResult = extractCoalesceAlt(alt, lineNum);
      if ("literal" in altResult) {
        nullFallback = altResult.literal;
      } else {
        sourceParts.push({ ref: altResult.sourceRef, isPipeFork: false });
      }
    }

    let fallback: string | undefined;
    let fallbackRef: NodeRef | undefined;
    let fallbackInternalWires: Wire[] = [];
    const errorAlt = sub(wireNode, "errorAlt");
    if (errorAlt) {
      const preLen = wires.length;
      const altResult = extractCoalesceAlt(errorAlt, lineNum);
      if ("literal" in altResult) {
        fallback = altResult.literal;
      } else {
        fallbackRef = altResult.sourceRef;
        fallbackInternalWires = wires.splice(preLen);
      }
    }

    for (let ci = 0; ci < sourceParts.length; ci++) {
      const { ref: fromRef, isPipeFork: isPipe } = sourceParts[ci];
      const isFirst = ci === 0;
      const isLast = ci === sourceParts.length - 1;
      const lastAttrs = isLast
        ? {
            ...(nullFallback ? { nullFallback } : {}),
            ...(fallback ? { fallback } : {}),
            ...(fallbackRef ? { fallbackRef } : {}),
          }
        : {};
      if (isPipe) {
        wires.push({ from: fromRef, to: toRef, pipe: true, ...lastAttrs });
      } else {
        wires.push({
          from: fromRef,
          to: toRef,
          ...(force && isFirst ? { force: true as const } : {}),
          ...lastAttrs,
        });
      }
    }
    wires.push(...fallbackInternalWires);
  }

  return { handles: handleBindings, wires, arrayIterators, pipeHandles: pipeHandleEntries };
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
  const trunkRemap = new Map<string, { module: string; type: string; field: string; instance: number }>();

  for (const hb of defineDef.handles) {
    if (hb.kind === "input" || hb.kind === "output" || hb.kind === "context" || hb.kind === "const") continue;
    if (hb.kind === "define") continue;
    const name = hb.kind === "tool" ? hb.name : "";
    if (!name) continue;

    const lastDot = name.lastIndexOf(".");
    let oldModule: string, oldType: string, oldField: string, instanceKey: string, bridgeKey: string;

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
    trunkRemap.set(oldKey, { module: oldModule, type: oldType, field: oldField, instance: newInstance });
    handleBindings.push({ handle: `${defineHandle}$${hb.handle}`, kind: "tool", name });
  }

  // Remap existing bridge wires pointing at the generic define module
  for (const wire of wires) {
    if ("from" in wire) {
      if (wire.to.module === genericModule) wire.to = { ...wire.to, module: inModule };
      if (wire.from.module === genericModule) wire.from = { ...wire.from, module: outModule };
      if (wire.fallbackRef?.module === genericModule) wire.fallbackRef = { ...wire.fallbackRef, module: outModule };
    }
    if ("value" in wire && wire.to.module === genericModule) wire.to = { ...wire.to, module: inModule };
  }

  const forkOffset = nextForkSeqRef.value;
  let maxDefForkSeq = 0;

  function remapRef(ref: NodeRef, side: "from" | "to"): NodeRef {
    if (ref.module === SELF_MODULE && ref.type === defType && ref.field === defField) {
      const targetModule = side === "from" ? inModule : outModule;
      return { ...ref, module: targetModule, type: bridgeType, field: bridgeField };
    }
    const key = `${ref.module}:${ref.type}:${ref.field}:${ref.instance ?? ""}`;
    const newTrunk = trunkRemap.get(key);
    if (newTrunk) return { ...ref, module: newTrunk.module, type: newTrunk.type, field: newTrunk.field, instance: newTrunk.instance };
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
      if (cloned.fallbackRef) cloned.fallbackRef = remapRef(cloned.fallbackRef, "from");
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
          ? { module: resolvedBt.module, type: resolvedBt.type, field: resolvedBt.field, instance: resolvedBt.instance }
          : ph.baseTrunk,
      });
    }
  }
}
