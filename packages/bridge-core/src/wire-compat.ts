/**
 * Wire compatibility layer — conversion between legacy Wire (discriminated
 * union) and the unified WireV2 (ordered sources array).
 *
 * Temporary module: will be removed after all consumers migrate to WireV2.
 */

import type {
  ControlFlowInstruction,
  Expression,
  NodeRef,
  Wire,
  WireCatch,
  WireFallback,
  WireSourceEntry,
  WireV2,
} from "./types.ts";

// ── Legacy → V2 ─────────────────────────────────────────────────────────────

/** Convert a legacy Wire to the unified WireV2 representation. */
export function legacyToV2(w: Wire): WireV2 {
  // Constant wire
  if ("value" in w) {
    return {
      to: w.to,
      sources: [{ expr: { type: "literal", value: w.value, loc: w.loc } }],
      loc: w.loc,
    };
  }

  // Build the primary expression from the wire variant
  let primaryExpr: Expression;
  let primaryLoc = w.loc;

  if ("from" in w) {
    primaryExpr = {
      type: "ref",
      ref: w.from,
      ...(w.safe ? { safe: true } : {}),
      ...(w.fromLoc ? { refLoc: w.fromLoc } : {}),
      loc: w.fromLoc ?? w.loc,
    };
  } else if ("cond" in w) {
    primaryExpr = {
      type: "ternary",
      cond: { type: "ref", ref: w.cond, loc: w.condLoc ?? w.loc },
      then: condBranchToExpr(w.thenRef, w.thenValue, w.thenLoc ?? w.loc),
      else: condBranchToExpr(w.elseRef, w.elseValue, w.elseLoc ?? w.loc),
      ...(w.condLoc ? { condLoc: w.condLoc } : {}),
      ...(w.thenLoc ? { thenLoc: w.thenLoc } : {}),
      ...(w.elseLoc ? { elseLoc: w.elseLoc } : {}),
      loc: w.loc,
    };
  } else if ("condAnd" in w) {
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condAnd;
    primaryExpr = {
      type: "and",
      left: {
        type: "ref",
        ref: leftRef,
        ...(safe ? { safe: true } : {}),
        loc: w.loc,
      },
      right: condOperandToExpr(rightRef, rightValue, rightSafe, w.loc),
      ...(safe ? { leftSafe: true } : {}),
      ...(rightSafe ? { rightSafe: true } : {}),
      loc: w.loc,
    };
  } else {
    // condOr
    const { leftRef, rightRef, rightValue, safe, rightSafe } = w.condOr;
    primaryExpr = {
      type: "or",
      left: {
        type: "ref",
        ref: leftRef,
        ...(safe ? { safe: true } : {}),
        loc: w.loc,
      },
      right: condOperandToExpr(rightRef, rightValue, rightSafe, w.loc),
      ...(safe ? { leftSafe: true } : {}),
      ...(rightSafe ? { rightSafe: true } : {}),
      loc: w.loc,
    };
  }

  // Build sources array: primary + fallback entries
  const sources: WireSourceEntry[] = [{ expr: primaryExpr, loc: primaryLoc }];

  const fallbacks = "fallbacks" in w ? w.fallbacks : undefined;
  if (fallbacks) {
    for (const fb of fallbacks) {
      sources.push(fallbackToSourceEntry(fb));
    }
  }

  // Build catch handler
  let wireCatch: WireCatch | undefined;
  const catchLoc = "catchLoc" in w ? w.catchLoc : undefined;
  if ("catchControl" in w && w.catchControl) {
    wireCatch = {
      control: w.catchControl,
      ...(catchLoc ? { loc: catchLoc } : {}),
    };
  } else if ("catchFallbackRef" in w && w.catchFallbackRef) {
    wireCatch = {
      ref: w.catchFallbackRef,
      ...(catchLoc ? { loc: catchLoc } : {}),
    };
  } else if ("catchFallback" in w && w.catchFallback != null) {
    wireCatch = {
      value: w.catchFallback,
      ...(catchLoc ? { loc: catchLoc } : {}),
    };
  }

  const result: WireV2 = {
    to: w.to,
    sources,
    loc: w.loc,
  };
  if (wireCatch) result.catch = wireCatch;
  if ("pipe" in w && w.pipe) result.pipe = true;
  if ("spread" in w && w.spread) result.spread = true;

  return result;
}

