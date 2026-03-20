/**
 * Thrown when a bridge operation cannot be executed correctly using the
 * field-by-field GraphQL resolver.
 *
 * `bridgeTransform` catches this error automatically and switches the affected
 * operation to standalone execution mode, logging a warning.
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
