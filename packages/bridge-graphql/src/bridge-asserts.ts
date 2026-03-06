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
 * - **Nested multilevel `break N` / `continue N`** — GraphQL resolves array
 *   elements field-by-field through independent resolver callbacks. A
 *   multilevel `LoopControlSignal` emitted deep inside an inner array element
 *   cannot propagate back out to the already-committed outer shadow array.
 */
export function assertBridgeGraphQLCompatible(bridge: Bridge): void {
  const op = `${bridge.type}.${bridge.field}`;

  for (const wire of bridge.wires) {
    if (wire.to.path.length <= 1) continue;

    const fallbacks =
      "from" in wire
        ? wire.fallbacks
        : "cond" in wire
          ? wire.fallbacks
          : "condAnd" in wire
            ? wire.fallbacks
            : "condOr" in wire
              ? wire.fallbacks
              : undefined;

    const catchControl =
      "from" in wire
        ? wire.catchControl
        : "cond" in wire
          ? wire.catchControl
          : "condAnd" in wire
            ? wire.catchControl
            : "condOr" in wire
              ? wire.catchControl
              : undefined;

    const isMultilevel = (
      ctrl: { kind: string; levels?: number } | undefined,
    ) =>
      ctrl &&
      (ctrl.kind === "break" || ctrl.kind === "continue") &&
      (ctrl.levels ?? 1) > 1;

    if (
      fallbacks?.some((fb) => isMultilevel(fb.control)) ||
      isMultilevel(catchControl)
    ) {
      const path = wire.to.path.join(".");
      throw new BridgeGraphQLIncompatibleError(
        op,
        `[bridge] ${op}: 'break N' / 'continue N' with N > 1 inside a nested ` +
          `array element (path: ${path}) is not supported in ` +
          `field-by-field GraphQL execution.`,
      );
    }
  }
}
