/**
 * Enumerate all possible traversal paths through a Bridge.
 *
 * Every bridge has a finite set of execution paths ("traversals"),
 * determined by the wire structure alone — independent of runtime values.
 *
 * Examples:
 *   `o <- i.a || i.b catch i.c`  →  3 traversals (primary, fallback, catch)
 *   `o <- i.arr[] as a { .data <- a.a ?? a.b }`  →  3 traversals
 *      (empty-array, primary for .data, nullish fallback for .data)
 *
 * The traversal manifest is a static analysis result. At runtime, the
 * execution engine produces a compact numeric `executionTraceId` (bitmask)
 * that records which traversal paths were actually taken. Use
 * {@link decodeExecutionTrace} to map the bitmask back to entries.
 */

import type {
  Bridge,
  WireSourceEntry,
  NodeRef,
  ControlFlowInstruction,
  SourceLocation,
  Expression,
  SourceChain,
  Statement,
} from "./types.ts";

// ── Public types ────────────────────────────────────────────────────────────

/**
 * A single traversal path through a bridge wire.
 */
export interface TraversalEntry {
  /** Stable identifier for this traversal path. */
  id: string;
  /** Index of the originating wire in `bridge.wires` (-1 for synthetic entries like empty-array). */
  wireIndex: number;
  /** Target path segments from the wire's `to` NodeRef. */
  target: string[];
  /** Classification of this traversal path. */
  kind:
    | "primary"
    | "fallback"
    | "catch"
    | "empty-array"
    | "then"
    | "else"
    | "const";
  /**
   * When `true`, this entry represents the error path for its source —
   * the source threw an exception that was not caught by the wire's own
   * `catch` handler.
   *
   * Error entries are only generated for sources that can throw (tool
   * calls without `?.` root-safe navigation).  When the wire already
   * carries a `catch` clause, individual source error entries are
   * omitted because the catch absorbs them.
   */
  error?: true;
  /** Fallback chain index (only when kind is `"fallback"`). */
  fallbackIndex?: number;
  /** Gate type (only when kind is `"fallback"`): `"falsy"` for `||`, `"nullish"` for `??`. */
  gateType?: "falsy" | "nullish";
  /** Bit position in the execution trace bitmask (0-based). */
  bitIndex: number;
  /** Source span for the specific traversal branch, when known. */
  loc?: SourceLocation;
  /** Source span covering the entire wire (full line), when known. */
  wireLoc?: SourceLocation;
  /**
   * Human-readable description of the source for this path.
   * Examples: `"api.username"`, `"|| \"Anonymous\""`, `"catch continue"`, `"= \"SBB\""`.
   */
  description?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pathKey(path: string[]): string {
  return path.length > 0 ? path.join(".") : "*";
}

/**
 * True when a NodeRef can throw at runtime — i.e. it targets a tool (or
 * pipe) call and is NOT root-safe (`?.`).
 *
 * Refs that always resolve from in-memory state (input, output, context,
 * alias, array element) cannot throw in a way that constitutes a distinct
 * traversal path.
 */
function canRefError(ref: NodeRef | undefined): boolean {
  if (!ref) return false;
  if (ref.rootSafe) return false;
  if (ref.element) return false;
  if (ref.elementDepth) return false;
  // Tool refs can throw (type "Tools", within the self module "_"),
  // but synthetic expression tools (instance >= 100000) are pure ops.
  if (ref.type === "Tools") return (ref.instance ?? 0) < 100000;
  // Pipe refs (external modules like "std.str") can throw
  if (ref.module !== "_" && ref.module !== "__local") return true;
  // Input / output / context — always in-memory, cannot throw
  return false;
}

// ── Description helpers ────────────────────────────────────────────────────

/** Map from ref type+field → handle alias for readable ref descriptions. */
function buildHandleMap(bridge: Bridge): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of bridge.handles) {
    if (h.kind === "tool" || h.kind === "define") {
      // Tool/define refs use type="Tools" and field=tool name.
      map.set(`Tools:${h.name}`, h.handle);
    } else if (h.kind === "input") {
      map.set("input", h.handle);
    } else if (h.kind === "context") {
      map.set("context", h.handle);
    }
  }
  return map;
}

