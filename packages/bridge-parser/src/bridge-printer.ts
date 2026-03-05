/**
 * Token-based Bridge DSL formatter with comment preservation.
 *
 * Uses the Chevrotain lexer directly to preserve comments that would be lost
 * during AST-based serialization. This approach reconstructs formatted source
 * from the token stream, applying consistent formatting rules.
 */
import type { IToken } from "chevrotain";
import { BridgeLexer } from "./parser/lexer.ts";

const INDENT = "  ";

// ── Comment handling ─────────────────────────────────────────────────────────

interface CommentAttachment {
  leading: IToken[];
  trailing: IToken | null;
}

/**
 * Attach comments to their logical positions in the token stream.
 */
function attachComments(
  tokens: IToken[],
  comments: IToken[],
): Map<number, CommentAttachment> {
  const result = new Map<number, CommentAttachment>();
  if (comments.length === 0) return result;

  const sortedComments = [...comments].sort(
    (a, b) => a.startOffset - b.startOffset,
  );

  for (const comment of sortedComments) {
    const commentLine = comment.startLine ?? 1;
    let prevToken: IToken | null = null;
    let nextToken: IToken | null = null;

    for (const t of tokens) {
      if (t.endOffset !== undefined && t.endOffset < comment.startOffset) {
        if (!prevToken || t.endOffset > (prevToken.endOffset ?? 0)) {
          prevToken = t;
        }
      }
      if (t.startOffset > comment.startOffset) {
        if (!nextToken || t.startOffset < nextToken.startOffset) {
          nextToken = t;
        }
      }
    }

    const isTrailing =
      prevToken?.endLine !== undefined && prevToken.endLine === commentLine;

    if (isTrailing && prevToken) {
      const key = prevToken.startOffset;
      const existing = result.get(key) ?? { leading: [], trailing: null };
      existing.trailing = comment;
      result.set(key, existing);
    } else if (nextToken) {
      const key = nextToken.startOffset;
      const existing = result.get(key) ?? { leading: [], trailing: null };
      existing.leading.push(comment);
      result.set(key, existing);
    }
  }

  return result;
}

// ── Spacing rules ────────────────────────────────────────────────────────────

const NO_SPACE_BEFORE = new Set([
  "Dot",
  "Comma",
  "RSquare",
  "RParen",
  "LParen",
  "LSquare",
  "Colon",
  "VersionTag",
  "SafeNav",
]);

const NO_SPACE_AFTER = new Set([
  "Dot",
  "LParen",
  "LSquare",
  "LCurly",
  "Colon",
  "Spread",
  "SafeNav",
]);

const SPACE_AROUND = new Set([
  "Equals",
  "Arrow",
  "NullCoalesce",
  "ErrorCoalesce",
  "DoubleEquals",
  "NotEquals",
  "GreaterEqual",
  "LessEqual",
  "GreaterThan",
  "LessThan",
  "Plus",
  "Star",
  "Minus",
  "AndKw",
  "OrKw",
  "CatchKw",
  "AsKw",
  "FromKw",
  "QuestionMark",
]);

// ── Line classification helpers ─────────────────────────────────────────────

function isWithLine(group: IToken[]): boolean {
  return group[0]?.tokenType.name === "WithKw";
}

function isWireLine(group: IToken[]): boolean {
  // A wire line contains an Arrow (<-)
  return group.some((t) => t.tokenType.name === "Arrow");
}

function isJsonObject(tokens: IToken[], startIdx: number): boolean {
  // Check if this LCurly starts a JSON object (next token is a string literal)
  const next = tokens[startIdx + 1];
  return next?.tokenType.name === "StringLiteral";
}

const TOP_LEVEL_BLOCK_STARTERS = new Set(["ToolKw", "BridgeKw", "DefineKw"]);

function isTopLevelBlockStart(group: IToken[]): boolean {
  return TOP_LEVEL_BLOCK_STARTERS.has(group[0]?.tokenType.name ?? "");
}

// ── Main formatter ───────────────────────────────────────────────────────────

/**
 * Format Bridge DSL source code with consistent styling.
 *
 * @param source - The Bridge DSL source text to format
 * @returns Formatted source text, or the original if parsing fails
 */
