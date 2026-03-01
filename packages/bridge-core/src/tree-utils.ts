/**
 * Pure utility functions for the execution tree — no class dependency.
 *
 * Extracted from ExecutionTree.ts — Phase 1 of the refactor.
 * See docs/execution-tree-refactor.md
 */

import type { NodeRef, Wire } from "./types.ts";
import type { Trunk } from "./tree-types.ts";

// ── Trunk helpers ───────────────────────────────────────────────────────────

/** Stable string key for the state map */
export function trunkKey(ref: Trunk & { element?: boolean }): string {
  if (ref.element) return `${ref.module}:${ref.type}:${ref.field}:*`;
  return `${ref.module}:${ref.type}:${ref.field}${ref.instance != null ? `:${ref.instance}` : ""}`;
}

/** Match two trunks (ignoring path and element) */
export function sameTrunk(a: Trunk, b: Trunk): boolean {
  return (
    a.module === b.module &&
    a.type === b.type &&
    a.field === b.field &&
    (a.instance ?? undefined) === (b.instance ?? undefined)
  );
}

// ── Path helpers ────────────────────────────────────────────────────────────

/** Strict path equality — manual loop avoids `.every()` closure allocation.  See docs/performance.md (#7). */
export function pathEquals(a: string[], b: string[]): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Constant coercion ───────────────────────────────────────────────────────

/**
 * Coerce a constant wire value string to its proper JS type.
 *
 * The parser stores all bare constants as strings (because the Wire type
 * uses `value: string`). JSON.parse recovers the original type:
 *   "true" → true, "false" → false, "null" → null, "42" → 42
 * Plain strings that aren't valid JSON (like "hello", "/search") fall
 * through and are returned as-is.
 *
 * Results are cached in a module-level Map because the same constant
 * strings appear repeatedly across shadow trees.  Only safe for
 * immutable values (primitives); callers must not mutate the returned
 * value.  See docs/performance.md (#6).
 */
const constantCache = new Map<string, unknown>();
export function coerceConstant(raw: string): unknown {
  const cached = constantCache.get(raw);
  if (cached !== undefined) return cached;
  let result: unknown;
  try {
    result = JSON.parse(raw);
  } catch {
    result = raw;
  }
  // Hard cap to prevent unbounded growth over long-lived processes.
  if (constantCache.size > 10_000) constantCache.clear();
  constantCache.set(raw, result);
  return result;
}

// ── Nested property helpers ─────────────────────────────────────────────────

export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Set a value at a nested path, creating intermediate objects/arrays as needed */
export function setNested(obj: any, path: string[], value: any): void {
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe assignment key: ${key}`);
    const nextKey = path[i + 1];
    if (obj[key] == null) {
      obj[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    obj = obj[key];
  }
  if (path.length > 0) {
    const finalKey = path[path.length - 1];
    if (UNSAFE_KEYS.has(finalKey))
      throw new Error(`Unsafe assignment key: ${finalKey}`);
    obj[finalKey] = value;
  }
}

// ── Symbol-keyed engine caches ──────────────────────────────────────────────
//
// Cached values are stored on AST objects using Symbol keys instead of
// string keys.  V8 stores Symbol-keyed properties in a separate backing
// store that does not participate in the hidden-class (Shape) system.
// This means the execution engine can safely cache computed values on
// parser-produced objects without triggering shape transitions that would
// degrade the parser's allocation-site throughput.
// See docs/performance.md (#11).

/** Symbol key for the cached `trunkKey()` result on NodeRef objects. */
export const TRUNK_KEY_CACHE = Symbol.for("bridge.trunkKey");

/** Symbol key for the cached simple-pull ref on Wire objects. */
export const SIMPLE_PULL_CACHE = Symbol.for("bridge.simplePull");

// ── Wire helpers ────────────────────────────────────────────────────────────

/**
 * Returns the `from` NodeRef when a wire qualifies for the simple-pull fast
 * path (single `from` wire, no safe/falsy/nullish/catch modifiers).  Returns
 * `null` otherwise.  The result is cached on the wire via a Symbol key so
 * subsequent calls are a single property read without affecting V8 shapes.
 * See docs/performance.md (#11).
 */
export function getSimplePullRef(w: Wire): NodeRef | null {
  if ("from" in w) {
    const cached = (w as any)[SIMPLE_PULL_CACHE];
    if (cached !== undefined) return cached;
    const ref =
      !w.safe &&
      !w.falsyFallbackRefs?.length &&
      w.falsyControl == null &&
      w.falsyFallback == null &&
      w.nullishControl == null &&
      !w.nullishFallbackRef &&
      w.nullishFallback == null &&
      !w.catchControl &&
      !w.catchFallbackRef &&
      w.catchFallback == null
        ? w.from
        : null;
    (w as any)[SIMPLE_PULL_CACHE] = ref;
    return ref;
  }
  return null;
}

// ── Misc ────────────────────────────────────────────────────────────────────

/** Round milliseconds to 2 decimal places */
export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}
