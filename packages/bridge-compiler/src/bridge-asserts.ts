import {
  SELF_MODULE,
  type Bridge,
  type NodeRef,
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

export function assertBridgeCompilerCompatible(bridge: Bridge): void {
  const op = `${bridge.type}.${bridge.field}`;

  // Pipe-handle trunk keys — block-scoped aliases inside array maps
  // reference these; the compiler handles them correctly.
  const pipeTrunkKeys = new Set((bridge.pipeHandles ?? []).map((ph) => ph.key));

  for (const w of bridge.wires) {
    // User-level alias (Shadow) wires: compiler has TDZ ordering bugs.
    // Block-scoped aliases inside array maps wire FROM a pipe-handle tool
    // instance (key is in pipeTrunkKeys) and are handled correctly.
    if (w.to.module === "__local" && w.to.type === "Shadow") {
      if (!("from" in w)) continue;
      const fromKey =
        w.from.instance != null
          ? `${w.from.module}:${w.from.type}:${w.from.field}:${w.from.instance}`
          : `${w.from.module}:${w.from.type}:${w.from.field}`;
      if (!pipeTrunkKeys.has(fromKey)) {
        throw new BridgeCompilerIncompatibleError(
          op,
          "Alias (shadow) wires are not yet supported by the compiler.",
        );
      }
      continue;
    }

    if (!("from" in w)) continue;

    // safe: true wires WITHOUT catch — compiler doesn't correctly catch
    // tool errors via bare ?. (it works when combined with catch).
    if (w.safe && !w.catchFallback && !w.catchFallbackRef && !w.catchControl) {
      throw new BridgeCompilerIncompatibleError(
        op,
        "Safe execution modifier (?.) without catch is not yet supported by the compiler.",
      );
    }

    // Fallback chains (|| / ??) with tool-backed refs — compiler eagerly
    // calls all tools via Promise.all, so short-circuit semantics are lost
    // and tool side effects fire unconditionally.
    if (w.fallbacks) {
      for (const fb of w.fallbacks) {
        if (fb.ref && isToolRef(fb.ref, bridge)) {
          throw new BridgeCompilerIncompatibleError(
            op,
            "Fallback chains (|| / ??) with tool-backed sources are not yet supported by the compiler.",
          );
        }
      }
    }
  }
}