export function formatBridge(source: string): string {
  const lexResult = BridgeLexer.tokenize(source);

  if (lexResult.errors.length > 0) {
    return source;
  }

  const tokens = lexResult.tokens;
  const comments = (lexResult.groups["comments"] as IToken[]) ?? [];

  if (tokens.length === 0) {
    // Comment-only file: preserve blank lines between comments (collapse 2+ to 1)
    if (comments.length === 0) return "";
    const sortedComments = [...comments].sort(
      (a, b) => a.startOffset - b.startOffset,
    );
    const lines: string[] = [];
    let lastLine = 0;
    for (const comment of sortedComments) {
      const commentLine = comment.startLine ?? 1;
      if (lastLine > 0 && commentLine > lastLine + 1) {
        lines.push(""); // Add one blank line
      }
      lines.push(comment.image);
      lastLine = commentLine;
    }
    return lines.join("\n") + "\n";
  }

  const commentMap = attachComments(tokens, comments);

  // Group tokens by original source line, tracking original line numbers
  const lineGroups: { tokens: IToken[]; originalLine: number }[] = [];
  let currentLine = -1;
  let currentGroup: IToken[] = [];

  for (const token of tokens) {
    const line = token.startLine ?? 1;
    if (line !== currentLine) {
      if (currentGroup.length > 0) {
        lineGroups.push({ tokens: currentGroup, originalLine: currentLine });
      }
      currentGroup = [token];
      currentLine = line;
    } else {
      currentGroup.push(token);
    }
  }
  if (currentGroup.length > 0) {
    lineGroups.push({ tokens: currentGroup, originalLine: currentLine });
  }

  const output: string[] = [];
  let depth = 0;
  let lastOutputLine = 0; // Track which original line we last output
  let lastWasWithLine = false; // Track if previous line was a 'with' declaration
  let lastWasOpenBrace = false; // Track if previous output was an opening brace

  for (let gi = 0; gi < lineGroups.length; gi++) {
    const { tokens: group, originalLine } = lineGroups[gi];
    const firstToken = group[0];

    // Track depth at start of line for proper indentation
    const lineStartDepth = depth;

    // Classify current line
    const currentIsWithLine = isWithLine(group);
    const currentIsWireLine = isWireLine(group);
    const currentIsTopLevelBlock = isTopLevelBlockStart(group);

    // Preserve blank lines from original source (but collapse 2+ to 1)
    let needsBlankLine =
      lastOutputLine > 0 && originalLine > lastOutputLine + 1;

    // Add blank line before top-level blocks (tool, bridge, define) at depth 0
    if (currentIsTopLevelBlock && lineStartDepth === 0 && output.length > 0) {
      const lastOutput = output[output.length - 1];
      if (lastOutput !== "\n") {
        needsBlankLine = true;
      }
    }

    // Don't add blank lines between consecutive 'with' lines
    if (lastWasWithLine && currentIsWithLine) {
      needsBlankLine = false;
    }

    // Don't add blank line right after opening brace
    if (lastWasOpenBrace) {
      needsBlankLine = false;
    }

    // Add blank line when transitioning from 'with' declarations to wire expressions
    if (lastWasWithLine && !currentIsWithLine && currentIsWireLine) {
      needsBlankLine = true;
    }

    if (needsBlankLine) {
      output.push("\n");
    }

    // Add blank line after version declaration
    if (gi > 0) {
      const prevGroup = lineGroups[gi - 1];
      const prevFirstType = prevGroup.tokens[0]?.tokenType.name;
      if (prevFirstType === "VersionKw" && output.length > 0) {
        // Check if we already have a blank line
        const lastOutput = output[output.length - 1];
        if (lastOutput !== "\n") {
          output.push("\n");
        }
      }
    }

    // Leading comments - emit them on their own lines, preserving blank lines
    const attached = commentMap.get(firstToken.startOffset);
    if (attached?.leading) {
      let lastCommentLine = 0;
      for (const comment of attached.leading) {
        const commentLine = comment.startLine ?? 1;
        if (lastCommentLine > 0 && commentLine > lastCommentLine + 1) {
          output.push("\n"); // Preserve blank line between comments
        }
        output.push(INDENT.repeat(lineStartDepth) + comment.image + "\n");
        lastCommentLine = commentLine;
      }
    }

    // Build the line
    let lineOutput = "";
    let lastType: string | null = null;
    let jsonObjectDepth = 0; // Track inline JSON object depth
    let inTernary = false; // Track if we've seen a ? (ternary operator) on this line

    for (let ti = 0; ti < group.length; ti++) {
      const token = group[ti];
      const tokenType = token.tokenType.name;

      // Check if this LCurly starts an inline JSON object
      const isJsonStart = tokenType === "LCurly" && isJsonObject(group, ti);

      // Handle brace depth
      if (tokenType === "LCurly") {
        if (isJsonStart || jsonObjectDepth > 0) {
          // JSON object - stay inline
          // Space before { if after = or other content, but no space after {
          if (
            lineOutput.length > 0 &&
            !lineOutput.endsWith(" ") &&
            !lineOutput.endsWith("{")
          ) {
            lineOutput += " ";
          }
          jsonObjectDepth++;
          lineOutput += "{";
          lastType = tokenType;
          continue;
        }

        // Space before brace
        if (lineOutput.length > 0 && !lineOutput.endsWith(" ")) {
          lineOutput += " ";
        }
        lineOutput += "{";
        depth++;
        lastType = tokenType;

        // Trailing comment on brace
        const tokenAttached = commentMap.get(token.startOffset);
        if (tokenAttached?.trailing) {
          lineOutput += " " + tokenAttached.trailing.image;
        }
        continue;
      }

      if (tokenType === "RCurly") {
        if (jsonObjectDepth > 0) {
          // JSON object - stay inline
          jsonObjectDepth--;
          lineOutput += "}";
          lastType = tokenType;
          continue;
        }

        // Output anything accumulated first
        if (lineOutput.length > 0) {
          output.push(INDENT.repeat(depth) + lineOutput + "\n");
          lineOutput = "";
        }
        // Decrement depth, then emit brace at new (outer) depth
        depth = Math.max(0, depth - 1);
        let braceOutput = "}";
        lastType = tokenType;

        // Trailing comment
        const tokenAttached = commentMap.get(token.startOffset);
        if (tokenAttached?.trailing) {
          braceOutput += " " + tokenAttached.trailing.image;
        }

        // Emit the closing brace immediately
        output.push(INDENT.repeat(depth) + braceOutput + "\n");
        continue;
      }

      // Spacing - context-aware to handle paths like c.from.station
      const afterDot = lastType === "Dot" || lastType === "SafeNav";
      const beforeDot = tokenType === "Dot" || tokenType === "SafeNav";

      // JSON object colon: "key": value - add space after colon
      const afterJsonColon = jsonObjectDepth > 0 && lastType === "Colon";

      // Ternary colon: needs space around it (condition ? true : false)
      const isTernaryColon = tokenType === "Colon" && inTernary;
      const afterTernaryColon = lastType === "Colon" && inTernary;

      const needsSpace =
        lineOutput.length > 0 &&
        !NO_SPACE_BEFORE.has(tokenType) &&
        !(lastType && NO_SPACE_AFTER.has(lastType));

      // Only force space around operators if not part of a dotted path
      const forceSpace =
        afterJsonColon ||
        isTernaryColon ||
        afterTernaryColon ||
        (!afterDot &&
          !beforeDot &&
          (SPACE_AROUND.has(tokenType) ||
            (lastType !== null && SPACE_AROUND.has(lastType))));

      if (needsSpace || forceSpace) {
        if (!lineOutput.endsWith(" ")) {
          lineOutput += " ";
        }
      }

      lineOutput += token.image;
      lastType = tokenType;

      // Track ternary state
      if (tokenType === "QuestionMark") {
        inTernary = true;
      }

      // Trailing comment
      const tokenAttached = commentMap.get(token.startOffset);
      if (tokenAttached?.trailing) {
        lineOutput += " " + tokenAttached.trailing.image;
      }
    }

    // Emit the line
    if (lineOutput.length > 0) {
      output.push(INDENT.repeat(lineStartDepth) + lineOutput + "\n");
    }

    lastOutputLine = originalLine;
    lastWasWithLine = currentIsWithLine;
    // Check if this line ends with an opening brace (for next iteration)
    lastWasOpenBrace = group.some((t) => t.tokenType.name === "LCurly");
  }

  let result = output.join("");

  // Clean up excessive blank lines (3+ consecutive newlines -> 2)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Ensure trailing newline
  if (!result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}
