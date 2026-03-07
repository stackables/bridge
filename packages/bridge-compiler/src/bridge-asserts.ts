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
  const seenHandles = new Set<string>();
  const shadowedHandles = new Set<string>();

  for (const handle of bridge.handles) {
    if (handle.kind !== "tool") continue;
    if (seenHandles.has(handle.handle)) {
      shadowedHandles.add(handle.handle);
      continue;
    }
    seenHandles.add(handle.handle);
  }

  if (shadowedHandles.size > 0) {
    throw new BridgeCompilerIncompatibleError(
      operation,
      `[bridge-compiler] ${operation}: shadowed loop-scoped tool handles are not supported by AOT compilation yet (${[...shadowedHandles].join(", ")}).`,
    );
  }
}
