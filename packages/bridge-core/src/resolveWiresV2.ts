/**
 * Wire resolution V2 — unified source-loop evaluation.
 *
 * Replaces the three-layer model (evaluateWireSource → applyFallbackGates →
 * applyCatchGate) with a single loop over `WireV2.sources[]`.
 *
 * During the staged migration, the legacy `resolveWires` module delegates
 * here after converting Wire → WireV2. Once all consumers produce WireV2
 * directly, the old module can be removed.
 */

import type {
  ControlFlowInstruction,
  Expression,
  NodeRef,
  WireCatch,
  WireV2,
} from "./types.ts";
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
import { coerceConstant } from "./tree-utils.ts";
import type { TraceWireBits } from "./enumerate-traversals.ts";
import type { SourceLocation } from "@stackables/bridge-types";

// ── Public entry points ─────────────────────────────────────────────────────

/**
 * Evaluate a recursive Expression tree to a single value.
 *
 * This is the core of the V2 model: any expression that can appear in a
 * source entry (ref, literal, ternary, and/or, control) is recursively
 * resolved here.
 */
export function evaluateExpression(
  ctx: TreeContext,
  expr: Expression,
  pullChain?: Set<string>,
): MaybePromise<any> {
  switch (expr.type) {
    case "ref":
      if (expr.safe) {
        return pullSafe(ctx, expr.ref, pullChain, expr.refLoc ?? expr.loc);
      }
      return ctx.pullSingle(expr.ref, pullChain, expr.refLoc ?? expr.loc);

    case "literal":
      return coerceConstant(expr.value);

    case "control":
      return applyControlFlowWithLoc(expr.control, expr.loc);

    case "ternary":
      return evaluateTernary(ctx, expr, pullChain);

    case "and":
      return evaluateAnd(ctx, expr, pullChain);

    case "or":
      return evaluateOr(ctx, expr, pullChain);
  }
}

/**
 * Resolve a single WireV2 — evaluate its ordered source entries with
 * gate semantics, then apply the catch handler on error.
 *
 * Returns the resolved value, or throws if all sources fail and no catch
 * handler recovers.
 *
 * @param bits — Optional pre-resolved trace bits for this wire.
 *   Passed explicitly (instead of looked up from `ctx.traceBits`) to
 *   decouple from the legacy Wire-keyed map during staged migration.
 */
export async function resolveSourceEntries(
  ctx: TreeContext,
  w: WireV2,
  pullChain?: Set<string>,
  bits?: TraceWireBits,
): Promise<unknown> {
  if (ctx.signal?.aborted) throw new BridgeAbortError();

  try {
    let value: unknown;
    for (let i = 0; i < w.sources.length; i++) {
      const entry = w.sources[i]!;

      // Gate check: skip this entry if its gate is not open
      if (i > 0 && entry.gate) {
        const gateOpen = entry.gate === "falsy" ? !value : value == null;
        if (!gateOpen) continue;
      }

      // Evaluate the expression — ternary at primary position needs
      // branch-specific trace recording (then → primary, else → else)
      if (i === 0 && entry.expr.type === "ternary" && bits?.else != null) {
        try {
          value = await evaluateTernaryWithTrace(
            ctx,
            entry.expr,
            pullChain,
            bits,
          );
        } catch (err: unknown) {
          if (isFatalError(err)) throw err;
          // Error bit was already recorded by evaluateTernaryWithTrace
          throw err;
        }
      } else {
        // Record which source was evaluated
        recordSourceBit(ctx, bits, i);

        // Evaluate the expression
        try {
          value = await evaluateExpression(ctx, entry.expr, pullChain);
        } catch (err: unknown) {
          if (isFatalError(err)) throw err;
          recordSourceErrorBit(ctx, bits, i);
          throw err;
        }
      }
    }

    return value;
  } catch (err: unknown) {
    if (isFatalError(err)) throw err;

    // Try catch handler
    if (w.catch) {
      const recovered = await applyCatch(ctx, w.catch, pullChain, bits);
      if (recovered !== undefined) return recovered;
    }

    throw wrapBridgeRuntimeError(err, { bridgeLoc: w.loc });
  }
}

/**
 * Apply the V2 fallback gates to a pre-evaluated value.
 *
 * This is the V2 equivalent of the legacy `applyFallbackGates` — exported
 * so existing tests can be migrated incrementally. Takes the source entries
 * (typically `w.sources.slice(1)`) and applies gate checks.
 */
