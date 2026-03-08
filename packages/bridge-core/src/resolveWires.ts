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
import type { MaybePromise, TreeContext } from "./tree-types.ts";
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

  if (wires.length === 1 && !ctx.recordSnapshotStep) {
    const w = wires[0]!;
    if ("value" in w) return coerceConstant(w.value);
    const ref = getSimplePullRef(w);
    if (ref) {
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
      ctx.recordSnapshotStep?.(w, "constant>return");
      return coerceConstant(w.value);
    }

    const branchParts: string[] = [];

    try {
      // Layer 1: Execution
      const source = await evaluateWireSource(ctx, w, pullChain);
      branchParts.push(source.outcome);
      let value = await source.value;

      // Layer 2: Fallback Gates (unified || and ?? chain)
      value = await applyFallbackGates(ctx, w, value, pullChain, branchParts);

      // Overdefinition Boundary
      if (value != null) {
        branchParts.push("return");
        ctx.recordSnapshotStep?.(w, branchParts.join(">"));
        return value;
      }
      branchParts.push("fallthrough:nullish");
      ctx.recordSnapshotStep?.(w, branchParts.join(">"));
    } catch (err: unknown) {
      // Layer 3: Catch Gate
      if (isFatalError(err)) throw err;

      const recoveredValue = await applyCatchGate(
        ctx,
        w,
        pullChain,
        branchParts,
      );
      if (recoveredValue !== undefined) {
        branchParts.push("return");
        ctx.recordSnapshotStep?.(w, branchParts.join(">"));
        return recoveredValue;
      }

      branchParts.push("error");
      ctx.recordSnapshotStep?.(w, branchParts.join(">"));

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
  branchParts?: string[],
): Promise<unknown> {
  if (!w.fallbacks?.length) return value;

  for (const [index, fallback] of w.fallbacks.entries()) {
    const isFalsyGateOpen = fallback.type === "falsy" && !value;
    const isNullishGateOpen = fallback.type === "nullish" && value == null;

    if (isFalsyGateOpen || isNullishGateOpen) {
      if (fallback.control) {
        branchParts?.push(
          `fallback:${index}:${fallback.type}:control:${fallback.control.kind}`,
        );
        return applyControlFlowWithLoc(fallback.control, fallback.loc ?? w.loc);
      }
      if (fallback.ref) {
        branchParts?.push(`fallback:${index}:${fallback.type}:ref`);
        value = await ctx.pullSingle(
          fallback.ref,
          pullChain,
          fallback.loc ?? w.loc,
        );
      } else if (fallback.value !== undefined) {
        branchParts?.push(`fallback:${index}:${fallback.type}:value`);
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
  branchParts?: string[],
): Promise<unknown> {
  if (w.catchControl) {
    branchParts?.push(`catch:control:${w.catchControl.kind}`);
    return applyControlFlowWithLoc(w.catchControl, w.catchLoc ?? w.loc);
  }
  if (w.catchFallbackRef) {
    branchParts?.push("catch:ref");
    return ctx.pullSingle(w.catchFallbackRef, pullChain, w.catchLoc ?? w.loc);
  }
  if (w.catchFallback != null) {
    branchParts?.push("catch:value");
    return coerceConstant(w.catchFallback);
  }
  return undefined;
}

function applyControlFlowWithLoc(
  control: ControlFlowInstruction,
  bridgeLoc: Wire["loc"],
): symbol | import("./tree-types.ts").LoopControlSignal {
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
): Promise<{ value: any; outcome: string }> {
  if ("cond" in w) {
    const condValue = await ctx.pullSingle(
      w.cond,
      pullChain,
      w.condLoc ?? w.loc,
    );
    if (condValue) {
      if (w.thenRef !== undefined) {
        return {
          value: ctx.pullSingle(w.thenRef, pullChain, w.thenLoc ?? w.loc),
          outcome: "source:cond:then:ref",
        };
      }
      if (w.thenValue !== undefined) {
        return {
          value: coerceConstant(w.thenValue),
          outcome: "source:cond:then:value",
        };
      }
      return { value: undefined, outcome: "source:cond:then:undefined" };
    } else {
      if (w.elseRef !== undefined) {
        return {
          value: ctx.pullSingle(w.elseRef, pullChain, w.elseLoc ?? w.loc),
          outcome: "source:cond:else:ref",
        };
      }
      if (w.elseValue !== undefined) {
        return {
          value: coerceConstant(w.elseValue),
          outcome: "source:cond:else:value",
        };
      }
      return { value: undefined, outcome: "source:cond:else:undefined" };
    }
  }

  if ("condAnd" in w) {
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condAnd;
    const leftVal = await pullSafe(ctx, leftRef, safe, pullChain, w.loc);
    if (!leftVal) return { value: false, outcome: "source:and:left-false" };
    if (rightRef !== undefined) {
      return {
        value: Boolean(
          await pullSafe(ctx, rightRef, rightSafe, pullChain, w.loc),
        ),
        outcome: "source:and:right:ref",
      };
    }
    if (rightValue !== undefined) {
      return {
        value: Boolean(coerceConstant(rightValue)),
        outcome: "source:and:right:value",
      };
    }
    return { value: Boolean(leftVal), outcome: "source:and:left-true" };
  }

  if ("condOr" in w) {
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condOr;
    const leftVal = await pullSafe(ctx, leftRef, safe, pullChain, w.loc);
    if (leftVal) return { value: true, outcome: "source:or:left-true" };
    if (rightRef !== undefined) {
      return {
        value: Boolean(
          await pullSafe(ctx, rightRef, rightSafe, pullChain, w.loc),
        ),
        outcome: "source:or:right:ref",
      };
    }
    if (rightValue !== undefined) {
      return {
        value: Boolean(coerceConstant(rightValue)),
        outcome: "source:or:right:value",
      };
    }
    return { value: Boolean(leftVal), outcome: "source:or:left-false" };
  }

  if ("from" in w) {
    if (w.safe) {
      try {
        return {
          value: await ctx.pullSingle(w.from, pullChain, w.fromLoc ?? w.loc),
          outcome: "source:from",
        };
      } catch (err: any) {
        if (isFatalError(err)) throw err;
        return { value: undefined, outcome: "source:from:safe-error" };
      }
    }
    return {
      value: ctx.pullSingle(w.from, pullChain, w.fromLoc ?? w.loc),
      outcome: "source:from",
    };
  }

  return { value: undefined, outcome: "source:unknown" };
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
