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
  Wire,
  WireSourceEntry,
  NodeRef,
  ControlFlowInstruction,
  SourceLocation,
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

/**
 * True when the wire is an array-source wire that simply feeds an array
 * iteration scope without any fallback/catch choices of its own.
 *
 * Such wires always execute (to fetch the array), so they are not a
 * traversal "choice".  The separate `empty-array` entry already covers
 * the "no elements" outcome.
 */
function isPlainArraySourceWire(
  w: Wire,
  arrayIterators: Record<string, string> | undefined,
): boolean {
  if (!arrayIterators) return false;
  if (w.sources.length !== 1 || w.catch) return false;
  const primary = w.sources[0]!.expr;
  if (primary.type !== "ref" || primary.ref.element) return false;
  const targetPath = w.to.path.join(".");
  if (!(targetPath in arrayIterators)) return false;
  return true;
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
  // Pipe handles use a non-"_" module (e.g., "std.str") with type="Query".
  if (bridge.pipeHandles) {
    for (const ph of bridge.pipeHandles) {
      map.set(`pipe:${ph.baseTrunk.module}`, ph.handle);
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

function catchDescription(w: Wire, hmap: Map<string, string>): string {
  if (!w.catch) return "catch";
  if ("value" in w.catch) return `catch ${w.catch.value}`;
  if ("ref" in w.catch) return `catch ${refLabel(w.catch.ref, hmap)}`;
  if ("control" in w.catch) return `catch ${controlLabel(w.catch.control)}`;
  return "catch";
}

/**
 * Compute the effective target path for a wire.
 * For `__local` module wires (aliases), use `to.field` as the target
 * since `to.path` is always empty for alias wires.
 */
function effectiveTarget(w: Wire): string[] {
  if (w.to.path.length === 0 && w.to.module === "__local") {
    return [w.to.field];
  }
  return w.to.path;
}

/** Source location of the primary expression. */
function primaryLoc(w: Wire): SourceLocation | undefined {
  const primary = w.sources[0];
  if (!primary) return w.loc;
  const expr = primary.expr;
  if (expr.type === "ref") return expr.refLoc ?? w.loc;
  return w.loc;
}

function addFallbackEntries(
  entries: TraversalEntry[],
  base: string,
  wireIndex: number,
  target: string[],
  w: Wire,
  hmap: Map<string, string>,
): void {
  for (let i = 1; i < w.sources.length; i++) {
    const entry = w.sources[i]!;
    entries.push({
      id: `${base}/fallback:${i - 1}`,
      wireIndex,
      target,
      kind: "fallback",
      fallbackIndex: i - 1,
      gateType: entry.gate,
      bitIndex: -1,
      loc: entry.loc,
      wireLoc: w.loc,
      description: sourceEntryDescription(entry, hmap),
    });
  }
}

function addCatchEntry(
  entries: TraversalEntry[],
  base: string,
  wireIndex: number,
  target: string[],
  w: Wire,
  hmap: Map<string, string>,
): void {
  if (w.catch) {
    entries.push({
      id: `${base}/catch`,
      wireIndex,
      target,
      kind: "catch",
      bitIndex: -1,
      loc: w.catch.loc,
      wireLoc: w.loc,
      description: catchDescription(w, hmap),
    });
  }
}

/**
 * Add error-path entries for wire sources that can throw.
 *
 * Rules:
 * - When the wire has a `catch`, individual source error entries are
 *   omitted because the catch absorbs all errors.  Only a `catch/error`
 *   entry is added if the catch source itself can throw.
 * - When the wire does NOT have a `catch`, each source ref that
 *   {@link canRefError} adds an error variant.
 * - The wire-level `safe` flag suppresses primary-source error entries
 *   (errors are caught → undefined).
 */
function addErrorEntries(
  entries: TraversalEntry[],
  base: string,
  wireIndex: number,
  target: string[],
  w: Wire,
  hmap: Map<string, string>,
  primaryRef: NodeRef | undefined,
  wireSafe: boolean,
  elseRef?: NodeRef | undefined,
): void {
  if (w.catch) {
    // Catch absorbs source errors — only check if the catch source itself
    // can throw.
    if ("ref" in w.catch && canRefError(w.catch.ref)) {
      entries.push({
        id: `${base}/catch/error`,
        wireIndex,
        target,
        kind: "catch",
        error: true,
        bitIndex: -1,
        loc: w.catch.loc,
        wireLoc: w.loc,
        description: `${catchDescription(w, hmap)} error`,
      });
    }
    return;
  }

  // No catch — add per-source error entries.

  // Primary / then source
  if (!wireSafe && canRefError(primaryRef)) {
    const desc = primaryRef ? refLabel(primaryRef, hmap) : undefined;
    entries.push({
      id: `${base}/primary/error`,
      wireIndex,
      target,
      kind: "primary",
      error: true,
      bitIndex: -1,
      loc: primaryLoc(w),
      wireLoc: w.loc,
      description: desc ? `${desc} error` : "error",
    });
  }

  // Else source (conditionals only)
  if (elseRef && canRefError(elseRef)) {
    const primary = w.sources[0]?.expr;
    const elseLoc =
      primary?.type === "ternary" ? (primary.elseLoc ?? w.loc) : w.loc;
    entries.push({
      id: `${base}/else/error`,
      wireIndex,
      target,
      kind: "else",
      error: true,
      bitIndex: -1,
      loc: elseLoc,
      wireLoc: w.loc,
      description: `${refLabel(elseRef, hmap)} error`,
    });
  }

  // Fallback sources
  for (let i = 1; i < w.sources.length; i++) {
    const entry = w.sources[i]!;
    const fbRef = entry.expr.type === "ref" ? entry.expr.ref : undefined;
    if (canRefError(fbRef)) {
      entries.push({
        id: `${base}/fallback:${i - 1}/error`,
        wireIndex,
        target,
        kind: "fallback",
        error: true,
        fallbackIndex: i - 1,
        gateType: entry.gate,
        bitIndex: -1,
        loc: entry.loc,
        wireLoc: w.loc,
        description: `${sourceEntryDescription(entry, hmap)} error`,
      });
    }
  }
}

// ── Main function ───────────────────────────────────────────────────────────

/**
 * Enumerate every possible traversal path through a bridge.
 *
 * Returns a flat list of {@link TraversalEntry} objects, one per
 * unique code-path through the bridge's wires.  The total length
 * of the returned array is a useful proxy for bridge complexity.
 *
 * `bitIndex` is initially set to `-1` during construction and
 * assigned sequentially (0, 1, 2, …) at the end.  No entry is
 * exposed with `bitIndex === -1`.
 */
export function enumerateTraversalIds(bridge: Bridge): TraversalEntry[] {
  const entries: TraversalEntry[] = [];
  const hmap = buildHandleMap(bridge);

  // Track per-target occurrence counts for disambiguation when
  // multiple wires write to the same target (overdefinition).
  const targetCounts = new Map<string, number>();

  for (let i = 0; i < bridge.wires.length; i++) {
    const w = bridge.wires[i];
    const target = effectiveTarget(w);
    const tKey = pathKey(target);

    // Disambiguate overdefined targets (same target written by >1 wire).
    const seen = targetCounts.get(tKey) ?? 0;
    targetCounts.set(tKey, seen + 1);
    const base = seen > 0 ? `${tKey}#${seen}` : tKey;

    // ── Classify by primary expression type ────────────────────────
    const primary = w.sources[0]?.expr;
    if (!primary) continue;

    // ── Constant wire ───────────────────────────────────────────────
    if (primary.type === "literal" && w.sources.length === 1 && !w.catch) {
      entries.push({
        id: `${base}/const`,
        wireIndex: i,
        target,
        kind: "const",
        bitIndex: -1,
        loc: w.loc,
        wireLoc: w.loc,
        description: `= ${primary.value}`,
      });
      continue;
    }

    // ── Pull wire (ref primary) ─────────────────────────────────────
    if (primary.type === "ref") {
      // Skip plain array source wires — they always execute and the
      // separate "empty-array" entry covers the "no elements" path.
      if (!isPlainArraySourceWire(w, bridge.arrayIterators)) {
        entries.push({
          id: `${base}/primary`,
          wireIndex: i,
          target,
          kind: "primary",
          bitIndex: -1,
          loc: primaryLoc(w),
          wireLoc: w.loc,
          description: refLabel(primary.ref, hmap),
        });
        addFallbackEntries(entries, base, i, target, w, hmap);
        addCatchEntry(entries, base, i, target, w, hmap);
        addErrorEntries(
          entries,
          base,
          i,
          target,
          w,
          hmap,
          primary.ref,
          !!primary.safe,
        );
      }
      continue;
    }

    // ── Conditional (ternary) wire ──────────────────────────────────
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
        wireIndex: i,
        target,
        kind: "then",
        bitIndex: -1,
        loc: primary.thenLoc ?? w.loc,
        wireLoc: w.loc,
        description: thenDesc,
      });
      entries.push({
        id: `${base}/else`,
        wireIndex: i,
        target,
        kind: "else",
        bitIndex: -1,
        loc: primary.elseLoc ?? w.loc,
        wireLoc: w.loc,
        description: elseDesc,
      });
      addFallbackEntries(entries, base, i, target, w, hmap);
      addCatchEntry(entries, base, i, target, w, hmap);
      const thenRef = thenExpr.type === "ref" ? thenExpr.ref : undefined;
      const elseRef = elseExpr.type === "ref" ? elseExpr.ref : undefined;
      addErrorEntries(
        entries,
        base,
        i,
        target,
        w,
        hmap,
        thenRef,
        false,
        elseRef,
      );
      continue;
    }

    // ── condAnd / condOr (logical binary) ───────────────────────────
    if (primary.type === "and" || primary.type === "or") {
      const leftRef =
        primary.left.type === "ref" ? primary.left.ref : undefined;
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
        wireIndex: i,
        target,
        kind: "primary",
        bitIndex: -1,
        loc: primaryLoc(w),
        wireLoc: w.loc,
        description: desc,
      });
      addFallbackEntries(entries, base, i, target, w, hmap);
      addCatchEntry(entries, base, i, target, w, hmap);
      addErrorEntries(
        entries,
        base,
        i,
        target,
        w,
        hmap,
        leftRef,
        !!primary.leftSafe,
      );
      continue;
    }

    // ── Other expression types (control, literal with catch/fallbacks) ──
    entries.push({
      id: `${base}/primary`,
      wireIndex: i,
      target,
      kind: "primary",
      bitIndex: -1,
      loc: w.loc,
      wireLoc: w.loc,
    });
    addFallbackEntries(entries, base, i, target, w, hmap);
    addCatchEntry(entries, base, i, target, w, hmap);
  }

  // ── Array iterators — each scope adds an "empty-array" path ─────
  if (bridge.arrayIterators) {
    let emptyIdx = 0;
    for (const key of Object.keys(bridge.arrayIterators)) {
      const iterName = bridge.arrayIterators[key];
      const target = key ? key.split(".") : [];
      const label = key || "(root)";
      const id = `${label}/empty-array`;
      entries.push({
        id,
        // Use unique negative wireIndex per empty-array so they don't group together.
        wireIndex: -++emptyIdx,
        target,
        kind: "empty-array",
        bitIndex: -1,
        description: `${iterName}[] empty`,
      });
    }
  }

  // Assign sequential bit indices
  for (let i = 0; i < entries.length; i++) {
    entries[i].bitIndex = i;
  }

  return entries;
}

