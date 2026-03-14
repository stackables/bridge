/**
 * Wire resolution — the core data-flow evaluation loop.
 *
 * Extracted from ExecutionTree.ts — Phase 2 of the refactor.
 * See docs/execution-tree-refactor.md
 *
 * All functions take a `TreeContext` as their first argument so they
 * can call back into the tree for `pullSingle` without depending on
 * the full `ExecutionTree` class.
 */

import type { Wire } from "./types.ts";
import type { MaybePromise, TreeContext } from "./tree-types.ts";
import { isFatalError, BridgeAbortError } from "./tree-types.ts";
import { coerceConstant, getSimplePullRef } from "./tree-utils.ts";
import type { TraceWireBits } from "./enumerate-traversals.ts";
import { resolveSourceEntries } from "./resolveWiresSources.ts";

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Resolve a set of matched wires.
 *
 * Architecture: two distinct resolution axes —
 *
 *  **Fallback Gates** (`||` / `??`, within a wire): ordered source entries
 *    → falsy gates trigger on falsy values (0, "", false, null, undefined)
 *    → nullish gates trigger only on null/undefined
 *    → gates are processed left-to-right, allowing mixed `||` and `??` chains
 *
 *  **Overdefinition** (across wires): multiple wires target the same path
 *    → nullish check — only null/undefined falls through to the next wire.
 *
 * Resolution is handled by `resolveSourceEntries()` from resolveWiresSources.ts,
 * which evaluates source entries in order with their gates and catch handler.
 *
 * ---
 *
 * Fast path: single `from` wire with no fallback/catch modifiers, which is
 * the common case for element field wires like `.id <- it.id`.  Delegates to
 * `resolveWiresAsync` for anything more complex.
 * See packages/bridge-core/performance.md (#10).
 */
export function resolveWires(
  ctx: TreeContext,
  wires: Wire[],
  pullChain?: Set<string>,
): MaybePromise<any> {
  // Abort discipline — honour pre-aborted signal even on the fast path
  if (ctx.signal?.aborted) throw new BridgeAbortError();

  if (wires.length === 1) {
    const w = wires[0]!;
    // Constant wire — single literal source, no catch
    if (
      w.sources.length === 1 &&
      w.sources[0]!.expr.type === "literal" &&
      !w.catch
    ) {
      recordPrimary(ctx, w);
      return coerceConstant(w.sources[0]!.expr.value);
    }
    const ref = getSimplePullRef(w);
    if (
      ref &&
      (ctx.traceBits?.get(w) as TraceWireBits | undefined)?.primaryError == null
    ) {
      recordPrimary(ctx, w);
      const expr = w.sources[0]!.expr;
      const refLoc = expr.type === "ref" ? (expr.refLoc ?? w.loc) : w.loc;
      return ctx.pullSingle(ref, pullChain, refLoc);
    }
  }
  const orderedWires = orderOverdefinedWires(ctx, wires);
  return resolveWiresAsync(ctx, orderedWires, pullChain);
}

function orderOverdefinedWires(ctx: TreeContext, wires: Wire[]): Wire[] {
  if (wires.length < 2 || !ctx.classifyOverdefinitionWire) return wires;

  const ranked = wires.map((wire, index) => ({
    wire,
    index,
    cost: ctx.classifyOverdefinitionWire!(wire),
  }));

  let changed = false;
  ranked.sort((left, right) => {
    if (left.cost !== right.cost) {
      changed = true;
      return left.cost - right.cost;
    }
    return left.index - right.index;
  });

  return changed ? ranked.map((entry) => entry.wire) : wires;
}

// ── Async resolution loop ───────────────────────────────────────────────────

async function resolveWiresAsync(
  ctx: TreeContext,
  wires: Wire[],
  pullChain?: Set<string>,
): Promise<unknown> {
  let lastError: unknown;

  for (const w of wires) {
    // Abort discipline — yield immediately if client disconnected
    if (ctx.signal?.aborted) throw new BridgeAbortError();

    // Constant wire — single literal source, no catch
    if (
      w.sources.length === 1 &&
      w.sources[0]!.expr.type === "literal" &&
      !w.catch
    ) {
      recordPrimary(ctx, w);
      return coerceConstant(w.sources[0]!.expr.value);
    }

    // Delegate to the unified source-loop resolver
    const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;

    try {
      const value = await resolveSourceEntries(ctx, w, pullChain, bits);

      // Overdefinition Boundary
      if (value != null) return value;
    } catch (err: unknown) {
      if (isFatalError(err)) throw err;
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return undefined;
}

// ── Trace recording helpers ─────────────────────────────────────────────────
// These are designed for minimal overhead: when `traceBits` is not set on the
// context (tracing disabled), the functions return immediately after a single
// falsy check.  When enabled, one Map.get + one bitwise OR is the hot path.
//
// INVARIANT: `traceMask` is always set when `traceBits` is set — both are
// initialised together by `ExecutionTree.enableExecutionTrace()`.

function recordPrimary(ctx: TreeContext, w: Wire): void {
  const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;
  if (bits?.primary != null) ctx.traceMask![0] |= 1n << BigInt(bits.primary);
}
