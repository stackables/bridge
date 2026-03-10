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

import type { ControlFlowInstruction, NodeRef, Wire } from "./types.ts";
import type {
  LoopControlSignal,
  MaybePromise,
  TreeContext,
} from "./tree-types.ts";
import {
  attachBridgeErrorMetadata,
  isFatalError,
  isPromise,
  applyControlFlow,
  BridgeAbortError,
  BridgePanicError,
  wrapBridgeRuntimeError,
} from "./tree-types.ts";
import { coerceConstant, getSimplePullRef } from "./tree-utils.ts";
import type { TraceWireBits } from "./enumerate-traversals.ts";

// ── Wire type helpers ────────────────────────────────────────────────────────

/**
 * A non-constant wire — any Wire variant that carries gate modifiers
 * (`fallbacks`, `catchFallback`, etc.).
 * Excludes the `{ value: string; to: NodeRef }` constant wire which has no
 * modifier slots.
 */
type WireWithGates = Exclude<Wire, { value: string }>;

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
    if ("value" in w) {
      recordPrimary(ctx, w);
      return coerceConstant(w.value);
    }
    const ref = getSimplePullRef(w);
    if (ref) {
      recordPrimary(ctx, w);
      return ctx.pullSingle(
        ref,
        pullChain,
        "from" in w ? (w.fromLoc ?? w.loc) : w.loc,
      );
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

    // Constant wire — always wins, no modifiers
    if ("value" in w) {
      recordPrimary(ctx, w);
      return coerceConstant(w.value);
    }

    try {
      // Layer 1: Execution
      let value = await evaluateWireSource(ctx, w, pullChain);

      // Layer 2: Fallback Gates (unified || and ?? chain)
      value = await applyFallbackGates(ctx, w, value, pullChain);

      // Overdefinition Boundary
      if (value != null) return value;
    } catch (err: unknown) {
      // Layer 3: Catch Gate
      if (isFatalError(err)) throw err;

      const recoveredValue = await applyCatchGate(ctx, w, pullChain);
      if (recoveredValue !== undefined) return recoveredValue;

      lastError = wrapBridgeRuntimeError(err, {
        bridgeLoc: w.loc,
      });
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
      recordFallback(ctx, w, fallbackIndex);
      if (fallback.control) {
        return applyControlFlowWithLoc(fallback.control, fallback.loc ?? w.loc);
      }
      if (fallback.ref) {
        value = await ctx.pullSingle(
          fallback.ref,
          pullChain,
          fallback.loc ?? w.loc,
        );
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
    recordCatch(ctx, w);
    return applyControlFlowWithLoc(w.catchControl, w.catchLoc ?? w.loc);
  }
  if (w.catchFallbackRef) {
    recordCatch(ctx, w);
    return ctx.pullSingle(w.catchFallbackRef, pullChain, w.catchLoc ?? w.loc);
  }
  if (w.catchFallback != null) {
    recordCatch(ctx, w);
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

// ── Layer 1: Wire source evaluation ─────────────────────────────────────────

/**
 * Evaluate the primary value of a wire (Layer 1) — the `from`, `cond`,
 * `condAnd`, or `condOr` portion, before any fallback gates are applied.
 *
 * Returns the raw resolved value (or `undefined` if the wire variant is
 * unrecognised).
 */
async function evaluateWireSource(
  ctx: TreeContext,
  w: Wire,
  pullChain?: Set<string>,
): Promise<any> {
  if ("cond" in w) {
    const condValue = await ctx.pullSingle(
      w.cond,
      pullChain,
      w.condLoc ?? w.loc,
    );
    if (condValue) {
      recordPrimary(ctx, w); // "then" branch → primary bit
      if (w.thenRef !== undefined) {
        return ctx.pullSingle(w.thenRef, pullChain, w.thenLoc ?? w.loc);
      }
      if (w.thenValue !== undefined) return coerceConstant(w.thenValue);
    } else {
      recordElse(ctx, w); // "else" branch
      if (w.elseRef !== undefined) {
        return ctx.pullSingle(w.elseRef, pullChain, w.elseLoc ?? w.loc);
      }
      if (w.elseValue !== undefined) return coerceConstant(w.elseValue);
    }
    return undefined;
  }

  if ("condAnd" in w) {
    recordPrimary(ctx, w);
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condAnd;
    const leftVal = await pullSafe(ctx, leftRef, safe, pullChain, w.loc);
    if (!leftVal) return false;
    if (rightRef !== undefined)
      return Boolean(
        await pullSafe(ctx, rightRef, rightSafe, pullChain, w.loc),
      );
    if (rightValue !== undefined) return Boolean(coerceConstant(rightValue));
    return Boolean(leftVal);
  }

  if ("condOr" in w) {
    recordPrimary(ctx, w);
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condOr;
    const leftVal = await pullSafe(ctx, leftRef, safe, pullChain, w.loc);
    if (leftVal) return true;
    if (rightRef !== undefined)
      return Boolean(
        await pullSafe(ctx, rightRef, rightSafe, pullChain, w.loc),
      );
    if (rightValue !== undefined) return Boolean(coerceConstant(rightValue));
    return Boolean(leftVal);
  }

  if ("from" in w) {
    recordPrimary(ctx, w);
    if (w.safe) {
      try {
        return await ctx.pullSingle(w.from, pullChain, w.fromLoc ?? w.loc);
      } catch (err: any) {
        if (isFatalError(err)) throw err;
        return undefined;
      }
    }
    return ctx.pullSingle(w.from, pullChain, w.fromLoc ?? w.loc);
  }

  return undefined;
}

// ── Safe-navigation helper ──────────────────────────────────────────────────

/**
 * Pull a ref with optional safe-navigation: catches non-fatal errors and
 * returns `undefined` instead.  Used by condAnd / condOr evaluation.
 * Returns `MaybePromise` so synchronous pulls skip microtask scheduling.
 */
function pullSafe(
  ctx: TreeContext,
  ref: NodeRef,
  safe: boolean | undefined,
  pullChain?: Set<string>,
  bridgeLoc?: Wire["loc"],
): MaybePromise<any> {
  // FAST PATH: Unsafe wires bypass the try/catch overhead entirely
  if (!safe) {
    return ctx.pullSingle(ref, pullChain, bridgeLoc);
  }

  // SAFE PATH: We must catch synchronous throws during the invocation
  let pull: any;
  try {
    pull = ctx.pullSingle(ref, pullChain, bridgeLoc);
  } catch (e: any) {
    // Caught a synchronous error!
    if (isFatalError(e)) throw e;
    return undefined;
  }

  // If the result was synchronous and didn't throw, we just return it
  if (!isPromise(pull)) {
    return pull;
  }

  // If the result is a Promise, we must catch asynchronous rejections
  return pull.catch((e: any) => {
    if (isFatalError(e)) throw e;
    return undefined;
  });
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

function recordElse(ctx: TreeContext, w: Wire): void {
  const bits = ctx.traceBits?.get(w) as TraceWireBits | undefined;
  if (bits?.else != null) ctx.traceMask![0] |= 1n << BigInt(bits.else);
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
