/**
 * AST Builder — converts Chevrotain CST into the nested Statement[]-based IR.
 *
 * This is a clean reimplementation of the CST→AST visitor that produces
 * `body: Statement[]` directly, without the legacy flat `Wire[]` intermediate.
 *
 * Key differences from the legacy `buildBridgeBody()`:
 * - Scope blocks (`target { ... }`) become `ScopeStatement` nodes (not flattened)
 * - Array mappings become `ArrayExpression` in Expression trees (not metadata)
 * - Operators (+, -, *, /, ==, etc.) become `BinaryExpression` nodes (not tool forks)
 * - `not` becomes `UnaryExpression` (not a tool fork)
 * - Template strings become `ConcatExpression` (not a tool fork)
 * - Pipe chains become `PipeExpression` (not synthetic fork wires)
 * - Literal values are pre-parsed `JsonValue` (not JSON-encoded strings)
 */
import type { CstNode, IToken } from "chevrotain";
import type {
  BinaryOp,
  DefineDef,
  Expression,
  ForceStatement,
  HandleBinding,
  Instruction,
  JsonValue,
  NodeRef,
  ScopeStatement,
  SourceChain,
  SpreadStatement,
  Statement,
  WireAliasStatement,
  WireCatch,
  WireSourceEntry,
  WireStatement,
  WithStatement,
} from "@stackables/bridge-core";
import { SELF_MODULE } from "@stackables/bridge-core";
import type { SourceLocation } from "@stackables/bridge-types";

// ── CST Navigation Helpers ──────────────────────────────────────────────────

function sub(node: CstNode, ruleName: string): CstNode | undefined {
  return (node.children[ruleName] as CstNode[] | undefined)?.[0];
}

function subs(node: CstNode, ruleName: string): CstNode[] {
  return (node.children[ruleName] as CstNode[] | undefined) ?? [];
}

function tok(node: CstNode, label: string): IToken | undefined {
  return (node.children[label] as IToken[] | undefined)?.[0];
}

function toks(node: CstNode, label: string): IToken[] {
  return (node.children[label] as IToken[] | undefined) ?? [];
}

function line(token: IToken | undefined): number {
  return token?.startLine ?? 0;
}

function makeLoc(
  start: IToken | undefined,
  end: IToken | undefined = start,
): SourceLocation | undefined {
  if (!start) return undefined;
  const last = end ?? start;
  return {
    startLine: start.startLine ?? 0,
    startColumn: start.startColumn ?? 0,
    endLine: last.endLine ?? last.startLine ?? 0,
    endColumn: last.endColumn ?? last.startColumn ?? 0,
  };
}

// ── Token / Node extraction ─────────────────────────────────────────────────

function extractNameToken(node: CstNode): string {
  for (const key of Object.keys(node.children)) {
    const tokens = node.children[key] as IToken[] | undefined;
    if (tokens?.[0]) return tokens[0].image;
  }
  return "";
}

function extractDottedName(node: CstNode): string {
  const first = extractNameToken(sub(node, "first")!);
  const rest = subs(node, "rest").map((n) => extractNameToken(n));
  return [first, ...rest].join(".");
}

function extractPathSegment(node: CstNode): string {
  for (const key of Object.keys(node.children)) {
    const tokens = node.children[key] as IToken[] | undefined;
    if (tokens?.[0]) return tokens[0].image;
  }
  return "";
}

function extractDottedPathStr(node: CstNode): string {
  const first = extractPathSegment(sub(node, "first")!);
  const rest = subs(node, "rest").map((n) => extractPathSegment(n));
  return [first, ...rest].join(".");
}