function refLabel(ref: NodeRef, hmap: Map<string, string>): string {
  if (ref.element) {
    return ref.path.length > 0 ? ref.path.join(".") : "element";
  }
  // __local refs are alias variables — use the field name (alias name) directly.
  if (ref.module === "__local") {
    return ref.path.length > 0
      ? `${ref.field}.${ref.path.join(".")}`
      : ref.field;
  }
  let alias: string | undefined;
  if (ref.type === "Tools") {
    alias = hmap.get(`Tools:${ref.field}`);
  } else if (ref.module !== "_") {
    // Pipe handle — look up by module name.
    alias = hmap.get(`pipe:${ref.module}`);
  } else {
    alias = hmap.get("input") ?? hmap.get("context");
  }
  alias ??= ref.field;
  return ref.path.length > 0 ? `${alias}.${ref.path.join(".")}` : alias;
}

function controlLabel(ctrl: ControlFlowInstruction): string {
  const n =
    ctrl.kind === "continue" || ctrl.kind === "break"
      ? ctrl.levels != null && ctrl.levels > 1
        ? ` ${ctrl.levels}`
        : ""
      : "";
  if (ctrl.kind === "throw" || ctrl.kind === "panic") {
    return `${ctrl.kind} "${ctrl.message}"`;
  }
  return `${ctrl.kind}${n}`;
}