function condBranchToExpr(
  ref: NodeRef | undefined,
  value: string | undefined,
  loc: Wire["loc"],
): Expression {
  if (ref !== undefined) return { type: "ref", ref, loc };
  if (value !== undefined) return { type: "literal", value, loc };
  // Undefined branch — return a literal undefined
  return { type: "literal", value: "null", loc };
}

function condOperandToExpr(
  ref: NodeRef | undefined,
  value: string | undefined,
  safe: true | undefined,
  loc: Wire["loc"],
): Expression {
  if (ref !== undefined)
    return { type: "ref", ref, ...(safe ? { safe: true } : {}), loc };
  if (value !== undefined) return { type: "literal", value, loc };
  // No right operand — boolean(left) is the result; return a literal true
  // so the and/or evaluator can handle it
  return { type: "literal", value: "true", loc };
}

function fallbackToSourceEntry(fb: WireFallback): WireSourceEntry {
  let expr: Expression;
  if (fb.control) {
    expr = { type: "control", control: fb.control, loc: fb.loc };
  } else if (fb.ref) {
    expr = { type: "ref", ref: fb.ref, loc: fb.loc };
  } else {
    expr = { type: "literal", value: fb.value!, loc: fb.loc };
  }
  return {
    expr,
    gate: fb.type === "falsy" ? "falsy" : "nullish",
    loc: fb.loc,
  };
}

// ── V2 → Legacy ─────────────────────────────────────────────────────────────

/** Convert a unified WireV2 back to the legacy Wire discriminated union. */
export function v2ToLegacy(w: WireV2): Wire {
  const primary = w.sources[0]!;
  const fallbackEntries = w.sources.slice(1);
  const fallbacks: WireFallback[] = fallbackEntries.map(sourceEntryToFallback);

  // Build catch fields
  let catchFallback: string | undefined;
  let catchFallbackRef: NodeRef | undefined;
  let catchControl: ControlFlowInstruction | undefined;
  let catchLoc = w.catch?.loc;
  if (w.catch) {
    if ("control" in w.catch) catchControl = w.catch.control;
    else if ("ref" in w.catch) catchFallbackRef = w.catch.ref;
    else catchFallback = w.catch.value;
  }

  const sharedGates = {
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    ...(catchLoc ? { catchLoc } : {}),
    ...(catchFallback != null ? { catchFallback } : {}),
    ...(catchFallbackRef ? { catchFallbackRef } : {}),
    ...(catchControl ? { catchControl } : {}),
  };

  const expr = primary.expr;

  if (expr.type === "literal" && fallbackEntries.length === 0 && !w.catch) {
    return { value: expr.value, to: w.to, ...(w.loc ? { loc: w.loc } : {}) };
  }

  if (expr.type === "ref") {
    return {
      from: expr.ref,
      to: w.to,
      ...(w.loc ? { loc: w.loc } : {}),
      ...(expr.refLoc ? { fromLoc: expr.refLoc } : {}),
      ...(w.pipe ? { pipe: true } : {}),
      ...(w.spread ? { spread: true } : {}),
      ...(expr.safe ? { safe: true } : {}),
      ...sharedGates,
    };
  }

  if (expr.type === "ternary") {
    return {
      cond: exprToRef(expr.cond),
      ...(expr.condLoc ? { condLoc: expr.condLoc } : {}),
      ...ternaryBranchToLegacy("then", expr.then, expr.thenLoc),
      ...ternaryBranchToLegacy("else", expr.else, expr.elseLoc),
      to: w.to,
      ...(w.loc ? { loc: w.loc } : {}),
      ...sharedGates,
    };
  }

  if (expr.type === "and") {
    return {
      condAnd: {
        leftRef: exprToRef(expr.left),
        ...condOperandToLegacy(expr.right),
        ...(expr.leftSafe ? { safe: true } : {}),
        ...(expr.rightSafe ? { rightSafe: true } : {}),
      },
      to: w.to,
      ...(w.loc ? { loc: w.loc } : {}),
      ...sharedGates,
    };
  }

  if (expr.type === "or") {
    return {
      condOr: {
        leftRef: exprToRef(expr.left),
        ...condOperandToLegacy(expr.right),
        ...(expr.leftSafe ? { safe: true } : {}),
        ...(expr.rightSafe ? { rightSafe: true } : {}),
      },
      to: w.to,
      ...(w.loc ? { loc: w.loc } : {}),
      ...sharedGates,
    };
  }

  // control or literal with gates — wrap as a constant with gates
  // This shouldn't normally happen but handle gracefully
  if (expr.type === "literal") {
    return {
      from: { module: "_", type: "Const", field: "_", path: [] },
      to: w.to,
      ...(w.loc ? { loc: w.loc } : {}),
      ...sharedGates,
    };
  }

  // control expression as primary — unusual but produce a valid wire
  return {
    from: { module: "_", type: "Const", field: "_", path: [] },
    to: w.to,
    ...(w.loc ? { loc: w.loc } : {}),
    ...sharedGates,
  };
}