// ── New public API ──────────────────────────────────────────────────────────

/**
 * Build the static traversal manifest for a bridge.
 *
 * Alias for {@link enumerateTraversalIds} with the recommended naming.
 * Returns the ordered array of {@link TraversalEntry} objects. Each entry
 * carries a `bitIndex` that maps it to a bit position in the runtime
 * execution trace bitmask.
 */
export const buildTraversalManifest = enumerateTraversalIds;

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
 * Build a lookup map from Wire objects to their trace bit positions.
 *
 * This is called once per bridge at setup time.  The returned map is
 * used by `resolveWires` to flip bits in the shared trace mask with
 * minimal overhead (one Map.get + one bitwise OR per decision).
 */
export function buildTraceBitsMap(
  bridge: Bridge,
  manifest: TraversalEntry[],
): Map<Wire, TraceWireBits> {
  const map = new Map<Wire, TraceWireBits>();
  for (const entry of manifest) {
    if (entry.kind === "empty-array") continue; // handled by buildEmptyArrayBitsMap
    if (entry.wireIndex < 0) continue;
    const wire = bridge.wires[entry.wireIndex];
    if (!wire) continue;

    let bits = map.get(wire);
    if (!bits) {
      bits = {};
      map.set(wire, bits);
    }

    switch (entry.kind) {
      case "primary":
      case "then":
      case "const":
        if (entry.error) {
          bits.primaryError = entry.bitIndex;
        } else {
          bits.primary = entry.bitIndex;
        }
        break;
      case "else":
        if (entry.error) {
          bits.elseError = entry.bitIndex;
        } else {
          bits.else = entry.bitIndex;
        }
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
        if (entry.error) {
          bits.catchError = entry.bitIndex;
        } else {
          bits.catch = entry.bitIndex;
        }
        break;
    }
  }
  return map;
}

/**
 * Build a lookup map from array-iterator path keys to their "empty-array"
 * trace bit positions.
 *
 * Path keys match `Object.keys(bridge.arrayIterators)` — `""` for a root
 * array, `"entries"` for `o.entries <- src[] as x { ... }`, etc.
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