/** Generate a description string for a fallback source entry. */
function sourceEntryDescription(
  entry: WireSourceEntry,
  hmap: Map<string, string>,
): string {
  const gate = entry.gate === "falsy" ? "||" : "??";
  const expr = entry.expr;
  if (expr.type === "ref") return `${gate} ${refLabel(expr.ref, hmap)}`;
  if (expr.type === "literal") return `${gate} ${expr.value}`;
  if (expr.type === "control") return `${gate} ${controlLabel(expr.control)}`;
  return gate;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build the static traversal manifest for a bridge.
 *
 * Entries are sorted lexicographically by semantic ID before bit indices
 * are assigned, guaranteeing ABI stability across source-code reorderings.
 */
export function buildTraversalManifest(bridge: Bridge): TraversalEntry[] {
  return buildBodyTraversalMaps(bridge).manifest;
}

// ── Body-based traversal enumeration ────────────────────────────────────────

/** Collected traceable item from body walking. */
/** Collected traceable item from body walking. */
type BodyTraceItem = {
  chain: SourceChain;
  target: string[];
};

/** Collected empty-array item from body walking. */
type EmptyArrayItem = {
  expr: Expression;
  target: string[];
};

/**
 * Walk a Statement[] body tree and collect all traceable SourceChain
 * references with their effective target paths.
 */
function collectTraceableItems(
  statements: Statement[],
  pathPrefix: string[],
  items: BodyTraceItem[],
  emptyArrayItems: EmptyArrayItem[],
): void {
  for (const stmt of statements) {
    switch (stmt.kind) {
      case "wire": {
        const target =
          stmt.target.path.length === 0 && stmt.target.module === "__local"
            ? [stmt.target.field]
            : [...pathPrefix, ...stmt.target.path];

        // Plain array source wire — skip traversal entry for the wire,
        // add empty-array entry, and recurse into array body.
        const primary = stmt.sources[0]?.expr;
        if (
          primary?.type === "array" &&
          stmt.sources.length === 1 &&
          !stmt.catch
        ) {
          emptyArrayItems.push({ expr: primary, target: [...target] });
          collectTraceableItems(primary.body, target, items, emptyArrayItems);
        } else {
          items.push({ chain: stmt, target });
          // Check for array expressions in any source (e.g., with fallbacks)
          for (const source of stmt.sources) {
            collectArrayExprs(source.expr, target, items, emptyArrayItems);
          }
        }
        break;
      }
      case "alias":
        items.push({ chain: stmt, target: [stmt.name] });
        for (const source of stmt.sources) {
          collectArrayExprs(source.expr, [stmt.name], items, emptyArrayItems);
        }
        break;
      case "spread":
        items.push({
          chain: stmt,
          target: pathPrefix.length > 0 ? [...pathPrefix] : [],
        });
        break;
      case "scope":
        collectTraceableItems(
          stmt.body,
          [...pathPrefix, ...stmt.target.path],
          items,
          emptyArrayItems,
        );
        break;
      // "with" and "force" don't produce traversal entries
    }
  }
}

/** Recurse into expression tree to find nested ArrayExpressions. */
function collectArrayExprs(
  expr: Expression,
  target: string[],
  items: BodyTraceItem[],
  emptyArrayItems: EmptyArrayItem[],
): void {
  switch (expr.type) {
    case "array":
      emptyArrayItems.push({ expr, target: [...target] });
      collectTraceableItems(expr.body, target, items, emptyArrayItems);
      collectArrayExprs(expr.source, target, items, emptyArrayItems);
      break;
    case "ternary":
      collectArrayExprs(expr.cond, target, items, emptyArrayItems);
      collectArrayExprs(expr.then, target, items, emptyArrayItems);
      collectArrayExprs(expr.else, target, items, emptyArrayItems);
      break;
    case "and":
    case "or":
    case "binary":
      collectArrayExprs(expr.left, target, items, emptyArrayItems);
      collectArrayExprs(expr.right, target, items, emptyArrayItems);
      break;
    case "unary":
      collectArrayExprs(expr.operand, target, items, emptyArrayItems);
      break;
    case "pipe":
      collectArrayExprs(expr.source, target, items, emptyArrayItems);
      break;
    case "concat":
      for (const part of expr.parts) {
        collectArrayExprs(part, target, items, emptyArrayItems);
      }
      break;
    case "ref":
    case "literal":
    case "control":
      break; // Leaves: no nested arrays possible
  }
}

/**
 * Generate TraversalEntry items for a single SourceChain.
 * Mirrors the wire-based logic but works on the SourceChain interface.
 */
function generateChainEntries(
  chain: SourceChain,
  base: string,
  target: string[],
  hmap: Map<string, string>,
): TraversalEntry[] {
  const entries: TraversalEntry[] = [];
  const primary = chain.sources[0]?.expr;
  if (!primary) return entries;

  const chainLoc = (chain as { loc?: SourceLocation }).loc;

  // Constant wire — single literal source, no catch
  if (
    primary.type === "literal" &&
    chain.sources.length === 1 &&
    !chain.catch
  ) {
    entries.push({
      id: `${base}/const`,
      wireIndex: -1,
      target,
      kind: "const",
      bitIndex: -1,
      loc: chainLoc,
      wireLoc: chainLoc,
      description: `= ${primary.value}`,
    });
    return entries;
  }

  // Pull wire (ref primary)
  if (primary.type === "ref") {
    entries.push({
      id: `${base}/primary`,
      wireIndex: -1,
      target,
      kind: "primary",
      bitIndex: -1,
      loc: primary.refLoc ?? primary.loc ?? chainLoc,
      wireLoc: chainLoc,
      description: refLabel(primary.ref, hmap),
    });
    addChainFallbacks(entries, base, target, chain, hmap);
    addChainCatch(entries, base, target, chain, hmap);
    addChainErrors(entries, base, target, chain, hmap, primary, !!primary.safe);
    return entries;
  }

  // Conditional (ternary)
  if (primary.type === "ternary") {
    const thenExpr = primary.then;
    const elseExpr = primary.else;
    const thenDesc =
      thenExpr.type === "ref"
        ? `? ${refLabel(thenExpr.ref, hmap)}`
        : thenExpr.type === "literal"
          ? `? ${thenExpr.value}`
          : "then";
    const elseDesc =
      elseExpr.type === "ref"
        ? `: ${refLabel(elseExpr.ref, hmap)}`
        : elseExpr.type === "literal"
          ? `: ${elseExpr.value}`
          : "else";
    entries.push({
      id: `${base}/then`,
      wireIndex: -1,
      target,
      kind: "then",
      bitIndex: -1,
      loc: primary.thenLoc ?? thenExpr.loc ?? chainLoc,
      wireLoc: chainLoc,
      description: thenDesc,
    });
    entries.push({
      id: `${base}/else`,
      wireIndex: -1,
      target,
      kind: "else",
      bitIndex: -1,
      loc: primary.elseLoc ?? elseExpr.loc ?? chainLoc,
      wireLoc: chainLoc,
      description: elseDesc,
    });
    addChainFallbacks(entries, base, target, chain, hmap);
    addChainCatch(entries, base, target, chain, hmap);
    addChainErrors(
      entries,
      base,
      target,
      chain,
      hmap,
      thenExpr,
      false,
      elseExpr,
    );
    return entries;
  }

  // Logical AND/OR
  if (primary.type === "and" || primary.type === "or") {
    const leftRef = primary.left.type === "ref" ? primary.left.ref : undefined;
    const rightExpr = primary.right;
    const op = primary.type === "and" ? "&&" : "||";
    const leftLabel = leftRef ? refLabel(leftRef, hmap) : "?";
    const rightLabel =
      rightExpr.type === "ref"
        ? refLabel(rightExpr.ref, hmap)
        : rightExpr.type === "literal" && rightExpr.value !== "true"
          ? rightExpr.value
          : undefined;
    const desc = rightLabel ? `${leftLabel} ${op} ${rightLabel}` : leftLabel;
    entries.push({
      id: `${base}/primary`,
      wireIndex: -1,
      target,
      kind: "primary",
      bitIndex: -1,
      loc: chainLoc,
      wireLoc: chainLoc,
      description: desc,
    });
    addChainFallbacks(entries, base, target, chain, hmap);
    addChainCatch(entries, base, target, chain, hmap);
    addChainErrors(
      entries,
      base,
      target,
      chain,
      hmap,
      primary.left,
      !!primary.leftSafe,
    );
    return entries;
  }

  // Other expression types (control, pipe, binary, etc.)
  entries.push({
    id: `${base}/primary`,
    wireIndex: -1,
    target,
    kind: "primary",
    bitIndex: -1,
    loc: chainLoc,
    wireLoc: chainLoc,
  });
  addChainFallbacks(entries, base, target, chain, hmap);
  addChainCatch(entries, base, target, chain, hmap);
  addChainErrors(entries, base, target, chain, hmap, primary, false);
  return entries;
}

function chainCatchDesc(chain: SourceChain, hmap: Map<string, string>): string {
  if (!chain.catch) return "catch";
  if ("value" in chain.catch)
    return `catch ${typeof chain.catch.value === "string" ? chain.catch.value : JSON.stringify(chain.catch.value)}`;
  if ("ref" in chain.catch) return `catch ${refLabel(chain.catch.ref, hmap)}`;
  if ("control" in chain.catch)
    return `catch ${controlLabel(chain.catch.control)}`;
  return "catch";
}

function addChainFallbacks(
  entries: TraversalEntry[],
  base: string,
  target: string[],
  chain: SourceChain,
  hmap: Map<string, string>,
): void {
  const chainLoc = (chain as { loc?: SourceLocation }).loc;
  for (let i = 1; i < chain.sources.length; i++) {
    const entry = chain.sources[i]!;
    entries.push({
      id: `${base}/fallback:${i - 1}`,
      wireIndex: -1,
      target,
      kind: "fallback",
      fallbackIndex: i - 1,
      gateType: entry.gate,
      bitIndex: -1,
      loc: entry.loc,
      wireLoc: chainLoc,
      description: sourceEntryDescription(entry, hmap),
    });
  }
}

function addChainCatch(
  entries: TraversalEntry[],
  base: string,
  target: string[],
  chain: SourceChain,
  hmap: Map<string, string>,
): void {
  if (!chain.catch) return;
  const chainLoc = (chain as { loc?: SourceLocation }).loc;
  entries.push({
    id: `${base}/catch`,
    wireIndex: -1,
    target,
    kind: "catch",
    bitIndex: -1,
    loc: chain.catch.loc,
    wireLoc: chainLoc,
    description: chainCatchDesc(chain, hmap),
  });
}

/**
 * True when an expression can throw at runtime (e.g., pipes or unsafe refs).
 */
function canExprThrow(expr: Expression | undefined): boolean {
  if (!expr) return false;
  switch (expr.type) {
    case "ref":
      if (expr.safe || expr.ref.element) return false;
      return canRefError(expr.ref);
    case "pipe":
      return true; // Pipes execute tools, which can throw
    case "ternary":
      return (
        canExprThrow(expr.cond) ||
        canExprThrow(expr.then) ||
        canExprThrow(expr.else)
      );
    case "and":
    case "or":
    case "binary":
      return canExprThrow(expr.left) || canExprThrow(expr.right);
    case "unary":
      return canExprThrow(expr.operand);
    case "concat":
      return expr.parts.some(canExprThrow);
    case "array":
      return canExprThrow(expr.source);
    case "literal":
    case "control":
      return false;
  }
}

function addChainErrors(
  entries: TraversalEntry[],
  base: string,
  target: string[],
  chain: SourceChain,
  hmap: Map<string, string>,
  primaryExpr: Expression | undefined,
  wireSafe: boolean,
  elseExpr?: Expression | undefined,
): void {
  const chainLoc = (chain as { loc?: SourceLocation }).loc;

  if (chain.catch) {
    const catchCanThrow =
      "ref" in chain.catch
        ? canRefError(chain.catch.ref)
        : "expr" in chain.catch
          ? canExprThrow(chain.catch.expr)
          : false;
    if (catchCanThrow) {
      entries.push({
        id: `${base}/catch/error`,
        wireIndex: -1,
        target,
        kind: "catch",
        error: true,
        bitIndex: -1,
        loc: chain.catch.loc,
        wireLoc: chainLoc,
        description: `${chainCatchDesc(chain, hmap)} error`,
      });
    }
    return;
  }

  if (!wireSafe && canExprThrow(primaryExpr)) {
    const desc =
      primaryExpr?.type === "ref" ? refLabel(primaryExpr.ref, hmap) : undefined;
    const pLoc =
      primaryExpr?.type === "ref"
        ? (primaryExpr.refLoc ?? primaryExpr.loc ?? chainLoc)
        : (primaryExpr?.loc ?? chainLoc);
    entries.push({
      id: `${base}/primary/error`,
      wireIndex: -1,
      target,
      kind: "primary",
      error: true,
      bitIndex: -1,
      loc: pLoc,
      wireLoc: chainLoc,
      description: desc ? `${desc} error` : "error",
    });
  }

  if (canExprThrow(elseExpr)) {
    const elseLoc = elseExpr!.loc ?? chainLoc;
    entries.push({
      id: `${base}/else/error`,
      wireIndex: -1,
      target,
      kind: "else",
      error: true,
      bitIndex: -1,
      loc: elseLoc,
      wireLoc: chainLoc,
      description:
        elseExpr!.type === "ref"
          ? `${refLabel(elseExpr!.ref, hmap)} error`
          : "else error",
    });
  }

  for (let i = 1; i < chain.sources.length; i++) {
    const entry = chain.sources[i]!;
    if (canExprThrow(entry.expr)) {
      entries.push({
        id: `${base}/fallback:${i - 1}/error`,
        wireIndex: -1,
        target,
        kind: "fallback",
        error: true,
        fallbackIndex: i - 1,
        gateType: entry.gate,
        bitIndex: -1,
        loc: entry.loc,
        wireLoc: chainLoc,
        description: `${sourceEntryDescription(entry, hmap)} error`,
      });
    }
  }
}

/**
 * Build traversal manifest and runtime trace maps from a Bridge's Statement[] body.
 *
 * Entries are sorted lexicographically by semantic ID before bit indices
 * are assigned. This guarantees the bitmask encoding is stable across
 * source-code reorderings (ABI stability).
 *
 * Returns:
 * - `manifest` — the ordered TraversalEntry[] (for decoding, coverage checks)
 * - `chainBitsMap` — Map<WireSourceEntry[], TraceWireBits> for O(1) runtime lookups
 *   (keyed by the `sources` array reference, shared between original and scope-prefixed copies)
 * - `emptyArrayBits` — Map<Expression, number> keyed by ArrayExpression reference for
 *   O(1) runtime lookups in evaluateArrayExpr
 */
export function buildBodyTraversalMaps(bridge: Bridge): {
  manifest: TraversalEntry[];
  chainBitsMap: Map<WireSourceEntry[], TraceWireBits>;
  emptyArrayBits: Map<Expression, number>;
} {
  // 1. Collect all traceable chains from body
  const items: BodyTraceItem[] = [];
  const emptyArrayItems: EmptyArrayItem[] = [];
  collectTraceableItems(bridge.body, [], items, emptyArrayItems);

  // 2. Generate traversal entries for each chain
  const hmap = buildHandleMap(bridge);
  const targetCounts = new Map<string, number>();
  const allEntries: { entry: TraversalEntry; chain: SourceChain }[] = [];

  for (const { chain, target } of items) {
    const tKey = pathKey(target);
    const seen = targetCounts.get(tKey) ?? 0;
    targetCounts.set(tKey, seen + 1);
    const base = seen > 0 ? `${tKey}#${seen}` : tKey;

    for (const entry of generateChainEntries(chain, base, target, hmap)) {
      allEntries.push({ entry, chain });
    }
  }

  // 3. Add empty-array entries
  const emptyArrayEntries: { entry: TraversalEntry; expr: Expression }[] = [];
  let emptyIdx = 0;
  for (const { expr, target } of emptyArrayItems) {
    const label = target.join(".") || "(root)";
    const entry: TraversalEntry = {
      id: `${label}/empty-array`,
      wireIndex: -++emptyIdx,
      target,
      kind: "empty-array",
      bitIndex: -1,
      description: `[] empty`,
    };
    allEntries.push({ entry, chain: { sources: [] } });
    emptyArrayEntries.push({ entry, expr });
  }

  // 4. Sort by ID for ABI stability
  allEntries.sort((a, b) => a.entry.id.localeCompare(b.entry.id));

  // 5. Assign sequential bitIndex
  for (let i = 0; i < allEntries.length; i++) {
    allEntries[i]!.entry.bitIndex = i;
  }

  // 6. Build chain → bits map (keyed by sources array reference)
  const chainBitsMap = new Map<WireSourceEntry[], TraceWireBits>();
  for (const { entry, chain } of allEntries) {
    if (entry.kind === "empty-array") continue;
    if (!chain.sources.length) continue;

    let bits = chainBitsMap.get(chain.sources);
    if (!bits) {
      bits = {};
      chainBitsMap.set(chain.sources, bits);
    }

    switch (entry.kind) {
      case "primary":
      case "then":
      case "const":
        if (entry.error) bits.primaryError = entry.bitIndex;
        else bits.primary = entry.bitIndex;
        break;
      case "else":
        if (entry.error) bits.elseError = entry.bitIndex;
        else bits.else = entry.bitIndex;
        break;
      case "fallback":
        if (entry.error) {
          if (!bits.fallbackErrors) bits.fallbackErrors = [];
          bits.fallbackErrors[entry.fallbackIndex ?? 0] = entry.bitIndex;
        } else {
          if (!bits.fallbacks) bits.fallbacks = [];
          bits.fallbacks[entry.fallbackIndex ?? 0] = entry.bitIndex;
        }
        break;
      case "catch":
        if (entry.error) bits.catchError = entry.bitIndex;
        else bits.catch = entry.bitIndex;
        break;
    }
  }

  // 7. Build empty-array bits map (keyed by ArrayExpression reference)
  const emptyArrayBits = new Map<Expression, number>();
  for (const { entry, expr } of emptyArrayEntries) {
    emptyArrayBits.set(expr, entry.bitIndex);
  }

  return {
    manifest: allEntries.map((e) => e.entry),
    chainBitsMap,
    emptyArrayBits,
  };
}

/**
 * Decode a runtime execution trace bitmask against a traversal manifest.
 *
 * Returns the subset of {@link TraversalEntry} objects whose bits are set
 * in the trace — i.e. the paths that were actually taken during execution.
 *
 * @param manifest  The static manifest from {@link buildTraversalManifest}.
 * @param trace     The bigint bitmask produced by the execution engine.
 */
export function decodeExecutionTrace(
  manifest: TraversalEntry[],
  trace: bigint,
): TraversalEntry[] {
  const result: TraversalEntry[] = [];
  for (const entry of manifest) {
    // Check if the bit at position `entry.bitIndex` is set in the trace,
    // indicating this path was taken during execution.
    if (trace & (1n << BigInt(entry.bitIndex))) {
      result.push(entry);
    }
  }
  return result;
}

// ── Runtime trace helpers ───────────────────────────────────────────────────

/**
 * Per-wire bit positions used by the execution engine to record which
 * traversal paths were taken.  Built once per bridge from the manifest.
 */
export interface TraceWireBits {
  /** Bit index for the primary / then / const path. */
  primary?: number;
  /** Bit index for the else branch (conditional wires only). */
  else?: number;
  /** Bit indices for each fallback gate (same order as `fallbacks` array). */
  fallbacks?: number[];
  /** Bit index for the catch path. */
  catch?: number;
  /** Bit index for the primary / then source error path. */
  primaryError?: number;
  /** Bit index for the else source error path (conditional wires only). */
  elseError?: number;
  /** Bit indices for each fallback source error path. */
  fallbackErrors?: number[];
  /** Bit index for the catch source error path. */
  catchError?: number;
}

/**
 * Build a lookup map from array-iterator path keys to their "empty-array"
 * trace bit positions.
 */
export function buildEmptyArrayBitsMap(
  manifest: TraversalEntry[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of manifest) {
    if (entry.kind !== "empty-array") continue;
    map.set(entry.target.join("."), entry.bitIndex);
  }
  return map;
}
