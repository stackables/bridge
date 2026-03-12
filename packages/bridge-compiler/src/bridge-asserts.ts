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

export function assertBridgeCompilerCompatible(
  bridge: Bridge,
  requestedFields?: string[],
): void {
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

  // Same-cost overdefinition sourced only from tools can diverge from runtime
  // tracing/error behavior in current AOT codegen; compile must downgrade.
  const toolOnlyOverdefs = new Map<string, number>();
  for (const w of bridge.wires) {
    if (
      w.to.module !== SELF_MODULE ||
      w.to.type !== bridge.type ||
      w.to.field !== bridge.field
    ) {
      continue;
    }
    if (!("from" in w) || !isToolRef(w.from, bridge)) {
      continue;
    }

    const outputPath = w.to.path.join(".");
    if (!matchesRequestedField(outputPath, requestedFields)) {
      continue;
    }

    toolOnlyOverdefs.set(
      outputPath,
      (toolOnlyOverdefs.get(outputPath) ?? 0) + 1,
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
