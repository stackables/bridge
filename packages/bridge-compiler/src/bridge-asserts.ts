import {
  SELF_MODULE,
  type Bridge,
  type NodeRef,
  type Wire,
} from "@stackables/bridge-core";

const isPull = (w: Wire): boolean => w.sources[0]?.expr.type === "ref";
const wRef = (w: Wire): NodeRef => (w.sources[0].expr as { ref: NodeRef }).ref;

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

  const wires: Wire[] = bridge.wires;

  // Pipe-handle trunk keys — block-scoped aliases inside array maps
  // reference these; the compiler handles them correctly.
  const pipeTrunkKeys = new Set((bridge.pipeHandles ?? []).map((ph) => ph.key));

  for (const w of wires) {
    // User-level alias (Shadow) wires: compiler has TDZ ordering bugs.
    // Block-scoped aliases inside array maps wire FROM a pipe-handle tool
    // instance (key is in pipeTrunkKeys) and are handled correctly.
    if (w.to.module === "__local" && w.to.type === "Shadow") {
      if (!isPull(w)) continue;
      const fromKey =
        wRef(w).instance != null
          ? `${wRef(w).module}:${wRef(w).type}:${wRef(w).field}:${wRef(w).instance}`
          : `${wRef(w).module}:${wRef(w).type}:${wRef(w).field}`;
      if (!pipeTrunkKeys.has(fromKey)) {
        throw new BridgeCompilerIncompatibleError(
          op,
          "Alias (shadow) wires are not yet supported by the compiler.",
        );
      }
      continue;
    }

    if (!isPull(w)) continue;

    // Catch fallback on pipe wires (expression results) — the catch must
    // propagate to the upstream tool, not the internal operator; codegen
    // does not handle this yet.
    if (w.pipe && w.catch) {
      throw new BridgeCompilerIncompatibleError(
        op,
        "Catch fallback on expression (pipe) wires is not yet supported by the compiler.",
      );
    }

    // Catch fallback that references a pipe handle — the compiler eagerly
    // calls all tools in the catch branch even when the main wire succeeds.
    if (w.catch && "ref" in w.catch) {
      const ref = w.catch.ref;
      if (ref.instance != null) {
        const refKey = `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`;
        if (bridge.pipeHandles?.some((ph) => ph.key === refKey)) {
          throw new BridgeCompilerIncompatibleError(
            op,
            "Catch fallback referencing a pipe expression is not yet supported by the compiler.",
          );
        }
      }
    }

    // Catch fallback on wires whose source tool has tool-backed input
    // dependencies — the compiler only catch-guards the direct source
    // tool, not its transitive dependency chain.
    if (w.catch && isToolRef(wRef(w), bridge)) {
      const sourceTrunk = `${wRef(w).module}:${wRef(w).type}:${wRef(w).field}`;
      for (const iw of wires) {
        if (!isPull(iw)) continue;
        const iwDest = `${iw.to.module}:${iw.to.type}:${iw.to.field}`;
        if (iwDest === sourceTrunk && isToolRef(wRef(iw), bridge)) {
          throw new BridgeCompilerIncompatibleError(
            op,
            "Catch fallback on wires with tool chain dependencies is not yet supported by the compiler.",
          );
        }
      }
    }

    // Fallback chains (|| / ??) with tool-backed refs — compiler eagerly
    // calls all tools via Promise.all, so short-circuit semantics are lost
    // and tool side effects fire unconditionally.
    for (const src of w.sources.slice(1)) {
      if (src.expr.type === "ref" && isToolRef(src.expr.ref, bridge)) {
        throw new BridgeCompilerIncompatibleError(
          op,
          "Fallback chains (|| / ??) with tool-backed sources are not yet supported by the compiler.",
        );
      }
    }
  }

  // Same-cost overdefinition sourced only from tools can diverge from runtime
  // tracing/error behavior in current AOT codegen; compile must downgrade.
  const toolOnlyOverdefs = new Map<string, number>();
  for (const w of wires) {
    if (
      w.to.module !== SELF_MODULE ||
      w.to.type !== bridge.type ||
      w.to.field !== bridge.field
    ) {
      continue;
    }
    if (!isPull(w) || !isToolRef(wRef(w), bridge)) {
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

  // Pipe handles with extra bridge wires to the same tool — the compiler
  // treats pipe forks as independent tool calls, so bridge wires that set
  // fields on the main tool trunk are not merged into the fork's input.
  if (bridge.pipeHandles && bridge.pipeHandles.length > 0) {
    const pipeHandleKeys = new Set<string>();
    const pipedToolNames = new Set<string>();
    for (const ph of bridge.pipeHandles) {
      pipeHandleKeys.add(ph.key);
      pipedToolNames.add(
        `${ph.baseTrunk.module}:${ph.baseTrunk.type}:${ph.baseTrunk.field}`,
      );
    }

    for (const w of wires) {
      if (!isPull(w) || w.to.path.length === 0) continue;
      // Build the full key for this wire target
      const fullKey =
        w.to.instance != null
          ? `${w.to.module}:${w.to.type}:${w.to.field}:${w.to.instance}`
          : `${w.to.module}:${w.to.type}:${w.to.field}`;
      // Skip wires that target the pipe handle itself (fork input)
      if (pipeHandleKeys.has(fullKey)) continue;
      // Check if this wire targets a tool that also has pipe calls
      const toolName = `${w.to.module}:${w.to.type}:${w.to.field}`;
      if (pipedToolNames.has(toolName)) {
        throw new BridgeCompilerIncompatibleError(
          op,
          "Bridge wires that set fields on a tool with pipe calls are not yet supported by the compiler.",
        );
      }
    }
  }
}
