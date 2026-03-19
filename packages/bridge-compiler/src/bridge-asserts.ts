import { type Bridge } from "@stackables/bridge-core";

export class BridgeCompilerIncompatibleError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeCompilerIncompatibleError";
  }
}

/**
 * Compatibility check — the new v2 compiler will throw
 * BridgeCompilerIncompatibleError from codegen itself for unsupported features.
 * This function is now a no-op; kept for API compatibility.
 */
export function assertBridgeCompilerCompatible(
  _bridge: Bridge,
  _requestedFields?: string[],
): void {
  // no-op — the new compiler handles incompatibility inline
}
