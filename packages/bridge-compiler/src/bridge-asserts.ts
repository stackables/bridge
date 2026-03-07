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

export function assertBridgeCompilerCompatible(bridge: Bridge): void {
  const operation = `${bridge.type}.${bridge.field}`;
  const memoizedHandles = bridge.handles
    .filter((handle) => handle.kind === "tool" && handle.memoize)
    .map((handle) => handle.handle);

  if (memoizedHandles.length > 0) {
    throw new BridgeCompilerIncompatibleError(
      operation,
      `[bridge-compiler] ${operation}: memoized tool handles are not supported by AOT compilation yet (${memoizedHandles.join(", ")}).`,
    );
  }
}
