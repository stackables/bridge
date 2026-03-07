import type { Bridge } from "@stackables/bridge-core";

export class BridgeCompilerIncompatibleError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeCompilerIncompatibleError";
  }
}

export function assertBridgeCompilerCompatible(_bridge: Bridge): void {
  // Intentionally empty: all currently supported bridge constructs compile.
}
