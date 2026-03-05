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

import type { NodeRef, Wire } from "./types.ts";
import type { MaybePromise, TreeContext } from "./tree-types.ts";
import { isFatalError, isPromise, applyControlFlow, BridgeAbortError } from "./tree-types.ts";
import { coerceConstant, getSimplePullRef } from "./tree-utils.ts";

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
 * See docs/performance.md (#10).
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
    if ("value" in w) return coerceConstant(w.value);
    const ref = getSimplePullRef(w);
    if (ref) return ctx.pullSingle(ref, pullChain);
  }
  return resolveWiresAsync(ctx, wires, pullChain);
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
    if ("value" in w) return coerceConstant(w.value);

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
      if (recoveredValue != null) return recoveredValue;

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

  for (const fallback of w.fallbacks) {
    const isFalsyGateOpen = fallback.type === "falsy" && !value;
    const isNullishGateOpen = fallback.type === "nullish" && value == null;

    if (isFalsyGateOpen || isNullishGateOpen) {
      if (fallback.control) return applyControlFlow(fallback.control);
      if (fallback.ref) {
        value = await ctx.pullSingle(fallback.ref, pullChain);
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
  if (w.catchControl) return applyControlFlow(w.catchControl);
  if (w.catchFallbackRef) return ctx.pullSingle(w.catchFallbackRef, pullChain);
  if (w.catchFallback != null) return coerceConstant(w.catchFallback);
  return undefined;
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
    const condValue = await ctx.pullSingle(w.cond, pullChain);
    if (condValue) {
      if (w.thenRef !== undefined) return ctx.pullSingle(w.thenRef, pullChain);
      if (w.thenValue !== undefined) return coerceConstant(w.thenValue);
    } else {
      if (w.elseRef !== undefined) return ctx.pullSingle(w.elseRef, pullChain);
      if (w.elseValue !== undefined) return coerceConstant(w.elseValue);
    }
    return undefined;
  }

  if ("condAnd" in w) {
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condAnd;
    const leftVal = await pullSafe(ctx, leftRef, safe, pullChain);
    if (!leftVal) return false;
    if (rightRef !== undefined)
      return Boolean(await pullSafe(ctx, rightRef, rightSafe, pullChain));
    if (rightValue !== undefined) return Boolean(coerceConstant(rightValue));
    return Boolean(leftVal);
  }

  if ("condOr" in w) {
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condOr;
    const leftVal = await pullSafe(ctx, leftRef, safe, pullChain);
    if (leftVal) return true;
    if (rightRef !== undefined)
      return Boolean(await pullSafe(ctx, rightRef, rightSafe, pullChain));
    if (rightValue !== undefined) return Boolean(coerceConstant(rightValue));
    return Boolean(leftVal);
  }

  if ("from" in w) {
    if (w.safe) {
      try {
        return await ctx.pullSingle(w.from, pullChain);
      } catch (err: any) {
        if (isFatalError(err)) throw err;
        return undefined;
      }
    }
    return ctx.pullSingle(w.from, pullChain);
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
): MaybePromise<any> {
  // FAST PATH: Unsafe wires bypass the try/catch overhead entirely
  if (!safe) {
    return ctx.pullSingle(ref, pullChain);
  }

  // SAFE PATH: We must catch synchronous throws during the invocation
  let pull: any;
  try {
    pull = ctx.pullSingle(ref, pullChain);
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
