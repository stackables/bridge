import type { Bridge, Statement, Expression } from "@stackables/bridge-core";

/**
 * Thrown when a bridge operation cannot be executed correctly using the
 * field-by-field GraphQL resolver.
 *
 * `bridgeTransform` catches this error automatically and switches the affected
 * operation to standalone execution mode, logging a warning.
 *
 * Additional incompatibility checks can be added to
 * {@link assertBridgeGraphQLCompatible} — each one throws this error with a
 * descriptive message and `bridgeTransform` handles them uniformly.
 */
export class BridgeGraphQLIncompatibleError extends Error {
  constructor(
    /** The affected operation in `"Type.field"` format. */
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeGraphQLIncompatibleError";
  }
}

/**
 * Check whether an expression tree contains break/continue control flow.
 */
function exprHasLoopControl(expr: Expression): boolean {
  switch (expr.type) {
    case "control":
      return expr.control.kind === "break" || expr.control.kind === "continue";
    case "ternary":
      return (
        exprHasLoopControl(expr.cond) ||
        exprHasLoopControl(expr.then) ||
        exprHasLoopControl(expr.else)
      );
    case "and":
    case "or":
    case "binary":
      return exprHasLoopControl(expr.left) || exprHasLoopControl(expr.right);
    case "unary":
      return exprHasLoopControl(expr.operand);
    case "pipe":
      return exprHasLoopControl(expr.source);
    case "concat":
      return expr.parts.some(exprHasLoopControl);
    case "array":
      return exprHasLoopControl(expr.source);
    default:
      return false;
  }
}

/**
 * Walk statements inside an array body to find break/continue in
 * element sub-field wires. Returns the offending path or undefined.
 */
function findLoopControlInArrayBody(body: Statement[]): string | undefined {
  for (const stmt of body) {
    switch (stmt.kind) {
      case "wire": {
        const hasControl =
          stmt.sources.some((s) => exprHasLoopControl(s.expr)) ||
          (stmt.catch &&
            "control" in stmt.catch &&
            (stmt.catch.control.kind === "break" ||
              stmt.catch.control.kind === "continue"));
        if (hasControl) {
          return stmt.target.path.join(".");
        }
        break;
      }
      case "alias": {
        const hasControl = stmt.sources.some((s) => exprHasLoopControl(s.expr));
        if (hasControl) return stmt.name;
        break;
      }
      case "scope": {
        const found = findLoopControlInArrayBody(stmt.body);
        if (found) return found;
        break;
      }
    }
  }
  return undefined;
}

/**
 * Walk a statement tree and check for break/continue inside array element
 * sub-field wires (which are incompatible with field-by-field GraphQL).
 */
function checkBodyForArrayLoopControl(
  statements: Statement[],
  op: string,
): void {
  for (const stmt of statements) {
    switch (stmt.kind) {
      case "wire": {
        // Check for array expressions in sources
        for (const source of stmt.sources) {
          checkExprForArrayLoopControl(source.expr, op);
        }
        break;
      }
      case "alias": {
        for (const source of stmt.sources) {
          checkExprForArrayLoopControl(source.expr, op);
        }
        break;
      }
      case "scope":
        checkBodyForArrayLoopControl(stmt.body, op);
        break;
    }
  }
}

function checkExprForArrayLoopControl(expr: Expression, op: string): void {
  switch (expr.type) {
    case "array": {
      const path = findLoopControlInArrayBody(expr.body);
      if (path !== undefined) {
        throw new BridgeGraphQLIncompatibleError(
          op,
          `[bridge] ${op}: 'break' / 'continue' inside an array element ` +
            `sub-field (path: ${path}) is not supported in field-by-field ` +
            `GraphQL execution.`,
        );
      }
      // Recurse into the array body for nested arrays
      checkBodyForArrayLoopControl(expr.body, op);
      // Recurse into the array source expression
      checkExprForArrayLoopControl(expr.source, op);
      break;
    }
    case "ternary":
      checkExprForArrayLoopControl(expr.cond, op);
      checkExprForArrayLoopControl(expr.then, op);
      checkExprForArrayLoopControl(expr.else, op);
      break;
    case "and":
    case "or":
    case "binary":
      checkExprForArrayLoopControl(expr.left, op);
      checkExprForArrayLoopControl(expr.right, op);
      break;
    case "unary":
      checkExprForArrayLoopControl(expr.operand, op);
      break;
    case "pipe":
      checkExprForArrayLoopControl(expr.source, op);
      break;
    case "concat":
      for (const part of expr.parts) {
        checkExprForArrayLoopControl(part, op);
      }
      break;
  }
}

/**
 * Assert that a bridge operation is compatible with field-by-field GraphQL
 * execution. Throws {@link BridgeGraphQLIncompatibleError} for each detected
 * incompatibility.
 *
 * `bridgeTransform` calls this for every bridge and catches the error to
 * automatically fall back to standalone execution mode — no rethrow or message
 * remapping needed; the error message is already the final warning text.
 *
 * **Currently detected incompatibilities:**
 *
 * - **`break` / `continue` inside array element sub-fields** — GraphQL
 *   resolves array elements field-by-field through independent resolver
 *   callbacks.  A control-flow signal emitted from a sub-field resolver
 *   cannot remove or skip the already-committed parent array element.
 *   Standalone mode handles these correctly.
 */
export function assertBridgeGraphQLCompatible(bridge: Bridge): void {
  const op = `${bridge.type}.${bridge.field}`;
  checkBodyForArrayLoopControl(bridge.body, op);
}