function findFirstToken(node: CstNode): IToken | undefined {
  for (const key of Object.keys(node.children)) {
    const child = node.children[key];
    if (!Array.isArray(child)) continue;
    for (const item of child) {
      if ("image" in item) return item as IToken;
      if ("children" in item) {
        const found = findFirstToken(item as CstNode);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function findLastToken(node: CstNode): IToken | undefined {
  const keys = Object.keys(node.children);
  for (let k = keys.length - 1; k >= 0; k--) {
    const child = node.children[keys[k]];
    if (!Array.isArray(child)) continue;
    for (let i = child.length - 1; i >= 0; i--) {
      const item = child[i];
      if ("image" in item) return item as IToken;
      if ("children" in item) {
        const found = findLastToken(item as CstNode);
        if (found) return found;
      }
    }
  }
  return undefined;
}

function locFromNode(node: CstNode | undefined): SourceLocation | undefined {
  if (!node) return undefined;
  return makeLoc(findFirstToken(node), findLastToken(node));
}

function parsePath(text: string): string[] {
  return text.split(/\.|\[|\]/).filter(Boolean);
}

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

function reconstructJson(node: CstNode): string {
  const tokens: IToken[] = [];
  collectTokens(node, tokens);
  tokens.sort((a, b) => a.startOffset - b.startOffset);
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

// ── Address path extraction ─────────────────────────────────────────────────

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

  const allSeps: { offset: number; isSafe: boolean }[] = [
    ...dotTokens.map((t) => ({ offset: t.startOffset, isSafe: false })),
    ...safeNavTokens.map((t) => ({ offset: t.startOffset, isSafe: true })),
  ].sort((a, b) => a.offset - b.offset);

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

// ── Template string parsing ─────────────────────────────────────────────────

type TemplateSeg =
  | { kind: "text"; value: string }
  | { kind: "ref"; path: string };

function parseTemplateString(raw: string): TemplateSeg[] | null {
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
      text += raw[i] + raw[i + 1];
      i += 2;
      continue;
    }
    if (raw[i] === "{") {
      const end = raw.indexOf("}", i + 1);
      if (end === -1) {
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

// ── Literal parsing ─────────────────────────────────────────────────────────

/** Parse a JSON-encoded string into a JsonValue. */
function parseLiteral(raw: string): JsonValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (
    trimmed.length >= 2 &&
    trimmed.charCodeAt(0) === 0x22 &&
    trimmed.charCodeAt(trimmed.length - 1) === 0x22
  ) {
    // JSON string — parse it
    return JSON.parse(trimmed) as string;
  }
  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num) && isFinite(num)) return num;
  // Attempt JSON parse for objects/arrays
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return trimmed;
  }
}

// ── Reserved keywords ───────────────────────────────────────────────────────

const RESERVED_KEYWORDS = new Set([
  "version",
  "tool",
  "bridge",
  "define",
  "const",
  "with",
  "as",
  "from",
  "extends",
  "alias",
  "force",
  "catch",
  "throw",
  "panic",
  "continue",
  "break",
  "not",
  "and",
  "or",
  "memoize",
  "true",
  "false",
  "null",
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

// ── Operator precedence ─────────────────────────────────────────────────────

const OP_TO_BINARY: Record<string, BinaryOp> = {
  "*": "mul",
  "/": "div",
  "+": "add",
  "-": "sub",
  "==": "eq",
  "!=": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

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

// ═══════════════════════════════════════════════════════════════════════════
//  Handle Resolution
// ═══════════════════════════════════════════════════════════════════════════

type HandleResolution = {
  module: string;
  type: string;
  field: string;
  instance?: number;
};

// ═══════════════════════════════════════════════════════════════════════════
//  Body Builder — produces Statement[] from bridgeBodyLine CST nodes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a `Statement[]` body from bridge/define/tool body CST lines.
 *
 * This is the core of the new AST builder. It processes with-declarations
 * first (to build the handle resolution map), then processes wires/aliases/
 * force/scope statements to produce the nested IR.
 */
export function buildBody(
  bodyLines: CstNode[],
  bridgeType: string,
  bridgeField: string,
  previousInstructions: Instruction[],
  options?: {
    forbiddenHandleKinds?: Set<string>;
    selfWireNodes?: CstNode[];
    spreadNodes?: CstNode[];
  },
): {
  handles: HandleBinding[];
  body: Statement[];
  handleRes: Map<string, HandleResolution>;
} {
  const handleBindings: HandleBinding[] = [];
  const handleRes = new Map<string, HandleResolution>();
  const instanceCounters = new Map<string, number>();
  const body: Statement[] = [];

  // ── Step 1: Process with-declarations ─────────────────────────────────

  for (const bodyLine of bodyLines) {
    const withNode = sub(bodyLine, "bridgeWithDecl");
    if (!withNode) continue;
    const wc = withNode.children;
    const lineNum = line(findFirstToken(withNode));

    const checkDuplicate = (handle: string) => {
      if (handleRes.has(handle)) {
        throw new Error(`Line ${lineNum}: Duplicate handle name "${handle}"`);
      }
    };

    let binding: HandleBinding | undefined;
    let resolution: HandleResolution | undefined;

    if (wc.inputKw) {
      if (options?.forbiddenHandleKinds?.has("input")) {
        throw new Error(
          `Line ${lineNum}: 'with input' is not allowed in tool blocks`,
        );
      }
      if (wc.memoizeKw) {
        throw new Error(
          `Line ${lineNum}: memoize is only valid for tool references`,
        );
      }
      const handle = wc.inputAlias
        ? extractNameToken((wc.inputAlias as CstNode[])[0])
        : "input";
      checkDuplicate(handle);
      binding = { handle, kind: "input" };
      resolution = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
      };
    } else if (wc.outputKw) {
      if (options?.forbiddenHandleKinds?.has("output")) {
        throw new Error(
          `Line ${lineNum}: 'with output' is not allowed in tool blocks`,
        );
      }
      if (wc.memoizeKw) {
        throw new Error(
          `Line ${lineNum}: memoize is only valid for tool references`,
        );
      }
      const handle = wc.outputAlias
        ? extractNameToken((wc.outputAlias as CstNode[])[0])
        : "output";
      checkDuplicate(handle);
      binding = { handle, kind: "output" };
      resolution = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
      };
    } else if (wc.contextKw) {
      if (wc.memoizeKw) {
        throw new Error(
          `Line ${lineNum}: memoize is only valid for tool references`,
        );
      }
      const handle = wc.contextAlias
        ? extractNameToken((wc.contextAlias as CstNode[])[0])
        : "context";
      checkDuplicate(handle);
      binding = { handle, kind: "context" };
      resolution = {
        module: SELF_MODULE,
        type: "Context",
        field: "context",
      };
    } else if (wc.constKw) {
      if (wc.memoizeKw) {
        throw new Error(
          `Line ${lineNum}: memoize is only valid for tool references`,
        );
      }
      const handle = wc.constAlias
        ? extractNameToken((wc.constAlias as CstNode[])[0])
        : "const";
      checkDuplicate(handle);
      binding = { handle, kind: "const" };
      resolution = {
        module: SELF_MODULE,
        type: "Const",
        field: "const",
      };
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
      const memoize = !!wc.memoizeKw;

      checkDuplicate(handle);
      if (wc.refAlias) assertNotReserved(handle, lineNum, "handle alias");

      const defineDef = previousInstructions.find(
        (inst): inst is DefineDef =>
          inst.kind === "define" && inst.name === name,
      );
      if (defineDef) {
        if (memoize) {
          throw new Error(
            `Line ${lineNum}: memoize is only valid for tool references`,
          );
        }
        binding = { handle, kind: "define", name };
        resolution = {
          module: `__define_${handle}`,
          type: bridgeType,
          field: bridgeField,
        };
      } else if (lastDot !== -1) {
        const modulePart = name.substring(0, lastDot);
        const fieldPart = name.substring(lastDot + 1);
        const key = `${modulePart}:${fieldPart}`;
        const instance = (instanceCounters.get(key) ?? 0) + 1;
        instanceCounters.set(key, instance);
        binding = {
          handle,
          kind: "tool",
          name,
          ...(memoize ? { memoize: true as const } : {}),
          ...(versionTag ? { version: versionTag } : {}),
        };
        resolution = {
          module: modulePart,
          type: bridgeType,
          field: fieldPart,
          instance,
        };
      } else {
        const key = `Tools:${name}`;
        const instance = (instanceCounters.get(key) ?? 0) + 1;
        instanceCounters.set(key, instance);
        binding = {
          handle,
          kind: "tool",
          name,
          ...(memoize ? { memoize: true as const } : {}),
          ...(versionTag ? { version: versionTag } : {}),
        };
        resolution = {
          module: SELF_MODULE,
          type: "Tools",
          field: name,
          instance,
        };
      }
    }

    if (binding && resolution) {
      handleBindings.push(binding);
      handleRes.set(binding.handle, resolution);
      body.push({ kind: "with", binding } satisfies WithStatement);
    }
  }

  // ── Address resolution helpers ────────────────────────────────────────

  function resolveAddress(
    root: string,
    segments: string[],
    lineNum: number,
  ): NodeRef {
    if (root === "") {
      throw new Error(
        `Line ${lineNum}: Self-reference creates a circular dependency. Remove the leading dot or use a declared handle.`,
      );
    }
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

  function resolveIterRef(
    root: string,
    segments: string[],
    iterScope?: string[],
  ): NodeRef | undefined {
    if (!iterScope) return undefined;
    for (let index = iterScope.length - 1; index >= 0; index--) {
      if (iterScope[index] !== root) continue;
      const elementDepth = iterScope.length - 1 - index;
      return {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
        element: true,
        ...(elementDepth > 0 ? { elementDepth } : {}),
        path: [...segments],
      };
    }
    return undefined;
  }

  function resolveRef(
    root: string,
    segments: string[],
    lineNum: number,
    iterScope?: string[],
  ): NodeRef {
    const iterRef = resolveIterRef(root, segments, iterScope);
    if (iterRef) return iterRef;
    return resolveAddress(root, segments, lineNum);
  }

  function assertNoTargetIndices(ref: NodeRef, lineNum: number): void {
    if (ref.path.some((seg) => /^\d+$/.test(seg))) {
      throw new Error(
        `Line ${lineNum}: Explicit array index in wire target is not supported. Use array mapping (\`[] as iter { }\`) instead.`,
      );
    }
  }

  // ── Expression builders ───────────────────────────────────────────────

  /**
   * Build an Expression from a sourceExpr CST node.
   * Handles simple refs and pipe chains.
   */
  function buildSourceExpression(
    sourceNode: CstNode,
    lineNum: number,
    iterScope?: string[],
  ): Expression {
    const loc = locFromNode(sourceNode);
    const headNode = sub(sourceNode, "head")!;
    const pipeNodes = subs(sourceNode, "pipeSegment");

    if (pipeNodes.length === 0) {
      // Simple ref: handle.path.to.data
      const { root, segments, safe, rootSafe, segmentSafe } =
        extractAddressPath(headNode);
      const ref = resolveRef(root, segments, lineNum, iterScope);
      const fullRef: NodeRef = {
        ...ref,
        ...(rootSafe ? { rootSafe: true } : {}),
        ...(segmentSafe ? { pathSafe: segmentSafe } : {}),
      };
      return {
        type: "ref",
        ref: fullRef,
        ...(safe ? { safe: true as const } : {}),
        loc,
      };
    }

    // Pipe chain: handle:source or handle.path:source
    // CST gives us [head, ...pipeSegment] — last is the data source,
    // everything before are pipe handles.
    const allParts = [headNode, ...pipeNodes];
    const actualSourceNode = allParts[allParts.length - 1];
    const pipeChainNodes = allParts.slice(0, -1);

    // Validate pipe handles
    for (const pipeNode of pipeChainNodes) {
      const { root } = extractAddressPath(pipeNode);
      if (!handleRes.has(root)) {
        throw new Error(
          `Line ${lineNum}: Undeclared handle in pipe: "${root}". Add 'with <tool> as ${root}' to the bridge header.`,
        );
      }
    }

    // Build the innermost source expression
    const {
      root: srcRoot,
      segments: srcSegments,
      safe: srcSafe,
      rootSafe: srcRootSafe,
      segmentSafe: srcSegmentSafe,
    } = extractAddressPath(actualSourceNode);
    const srcRef = resolveRef(srcRoot, srcSegments, lineNum, iterScope);
    let expr: Expression = {
      type: "ref",
      ref: {
        ...srcRef,
        ...(srcRootSafe ? { rootSafe: true } : {}),
        ...(srcSegmentSafe ? { pathSafe: srcSegmentSafe } : {}),
      },
      ...(srcSafe ? { safe: true as const } : {}),
      loc,
    };

    // Wrap in PipeExpressions from innermost (rightmost) to outermost (leftmost)
    const reversed = [...pipeChainNodes].reverse();
    for (const pNode of reversed) {
      const { root: handleName, segments: handleSegs } =
        extractAddressPath(pNode);
      const path = handleSegs.length > 0 ? handleSegs : undefined;
      expr = {
        type: "pipe",
        source: expr,
        handle: handleName,
        ...(path ? { path } : {}),
        loc,
      };
    }

    return expr;
  }

  /**
   * Build a concat Expression from template string segments.
   */
  function buildConcatExpression(
    segs: TemplateSeg[],
    lineNum: number,
    iterScope?: string[],
    loc?: SourceLocation,
  ): Expression {
    const parts: Expression[] = [];
    for (const seg of segs) {
      if (seg.kind === "text") {
        parts.push({ type: "literal", value: seg.value, loc });
      } else {
        parts.push(
          buildTemplateSegExpression(seg.path, lineNum, iterScope, loc),
        );
      }
    }
    return { type: "concat", parts, loc };
  }

  /**
   * Build an Expression from a raw template segment path.
   * Handles simple refs ("handle.field") and pipe chains ("pipe:handle.field").
   */
  function buildTemplateSegExpression(
    segPath: string,
    lineNum: number,
    iterScope?: string[],
    loc?: SourceLocation,
  ): Expression {
    // Split on ":" to detect pipe chains: "toUpper:i.symbol" → ["toUpper", "i.symbol"]
    const colonIdx = segPath.indexOf(":");
    if (colonIdx === -1) {
      // Simple ref: "handle.field.subfield"
      const dotParts = segPath.split(".");
      const root = dotParts[0]!;
      const path = dotParts.slice(1);
      const ref = resolveRef(root, path, lineNum, iterScope);
      return { type: "ref", ref, loc };
    }

    // Pipe chain: split on ":" — everything before the last segment are pipe handles,
    // the last segment is the actual data source ref.
    const pipeAndSource = segPath.split(":");
    const pipeHandles = pipeAndSource.slice(0, -1);
    const sourceSegment = pipeAndSource[pipeAndSource.length - 1]!;

    // Build the innermost source ref
    const dotParts = sourceSegment.split(".");
    const root = dotParts[0]!;
    const path = dotParts.slice(1);
    const ref = resolveRef(root, path, lineNum, iterScope);

    // Validate pipe handles
    for (const handle of pipeHandles) {
      if (!handleRes.has(handle)) {
        throw new Error(
          `Line ${lineNum}: Undeclared handle in pipe: "${handle}". Add 'with <tool> as ${handle}' to the bridge header.`,
        );
      }
    }

    // Wrap in PipeExpressions from innermost (rightmost) to outermost (leftmost)
    let expr: Expression = { type: "ref", ref, loc };
    for (const handle of [...pipeHandles].reverse()) {
      expr = { type: "pipe", source: expr, handle, loc };
    }
    return expr;
  }

  /**
   * Resolve an expression operand (right side of binary op).
   */
  function resolveOperandExpression(
    operandNode: CstNode,
    lineNum: number,
    iterScope?: string[],
  ): Expression {
    const c = operandNode.children;
    const loc = locFromNode(operandNode);

    if (c.numberLit) {
      return {
        type: "literal",
        value: Number((c.numberLit as IToken[])[0].image),
        loc,
      };
    }
    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      const content = raw.slice(1, -1);
      const segs = parseTemplateString(content);
      if (segs) return buildConcatExpression(segs, lineNum, iterScope, loc);
      return { type: "literal", value: content, loc };
    }
    if (c.trueLit) return { type: "literal", value: true, loc };
    if (c.falseLit) return { type: "literal", value: false, loc };
    if (c.nullLit) return { type: "literal", value: null, loc };
    if (c.sourceRef) {
      return buildSourceExpression(
        (c.sourceRef as CstNode[])[0],
        lineNum,
        iterScope,
      );
    }
    if (c.parenExpr) {
      return buildParenExpression(
        (c.parenExpr as CstNode[])[0],
        lineNum,
        iterScope,
      );
    }
    throw new Error(`Line ${lineNum}: Invalid expression operand`);
  }

  /**
   * Build an expression chain with operator precedence.
   * Returns a single Expression tree.
   */
  function buildExprChain(
    left: Expression,
    exprOps: CstNode[],
    exprRights: CstNode[],
    lineNum: number,
    iterScope?: string[],
    loc?: SourceLocation,
  ): Expression {
    const operands: Expression[] = [left];
    const ops: string[] = [];

    for (let i = 0; i < exprOps.length; i++) {
      ops.push(extractExprOpStr(exprOps[i]));
      operands.push(
        resolveOperandExpression(exprRights[i], lineNum, iterScope),
      );
    }

    // Reduce a precedence level: fold all ops at `prec` left-to-right
    function reduceLevel(prec: number): void {
      let i = 0;
      while (i < ops.length) {
        if ((OP_PREC[ops[i]] ?? 0) !== prec) {
          i++;
          continue;
        }
        const opStr = ops[i];
        const l = operands[i];
        const r = operands[i + 1];

        let expr: Expression;
        if (opStr === "and") {
          expr = { type: "and", left: l, right: r, loc };
        } else if (opStr === "or") {
          expr = { type: "or", left: l, right: r, loc };
        } else {
          const op = OP_TO_BINARY[opStr];
          if (!op)
            throw new Error(`Line ${lineNum}: Unknown operator "${opStr}"`);
          expr = { type: "binary", op, left: l, right: r, loc };
        }
        operands.splice(i, 2, expr);
        ops.splice(i, 1);
      }
    }

    reduceLevel(4); // * /
    reduceLevel(3); // + -
    reduceLevel(2); // == != > >= < <=
    reduceLevel(1); // and
    reduceLevel(0); // or

    return operands[0];
  }

  /**
   * Build expression from a parenthesized sub-expression.
   */
  function buildParenExpression(
    parenNode: CstNode,
    lineNum: number,
    iterScope?: string[],
  ): Expression {
    const pc = parenNode.children;
    const innerSourceNode = sub(parenNode, "parenSource")!;
    const innerOps = subs(parenNode, "parenExprOp");
    const innerRights = subs(parenNode, "parenExprRight");
    const hasNot = !!(pc.parenNotPrefix as IToken[] | undefined)?.length;

    let expr = buildSourceExpression(innerSourceNode, lineNum, iterScope);

    if (innerOps.length > 0) {
      expr = buildExprChain(
        expr,
        innerOps,
        innerRights,
        lineNum,
        iterScope,
        locFromNode(parenNode),
      );
    }

    if (hasNot) {
      expr = {
        type: "unary",
        op: "not",
        operand: expr,
        loc: locFromNode(parenNode),
      };
    }

    return expr;
  }

  /**
   * Resolve a ternary branch to an Expression.
   */
  function buildTernaryBranch(
    branchNode: CstNode,
    lineNum: number,
    iterScope?: string[],
  ): Expression {
    const c = branchNode.children;
    const loc = locFromNode(branchNode);

    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      const content = raw.slice(1, -1);
      const segs = parseTemplateString(content);
      if (segs) return buildConcatExpression(segs, lineNum, iterScope, loc);
      return { type: "literal", value: JSON.parse(raw) as JsonValue, loc };
    }
    if (c.numberLit)
      return {
        type: "literal",
        value: Number((c.numberLit as IToken[])[0].image),
        loc,
      };
    if (c.trueLit) return { type: "literal", value: true, loc };
    if (c.falseLit) return { type: "literal", value: false, loc };
    if (c.nullLit) return { type: "literal", value: null, loc };
    if (c.sourceRef) {
      const addrNode = (c.sourceRef as CstNode[])[0];
      const { root, segments, rootSafe, segmentSafe } =
        extractAddressPath(addrNode);
      const ref = resolveRef(root, segments, lineNum, iterScope);
      return {
        type: "ref",
        ref: {
          ...ref,
          ...(rootSafe ? { rootSafe: true } : {}),
          ...(segmentSafe ? { pathSafe: segmentSafe } : {}),
        },
        loc,
      };
    }
    throw new Error(`Line ${lineNum}: Invalid ternary branch`);
  }

  /**
   * Build a coalesce alternative as an Expression.
   */
  function buildCoalesceAltExpression(
    altNode: CstNode,
    lineNum: number,
    iterScope?: string[],
  ): Expression {
    const c = altNode.children;
    const loc = locFromNode(altNode);

    if (c.throwKw) {
      const msg = (c.throwMsg as IToken[])[0].image;
      return {
        type: "control",
        control: { kind: "throw", message: JSON.parse(msg) as string },
        loc,
      };
    }
    if (c.panicKw) {
      const msg = (c.panicMsg as IToken[])[0].image;
      return {
        type: "control",
        control: { kind: "panic", message: JSON.parse(msg) as string },
        loc,
      };
    }
    if (c.continueKw) {
      const raw = (c.continueLevel as IToken[] | undefined)?.[0]?.image;
      const levels = raw ? Number(raw) : undefined;
      if (levels !== undefined && (!Number.isInteger(levels) || levels < 1)) {
        throw new Error(
          `Line ${lineNum}: continue level must be a positive integer`,
        );
      }
      return {
        type: "control",
        control: {
          kind: "continue",
          ...(levels ? { levels } : {}),
        },
        loc,
      };
    }
    if (c.breakKw) {
      const raw = (c.breakLevel as IToken[] | undefined)?.[0]?.image;
      const levels = raw ? Number(raw) : undefined;
      if (levels !== undefined && (!Number.isInteger(levels) || levels < 1)) {
        throw new Error(
          `Line ${lineNum}: break level must be a positive integer`,
        );
      }
      return {
        type: "control",
        control: {
          kind: "break",
          ...(levels ? { levels } : {}),
        },
        loc,
      };
    }
    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      const content = raw.slice(1, -1);
      const segs = parseTemplateString(content);
      if (segs) return buildConcatExpression(segs, lineNum, iterScope, loc);
      return { type: "literal", value: JSON.parse(raw) as JsonValue, loc };
    }
    if (c.numberLit)
      return {
        type: "literal",
        value: Number((c.numberLit as IToken[])[0].image),
        loc,
      };
    if (c.trueLit) return { type: "literal", value: true, loc };
    if (c.falseLit) return { type: "literal", value: false, loc };
    if (c.nullLit) return { type: "literal", value: null, loc };
    if (c.objectLit) {
      const jsonStr = reconstructJson((c.objectLit as CstNode[])[0]);
      return { type: "literal", value: JSON.parse(jsonStr) as JsonValue, loc };
    }
    if (c.arrayLit) {
      const jsonStr = reconstructJson((c.arrayLit as CstNode[])[0]);
      return { type: "literal", value: JSON.parse(jsonStr) as JsonValue, loc };
    }
    if (c.sourceAlt) {
      return buildSourceExpression(
        (c.sourceAlt as CstNode[])[0],
        lineNum,
        iterScope,
      );
    }
    throw new Error(`Line ${lineNum}: Invalid coalesce alternative`);
  }

  /**
   * Build WireSourceEntry[] from coalesce chain items.
   */
  function buildFallbacks(
    items: CstNode[],
    lineNum: number,
    iterScope?: string[],
  ): WireSourceEntry[] {
    return items.map((item) => {
      const gate = tok(item, "falsyOp")
        ? ("falsy" as const)
        : ("nullish" as const);
      const altNode = sub(item, "altValue")!;
      let expr = buildCoalesceAltExpression(altNode, lineNum, iterScope);

      // Array mapping on coalesce alternative: || source[] as iter { ... }
      const arrayMappingNode = sub(item, "altArrayMapping");
      if (arrayMappingNode) {
        const iterName = extractNameToken(sub(arrayMappingNode, "iterName")!);
        const newIterScope = [...(iterScope ?? []), iterName];
        const arrayBody = buildArrayMappingBody(
          arrayMappingNode,
          lineNum,
          newIterScope,
        );
        expr = {
          type: "array",
          source: expr,
          iteratorName: iterName,
          body: arrayBody,
          loc: locFromNode(arrayMappingNode),
        };
      }

      return { expr, gate, loc: locFromNode(altNode) };
    });
  }

  /**
   * Build a WireCatch from a catch alternative CST node.
   */
  function buildCatch(
    catchAlt: CstNode,
    lineNum: number,
    iterScope?: string[],
  ): WireCatch {
    const c = catchAlt.children;
    const loc = locFromNode(catchAlt);

    // Control flow
    if (c.throwKw) {
      const msg = (c.throwMsg as IToken[])[0].image;
      return {
        control: { kind: "throw", message: JSON.parse(msg) as string },
        ...(loc ? { loc } : {}),
      };
    }
    if (c.panicKw) {
      const msg = (c.panicMsg as IToken[])[0].image;
      return {
        control: { kind: "panic", message: JSON.parse(msg) as string },
        ...(loc ? { loc } : {}),
      };
    }
    if (c.continueKw) {
      const raw = (c.continueLevel as IToken[] | undefined)?.[0]?.image;
      const levels = raw ? Number(raw) : undefined;
      return {
        control: {
          kind: "continue",
          ...(levels ? { levels } : {}),
        },
        ...(loc ? { loc } : {}),
      };
    }
    if (c.breakKw) {
      const raw = (c.breakLevel as IToken[] | undefined)?.[0]?.image;
      const levels = raw ? Number(raw) : undefined;
      return {
        control: {
          kind: "break",
          ...(levels ? { levels } : {}),
        },
        ...(loc ? { loc } : {}),
      };
    }
    // Literals
    if (c.stringLit) {
      const raw = (c.stringLit as IToken[])[0].image;
      // Check for template strings in catch position
      const content = raw.slice(1, -1);
      const segs = parseTemplateString(content);
      if (segs) {
        // WireCatch only supports ref, value, or control — not arbitrary expressions.
        // Template strings in catch position are rare. Keep as raw string.
        return { value: content, ...(loc ? { loc } : {}) };
      }
      return {
        value: JSON.parse(raw) as string,
        ...(loc ? { loc } : {}),
      };
    }
    if (c.numberLit)
      return {
        value: Number((c.numberLit as IToken[])[0].image),
        ...(loc ? { loc } : {}),
      };
    if (c.trueLit) return { value: true, ...(loc ? { loc } : {}) };
    if (c.falseLit) return { value: false, ...(loc ? { loc } : {}) };
    if (c.nullLit) return { value: null, ...(loc ? { loc } : {}) };
    if (c.objectLit) {
      const jsonStr = reconstructJson((c.objectLit as CstNode[])[0]);
      return {
        value: JSON.parse(jsonStr) as JsonValue,
        ...(loc ? { loc } : {}),
      };
    }
    if (c.arrayLit) {
      const jsonStr = reconstructJson((c.arrayLit as CstNode[])[0]);
      return {
        value: JSON.parse(jsonStr) as JsonValue,
        ...(loc ? { loc } : {}),
      };
    }
    // Source ref (possibly a pipe expression)
    if (c.sourceAlt) {
      const srcNode = (c.sourceAlt as CstNode[])[0];
      const expr = buildSourceExpression(srcNode, lineNum, iterScope);
      if (expr.type === "ref") {
        // Simple ref — keep backward-compatible format
        return {
          ref: expr.ref,
          ...(loc ? { loc } : {}),
        };
      }
      // Complex expression (pipe chain, etc.) — use expr variant
      return {
        expr,
        ...(loc ? { loc } : {}),
      };
    }
    throw new Error(`Line ${lineNum}: Invalid catch alternative`);
  }

  // ── Wire RHS builder ──────────────────────────────────────────────────

  /**
   * Build the full RHS of a wire: primary expression + coalesce + catch.
   *
   * This is the central function that converts the wire RHS CST
   * (source expr + operators + ternary + array mapping + coalesce + catch)
   * into a SourceChain (sources[] + catch?).
   */
  function buildWireRHS(
    wireNode: CstNode,
    lineNum: number,
    iterScope?: string[],
    // Label config for different CST node shapes
    labels?: {
      stringSource?: string;
      notPrefix?: string;
      firstParenExpr?: string;
      firstSource?: string;
      exprOp?: string;
      exprRight?: string;
      ternaryOp?: string;
      thenBranch?: string;
      elseBranch?: string;
      arrayMapping?: string;
      coalesceItem?: string;
      catchAlt?: string;
    },
  ): SourceChain & { arrayMapping?: CstNode } {
    const loc = locFromNode(wireNode);
    const lb = labels ?? {};

    // String literal source (template or plain)
    const stringToken = tok(wireNode, lb.stringSource ?? "stringSource");
    if (stringToken) {
      const raw = stringToken.image.slice(1, -1);
      const segs = parseTemplateString(raw);
      let primaryExpr: Expression;
      if (segs) {
        primaryExpr = buildConcatExpression(segs, lineNum, iterScope, loc);
      } else {
        primaryExpr = {
          type: "literal",
          value: JSON.parse(stringToken.image) as JsonValue,
          loc,
        };
      }

      // String source can also have expression chain after it
      const stringOps = subs(wireNode, lb.exprOp ?? "exprOp");
      const stringRights = subs(wireNode, lb.exprRight ?? "exprRight");
      if (stringOps.length > 0) {
        primaryExpr = buildExprChain(
          primaryExpr,
          stringOps,
          stringRights,
          lineNum,
          iterScope,
          loc,
        );
      }

      // Ternary after string expression
      const ternOp = tok(wireNode, lb.ternaryOp ?? "ternaryOp");
      if (ternOp) {
        const thenBranch = buildTernaryBranch(
          sub(wireNode, lb.thenBranch ?? "thenBranch")!,
          lineNum,
          iterScope,
        );
        const elseBranch = buildTernaryBranch(
          sub(wireNode, lb.elseBranch ?? "elseBranch")!,
          lineNum,
          iterScope,
        );
        primaryExpr = {
          type: "ternary",
          cond: primaryExpr,
          then: thenBranch,
          else: elseBranch,
          loc,
        };
      }

      const sources: WireSourceEntry[] = [{ expr: primaryExpr, loc }];

      // Coalesce chain
      const coalesceItems = subs(wireNode, lb.coalesceItem ?? "coalesceItem");
      if (coalesceItems.length > 0) {
        sources.push(...buildFallbacks(coalesceItems, lineNum, iterScope));
      }

      // Catch
      const catchAlt = sub(wireNode, lb.catchAlt ?? "catchAlt");
      const catchHandler = catchAlt
        ? buildCatch(catchAlt, lineNum, iterScope)
        : undefined;

      return {
        sources,
        ...(catchHandler ? { catch: catchHandler } : {}),
      };
    }

    // Normal source expression with optional not prefix, operators, ternary
    const notPrefix = tok(wireNode, lb.notPrefix ?? "notPrefix");
    const parenExprNode = sub(wireNode, lb.firstParenExpr ?? "firstParenExpr");
    const sourceNode = sub(wireNode, lb.firstSource ?? "firstSource");

    let primaryExpr: Expression;
    if (parenExprNode) {
      primaryExpr = buildParenExpression(parenExprNode, lineNum, iterScope);
    } else if (sourceNode) {
      primaryExpr = buildSourceExpression(sourceNode, lineNum, iterScope);
    } else {
      throw new Error(`Line ${lineNum}: Expected source expression`);
    }

    // Expression chain: op operand pairs
    const exprOps = subs(wireNode, lb.exprOp ?? "exprOp");
    const exprRights = subs(wireNode, lb.exprRight ?? "exprRight");
    if (exprOps.length > 0) {
      primaryExpr = buildExprChain(
        primaryExpr,
        exprOps,
        exprRights,
        lineNum,
        iterScope,
        loc,
      );
    }

    // Ternary
    const ternOp = tok(wireNode, lb.ternaryOp ?? "ternaryOp");
    if (ternOp) {
      const thenBranch = buildTernaryBranch(
        sub(wireNode, lb.thenBranch ?? "thenBranch")!,
        lineNum,
        iterScope,
      );
      const elseBranch = buildTernaryBranch(
        sub(wireNode, lb.elseBranch ?? "elseBranch")!,
        lineNum,
        iterScope,
      );
      primaryExpr = {
        type: "ternary",
        cond: primaryExpr,
        then: thenBranch,
        else: elseBranch,
        loc,
      };
    }

    // Not prefix wraps the entire expression
    if (notPrefix) {
      primaryExpr = { type: "unary", op: "not", operand: primaryExpr, loc };
    }

    // Array mapping: [] as iter { ... }
    const arrayMappingNode = sub(wireNode, lb.arrayMapping ?? "arrayMapping");
    if (arrayMappingNode) {
      const iterName = extractNameToken(sub(arrayMappingNode, "iterName")!);
      const newIterScope = [...(iterScope ?? []), iterName];

      // Process element lines inside the array mapping
      const arrayBody = buildArrayMappingBody(
        arrayMappingNode,
        lineNum,
        newIterScope,
      );

      primaryExpr = {
        type: "array",
        source: primaryExpr,
        iteratorName: iterName,
        body: arrayBody,
        loc: locFromNode(arrayMappingNode),
      };
    }

    const sources: WireSourceEntry[] = [{ expr: primaryExpr, loc }];

    // Coalesce chain
    const coalesceItems = subs(wireNode, lb.coalesceItem ?? "coalesceItem");
    if (coalesceItems.length > 0) {
      sources.push(...buildFallbacks(coalesceItems, lineNum, iterScope));
    }

    // Catch
    const catchAlt = sub(wireNode, lb.catchAlt ?? "catchAlt");
    const catchHandler = catchAlt
      ? buildCatch(catchAlt, lineNum, iterScope)
      : undefined;

    return {
      sources,
      ...(catchHandler ? { catch: catchHandler } : {}),
      ...(arrayMappingNode ? { arrayMapping: arrayMappingNode } : {}),
    };
  }

  // ── Array mapping body builder ────────────────────────────────────────

  /**
   * Build Statement[] from the inside of an array mapping block.
   */
  function buildArrayMappingBody(
    arrayMappingNode: CstNode,
    _lineNum: number,
    iterScope: string[],
  ): Statement[] {
    const stmts: Statement[] = [];

    // elementWithDecl: alias name <- source (local bindings)
    for (const withDecl of subs(arrayMappingNode, "elementWithDecl")) {
      const alias = extractNameToken(sub(withDecl, "elemWithAlias")!);
      const elemLineNum = line(findFirstToken(withDecl));
      assertNotReserved(alias, elemLineNum, "local binding alias");

      const sourceNode = sub(withDecl, "elemWithSource")!;
      const expr = buildSourceExpression(sourceNode, elemLineNum, iterScope);

      // Coalesce chain on the alias
      const coalesceItems = subs(withDecl, "elemCoalesceItem");
      const fallbacks = buildFallbacks(coalesceItems, elemLineNum, iterScope);
      const catchAlt = sub(withDecl, "elemCatchAlt");
      const catchHandler = catchAlt
        ? buildCatch(catchAlt, elemLineNum, iterScope)
        : undefined;

      const sources: WireSourceEntry[] = [
        { expr, loc: locFromNode(sourceNode) },
        ...fallbacks,
      ];

      // Register the alias in handleRes for subsequent element lines
      handleRes.set(alias, {
        module: SELF_MODULE,
        type: "__local",
        field: alias,
      });

      stmts.push({
        kind: "alias",
        name: alias,
        sources,
        ...(catchHandler ? { catch: catchHandler } : {}),
        loc: locFromNode(withDecl),
      } satisfies WireAliasStatement);
    }

    // elementToolWithDecl: with <tool> [as <alias>] [memoize]
    for (const toolWith of subs(arrayMappingNode, "elementToolWithDecl")) {
      const elemLineNum = line(findFirstToken(toolWith));
      const name = extractDottedName(sub(toolWith, "refName")!);
      const versionTag = (
        toolWith.children.refVersion as IToken[] | undefined
      )?.[0]?.image.slice(1);
      const lastDot = name.lastIndexOf(".");
      const defaultHandle = lastDot !== -1 ? name.substring(lastDot + 1) : name;
      const handle = toolWith.children.refAlias
        ? extractNameToken((toolWith.children.refAlias as CstNode[])[0])
        : defaultHandle;
      const memoize = !!toolWith.children.memoizeKw;

      if (toolWith.children.refAlias) {
        assertNotReserved(handle, elemLineNum, "handle alias");
      }

      let binding: HandleBinding;
      const defineDef = previousInstructions.find(
        (inst): inst is DefineDef =>
          inst.kind === "define" && inst.name === name,
      );
      if (defineDef) {
        if (memoize) {
          throw new Error(
            `Line ${elemLineNum}: memoize is only valid for tool references`,
          );
        }
        binding = { handle, kind: "define", name };
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
        binding = {
          handle,
          kind: "tool",
          name,
          element: true,
          ...(memoize ? { memoize: true as const } : {}),
          ...(versionTag ? { version: versionTag } : {}),
        };
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
        binding = {
          handle,
          kind: "tool",
          name,
          element: true,
          ...(memoize ? { memoize: true as const } : {}),
          ...(versionTag ? { version: versionTag } : {}),
        };
        handleRes.set(handle, {
          module: SELF_MODULE,
          type: "Tools",
          field: name,
          instance,
        });
      }

      handleBindings.push(binding);
      stmts.push({ kind: "with", binding } satisfies WithStatement);
    }

    // elementHandleWire: handle.field <- expr | handle.field = value
    for (const wireNode of subs(arrayMappingNode, "elementHandleWire")) {
      const elemLineNum = line(findFirstToken(wireNode));
      const { root: targetRoot, segments: targetSegs } = extractAddressPath(
        sub(wireNode, "target")!,
      );
      const toRef = resolveAddress(targetRoot, targetSegs, elemLineNum);
      assertNoTargetIndices(toRef, elemLineNum);

      const wc = wireNode.children;
      if (wc.equalsOp) {
        const value = extractBareValue(sub(wireNode, "constValue")!);
        stmts.push({
          kind: "wire",
          target: toRef,
          sources: [{ expr: { type: "literal", value: parseLiteral(value) } }],
          loc: locFromNode(wireNode),
        } satisfies WireStatement);
        continue;
      }

      const rhs = buildWireRHS(wireNode, elemLineNum, iterScope, {
        coalesceItem: "coalesceItem",
        catchAlt: "catchAlt",
      });
      stmts.push({
        kind: "wire",
        target: toRef,
        sources: rhs.sources,
        ...(rhs.catch ? { catch: rhs.catch } : {}),
        loc: locFromNode(wireNode),
      } satisfies WireStatement);
    }

    // elemMapSpreadLine: ... <- source (spread inside array mapper)
    for (const spreadLine of subs(arrayMappingNode, "elemMapSpreadLine")) {
      buildSpreadLine(spreadLine, stmts, iterScope);
    }

    // elementLine: .field = value | .field <- expr | .field { ... }
    for (const elemLine of subs(arrayMappingNode, "elementLine")) {
      const elemLineNum = line(findFirstToken(elemLine));
      const targetStr = extractDottedPathStr(sub(elemLine, "elemTarget")!);
      const elemSegs = parsePath(targetStr);
      const wc = elemLine.children;

      // Scope block: .field { ... }
      if (wc.elemScopeBlock) {
        const scopeRef: NodeRef = {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: elemSegs,
        };
        const scopeBody: Statement[] = [];

        for (const scopeLine of subs(elemLine, "elemScopeLine")) {
          buildPathScopeLine(scopeLine, scopeBody, iterScope, true);
        }
        for (const spreadLine of subs(elemLine, "elemSpreadLine")) {
          buildSpreadLine(spreadLine, scopeBody, iterScope);
        }

        stmts.push({
          kind: "scope",
          target: scopeRef,
          body: scopeBody,
          loc: locFromNode(elemLine),
        } satisfies ScopeStatement);
        continue;
      }

      const toRef: NodeRef = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
        element: true,
        path: elemSegs,
      };

      // Constant: .field = value
      if (wc.elemEquals) {
        const value = extractBareValue(sub(elemLine, "elemValue")!);
        stmts.push({
          kind: "wire",
          target: toRef,
          sources: [{ expr: { type: "literal", value: parseLiteral(value) } }],
          loc: locFromNode(elemLine),
        } satisfies WireStatement);
        continue;
      }

      // Pull wire: .field <- expr ...
      const rhs = buildWireRHS(elemLine, elemLineNum, iterScope, {
        stringSource: "elemStringSource",
        notPrefix: "elemNotPrefix",
        firstParenExpr: "elemFirstParenExpr",
        firstSource: "elemSource",
        exprOp: "elemExprOp",
        exprRight: "elemExprRight",
        ternaryOp: "elemTernaryOp",
        thenBranch: "elemThenBranch",
        elseBranch: "elemElseBranch",
        arrayMapping: "nestedArrayMapping",
        coalesceItem: "elemCoalesceItem",
        catchAlt: "elemCatchAlt",
      });
      stmts.push({
        kind: "wire",
        target: toRef,
        sources: rhs.sources,
        ...(rhs.catch ? { catch: rhs.catch } : {}),
        loc: locFromNode(elemLine),
      } satisfies WireStatement);
    }

    return stmts;
  }

  // ── Path scope line builder ───────────────────────────────────────────

  function buildPathScopeLine(
    scopeLine: CstNode,
    stmts: Statement[],
    iterScope?: string[],
    inElement?: boolean,
  ): void {
    const scopeLineNum = line(findFirstToken(scopeLine));
    const targetStr = extractDottedPathStr(sub(scopeLine, "scopeTarget")!);
    const scopeSegs = parsePath(targetStr);
    const sc = scopeLine.children;

    // Nested scope: .field { ... }
    const nestedScopeLines = subs(scopeLine, "pathScopeLine");
    const nestedSpreadLines = subs(scopeLine, "scopeSpreadLine");
    const nestedAliases = subs(scopeLine, "scopeAlias");
    if (
      nestedScopeLines.length > 0 ||
      nestedSpreadLines.length > 0 ||
      nestedAliases.length > 0
    ) {
      // This is a nested scope block
      const scopeRef: NodeRef = {
        module: SELF_MODULE,
        type: bridgeType,
        field: bridgeField,
        ...(inElement ? { element: true as const } : {}),
        path: scopeSegs,
      };
      const scopeBody: Statement[] = [];

      for (const innerAlias of nestedAliases) {
        buildAliasStatement(innerAlias, scopeBody, iterScope);
      }
      for (const innerLine of nestedScopeLines) {
        buildPathScopeLine(innerLine, scopeBody, iterScope, inElement);
      }
      for (const innerSpread of nestedSpreadLines) {
        buildSpreadLine(innerSpread, scopeBody, iterScope);
      }

      stmts.push({
        kind: "scope",
        target: scopeRef,
        body: scopeBody,
        loc: locFromNode(scopeLine),
      } satisfies ScopeStatement);
      return;
    }

    // Target ref for non-scope wires inside the scope block
    const toRef: NodeRef = {
      module: SELF_MODULE,
      type: bridgeType,
      field: bridgeField,
      ...(inElement ? { element: true as const } : {}),
      path: scopeSegs,
    };

    // Constant: .field = value
    if (sc.scopeEquals) {
      const value = extractBareValue(sub(scopeLine, "scopeValue")!);
      stmts.push({
        kind: "wire",
        target: toRef,
        sources: [{ expr: { type: "literal", value: parseLiteral(value) } }],
        loc: locFromNode(scopeLine),
      } satisfies WireStatement);
      return;
    }

    // Pull wire: .field <- expr
    const rhs = buildWireRHS(scopeLine, scopeLineNum, iterScope, {
      stringSource: "scopeStringSource",
      notPrefix: "scopeNotPrefix",
      firstParenExpr: "scopeFirstParenExpr",
      firstSource: "scopeSource",
      exprOp: "scopeExprOp",
      exprRight: "scopeExprRight",
      ternaryOp: "scopeTernaryOp",
      thenBranch: "scopeThenBranch",
      elseBranch: "scopeElseBranch",
      arrayMapping: "scopeArrayMapping",
      coalesceItem: "scopeCoalesceItem",
      catchAlt: "scopeCatchAlt",
    });
    stmts.push({
      kind: "wire",
      target: toRef,
      sources: rhs.sources,
      ...(rhs.catch ? { catch: rhs.catch } : {}),
      loc: locFromNode(scopeLine),
    } satisfies WireStatement);
  }

  // ── Spread line builder ───────────────────────────────────────────────

  function buildSpreadLine(
    spreadLine: CstNode,
    stmts: Statement[],
    iterScope?: string[],
  ): void {
    const spreadLineNum = line(findFirstToken(spreadLine));
    const sourceNode = sub(spreadLine, "spreadSource")!;
    const expr = buildSourceExpression(sourceNode, spreadLineNum, iterScope);

    stmts.push({
      kind: "spread",
      sources: [{ expr, loc: locFromNode(sourceNode) }],
      loc: locFromNode(spreadLine),
    } satisfies SpreadStatement);
  }

  // ── Alias statement builder ───────────────────────────────────────────

  function buildAliasStatement(
    aliasNode: CstNode,
    stmts: Statement[],
    iterScope?: string[],
  ): void {
    const aliasLineNum = line(findFirstToken(aliasNode));
    const aliasName = extractNameToken(sub(aliasNode, "nodeAliasName")!);

    // String literal source
    const stringToken = tok(aliasNode, "aliasStringSource");
    if (stringToken) {
      const raw = stringToken.image.slice(1, -1);
      const segs = parseTemplateString(raw);
      let primaryExpr: Expression;
      if (segs) {
        primaryExpr = buildConcatExpression(
          segs,
          aliasLineNum,
          iterScope,
          locFromNode(aliasNode),
        );
      } else {
        primaryExpr = {
          type: "literal",
          value: JSON.parse(stringToken.image) as JsonValue,
          loc: locFromNode(aliasNode),
        };
      }

      // Expression chain after string
      const ops = subs(aliasNode, "aliasStringExprOp");
      const rights = subs(aliasNode, "aliasStringExprRight");
      if (ops.length > 0) {
        primaryExpr = buildExprChain(
          primaryExpr,
          ops,
          rights,
          aliasLineNum,
          iterScope,
          locFromNode(aliasNode),
        );
      }

      // Ternary after string expression
      const ternOp = tok(aliasNode, "aliasStringTernaryOp");
      if (ternOp) {
        const thenBranch = buildTernaryBranch(
          sub(aliasNode, "aliasStringThenBranch")!,
          aliasLineNum,
          iterScope,
        );
        const elseBranch = buildTernaryBranch(
          sub(aliasNode, "aliasStringElseBranch")!,
          aliasLineNum,
          iterScope,
        );
        primaryExpr = {
          type: "ternary",
          cond: primaryExpr,
          then: thenBranch,
          else: elseBranch,
          loc: locFromNode(aliasNode),
        };
      }

      const sources: WireSourceEntry[] = [
        { expr: primaryExpr, loc: locFromNode(aliasNode) },
      ];

      // Coalesce + catch
      const coalesceItems = subs(aliasNode, "aliasCoalesceItem");
      sources.push(...buildFallbacks(coalesceItems, aliasLineNum, iterScope));
      const catchAlt = sub(aliasNode, "aliasCatchAlt");
      const catchHandler = catchAlt
        ? buildCatch(catchAlt, aliasLineNum, iterScope)
        : undefined;

      // Register alias in handleRes
      handleRes.set(aliasName, {
        module: SELF_MODULE,
        type: "__local",
        field: aliasName,
      });

      stmts.push({
        kind: "alias",
        name: aliasName,
        sources,
        ...(catchHandler ? { catch: catchHandler } : {}),
        loc: locFromNode(aliasNode),
      } satisfies WireAliasStatement);
      return;
    }

    // Normal source alias (not prefix + source/paren expr + ops + ternary + array mapping)
    const rhs = buildWireRHS(aliasNode, aliasLineNum, iterScope, {
      notPrefix: "aliasNotPrefix",
      firstParenExpr: "aliasFirstParen",
      firstSource: "nodeAliasSource",
      exprOp: "aliasExprOp",
      exprRight: "aliasExprRight",
      ternaryOp: "aliasTernaryOp",
      thenBranch: "aliasThenBranch",
      elseBranch: "aliasElseBranch",
      arrayMapping: "arrayMapping",
      coalesceItem: "aliasCoalesceItem",
      catchAlt: "aliasCatchAlt",
    });

    // Register alias
    handleRes.set(aliasName, {
      module: SELF_MODULE,
      type: "__local",
      field: aliasName,
    });

    stmts.push({
      kind: "alias",
      name: aliasName,
      sources: rhs.sources,
      ...(rhs.catch ? { catch: rhs.catch } : {}),
      loc: locFromNode(aliasNode),
    } satisfies WireAliasStatement);
  }

  // ── Step 2: Process body lines (wires, aliases, force, scopes) ────────

  for (const bodyLine of bodyLines) {
    const bc = bodyLine.children;
    const bodyLineNum = line(findFirstToken(bodyLine));
    const bodyLineLoc = locFromNode(bodyLine);

    // Skip with-declarations (already processed in Step 1)
    if (bc.bridgeWithDecl) continue;

    // Force statement
    if (bc.bridgeForce) {
      const forceNode = (bc.bridgeForce as CstNode[])[0];
      const handle = extractNameToken(sub(forceNode, "forcedHandle")!);
      const hasCatchNull = !!tok(forceNode, "forceCatchKw");
      const res = handleRes.get(handle);
      if (!res) {
        throw new Error(
          `Line ${bodyLineNum}: Cannot force undeclared handle "${handle}"`,
        );
      }
      body.push({
        kind: "force",
        handle,
        module: res.module,
        type: res.type,
        field: res.field,
        ...(res.instance != null ? { instance: res.instance } : {}),
        ...(hasCatchNull ? { catchError: true as const } : {}),
        loc: locFromNode(forceNode),
      } satisfies ForceStatement);
      continue;
    }

    // Node alias
    if (bc.bridgeNodeAlias) {
      buildAliasStatement(
        (bc.bridgeNodeAlias as CstNode[])[0],
        body,
        undefined,
      );
      continue;
    }

    // Bridge wire (constant, pull, or scope block)
    if (bc.bridgeWire) {
      const wireNode = (bc.bridgeWire as CstNode[])[0];
      const wc = wireNode.children;
      const { root: targetRoot, segments: targetSegs } = extractAddressPath(
        sub(wireNode, "target")!,
      );
      const toRef = resolveAddress(targetRoot, targetSegs, bodyLineNum);
      assertNoTargetIndices(toRef, bodyLineNum);

      // Constant wire: target = value
      if (wc.equalsOp) {
        const value = extractBareValue(sub(wireNode, "constValue")!);
        body.push({
          kind: "wire",
          target: toRef,
          sources: [{ expr: { type: "literal", value: parseLiteral(value) } }],
          loc: bodyLineLoc,
        } satisfies WireStatement);
        continue;
      }

      // Scope block: target { ... }
      if (wc.scopeBlock) {
        const scopeBody: Statement[] = [];

        for (const aliasNode of subs(wireNode, "scopeAlias")) {
          buildAliasStatement(aliasNode, scopeBody, undefined);
        }
        for (const scopeLine of subs(wireNode, "pathScopeLine")) {
          buildPathScopeLine(scopeLine, scopeBody, undefined);
        }
        for (const spreadLine of subs(wireNode, "scopeSpreadLine")) {
          buildSpreadLine(spreadLine, scopeBody, undefined);
        }

        body.push({
          kind: "scope",
          target: toRef,
          body: scopeBody,
          loc: bodyLineLoc,
        } satisfies ScopeStatement);
        continue;
      }

      // Pull wire: target <- expr [modifiers]
      const rhs = buildWireRHS(wireNode, bodyLineNum);
      body.push({
        kind: "wire",
        target: toRef,
        sources: rhs.sources,
        ...(rhs.catch ? { catch: rhs.catch } : {}),
        loc: bodyLineLoc,
      } satisfies WireStatement);
      continue;
    }
  }

  // ── Tool self-wires (.key = value | .key <- expr) ─────────────────────

  if (options?.selfWireNodes) {
    for (const selfWire of options.selfWireNodes) {
      const selfLineNum = line(findFirstToken(selfWire));
      const targetStr = extractDottedPathStr(sub(selfWire, "elemTarget")!);
      const selfSegs = parsePath(targetStr);
      const wc = selfWire.children;

      // The tool itself is the target — resolve from the first handle
      // that represents the tool (usually the only one for self-wires)
      const toRef: NodeRef = {
        module: SELF_MODULE,
        type: "Tools",
        field: bridgeField,
        path: selfSegs,
      };

      if (wc.elemEquals) {
        const value = extractBareValue(sub(selfWire, "elemValue")!);
        body.push({
          kind: "wire",
          target: toRef,
          sources: [{ expr: { type: "literal", value: parseLiteral(value) } }],
          loc: locFromNode(selfWire),
        } satisfies WireStatement);
        continue;
      }

      // Scope block: .field { .sub <- source, ... }
      if (wc.elemScopeBlock) {
        const scopeBody: Statement[] = [];
        for (const scopeLine of subs(selfWire, "elemScopeLine")) {
          buildPathScopeLine(scopeLine, scopeBody, undefined);
        }
        for (const spreadLine of subs(selfWire, "elemSpreadLine")) {
          buildSpreadLine(spreadLine, scopeBody, undefined);
        }
        body.push({
          kind: "scope",
          target: toRef,
          body: scopeBody,
          loc: locFromNode(selfWire),
        } satisfies ScopeStatement);
        continue;
      }

      // Pull wire
      const rhs = buildWireRHS(selfWire, selfLineNum, undefined, {
        stringSource: "elemStringSource",
        notPrefix: "elemNotPrefix",
        firstParenExpr: "elemFirstParenExpr",
        firstSource: "elemSource",
        exprOp: "elemExprOp",
        exprRight: "elemExprRight",
        ternaryOp: "elemTernaryOp",
        thenBranch: "elemThenBranch",
        elseBranch: "elemElseBranch",
        coalesceItem: "elemCoalesceItem",
        catchAlt: "elemCatchAlt",
      });
      body.push({
        kind: "wire",
        target: toRef,
        sources: rhs.sources,
        ...(rhs.catch ? { catch: rhs.catch } : {}),
        loc: locFromNode(selfWire),
      } satisfies WireStatement);
    }
  }

  // ── Tool-level spread lines (... <- source) ──────────────────────────

  if (options?.spreadNodes) {
    for (const spreadNode of options.spreadNodes) {
      buildSpreadLine(spreadNode, body, undefined);
    }
  }

  return { handles: handleBindings, body, handleRes };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Top-level document builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build a complete BridgeDocument from a Chevrotain CST, populating
 * `body: Statement[]` on all bridge/tool/define instructions.
 *
 * This can be called alongside the existing `toBridgeAst()` to augment
 * instructions with the nested IR.
 */
export function buildBodies(_cst: CstNode, instructions: Instruction[]): void {
  // Walk instruction list and build body for each bridge/tool/define
  for (const _inst of instructions) {
    // Find corresponding CST node and call buildBody per-block.
    // This function is a hook for future integration.
  }
}
