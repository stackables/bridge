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

import type { ControlFlowInstruction, Wire, WireLegacy } from "./types.ts";
import type {
  LoopControlSignal,
  MaybePromise,
  TreeContext,
} from "./tree-types.ts";
import {
  attachBridgeErrorMetadata,
  isFatalError,
  applyControlFlow,
  BridgeAbortError,
  BridgePanicError,
  wrapBridgeRuntimeError,
} from "./tree-types.ts";
import { coerceConstant, getSimplePullRef } from "./tree-utils.ts";
import type { TraceWireBits } from "./enumerate-traversals.ts";
import { resolveSourceEntries } from "./resolveWiresV2.ts";

// ── Wire type helpers ────────────────────────────────────────────────────────

/**
 * A non-constant legacy wire — used by the backward-compatible
 * `applyFallbackGates` / `applyCatchGate` exports.
 */
type WireWithGates = Exclude<WireLegacy, { value: string }>;

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Resolve a set of matched wires.
 *
 * Architecture: two distinct resolution axes —
 *
 *  **Fallback Gates** (`||` / `??`, within a wire): unified `fallbacks` array
 *    → falsy gates trigger on falsy values (0, "", false, null, undefined)
 *    → nullish gates trigger only on null/undefined
 *    → gates are processed left-to-right, allowing mixed `||` and `??` chains
 *
 *  **Overdefinition** (across wires): multiple wires target the same path
 *    → nullish check — only null/undefined falls through to the next wire.
 *
 * Per-wire layers:
 *   Layer 1  — Execution (pullSingle + safe modifier)
 *   Layer 2  — Fallback Gates (unified fallbacks array: || and ?? in order)
 *   Layer 3  — Catch         (catchFallbackRef / catchFallback / catchControl)
 *
 * After layers 1–2, the overdefinition boundary (`!= null`) decides whether
 * to return or continue to the next wire.
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

// ── Layer 2: Fallback Gates (unified || and ??) ─────────────────────────────

/**
 * Apply the unified Fallback Gates (Layer 2) to a resolved value.
 *
 * Walks the `fallbacks` array in order.  Each entry is either a falsy gate
 * (`||`) or a nullish gate (`??`).  A falsy gate opens when `!value`;
 * a nullish gate opens when `value == null`.  When a gate is open, the
 * fallback is applied (control flow, ref pull, or constant coercion) and
 * the result replaces `value` for subsequent gates.
 */
export async function applyFallbackGates(
  ctx: TreeContext,
  w: WireWithGates,
  value: unknown,
  pullChain?: Set<string>,
): Promise<unknown> {
  if (!w.fallbacks?.length) return value;

  for (
    let fallbackIndex = 0;
    fallbackIndex < w.fallbacks.length;
    fallbackIndex++
  ) {
    const fallback = w.fallbacks[fallbackIndex];
    const isFalsyGateOpen = fallback.type === "falsy" && !value;
    const isNullishGateOpen = fallback.type === "nullish" && value == null;

    if (isFalsyGateOpen || isNullishGateOpen) {
      recordFallback(ctx, w as unknown as Wire, fallbackIndex);
      if (fallback.control) {
        return applyControlFlowWithLoc(fallback.control, fallback.loc ?? w.loc);
      }
      if (fallback.ref) {
        try {
          value = await ctx.pullSingle(
            fallback.ref,
            pullChain,
            fallback.loc ?? w.loc,
          );
        } catch (err: any) {
          recordFallbackError(ctx, w as unknown as Wire, fallbackIndex);
          throw err;
        }
      } else if (fallback.value !== undefined) {
        value = coerceConstant(fallback.value);
      }
    }
  }

  return value;
}

// ── Layer 3: Catch Gate ──────────────────────────────────────────────────────

/**
 * Apply the Catch Gate (Layer 3) after an error has been thrown by the
 * execution layer.
 *
 * Returns the recovered value if the wire supplies a catch handler, or
 * `undefined` if the error should be stored as `lastError` so the loop can
 * continue to the next wire.
 */
export async function applyCatchGate(
  ctx: TreeContext,
  w: WireWithGates,
  pullChain?: Set<string>,
): Promise<unknown> {
  if (w.catchControl) {
    recordCatch(ctx, w as unknown as Wire);
    return applyControlFlowWithLoc(w.catchControl, w.catchLoc ?? w.loc);
  }
  if (w.catchFallbackRef) {
    recordCatch(ctx, w as unknown as Wire);
    try {
      return await ctx.pullSingle(
        w.catchFallbackRef,
        pullChain,
        w.catchLoc ?? w.loc,
      );
    } catch (err: any) {
      recordCatchError(ctx, w as unknown as Wire);
      throw err;
    }
  }
  if (w.catchFallback != null) {
    recordCatch(ctx, w as unknown as Wire);
    return coerceConstant(w.catchFallback);
  }
  return undefined;
}

function applyControlFlowWithLoc(
  control: ControlFlowInstruction,
  bridgeLoc: Wire["loc"],
): symbol | LoopControlSignal {
  try {
    return applyControlFlow(control);
  } catch (err) {
    if (err instanceof BridgePanicError) {
      throw attachBridgeErrorMetadata(err, {
        bridgeLoc,
      });
    }
    if (isFatalError(err)) throw err;
    throw wrapBridgeRuntimeError(err, {
      bridgeLoc,
    });
  }
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

function recordFallback(ctx: TreeContext, w: Wire, index: number): void {
  const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;
  const fb = bits?.fallbacks;
  if (fb && fb[index] != null) ctx.traceMask![0] |= 1n << BigInt(fb[index]);
}

function recordCatch(ctx: TreeContext, w: Wire): void {
  const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;
  if (bits?.catch != null) ctx.traceMask![0] |= 1n << BigInt(bits.catch);
}

function recordFallbackError(ctx: TreeContext, w: Wire, index: number): void {
  const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;
  const fb = bits?.fallbackErrors;
  if (fb && fb[index] != null) ctx.traceMask![0] |= 1n << BigInt(fb[index]);
}

function recordCatchError(ctx: TreeContext, w: Wire): void {
  const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;
  if (bits?.catchError != null)
    ctx.traceMask![0] |= 1n << BigInt(bits.catchError);
}