export async function applyFallbackGatesV2(
  ctx: TreeContext,
  w: WireV2,
  value: unknown,
  pullChain?: Set<string>,
  bits?: TraceWireBits,
): Promise<unknown> {
  if (w.sources.length <= 1) return value;

  for (let i = 1; i < w.sources.length; i++) {
    const entry = w.sources[i]!;

    // Gate check
    const gateOpen = entry.gate === "falsy" ? !value : value == null;
    if (!gateOpen) continue;

    // Record fallback — uses the "fallback" index (i - 1) for backward
    // compatibility with TraceWireBits.fallbacks[]
    const fallbackIndex = i - 1;
    recordFallbackBit(ctx, bits, fallbackIndex);

    // Evaluate the expression
    if (entry.expr.type === "control") {
      return applyControlFlowWithLoc(entry.expr.control, entry.loc ?? w.loc);
    }

    if (entry.expr.type === "ref") {
      try {
        value = await ctx.pullSingle(
          entry.expr.ref,
          pullChain,
          entry.loc ?? w.loc,
        );
      } catch (err: any) {
        recordFallbackErrorBit(ctx, bits, fallbackIndex);
        throw err;
      }
    } else if (entry.expr.type === "literal") {
      value = coerceConstant(entry.expr.value);
    } else {
      // Complex expression in fallback position
      try {
        value = await evaluateExpression(ctx, entry.expr, pullChain);
      } catch (err: any) {
        recordFallbackErrorBit(ctx, bits, fallbackIndex);
        throw err;
      }
    }
  }

  return value;
}

/**
 * Apply the V2 catch handler.
 *
 * Returns the recovered value, or `undefined` if no catch handler is
 * configured (indicating the error should propagate).
 */
export async function applyCatchV2(
  ctx: TreeContext,
  w: WireV2,
  pullChain?: Set<string>,
  bits?: TraceWireBits,
): Promise<unknown> {
  if (!w.catch) return undefined;
  return applyCatch(ctx, w.catch, pullChain, bits);
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function applyCatch(
  ctx: TreeContext,
  c: WireCatch,
  pullChain?: Set<string>,
  bits?: TraceWireBits,
): Promise<unknown> {
  recordCatchBit(ctx, bits);
  if ("control" in c) {
    return applyControlFlowWithLoc(c.control, c.loc);
  }
  if ("ref" in c) {
    try {
      return await ctx.pullSingle(c.ref, pullChain, c.loc);
    } catch (err: any) {
      recordCatchErrorBit(ctx, bits);
      throw err;
    }
  }
  return coerceConstant(c.value);
}

async function evaluateTernary(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "ternary" }>,
  pullChain?: Set<string>,
): Promise<any> {
  const condValue = await evaluateExpression(ctx, expr.cond, pullChain);
  if (condValue) {
    return evaluateExpression(ctx, expr.then, pullChain);
  }
  return evaluateExpression(ctx, expr.else, pullChain);
}

/**
 * Evaluate a ternary expression with branch-specific trace recording.
 *
 * Used by `resolveSourceEntries` when the primary source is a ternary and
 * the trace bits distinguish then/else branches.
 */
async function evaluateTernaryWithTrace(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "ternary" }>,
  pullChain: Set<string> | undefined,
  bits: TraceWireBits,
): Promise<any> {
  const condValue = await evaluateExpression(ctx, expr.cond, pullChain);
  if (condValue) {
    recordSourceBit(ctx, bits, 0); // "then" → primary bit
    try {
      return await evaluateExpression(ctx, expr.then, pullChain);
    } catch (err: unknown) {
      if (isFatalError(err)) throw err;
      recordSourceErrorBit(ctx, bits, 0);
      throw err;
    }
  } else {
    recordElseBit(ctx, bits);
    try {
      return await evaluateExpression(ctx, expr.else, pullChain);
    } catch (err: unknown) {
      if (isFatalError(err)) throw err;
      recordElseErrorBit(ctx, bits);
      throw err;
    }
  }
}

async function evaluateAnd(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "and" }>,
  pullChain?: Set<string>,
): Promise<boolean> {
  const leftVal = await evaluateExprSafe(
    ctx,
    expr.left,
    expr.leftSafe,
    pullChain,
  );
  if (!leftVal) return false;
  if (expr.right.type === "literal" && expr.right.value === "true") {
    return Boolean(leftVal);
  }
  const rightVal = await evaluateExprSafe(
    ctx,
    expr.right,
    expr.rightSafe,
    pullChain,
  );
  return Boolean(rightVal);
}

async function evaluateOr(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "or" }>,
  pullChain?: Set<string>,
): Promise<boolean> {
  const leftVal = await evaluateExprSafe(
    ctx,
    expr.left,
    expr.leftSafe,
    pullChain,
  );
  if (leftVal) return true;
  if (expr.right.type === "literal" && expr.right.value === "true") {
    return Boolean(leftVal);
  }
  const rightVal = await evaluateExprSafe(
    ctx,
    expr.right,
    expr.rightSafe,
    pullChain,
  );
  return Boolean(rightVal);
}

