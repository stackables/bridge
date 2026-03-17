import {
  SELF_MODULE,
  type Bridge,
  type NodeRef,
  type Statement,
  type Expression,
} from "@stackables/bridge-core";

export class BridgeCompilerIncompatibleError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeCompilerIncompatibleError";
  }
}

function matchesRequestedField(
  path: string,
  requestedFields?: string[],
): boolean {
  if (!requestedFields || requestedFields.length === 0) {
    return true;
  }

  return requestedFields.some((requested) => {
    if (requested === path) {
      return true;
    }

    if (requested.endsWith(".*")) {
      const prefix = requested.slice(0, -2);
      return path === prefix || path.startsWith(`${prefix}.`);
    }

    return false;
  });
}

function isToolRef(ref: NodeRef, bridge: Bridge): boolean {
  if (
    ref.module === SELF_MODULE &&
    ref.type === bridge.type &&
    ref.field === bridge.field
  )
    return false;
  if (ref.module === SELF_MODULE && ref.type === "Context") return false;
  if (ref.module === SELF_MODULE && ref.type === "Const") return false;
  if (ref.module.startsWith("__define_")) return false;
  if (ref.module === "__local") return false;
  return true;
}

function isToolBackedExpr(expr: Expression, bridge: Bridge): boolean {
  switch (expr.type) {
    case "ref":
      return isToolRef(expr.ref, bridge);
    case "pipe":
      return true;
    case "literal":
    case "control":
      return false;
    case "ternary":
      return (
        isToolBackedExpr(expr.cond, bridge) ||
        isToolBackedExpr(expr.then, bridge) ||
        isToolBackedExpr(expr.else, bridge)
      );
    case "and":
    case "or":
      return (
        isToolBackedExpr(expr.left, bridge) ||
        isToolBackedExpr(expr.right, bridge)
      );
    case "binary":
      return (
        isToolBackedExpr(expr.left, bridge) ||
        isToolBackedExpr(expr.right, bridge)
      );
    case "unary":
      return isToolBackedExpr(expr.operand, bridge);
    case "concat":
      return expr.parts.some((p) => isToolBackedExpr(p, bridge));
    case "array":
      return isToolBackedExpr(expr.source, bridge);
  }
}

interface OutputWireInfo {
  targetPath: string;
  primaryIsToolRef: boolean;
}

function collectOutputWires(
  body: Statement[],
  bridge: Bridge,
): OutputWireInfo[] {
  const selfKey = `${SELF_MODULE}:${bridge.type}:${bridge.field}`;
  const results: OutputWireInfo[] = [];

  function walk(stmts: Statement[], pathPrefix: string[]) {
    for (const s of stmts) {
      if (s.kind === "wire") {
        const tk = `${s.target.module}:${s.target.type}:${s.target.field}`;
        if (tk === selfKey && s.target.instance == null) {
          const fullPath = [...pathPrefix, ...s.target.path];
          const primary = s.sources[0]!;
          results.push({
            targetPath: fullPath.join("."),
            primaryIsToolRef:
              primary.expr.type === "ref" &&
              isToolRef(primary.expr.ref, bridge),
          });
        }
      }
      if (s.kind === "scope") {
        walk(s.body, [...pathPrefix, ...s.target.path]);
      }
    }
  }
  walk(body, []);
  return results;
}

export function assertBridgeCompilerCompatible(
  bridge: Bridge,
  requestedFields?: string[],
): void {
  if (!bridge.body) return;

  const op = `${bridge.type}.${bridge.field}`;

  // Check fallback chains with tool-backed refs
  function checkFallbackChains(stmts: Statement[]) {
    for (const s of stmts) {
      if (s.kind === "wire" || s.kind === "alias" || s.kind === "spread") {
        for (const src of s.sources.slice(1)) {
          if (isToolBackedExpr(src.expr, bridge)) {
            throw new BridgeCompilerIncompatibleError(
              op,
              "Fallback chains (|| / ??) with tool-backed sources are not yet supported by the compiler.",
            );
          }
        }
      }
      if (s.kind === "scope") {
        checkFallbackChains(s.body);
      }
    }
  }
  checkFallbackChains(bridge.body);

  // Same-cost overdefinition sourced only from tools
  const outputWires = collectOutputWires(bridge.body, bridge);
  const toolOnlyOverdefs = new Map<string, number>();

  for (const w of outputWires) {
    if (!w.primaryIsToolRef) continue;
    if (!matchesRequestedField(w.targetPath, requestedFields)) continue;
    toolOnlyOverdefs.set(
      w.targetPath,
      (toolOnlyOverdefs.get(w.targetPath) ?? 0) + 1,
    );
  }

  for (const [outputPath, count] of toolOnlyOverdefs) {
    if (count > 1) {
      throw new BridgeCompilerIncompatibleError(
        op,
        `Tool-only overdefinition for output path "${outputPath}" is not yet supported by the compiler.`,
      );
    }
  }
}
