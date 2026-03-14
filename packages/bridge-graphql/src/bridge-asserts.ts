import type { Bridge } from "@stackables/bridge-core";

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
 *   Standalone mode uses `materializeShadows` which handles these correctly.
 */
export function assertBridgeGraphQLCompatible(bridge: Bridge): void {
  const op = `${bridge.type}.${bridge.field}`;
  const arrayPaths = new Set(Object.keys(bridge.arrayIterators ?? {}));

  for (const wire of bridge.wires) {
    // Check if this wire targets a sub-field inside an array element.
    // Array iterators map output-path prefixes (e.g. "list" for o.list,
    // "" for root o) to their iterator variable.  A wire whose to.path
    // starts with one of those prefixes + at least one more segment is
    // an element sub-field wire.
    const toPath = wire.to.path;
    const isElementSubfield =
      (arrayPaths.has("") && toPath.length >= 1) ||
      toPath.some(
        (_, i) => i > 0 && arrayPaths.has(toPath.slice(0, i).join(".")),
      );

    if (!isElementSubfield) continue;

    // Check sources for break/continue control flow in fallback gates
    const hasControlFlowInSources = wire.sources.some(
      (s) =>
        s.expr.type === "control" &&
        (s.expr.control.kind === "break" || s.expr.control.kind === "continue"),
    );

    // Check catch handler for break/continue control flow
    const catchHasControlFlow =
      wire.catch &&
      "control" in wire.catch &&
      (wire.catch.control.kind === "break" ||
        wire.catch.control.kind === "continue");

    if (hasControlFlowInSources || catchHasControlFlow) {
      const path = wire.to.path.join(".");
      throw new BridgeGraphQLIncompatibleError(
        op,
        `[bridge] ${op}: 'break' / 'continue' inside an array element ` +
          `sub-field (path: ${path}) is not supported in field-by-field ` +
          `GraphQL execution.`,
      );
    }
  }
}