function sourceEntryToFallback(entry: WireSourceEntry): WireFallback {
  const gate = entry.gate === "nullish" ? "nullish" : "falsy";
  const expr = entry.expr;
  if (expr.type === "control") {
    return {
      type: gate,
      control: expr.control,
      ...(entry.loc ? { loc: entry.loc } : {}),
    };
  }
  if (expr.type === "ref") {
    return {
      type: gate,
      ref: expr.ref,
      ...(entry.loc ? { loc: entry.loc } : {}),
    };
  }
  if (expr.type === "literal") {
    return {
      type: gate,
      value: expr.value,
      ...(entry.loc ? { loc: entry.loc } : {}),
    };
  }
  // Complex expression in fallback position — not representable in legacy
  // Shouldn't happen during migration; use a placeholder
  return {
    type: gate,
    value: "null",
    ...(entry.loc ? { loc: entry.loc } : {}),
  };
}

function exprToRef(e: Expression): NodeRef {
  if (e.type === "ref") return e.ref;
  // Should not happen in well-formed conversions
  return { module: "_", type: "Const", field: "_", path: [] };
}

function ternaryBranchToLegacy(
  branch: "then" | "else",
  expr: Expression,
  branchLoc: Expression["loc"],
): Record<string, any> {
  const refKey = branch === "then" ? "thenRef" : "elseRef";
  const valueKey = branch === "then" ? "thenValue" : "elseValue";
  const locKey = branch === "then" ? "thenLoc" : "elseLoc";
  const result: Record<string, any> = {};
  if (branchLoc) result[locKey] = branchLoc;
  if (expr.type === "ref") result[refKey] = expr.ref;
  else if (expr.type === "literal") result[valueKey] = expr.value;
  return result;
}

function condOperandToLegacy(expr: Expression): {
  rightRef?: NodeRef;
  rightValue?: string;
} {
  if (expr.type === "ref") return { rightRef: expr.ref };
  if (expr.type === "literal" && expr.value !== "true")
    return { rightValue: expr.value };
  return {};
}

// ── Expression type guards ──────────────────────────────────────────────────

export function isRefExpr(
  e: Expression,
): e is Extract<Expression, { type: "ref" }> {
  return e.type === "ref";
}

export function isLiteralExpr(
  e: Expression,
): e is Extract<Expression, { type: "literal" }> {
  return e.type === "literal";
}

export function isTernaryExpr(
  e: Expression,
): e is Extract<Expression, { type: "ternary" }> {
  return e.type === "ternary";
}

export function isAndExpr(
  e: Expression,
): e is Extract<Expression, { type: "and" }> {
  return e.type === "and";
}

export function isOrExpr(
  e: Expression,
): e is Extract<Expression, { type: "or" }> {
  return e.type === "or";
}

export function isControlExpr(
  e: Expression,
): e is Extract<Expression, { type: "control" }> {
  return e.type === "control";
}

/**
 * Check if a WireV2 qualifies for the simple-pull fast path:
 * single ref source, not safe, no fallbacks, no catch.
 */
export function getSimplePullRefV2(w: WireV2): NodeRef | null {
  if (w.sources.length !== 1 || w.catch) return null;
  const expr = w.sources[0]!.expr;
  if (expr.type === "ref" && !expr.safe) return expr.ref;
  return null;
}