/**
 * Evaluate an expression with optional safe navigation — catches non-fatal
 * errors and returns `undefined`.
 */
function evaluateExprSafe(
  ctx: TreeContext,
  expr: Expression,
  safe: boolean | undefined,
  pullChain?: Set<string>,
): MaybePromise<any> {
  if (!safe) return evaluateExpression(ctx, expr, pullChain);

  let result: any;
  try {
    result = evaluateExpression(ctx, expr, pullChain);
  } catch (e: any) {
    if (isFatalError(e)) throw e;
    return undefined;
  }
  if (!isPromise(result)) return result;
  return result.catch((e: any) => {
    if (isFatalError(e)) throw e;
    return undefined;
  });
}

function applyControlFlowWithLoc(
  control: ControlFlowInstruction,
  bridgeLoc: SourceLocation | undefined,
): symbol | LoopControlSignal {
  try {
    return applyControlFlow(control);
  } catch (err) {
    if (err instanceof BridgePanicError) {
      throw attachBridgeErrorMetadata(err, { bridgeLoc });
    }
    if (isFatalError(err)) throw err;
    throw wrapBridgeRuntimeError(err, { bridgeLoc });
  }
}

/**
 * Pull a ref with optional safe-navigation.
 */
function pullSafe(
  ctx: TreeContext,
  ref: NodeRef,
  pullChain?: Set<string>,
  bridgeLoc?: SourceLocation,
): MaybePromise<any> {
  let pull: any;
  try {
    pull = ctx.pullSingle(ref, pullChain, bridgeLoc);
  } catch (e: any) {
    if (isFatalError(e)) throw e;
    return undefined;
  }
  if (!isPromise(pull)) return pull;
  return pull.catch((e: any) => {
    if (isFatalError(e)) throw e;
    return undefined;
  });
}

// ── Trace recording helpers (V2) ────────────────────────────────────────────
//
// These operate on TraceWireBits directly (passed by caller) instead of
// looking up from the Wire-keyed map. This decouples V2 from the
// legacy Wire identity during staged migration.

function recordSourceBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
  index: number,
): void {
  if (!bits || !ctx.traceMask) return;
  if (index === 0) {
    if (bits.primary != null) ctx.traceMask[0] |= 1n << BigInt(bits.primary);
  } else {
    const fb = bits.fallbacks;
    const fbIndex = index - 1;
    if (fb && fb[fbIndex] != null)
      ctx.traceMask[0] |= 1n << BigInt(fb[fbIndex]);
  }
}

function recordSourceErrorBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
  index: number,
): void {
  if (!bits || !ctx.traceMask) return;
  if (index === 0) {
    if (bits.primaryError != null)
      ctx.traceMask[0] |= 1n << BigInt(bits.primaryError);
  } else {
    const fb = bits.fallbackErrors;
    const fbIndex = index - 1;
    if (fb && fb[fbIndex] != null)
      ctx.traceMask[0] |= 1n << BigInt(fb[fbIndex]);
  }
}

function recordFallbackBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
  fallbackIndex: number,
): void {
  if (!bits || !ctx.traceMask) return;
  const fb = bits.fallbacks;
  if (fb && fb[fallbackIndex] != null)
    ctx.traceMask[0] |= 1n << BigInt(fb[fallbackIndex]);
}

function recordFallbackErrorBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
  fallbackIndex: number,
): void {
  if (!bits || !ctx.traceMask) return;
  const fb = bits.fallbackErrors;
  if (fb && fb[fallbackIndex] != null)
    ctx.traceMask[0] |= 1n << BigInt(fb[fallbackIndex]);
}

function recordCatchBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
): void {
  if (!bits || !ctx.traceMask) return;
  if (bits.catch != null) ctx.traceMask[0] |= 1n << BigInt(bits.catch);
}

function recordCatchErrorBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
): void {
  if (!bits || !ctx.traceMask) return;
  if (bits.catchError != null)
    ctx.traceMask[0] |= 1n << BigInt(bits.catchError);
}

function recordElseBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
): void {
  if (!bits || !ctx.traceMask) return;
  if (bits.else != null) ctx.traceMask[0] |= 1n << BigInt(bits.else);
}

function recordElseErrorBit(
  ctx: TreeContext,
  bits: TraceWireBits | undefined,
): void {
  if (!bits || !ctx.traceMask) return;
  if (bits.elseError != null) ctx.traceMask[0] |= 1n << BigInt(bits.elseError);
}
