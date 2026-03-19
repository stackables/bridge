/**
 * Expression evaluation for bridge statements.
 *
 * Evaluates `Expression` trees recursively. The public entry point is
 * `evaluateExpression`, called from `execute-bridge.ts`.
 */

import type { ControlFlowInstruction, Expression, NodeRef } from "./types.ts";
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
  BridgePanicError,
  wrapBridgeRuntimeError,
} from "./tree-types.ts";
import { coerceConstant } from "./tree-utils.ts";
import type { SourceLocation } from "@stackables/bridge-types";

// ── Public entry points ─────────────────────────────────────────────────────

/**
 * Evaluate a recursive Expression tree to a single value.
 *
 * Any expression that can appear in a source entry (ref, literal, ternary,
 * and/or, control) is recursively resolved here.
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

    case "array":
      // Array expressions are handled at a higher level (ExecutionTree).
      // If we reach here, it means the engine hasn't been updated yet.
      throw new Error(
        "Array expressions are not yet supported in evaluateExpression",
      );

    case "pipe":
      // Pipe expressions are handled at a higher level (ExecutionTree).
      // If we reach here, it means the engine hasn't been updated yet.
      throw new Error(
        "Pipe expressions are not yet supported in evaluateExpression",
      );

    case "binary":
      return evaluateBinary(ctx, expr, pullChain);

    case "unary":
      return evaluateUnary(ctx, expr, pullChain);

    case "concat":
      return evaluateConcat(ctx, expr, pullChain);
  }
}
// ── Internal helpers ────────────────────────────────────────────────────────

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

async function evaluateBinary(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "binary" }>,
  pullChain?: Set<string>,
): Promise<unknown> {
  const left = await evaluateExpression(ctx, expr.left, pullChain);
  const right = await evaluateExpression(ctx, expr.right, pullChain);
  switch (expr.op) {
    case "add":
    case "sub":
    case "mul":
    case "div":
      // Propagate null/undefined so that downstream `??` fallbacks can fire.
      // Without this, `undefined * N` produces NaN which is not null/undefined
      // and therefore does not trigger nullish coalescing.
      if (left == null || right == null) return null;
      switch (expr.op) {
        case "add":
          return Number(left) + Number(right);
        case "sub":
          return Number(left) - Number(right);
        case "mul":
          return Number(left) * Number(right);
        case "div":
          return Number(left) / Number(right);
      }
      break;
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
  }
}

async function evaluateUnary(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "unary" }>,
  pullChain?: Set<string>,
): Promise<boolean> {
  const val = await evaluateExpression(ctx, expr.operand, pullChain);
  return !val;
}

async function evaluateConcat(
  ctx: TreeContext,
  expr: Extract<Expression, { type: "concat" }>,
  pullChain?: Set<string>,
): Promise<string> {
  const parts = await Promise.all(
    expr.parts.map((p) => evaluateExpression(ctx, p, pullChain)),
  );
  return parts.map((v) => (v == null ? "" : String(v))).join("");
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
