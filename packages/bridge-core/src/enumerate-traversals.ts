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
 * execution engine produces a compact numeric `executionTrace` (bitmask)
 * that records which traversal paths were actually taken. Use
 * {@link decodeExecutionTrace} to map the bitmask back to entries.
 */

import type { Bridge, Wire, WireFallback, NodeRef, ControlFlowInstruction } from "./types.ts";

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
  /** Fallback chain index (only when kind is `"fallback"`). */
  fallbackIndex?: number;
  /** Gate type (only when kind is `"fallback"`): `"falsy"` for `||`, `"nullish"` for `??`. */
  gateType?: "falsy" | "nullish";
  /** Bit position in the execution trace bitmask (0-based). */
  bitIndex: number;
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

function hasCatch(w: Wire): boolean {
  if ("value" in w) return false;
  return (
    w.catchFallback != null ||
    w.catchFallbackRef != null ||
    w.catchControl != null
  );
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
  if (!("from" in w)) return false;
  if (w.from.element) return false;
  const targetPath = w.to.path.join(".");
  if (!(targetPath in arrayIterators)) return false;
  return !w.fallbacks?.length && !hasCatch(w);
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
    return ref.path.length > 0 ? `${ref.field}.${ref.path.join(".")}` : ref.field;
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
  const n = ctrl.kind === "continue" || ctrl.kind === "break"
    ? (ctrl.levels != null && ctrl.levels > 1 ? ` ${ctrl.levels}` : "")
    : "";
  if (ctrl.kind === "throw" || ctrl.kind === "panic") {
    return `${ctrl.kind} "${ctrl.message}"`;
  }
  return `${ctrl.kind}${n}`;
}

function fallbackDescription(fb: WireFallback, hmap: Map<string, string>): string {
  const gate = fb.type === "falsy" ? "||" : "??";
  if (fb.value != null) return `${gate} ${fb.value}`;
  if (fb.ref) return `${gate} ${refLabel(fb.ref, hmap)}`;
  if (fb.control) return `${gate} ${controlLabel(fb.control)}`;
  return gate;
}

function catchDescription(w: Wire, hmap: Map<string, string>): string {
  if ("value" in w) return "catch";
  if (w.catchFallback != null) return `catch ${w.catchFallback}`;
  if (w.catchFallbackRef) return `catch ${refLabel(w.catchFallbackRef, hmap)}`;
  if (w.catchControl) return `catch ${controlLabel(w.catchControl)}`;
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

function addFallbackEntries(
  entries: TraversalEntry[],
  base: string,
  wireIndex: number,
  target: string[],
  fallbacks: WireFallback[] | undefined,
  hmap: Map<string, string>,
): void {
  if (!fallbacks) return;
  for (let i = 0; i < fallbacks.length; i++) {
    entries.push({
      id: `${base}/fallback:${i}`,
      wireIndex,
      target,
      kind: "fallback",
      fallbackIndex: i,
      gateType: fallbacks[i].type,
      bitIndex: -1, // assigned after enumeration
      description: fallbackDescription(fallbacks[i], hmap),
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
  if (hasCatch(w)) {
    entries.push({
      id: `${base}/catch`,
      wireIndex,
      target,
      kind: "catch",
      bitIndex: -1,
      description: catchDescription(w, hmap),
    });
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

    // ── Constant wire ───────────────────────────────────────────────
    if ("value" in w) {
      entries.push({
        id: `${base}/const`,
        wireIndex: i,
        target,
        kind: "const",
        bitIndex: -1,
        description: `= ${w.value}`,
      });
      continue;
    }

    // ── Pull wire ───────────────────────────────────────────────────
    if ("from" in w) {
      // Skip plain array source wires — they always execute and the
      // separate "empty-array" entry covers the "no elements" path.
      if (!isPlainArraySourceWire(w, bridge.arrayIterators)) {
        entries.push({
          id: `${base}/primary`,
          wireIndex: i,
          target,
          kind: "primary",
          bitIndex: -1,
          description: refLabel(w.from, hmap),
        });
        addFallbackEntries(entries, base, i, target, w.fallbacks, hmap);
        addCatchEntry(entries, base, i, target, w, hmap);
      }
      continue;
    }

    // ── Conditional (ternary) wire ──────────────────────────────────
    if ("cond" in w) {
      const thenDesc = w.thenRef ? `? ${refLabel(w.thenRef, hmap)}` : w.thenValue != null ? `? ${w.thenValue}` : "then";
      const elseDesc = w.elseRef ? `: ${refLabel(w.elseRef, hmap)}` : w.elseValue != null ? `: ${w.elseValue}` : "else";
      entries.push({ id: `${base}/then`, wireIndex: i, target, kind: "then", bitIndex: -1, description: thenDesc });
      entries.push({ id: `${base}/else`, wireIndex: i, target, kind: "else", bitIndex: -1, description: elseDesc });
      addFallbackEntries(entries, base, i, target, w.fallbacks, hmap);
      addCatchEntry(entries, base, i, target, w, hmap);
      continue;
    }

    // ── condAnd / condOr (logical binary) ───────────────────────────
    if ("condAnd" in w) {
      const desc = w.condAnd.rightRef
        ? `${refLabel(w.condAnd.leftRef, hmap)} && ${refLabel(w.condAnd.rightRef, hmap)}`
        : w.condAnd.rightValue != null
          ? `${refLabel(w.condAnd.leftRef, hmap)} && ${w.condAnd.rightValue}`
          : refLabel(w.condAnd.leftRef, hmap);
      entries.push({ id: `${base}/primary`, wireIndex: i, target, kind: "primary", bitIndex: -1, description: desc });
      addFallbackEntries(entries, base, i, target, w.fallbacks, hmap);
      addCatchEntry(entries, base, i, target, w, hmap);
    } else {
      // condOr
      const wo = w as Extract<Wire, { condOr: unknown }>;
      const desc = wo.condOr.rightRef
        ? `${refLabel(wo.condOr.leftRef, hmap)} || ${refLabel(wo.condOr.rightRef, hmap)}`
        : wo.condOr.rightValue != null
          ? `${refLabel(wo.condOr.leftRef, hmap)} || ${wo.condOr.rightValue}`
          : refLabel(wo.condOr.leftRef, hmap);
      entries.push({ id: `${base}/primary`, wireIndex: i, target, kind: "primary", bitIndex: -1, description: desc });
      addFallbackEntries(entries, base, i, target, wo.fallbacks, hmap);
      addCatchEntry(entries, base, i, target, w, hmap);
    }
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
        wireIndex: -(++emptyIdx),
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
    if (entry.wireIndex < 0) continue; // synthetic entries (empty-array)
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
        bits.primary = entry.bitIndex;
        break;
      case "else":
        bits.else = entry.bitIndex;
        break;
      case "fallback":
        if (!bits.fallbacks) bits.fallbacks = [];
        bits.fallbacks[entry.fallbackIndex ?? 0] = entry.bitIndex;
        break;
      case "catch":
        bits.catch = entry.bitIndex;
        break;
    }
  }
  return map;
}
