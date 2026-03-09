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

import type { Bridge, Wire, WireFallback } from "./types.ts";

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

function addFallbackEntries(
  entries: TraversalEntry[],
  base: string,
  wireIndex: number,
  target: string[],
  fallbacks: WireFallback[] | undefined,
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
    });
  }
}

function addCatchEntry(
  entries: TraversalEntry[],
  base: string,
  wireIndex: number,
  target: string[],
  w: Wire,
): void {
  if (hasCatch(w)) {
    entries.push({ id: `${base}/catch`, wireIndex, target, kind: "catch", bitIndex: -1 });
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

  // Track per-target occurrence counts for disambiguation when
  // multiple wires write to the same target (overdefinition).
  const targetCounts = new Map<string, number>();

  for (let i = 0; i < bridge.wires.length; i++) {
    const w = bridge.wires[i];
    const target = w.to.path;
    const tKey = pathKey(target);

    // Disambiguate overdefined targets (same target written by >1 wire).
    const seen = targetCounts.get(tKey) ?? 0;
    targetCounts.set(tKey, seen + 1);
    const base = seen > 0 ? `${tKey}#${seen}` : tKey;

    // ── Constant wire ───────────────────────────────────────────────
    if ("value" in w) {
      entries.push({ id: `${base}/const`, wireIndex: i, target, kind: "const", bitIndex: -1 });
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
        });
        addFallbackEntries(entries, base, i, target, w.fallbacks);
        addCatchEntry(entries, base, i, target, w);
      }
      continue;
    }

    // ── Conditional (ternary) wire ──────────────────────────────────
    if ("cond" in w) {
      entries.push({ id: `${base}/then`, wireIndex: i, target, kind: "then", bitIndex: -1 });
      entries.push({ id: `${base}/else`, wireIndex: i, target, kind: "else", bitIndex: -1 });
      addFallbackEntries(entries, base, i, target, w.fallbacks);
      addCatchEntry(entries, base, i, target, w);
      continue;
    }

    // ── condAnd / condOr (logical binary) ───────────────────────────
    entries.push({
      id: `${base}/primary`,
      wireIndex: i,
      target,
      kind: "primary",
      bitIndex: -1,
    });
    if ("condAnd" in w) {
      addFallbackEntries(entries, base, i, target, w.fallbacks);
      addCatchEntry(entries, base, i, target, w);
    } else {
      // condOr
      const wo = w as Extract<Wire, { condOr: unknown }>;
      addFallbackEntries(entries, base, i, target, wo.fallbacks);
      addCatchEntry(entries, base, i, target, w);
    }
  }

  // ── Array iterators — each scope adds an "empty-array" path ─────
  if (bridge.arrayIterators) {
    for (const key of Object.keys(bridge.arrayIterators)) {
      const id = key ? `${key}/empty-array` : "*/empty-array";
      entries.push({
        id,
        wireIndex: -1,
        target: key ? key.split(".") : [],
        kind: "empty-array",
        bitIndex: -1,
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
 * @param trace     The numeric bitmask produced by the execution engine.
 */
export function decodeExecutionTrace(
  manifest: TraversalEntry[],
  trace: number,
): TraversalEntry[] {
  const result: TraversalEntry[] = [];
  for (const entry of manifest) {
    // Check if the bit at position `entry.bitIndex` is set in the trace,
    // indicating this path was taken during execution.
    if (trace & (1 << entry.bitIndex)) {
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
