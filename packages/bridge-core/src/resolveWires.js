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
import { isFatalError, isPromise, applyControlFlow, BridgeAbortError } from "./tree-types.js";
import { coerceConstant, getSimplePullRef } from "./tree-utils.js";
// ── Public entry point ──────────────────────────────────────────────────────
/**
 * Resolve a set of matched wires.
 *
 * Architecture: two distinct resolution axes —
 *
 *  **Falsy Gate** (`||`, within a wire): `falsyFallbackRefs` + `falsyFallback`
 *    → truthy check — falsy values (0, "", false) trigger fallback chain.
 *
 *  **Overdefinition** (across wires): multiple wires target the same path
 *    → nullish check — only null/undefined falls through to the next wire.
 *
 * Per-wire layers:
 *   Layer 1  — Execution (pullSingle + safe modifier)
 *   Layer 2a — Falsy Gate   (falsyFallbackRefs → falsyFallback / falsyControl)
 *   Layer 2b — Nullish Gate  (nullishFallbackRef / nullishFallback / nullishControl)
 *   Layer 3  — Catch         (catchFallbackRef / catchFallback / catchControl)
 *
 * After layers 1–2b, the overdefinition boundary (`!= null`) decides whether
 * to return or continue to the next wire.
 *
 * ---
 *
 * Fast path: single `from` wire with no fallback/catch modifiers, which is
 * the common case for element field wires like `.id <- it.id`.  Delegates to
 * `resolveWiresAsync` for anything more complex.
 * See docs/performance.md (#10).
 */
export function resolveWires(ctx, wires, pullChain) {
    // Abort discipline — honour pre-aborted signal even on the fast path
    if (ctx.signal?.aborted)
        throw new BridgeAbortError();
    if (wires.length === 1) {
        const w = wires[0];
        if ("value" in w)
            return coerceConstant(w.value);
        const ref = getSimplePullRef(w);
        if (ref)
            return ctx.pullSingle(ref, pullChain);
    }
    return resolveWiresAsync(ctx, wires, pullChain);
}
// ── Async resolution loop ───────────────────────────────────────────────────
async function resolveWiresAsync(ctx, wires, pullChain) {
    let lastError;
    for (const w of wires) {
        // Abort discipline — yield immediately if client disconnected
        if (ctx.signal?.aborted)
            throw new BridgeAbortError();
        // Constant wire — always wins, no modifiers
        if ("value" in w)
            return coerceConstant(w.value);
        try {
            // --- Layer 1: Execution ---
            let resolvedValue = await evaluateWireSource(ctx, w, pullChain);
            // --- Layer 2a: Falsy Gate (||) ---
            if (!resolvedValue && w.falsyFallbackRefs?.length) {
                for (const ref of w.falsyFallbackRefs) {
                    resolvedValue = await ctx.pullSingle(ref, pullChain);
                    if (resolvedValue)
                        break;
                }
            }
            if (!resolvedValue) {
                if (w.falsyControl) {
                    resolvedValue = applyControlFlow(w.falsyControl);
                }
                else if (w.falsyFallback != null) {
                    resolvedValue = coerceConstant(w.falsyFallback);
                }
            }
            // --- Layer 2b: Nullish Gate (??) ---
            if (resolvedValue == null) {
                if (w.nullishControl) {
                    resolvedValue = applyControlFlow(w.nullishControl);
                }
                else if (w.nullishFallbackRef) {
                    resolvedValue = await ctx.pullSingle(w.nullishFallbackRef, pullChain);
                }
                else if (w.nullishFallback != null) {
                    resolvedValue = coerceConstant(w.nullishFallback);
                }
            }
            // --- Overdefinition Boundary ---
            if (resolvedValue != null)
                return resolvedValue;
        }
        catch (err) {
            // --- Layer 3: Catch ---
            if (isFatalError(err))
                throw err;
            if (w.catchControl)
                return applyControlFlow(w.catchControl);
            if (w.catchFallbackRef)
                return ctx.pullSingle(w.catchFallbackRef, pullChain);
            if (w.catchFallback != null)
                return coerceConstant(w.catchFallback);
            lastError = err;
        }
    }
    if (lastError)
        throw lastError;
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
async function evaluateWireSource(ctx, w, pullChain) {
    if ("cond" in w) {
        const condValue = await ctx.pullSingle(w.cond, pullChain);
        if (condValue) {
            if (w.thenRef !== undefined)
                return ctx.pullSingle(w.thenRef, pullChain);
            if (w.thenValue !== undefined)
                return coerceConstant(w.thenValue);
        }
        else {
            if (w.elseRef !== undefined)
                return ctx.pullSingle(w.elseRef, pullChain);
            if (w.elseValue !== undefined)
                return coerceConstant(w.elseValue);
        }
        return undefined;
    }
    if ("condAnd" in w) {
        const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condAnd;
        const leftVal = await pullSafe(ctx, leftRef, safe, pullChain);
        if (!leftVal)
            return false;
        if (rightRef !== undefined)
            return Boolean(await pullSafe(ctx, rightRef, rightSafe, pullChain));
        if (rightValue !== undefined)
            return Boolean(coerceConstant(rightValue));
        return Boolean(leftVal);
    }
    if ("condOr" in w) {
        const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condOr;
        const leftVal = await pullSafe(ctx, leftRef, safe, pullChain);
        if (leftVal)
            return true;
        if (rightRef !== undefined)
            return Boolean(await pullSafe(ctx, rightRef, rightSafe, pullChain));
        if (rightValue !== undefined)
            return Boolean(coerceConstant(rightValue));
        return Boolean(leftVal);
    }
    if ("from" in w) {
        if (w.safe) {
            try {
                return await ctx.pullSingle(w.from, pullChain);
            }
            catch (err) {
                if (isFatalError(err))
                    throw err;
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
function pullSafe(ctx, ref, safe, pullChain) {
    // FAST PATH: Unsafe wires bypass the try/catch overhead entirely
    if (!safe) {
        return ctx.pullSingle(ref, pullChain);
    }
    // SAFE PATH: We must catch synchronous throws during the invocation
    let pull;
    try {
        pull = ctx.pullSingle(ref, pullChain);
    }
    catch (e) {
        // Caught a synchronous error!
        if (isFatalError(e))
            throw e;
        return undefined;
    }
    // If the result was synchronous and didn't throw, we just return it
    if (!isPromise(pull)) {
        return pull;
    }
    // If the result is a Promise, we must catch asynchronous rejections
    return pull.catch((e) => {
        if (isFatalError(e))
            throw e;
        return undefined;
    });
}
