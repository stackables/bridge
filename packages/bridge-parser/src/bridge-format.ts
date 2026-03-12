import type {
  Bridge,
  BridgeDocument,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  NodeRef,
  ToolDef,
  Wire,
} from "@stackables/bridge-core";
import { SELF_MODULE } from "@stackables/bridge-core";
import {
  parseBridgeChevrotain,
  type ParseBridgeOptions,
} from "./parser/index.ts";
export { parsePath } from "@stackables/bridge-core";

/**
 * Parse .bridge text — delegates to the Chevrotain parser.
 */
export function parseBridge(
  text: string,
  options: ParseBridgeOptions = {},
): BridgeDocument {
  return parseBridgeChevrotain(text, options);
}

const BRIDGE_VERSION = "1.5";

const RESERVED_BARE_VALUE_KEYWORDS = new Set([
  // Declaration keywords
  "version",
  "bridge",
  "tool",
  "define",
  "with",
  "input",
  "output",
  "context",
  "const",
  "from",
  "as",
  "alias",
  "on",
  "error",
  "force",
  "catch",
  // Control flow
  "continue",
  "break",
  "throw",
  "panic",
  "if",
  "pipe",
  // Boolean/logic operators
  "and",
  "or",
  "not",
]);

/** Serialize a ControlFlowInstruction to its textual form. */
function serializeControl(ctrl: ControlFlowInstruction): string {
  if (ctrl.kind === "throw") return `throw ${JSON.stringify(ctrl.message)}`;
  if (ctrl.kind === "panic") return `panic ${JSON.stringify(ctrl.message)}`;
  if (ctrl.kind === "continue") {
    return ctrl.levels && ctrl.levels > 1
      ? `continue ${ctrl.levels}`
      : "continue";
  }
  return ctrl.levels && ctrl.levels > 1 ? `break ${ctrl.levels}` : "break";
}

// ── Serializer ───────────────────────────────────────────────────────────────

export function serializeBridge(doc: BridgeDocument): string {
  const version = doc.version ?? BRIDGE_VERSION;
  const { instructions } = doc;
  const bridges = instructions.filter((i): i is Bridge => i.kind === "bridge");
  const tools = instructions.filter((i): i is ToolDef => i.kind === "tool");
  const consts = instructions.filter((i): i is ConstDef => i.kind === "const");
  const defines = instructions.filter(
    (i): i is DefineDef => i.kind === "define",
  );
  if (
    bridges.length === 0 &&
    tools.length === 0 &&
    consts.length === 0 &&
    defines.length === 0
  )
    return "";

  const blocks: string[] = [];

  // Group const declarations into a single block
  if (consts.length > 0) {
    blocks.push(consts.map((c) => `const ${c.name} = ${c.value}`).join("\n"));
  }
  for (const tool of tools) {
    blocks.push(serializeToolBlock(tool));
  }
  for (const def of defines) {
    blocks.push(serializeDefineBlock(def));
  }
  for (const bridge of bridges) {
    blocks.push(serializeBridgeBlock(bridge));
  }

  return `version ${version}\n\n` + blocks.join("\n\n") + "\n";
}

/**
 * Whether a value string needs quoting to be re-parseable as a bare value.
 * Safe unquoted: number, boolean, null, /path, simple-identifier, keyword.
 * Already-quoted JSON strings (produced by the updated parser) are also safe.
 */
function needsQuoting(v: string): boolean {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return false; // JSON string literal
  if (v === "true" || v === "false" || v === "null") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) return false; // number
  if (/^\/[\w./-]+$/.test(v)) return false; // /path
  if (/^[a-zA-Z_][\w-]*$/.test(v)) {
    return RESERVED_BARE_VALUE_KEYWORDS.has(v);
  }
  return true;
}

/**
 * Format a bare-value string for output.
 * Pre-quoted JSON strings are emitted as-is; everything else goes through
 * the same quoting logic as needsQuoting.
 */
function formatBareValue(v: string): string {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v;
  return needsQuoting(v) ? `"${v}"` : v;
}

/**
 * Format a value that appears as an operand in an expression context.
 * Identifier-like strings must be quoted because bare identifiers in
 * expressions are parsed as source references, not string literals.
 */
function formatExprValue(v: string): string {
  if (/^[a-zA-Z_][\w-]*$/.test(v)) return `"${v}"`;
  return formatBareValue(v);
}

function serializeToolBlock(tool: ToolDef): string {
  const lines: string[] = [];
  const hasBody =
    tool.handles.length > 0 || tool.wires.length > 0 || !!tool.onError;

  // Declaration line — use `tool <name> from <source>` format
  const source = tool.extends ?? tool.fn;
  lines.push(
    hasBody
      ? `tool ${tool.name} from ${source} {`
      : `tool ${tool.name} from ${source}`,
  );

  // Handles (context, const, tool deps)
  for (const h of tool.handles) {
    if (h.kind === "context") {
      if (h.handle === "context") {
        lines.push(`  with context`);
      } else {
        lines.push(`  with context as ${h.handle}`);
      }
    } else if (h.kind === "const") {
      if (h.handle === "const") {
        lines.push(`  with const`);
      } else {
        lines.push(`  with const as ${h.handle}`);
      }
    } else if (h.kind === "tool") {
      const vTag = h.version ? `@${h.version}` : "";
      const memoize = h.memoize ? " memoize" : "";
      // Short form when handle == last segment of name
      const lastDot = h.name.lastIndexOf(".");
      const defaultHandle =
        lastDot !== -1 ? h.name.substring(lastDot + 1) : h.name;
      if (h.handle === defaultHandle && !vTag) {
        lines.push(`  with ${h.name}${memoize}`);
      } else {
        lines.push(`  with ${h.name}${vTag} as ${h.handle}${memoize}`);
      }
    }
  }

  // ── Build internal-fork registries for expressions and concat ──────
  const TOOL_FN_TO_OP: Record<string, string> = {
    multiply: "*",
    divide: "/",
    add: "+",
    subtract: "-",
    eq: "==",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };

  const refTk = (ref: NodeRef): string =>
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;

  // Expression fork info
  type ToolExprForkInfo = {
    op: string;
    aWire: Extract<Wire, { from: NodeRef }> | undefined;
    bWire: Wire | undefined;
  };
  const exprForks = new Map<string, ToolExprForkInfo>();
  const exprInternalWires = new Set<Wire>();

  // Concat fork info
  type ToolConcatForkInfo = {
    parts: ({ kind: "text"; value: string } | { kind: "ref"; ref: NodeRef })[];
  };
  const concatForks = new Map<string, ToolConcatForkInfo>();
  const concatInternalWires = new Set<Wire>();

  // Pipe handle keys for detecting pipe wires
  const pipeHandleTrunkKeys = new Set<string>();

  for (const ph of tool.pipeHandles ?? []) {
    pipeHandleTrunkKeys.add(ph.key);

    // Expression forks: __expr_N with known operator base trunk
    if (ph.handle.startsWith("__expr_")) {
      const op = TOOL_FN_TO_OP[ph.baseTrunk.field];
      if (!op) continue;
      let aWire: Extract<Wire, { from: NodeRef }> | undefined;
      let bWire: Wire | undefined;
      for (const w of tool.wires) {
        const wTo = w.to;
        if (refTk(wTo) !== ph.key || wTo.path.length !== 1) continue;
        if (wTo.path[0] === "a" && "from" in w)
          aWire = w as Extract<Wire, { from: NodeRef }>;
        else if (wTo.path[0] === "b") bWire = w;
      }
      exprForks.set(ph.key, { op, aWire, bWire });
      if (aWire) exprInternalWires.add(aWire);
      if (bWire) exprInternalWires.add(bWire);
    }

    // Concat forks: __concat_N with baseTrunk.field === "concat"
    if (ph.handle.startsWith("__concat_") && ph.baseTrunk.field === "concat") {
      const partsMap = new Map<
        number,
        { kind: "text"; value: string } | { kind: "ref"; ref: NodeRef }
      >();
      for (const w of tool.wires) {
        const wTo = w.to;
        if (refTk(wTo) !== ph.key) continue;
        if (wTo.path.length !== 2 || wTo.path[0] !== "parts") continue;
        const idx = parseInt(wTo.path[1], 10);
        if (isNaN(idx)) continue;
        if ("value" in w && !("from" in w)) {
          partsMap.set(idx, { kind: "text", value: (w as any).value });
        } else if ("from" in w) {
          partsMap.set(idx, {
            kind: "ref",
            ref: (w as Extract<Wire, { from: NodeRef }>).from,
          });
        }
        concatInternalWires.add(w);
      }
      const maxIdx = Math.max(...partsMap.keys(), -1);
      const parts: ToolConcatForkInfo["parts"] = [];
      for (let i = 0; i <= maxIdx; i++) {
        const part = partsMap.get(i);
        if (part) parts.push(part);
      }
      concatForks.set(ph.key, { parts });
    }
  }

  // Mark output wires from expression/concat forks as internal
  for (const w of tool.wires) {
    if (!("from" in w)) continue;
    const fromTk = refTk(w.from);
    if (
      w.from.path.length === 0 &&
      (exprForks.has(fromTk) || concatForks.has(fromTk))
    ) {
      // This is the output wire from a fork to the tool's self-wire target.
      // We'll emit this as the main wire with the reconstructed expression.
      // Don't mark it as internal — we still process it, but with special logic.
    }
  }

  /** Serialize a ref using the tool's handle map. */
  function serToolRef(ref: NodeRef): string {
    return serializeToolWireSource(ref, tool);
  }

  /**
   * Recursively reconstruct an expression string from a fork chain.
   * E.g. for `const.one + 1` returns "const.one + 1".
   */
  function reconstructExpr(forkTk: string, parentPrec?: number): string {
    const info = exprForks.get(forkTk);
    if (!info) return forkTk;

    // Reconstruct left operand
    let left: string;
    if (info.aWire) {
      const aFromTk = refTk(info.aWire.from);
      if (exprForks.has(aFromTk)) {
        left = reconstructExpr(
          aFromTk,
          TOOL_PREC[info.op as keyof typeof TOOL_PREC],
        );
      } else {
        left = serToolRef(info.aWire.from);
      }
    } else {
      left = "?";
    }

    // Reconstruct right operand
    let right: string;
    if (info.bWire) {
      if ("from" in info.bWire) {
        const bFromTk = refTk(
          (info.bWire as Extract<Wire, { from: NodeRef }>).from,
        );
        if (exprForks.has(bFromTk)) {
          right = reconstructExpr(
            bFromTk,
            TOOL_PREC[info.op as keyof typeof TOOL_PREC],
          );
        } else {
          right = serToolRef(
            (info.bWire as Extract<Wire, { from: NodeRef }>).from,
          );
        }
      } else if ("value" in info.bWire) {
        right = formatExprValue((info.bWire as any).value);
      } else {
        right = "?";
      }
    } else {
      right = "?";
    }

    const expr = `${left} ${info.op} ${right}`;
    const myPrec = TOOL_PREC[info.op as keyof typeof TOOL_PREC] ?? 0;
    if (parentPrec != null && myPrec < parentPrec) return `(${expr})`;
    return expr;
  }
  const TOOL_PREC: Record<string, number> = {
    "*": 4,
    "/": 4,
    "+": 3,
    "-": 3,
    "==": 2,
    "!=": 2,
    ">": 2,
    ">=": 2,
    "<": 2,
    "<=": 2,
  };

  /**
   * Reconstruct a template string from a concat fork.
   */
  function reconstructTemplateStr(forkTk: string): string | null {
    const info = concatForks.get(forkTk);
    if (!info || info.parts.length === 0) return null;
    let result = "";
    for (const part of info.parts) {
      if (part.kind === "text") {
        result += part.value.replace(/\\/g, "\\\\").replace(/\{/g, "\\{");
      } else {
        result += `{${serToolRef(part.ref)}}`;
      }
    }
    return `"${result}"`;
  }

  // Wires — self-wires (targeting the tool's own trunk) get `.` prefix;
  // handle-targeted wires (targeting declared handles) use bare target names
  for (const wire of tool.wires) {
    // Skip internal expression/concat wires
    if (exprInternalWires.has(wire) || concatInternalWires.has(wire)) continue;

    const isSelfWire =
      wire.to.module === SELF_MODULE &&
      wire.to.type === "Tools" &&
      wire.to.field === tool.name;
    const prefix = isSelfWire ? "." : "";

    // Check if this wire's source is an expression or concat fork
    if ("from" in wire) {
      const fromTk = refTk(wire.from);

      // Expression fork output wire
      if (wire.from.path.length === 0 && exprForks.has(fromTk)) {
        const target = wire.to.path.join(".");
        const exprStr = reconstructExpr(fromTk);
        // Check for ternary, coalesce, fallbacks, catch on the wire
        let suffix = "";
        if ("cond" in wire) {
          const condWire = wire as any;
          const trueVal =
            "trueValue" in condWire
              ? formatBareValue(condWire.trueValue)
              : serToolRef(condWire.trueRef);
          const falseVal =
            "falseValue" in condWire
              ? formatBareValue(condWire.falseValue)
              : serToolRef(condWire.falseRef);
          lines.push(
            `  ${prefix}${target} <- ${exprStr} ? ${trueVal} : ${falseVal}`,
          );
          continue;
        }
        if ((wire as any).nullCoalesceRef) {
          suffix = ` ?? ${serToolRef((wire as any).nullCoalesceRef)}`;
        } else if ((wire as any).nullCoalesceValue != null) {
          suffix = ` ?? ${formatBareValue((wire as any).nullCoalesceValue)}`;
        }
        if ((wire as any).catchFallbackRef) {
          suffix += ` catch ${serToolRef((wire as any).catchFallbackRef)}`;
        } else if ((wire as any).catchFallback != null) {
          suffix += ` catch ${formatBareValue((wire as any).catchFallback)}`;
        }
        lines.push(`  ${prefix}${target} <- ${exprStr}${suffix}`);
        continue;
      }

      // Concat fork output wire (template string)
      if (
        wire.from.path.length <= 1 &&
        concatForks.has(
          wire.from.path.length === 0
            ? fromTk
            : refTk({ ...wire.from, path: [] }),
        )
      ) {
        const concatTk =
          wire.from.path.length === 0
            ? fromTk
            : refTk({ ...wire.from, path: [] });
        // Only handle .value path (standard concat output)
        if (
          wire.from.path.length === 0 ||
          (wire.from.path.length === 1 && wire.from.path[0] === "value")
        ) {
          const target = wire.to.path.join(".");
          const tmpl = reconstructTemplateStr(concatTk);
          if (tmpl) {
            lines.push(`  ${prefix}${target} <- ${tmpl}`);
            continue;
          }
        }
      }

      // Skip internal pipe wires (targeting fork inputs)
      if ((wire as any).pipe && pipeHandleTrunkKeys.has(refTk(wire.to))) {
        continue;
      }
    }

    // Ternary wire: has `cond` (condition ref), `thenValue`/`thenRef`, `elseValue`/`elseRef`
    if ("cond" in wire) {
      const condWire = wire as any;
      const target = wire.to.path.join(".");
      const condStr = serToolRef(condWire.cond);
      const thenVal =
        "thenValue" in condWire
          ? formatBareValue(condWire.thenValue)
          : serToolRef(condWire.thenRef);
      const elseVal =
        "elseValue" in condWire
          ? formatBareValue(condWire.elseValue)
          : serToolRef(condWire.elseRef);
      lines.push(
        `  ${prefix}${target} <- ${condStr} ? ${thenVal} : ${elseVal}`,
      );
      continue;
    }

    if ("value" in wire && !("cond" in wire)) {
      // Constant wire
      const target = wire.to.path.join(".");
      if (needsQuoting(wire.value)) {
        lines.push(`  ${prefix}${target} = "${wire.value}"`);
      } else {
        lines.push(`  ${prefix}${target} = ${formatBareValue(wire.value)}`);
      }
    } else if ("from" in wire) {
      // Pull wire — reconstruct source from handle map
      const sourceStr = serializeToolWireSource(wire.from, tool);
      const target = wire.to.path.join(".");
      let suffix = "";
      // Fallbacks: || (or) and ?? (nullish coalesce)
      const fallbacks = (wire as any).fallbacks as
        | Array<{
            type: "or" | "nullish";
            value?: string;
            ref?: NodeRef;
          }>
        | undefined;
      if (fallbacks) {
        for (const fb of fallbacks) {
          const op = fb.type === "nullish" ? "??" : "||";
          if (fb.ref) {
            suffix += ` ${op} ${serToolRef(fb.ref)}`;
          } else if (fb.value != null) {
            suffix += ` ${op} ${formatBareValue(fb.value)}`;
          }
        }
      }
      // Catch
      if ((wire as any).catchFallbackRef) {
        suffix += ` catch ${serToolRef((wire as any).catchFallbackRef)}`;
      } else if ((wire as any).catchFallback != null) {
        suffix += ` catch ${formatBareValue((wire as any).catchFallback)}`;
      }
      lines.push(`  ${prefix}${target} <- ${sourceStr}${suffix}`);
    }
  }

  // onError
  if (tool.onError) {
    if ("value" in tool.onError) {
      lines.push(`  on error = ${tool.onError.value}`);
    } else {
      lines.push(`  on error <- ${tool.onError.source}`);
    }
  }

  if (hasBody) lines.push(`}`);

  return lines.join("\n");
}

/**
 * Reconstruct a pull wire source into a readable string for tool block serialization.
 * Maps NodeRef back to handle.path format.
 */
function serializeToolWireSource(ref: NodeRef, tool: ToolDef): string {
  for (const h of tool.handles) {
    if (h.kind === "context") {
      if (
        ref.module === SELF_MODULE &&
        ref.type === "Context" &&
        ref.field === "context"
      ) {
        return ref.path.length > 0
          ? `${h.handle}.${ref.path.join(".")}`
          : h.handle;
      }
    } else if (h.kind === "const") {
      if (
        ref.module === SELF_MODULE &&
        ref.type === "Const" &&
        ref.field === "const"
      ) {
        return ref.path.length > 0
          ? `${h.handle}.${ref.path.join(".")}`
          : h.handle;
      }
    } else if (h.kind === "tool") {
      const lastDot = h.name.lastIndexOf(".");
      if (lastDot !== -1) {
        if (
          ref.module === h.name.substring(0, lastDot) &&
          ref.field === h.name.substring(lastDot + 1)
        ) {
          return ref.path.length > 0
            ? `${h.handle}.${ref.path.join(".")}`
            : h.handle;
        }
      } else if (
        ref.module === SELF_MODULE &&
        ref.type === "Tools" &&
        ref.field === h.name
      ) {
        return ref.path.length > 0
          ? `${h.handle}.${ref.path.join(".")}`
          : h.handle;
      }
    }
  }
  // Fallback: use raw ref path
  return ref.path.join(".");
}

/**
 * Serialize a fallback NodeRef as a human-readable source string.
 *
 * If the ref is a pipe-fork root, reconstructs the pipe chain by walking
 * the `toInMap` backward (same logic as the main pipe serializer).
 * Otherwise delegates to `serializeRef`.
 *
 * This is used to emit `catch handle.path` or `catch pipe:source` for wire
 * `catchFallbackRef` values, or `|| ref` / `?? ref` for `fallbacks`.
 */
function serializePipeOrRef(
  ref: NodeRef,
  pipeHandleTrunkKeys: Set<string>,
  toInMap: Map<string, Extract<Wire, { from: NodeRef }>>,
  handleMap: Map<string, string>,
  bridge: Bridge,
  inputHandle: string | undefined,
  outputHandle: string | undefined,
): string {
  const refTk =
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;

  if (ref.path.length === 0 && pipeHandleTrunkKeys.has(refTk)) {
    // Pipe-fork root — walk the chain to reconstruct `pipe:source` notation
    const handleChain: string[] = [];
    let currentTk = refTk;
    let actualSourceRef: NodeRef | null = null;

    for (;;) {
      const handleName = handleMap.get(currentTk);
      if (!handleName) break;
      const inWire = toInMap.get(currentTk);
      const fieldName = inWire?.to.path[0] ?? "in";
      const token =
        fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
      handleChain.push(token);
      if (!inWire) break;
      const fromTk =
        inWire.from.instance != null
          ? `${inWire.from.module}:${inWire.from.type}:${inWire.from.field}:${inWire.from.instance}`
          : `${inWire.from.module}:${inWire.from.type}:${inWire.from.field}`;
      if (inWire.from.path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
        currentTk = fromTk;
      } else {
        actualSourceRef = inWire.from;
        break;
      }
    }

    if (actualSourceRef && handleChain.length > 0) {
      const sourceStr = serializeRef(
        actualSourceRef,
        bridge,
        handleMap,
        inputHandle,
        outputHandle,
        true,
      );
      return `${handleChain.join(":")}:${sourceStr}`;
    }
  }

  return serializeRef(ref, bridge, handleMap, inputHandle, outputHandle, true);
}

/**
 * Serialize a DefineDef into its textual form.
 *
 * Delegates to serializeBridgeBlock with a synthetic Bridge, then replaces
 * the `bridge Define.<name>` header with `define <name>`.
 */
function serializeDefineBlock(def: DefineDef): string {
  const syntheticBridge: Bridge = {
    kind: "bridge",
    type: "Define",
    field: def.name,
    handles: def.handles,
    wires: def.wires,
    arrayIterators: def.arrayIterators,
    pipeHandles: def.pipeHandles,
  };
  const bridgeText = serializeBridgeBlock(syntheticBridge);
  // Replace "bridge Define.<name>" → "define <name>"
  return bridgeText.replace(/^bridge Define\.(\w+)/, "define $1");
}

function serializeBridgeBlock(bridge: Bridge): string {
  // ── Passthrough shorthand ───────────────────────────────────────────
  if (bridge.passthrough) {
    return `bridge ${bridge.type}.${bridge.field} with ${bridge.passthrough}`;
  }

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  lines.push(`bridge ${bridge.type}.${bridge.field} {`);

  for (const h of bridge.handles) {
    // Element-scoped tool handles are emitted inside their array block
    if (h.kind === "tool" && h.element) continue;
    switch (h.kind) {
      case "tool": {
        // Short form `with <name>` when handle == last segment of name
        const lastDot = h.name.lastIndexOf(".");
        const defaultHandle =
          lastDot !== -1 ? h.name.substring(lastDot + 1) : h.name;
        const vTag = h.version ? `@${h.version}` : "";
        const memoize = h.memoize ? " memoize" : "";
        if (h.handle === defaultHandle && !vTag) {
          lines.push(`  with ${h.name}${memoize}`);
        } else {
          lines.push(`  with ${h.name}${vTag} as ${h.handle}${memoize}`);
        }
        break;
      }
      case "input":
        if (h.handle === "input") {
          lines.push(`  with input`);
        } else {
          lines.push(`  with input as ${h.handle}`);
        }
        break;
      case "output":
        if (h.handle === "output") {
          lines.push(`  with output`);
        } else {
          lines.push(`  with output as ${h.handle}`);
        }
        break;
      case "context":
        lines.push(`  with context as ${h.handle}`);
        break;
      case "const":
        if (h.handle === "const") {
          lines.push(`  with const`);
        } else {
          lines.push(`  with const as ${h.handle}`);
        }
        break;
      case "define":
        lines.push(`  with ${h.name} as ${h.handle}`);
        break;
    }
  }

  lines.push("");

  // Mark where the wire body starts — everything after this gets 2-space indent
  const wireBodyStart = lines.length;

  // ── Build handle map for reverse resolution ─────────────────────────
  const { handleMap, inputHandle, outputHandle } = buildHandleMap(bridge);

  // ── Element-scoped tool trunk keys ──────────────────────────────────
  const elementToolTrunkKeys = new Set<string>();
  {
    const localCounters = new Map<string, number>();
    for (const h of bridge.handles) {
      if (h.kind !== "tool") continue;
      const lastDot = h.name.lastIndexOf(".");
      if (lastDot !== -1) {
        const mod = h.name.substring(0, lastDot);
        const fld = h.name.substring(lastDot + 1);
        const ik = `${mod}:${fld}`;
        const inst = (localCounters.get(ik) ?? 0) + 1;
        localCounters.set(ik, inst);
        if (h.element) {
          elementToolTrunkKeys.add(`${mod}:${bridge.type}:${fld}:${inst}`);
        }
      } else {
        const ik = `Tools:${h.name}`;
        const inst = (localCounters.get(ik) ?? 0) + 1;
        localCounters.set(ik, inst);
        if (h.element) {
          elementToolTrunkKeys.add(`${SELF_MODULE}:Tools:${h.name}:${inst}`);
        }
      }
    }
  }

  // ── Pipe fork registry ──────────────────────────────────────────────
  const pipeHandleTrunkKeys = new Set<string>();
  for (const ph of bridge.pipeHandles ?? []) {
    handleMap.set(ph.key, ph.handle);
    pipeHandleTrunkKeys.add(ph.key);
  }

  // ── Pipe wire detection ─────────────────────────────────────────────
  const refTrunkKey = (ref: NodeRef): string =>
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;

  type FW = Extract<Wire, { from: NodeRef }>;
  const toInMap = new Map<string, FW>();
  const fromOutMap = new Map<string, FW>();
  const pipeWireSet = new Set<Wire>();

  for (const w of bridge.wires) {
    if (!("from" in w) || !(w as any).pipe) continue;
    const fw = w as FW;
    pipeWireSet.add(w);
    const toTk = refTrunkKey(fw.to);
    if (fw.to.path.length === 1 && pipeHandleTrunkKeys.has(toTk)) {
      toInMap.set(toTk, fw);
    }
    const fromTk = refTrunkKey(fw.from);
    if (fw.from.path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
      fromOutMap.set(fromTk, fw);
    }
    // Concat fork output: from.path=["value"], target is not a pipe handle
    if (
      fw.from.path.length === 1 &&
      fw.from.path[0] === "value" &&
      pipeHandleTrunkKeys.has(fromTk) &&
      !pipeHandleTrunkKeys.has(toTk)
    ) {
      fromOutMap.set(fromTk, fw);
    }
  }

  // ── Expression fork detection ──────────────────────────────────────────
  // Operator tool name → infix operator symbol
  const FN_TO_OP: Record<string, string> = {
    multiply: "*",
    divide: "/",
    add: "+",
    subtract: "-",
    eq: "==",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    __and: "and",
    __or: "or",
    not: "not",
  };
  const OP_PREC_SER: Record<string, number> = {
    "*": 4,
    "/": 4,
    "+": 3,
    "-": 3,
    "==": 2,
    "!=": 2,
    ">": 2,
    ">=": 2,
    "<": 2,
    "<=": 2,
    and: 1,
    or: 0,
    not: -1,
  };
  // Collect expression fork metadata: forkTk → { op, bWire, aWire }
  type ExprForkInfo = {
    op: string;
    bWire: Wire | undefined;
    aWire: FW | undefined;
    /** For condAnd/condOr wires: the logic wire itself */
    logicWire?:
      | Extract<Wire, { condAnd: any }>
      | Extract<Wire, { condOr: any }>;
  };
  const exprForks = new Map<string, ExprForkInfo>();
  const exprPipeWireSet = new Set<Wire>(); // wires that belong to expression forks

  for (const ph of bridge.pipeHandles ?? []) {
    if (!ph.handle.startsWith("__expr_")) continue;
    const op = FN_TO_OP[ph.baseTrunk.field];
    if (!op) continue;

    // For condAnd/condOr wires (field === "__and" or "__or")
    if (ph.baseTrunk.field === "__and" || ph.baseTrunk.field === "__or") {
      const logicWire = bridge.wires.find((w) => {
        const prop = ph.baseTrunk.field === "__and" ? "condAnd" : "condOr";
        return prop in w && refTrunkKey(w.to) === ph.key;
      }) as
        | Extract<Wire, { condAnd: any }>
        | Extract<Wire, { condOr: any }>
        | undefined;

      if (logicWire) {
        exprForks.set(ph.key, {
          op,
          bWire: undefined,
          aWire: undefined,
          logicWire,
        });
        exprPipeWireSet.add(logicWire);
      }
      continue;
    }

    // Find the .a and .b wires for this fork
    let aWire: FW | undefined;
    let bWire: Wire | undefined;
    for (const w of bridge.wires) {
      const wTo = (w as any).to as NodeRef;
      if (!wTo || refTrunkKey(wTo) !== ph.key || wTo.path.length !== 1)
        continue;
      if (wTo.path[0] === "a" && "from" in w) aWire = w as FW;
      else if (wTo.path[0] === "b") bWire = w;
    }
    exprForks.set(ph.key, { op, bWire, aWire });
    if (bWire) exprPipeWireSet.add(bWire);
    if (aWire) exprPipeWireSet.add(aWire);
  }

  // ── Concat (template string) fork detection ────────────────────────────
  // Detect __concat_* forks and collect their ordered parts wires.
  type ConcatForkInfo = {
    /** Ordered parts: either { kind: "text", value } or { kind: "ref", ref } */
    parts: ({ kind: "text"; value: string } | { kind: "ref"; ref: NodeRef })[];
  };
  const concatForks = new Map<string, ConcatForkInfo>();
  const concatPipeWireSet = new Set<Wire>(); // wires that belong to concat forks

  for (const ph of bridge.pipeHandles ?? []) {
    if (!ph.handle.startsWith("__concat_")) continue;
    if (ph.baseTrunk.field !== "concat") continue;

    // Collect parts.N wires (constant or pull)
    const partsMap = new Map<
      number,
      { kind: "text"; value: string } | { kind: "ref"; ref: NodeRef }
    >();
    for (const w of bridge.wires) {
      const wTo = (w as any).to as NodeRef;
      if (!wTo || refTrunkKey(wTo) !== ph.key) continue;
      if (wTo.path.length !== 2 || wTo.path[0] !== "parts") continue;
      const idx = parseInt(wTo.path[1], 10);
      if (isNaN(idx)) continue;
      if ("value" in w && !("from" in w)) {
        partsMap.set(idx, { kind: "text", value: (w as any).value });
      } else if ("from" in w) {
        partsMap.set(idx, { kind: "ref", ref: (w as FW).from });
      }
      concatPipeWireSet.add(w);
    }

    // Build ordered parts array
    const maxIdx = Math.max(...partsMap.keys(), -1);
    const parts: ConcatForkInfo["parts"] = [];
    for (let i = 0; i <= maxIdx; i++) {
      const part = partsMap.get(i);
      if (part) parts.push(part);
    }
    concatForks.set(ph.key, { parts });
  }

  /**
   * Reconstruct a template string from a concat fork.
   * Returns `"literal{ref}literal"` notation.
   */
  function reconstructTemplateString(forkTk: string): string | null {
    const info = concatForks.get(forkTk);
    if (!info || info.parts.length === 0) return null;

    let result = "";
    for (const part of info.parts) {
      if (part.kind === "text") {
        // Escape backslashes before braces first, then escape literal braces
        result += part.value.replace(/\\/g, "\\\\").replace(/\{/g, "\\{");
      } else {
        const refStr = part.ref.element
          ? "ITER." + serPath(part.ref.path)
          : sRef(part.ref, true);
        result += `{${refStr}}`;
      }
    }
    return `"${result}"`;
  }

  // ── Group element wires by array-destination field ──────────────────
  // Pull wires: from.element=true OR involving element-scoped tools
  const isElementToolWire = (w: Wire): boolean => {
    if (!("from" in w)) return false;
    if (elementToolTrunkKeys.has(refTrunkKey(w.from))) return true;
    if (elementToolTrunkKeys.has(refTrunkKey(w.to))) return true;
    return false;
  };
  const elementPullWires = bridge.wires.filter(
    (w): w is Extract<Wire, { from: NodeRef }> =>
      "from" in w && (!!w.from.element || isElementToolWire(w)),
  );
  // Constant wires: "value" in w && to.element=true
  const elementConstWires = bridge.wires.filter(
    (w): w is Extract<Wire, { value: string }> =>
      "value" in w && !!w.to.element,
  );

  // Build grouped maps keyed by the full array-destination path (to.path joined)
  // For a 1-level array o.items <- src[], element paths are like ["items", "name"]
  // For a root-level array o <- src[], element paths are like ["name"]
  // For nested arrays, inner element paths are like ["items", "legs", "trainName"]
  const elementPullAll = elementPullWires.filter(
    (w) =>
      !exprPipeWireSet.has(w) &&
      !pipeWireSet.has(w) &&
      !concatPipeWireSet.has(w),
  );
  const elementConstAll = elementConstWires.filter(
    (w) => !exprPipeWireSet.has(w) && !concatPipeWireSet.has(w),
  );

  // Collect element-targeting expression output wires (from expression fork → element)
  type ElementExprInfo = {
    toPath: string[];
    sourceStr: string; // fully serialized expression string
  };
  const elementExprWires: ElementExprInfo[] = [];

  // Detect array source wires: a regular wire whose to.path (joined) matches
  // a key in arrayIterators. This includes root-level arrays (path=[]).
  const arrayIterators = bridge.arrayIterators ?? {};

  /** Check if a NodeRef targets a path under an array iterator scope. */
  function isUnderArrayScope(ref: NodeRef): boolean {
    if (
      ref.module !== SELF_MODULE ||
      ref.type !== bridge.type ||
      ref.field !== bridge.field
    )
      return false;
    const p = ref.path.join(".");
    for (const iterPath of Object.keys(arrayIterators)) {
      if (iterPath === "" || p.startsWith(iterPath + ".")) return true;
    }
    return false;
  }

  // ── Determine array scope for each element-scoped tool ──────────────
  // Maps element tool trunk key → array iterator key (e.g. "g" or "g.b")
  const elementToolScope = new Map<string, string>();
  // Also maps handle index → array iterator key for the declaration loop
  const elementHandleScope = new Map<number, string>();
  {
    // Build trunk key for each handle (mirrors elementToolTrunkKeys logic)
    const localCounters = new Map<string, number>();
    const handleTrunkKeys: (string | undefined)[] = [];
    for (const h of bridge.handles) {
      if (h.kind !== "tool") {
        handleTrunkKeys.push(undefined);
        continue;
      }
      const lastDot = h.name.lastIndexOf(".");
      let tk: string;
      if (lastDot !== -1) {
        const mod = h.name.substring(0, lastDot);
        const fld = h.name.substring(lastDot + 1);
        const ik = `${mod}:${fld}`;
        const inst = (localCounters.get(ik) ?? 0) + 1;
        localCounters.set(ik, inst);
        tk = `${mod}:${bridge.type}:${fld}:${inst}`;
      } else {
        const ik = `Tools:${h.name}`;
        const inst = (localCounters.get(ik) ?? 0) + 1;
        localCounters.set(ik, inst);
        tk = `${SELF_MODULE}:Tools:${h.name}:${inst}`;
      }
      handleTrunkKeys.push(h.element ? tk : undefined);
    }

    // Sort iterator keys by path depth (deepest first) for matching
    const iterKeys = Object.keys(arrayIterators).sort(
      (a, b) => b.length - a.length,
    );

    // For each element tool, find its output wire to determine scope
    for (const w of bridge.wires) {
      if (!("from" in w)) continue;
      const fromTk = refTrunkKey(w.from);
      if (!elementToolTrunkKeys.has(fromTk)) continue;
      if (elementToolScope.has(fromTk)) continue;
      // Output wire: from=tool → to=bridge output
      const toRef = w.to;
      if (
        toRef.module !== SELF_MODULE ||
        toRef.type !== bridge.type ||
        toRef.field !== bridge.field
      )
        continue;
      const toPath = toRef.path.join(".");
      for (const ik of iterKeys) {
        if (ik === "" || toPath.startsWith(ik + ".") || toPath === ik) {
          elementToolScope.set(fromTk, ik);
          break;
        }
      }
    }

    // Map handle indices using the trunk keys
    for (let i = 0; i < bridge.handles.length; i++) {
      const tk = handleTrunkKeys[i];
      if (tk && elementToolScope.has(tk)) {
        elementHandleScope.set(i, elementToolScope.get(tk)!);
      }
    }
  }

  // ── Exclude pipe, element-pull, element-const, expression-internal, concat-internal, __local, and element-scoped ternary wires from main loop
  const regularWires = bridge.wires.filter(
    (w) =>
      !pipeWireSet.has(w) &&
      !exprPipeWireSet.has(w) &&
      !concatPipeWireSet.has(w) &&
      (!("from" in w) || !w.from.element) &&
      !isElementToolWire(w) &&
      (!("value" in w) || !w.to.element) &&
      w.to.module !== "__local" &&
      (!("from" in w) || (w.from as NodeRef).module !== "__local") &&
      (!("cond" in w) || !isUnderArrayScope(w.to)),
  );

  // ── Collect __local binding wires for array-scoped `with` declarations ──
  type LocalBindingInfo = {
    alias: string;
    sourceWire?: Extract<Wire, { from: NodeRef }>;
    ternaryWire?: Extract<Wire, { cond: NodeRef }>;
  };
  const localBindingsByAlias = new Map<string, LocalBindingInfo>();
  const localReadWires: Extract<Wire, { from: NodeRef }>[] = [];
  for (const w of bridge.wires) {
    if (w.to.module === "__local" && "from" in w) {
      localBindingsByAlias.set(w.to.field, {
        alias: w.to.field,
        sourceWire: w as Extract<Wire, { from: NodeRef }>,
      });
    }
    if (w.to.module === "__local" && "cond" in w) {
      localBindingsByAlias.set(w.to.field, {
        alias: w.to.field,
        ternaryWire: w as Extract<Wire, { cond: NodeRef }>,
      });
    }
    if ("from" in w && (w.from as NodeRef).module === "__local") {
      localReadWires.push(w as Extract<Wire, { from: NodeRef }>);
    }
  }

  // ── Collect element-scoped ternary wires ────────────────────────────
  const elementTernaryWires = bridge.wires.filter(
    (w): w is Extract<Wire, { cond: NodeRef }> =>
      "cond" in w && isUnderArrayScope(w.to),
  );

  const serializedArrays = new Set<string>();

  // ── Helper: serialize a reference (forward outputHandle) ─────────────
  const sRef = (ref: NodeRef, isFrom: boolean) =>
    serializeRef(ref, bridge, handleMap, inputHandle, outputHandle, isFrom);
  const sPipeOrRef = (ref: NodeRef) =>
    serializePipeOrRef(
      ref,
      pipeHandleTrunkKeys,
      toInMap,
      handleMap,
      bridge,
      inputHandle,
      outputHandle,
    );

  // ── Pre-compute element expression wires ────────────────────────────
  // Walk expression trees from fromOutMap that target element refs
  for (const [tk, outWire] of fromOutMap.entries()) {
    if (!exprForks.has(tk) || !isUnderArrayScope(outWire.to)) continue;

    // Recursively serialize expression fork tree
    function serializeElemExprTree(
      forkTk: string,
      parentPrec?: number,
    ): string | null {
      const info = exprForks.get(forkTk);
      if (!info) return null;

      // condAnd/condOr logic wire — reconstruct from leftRef/rightRef
      if (info.logicWire) {
        const logic =
          "condAnd" in info.logicWire
            ? info.logicWire.condAnd
            : info.logicWire.condOr;
        let leftStr: string;
        const leftTk = refTrunkKey(logic.leftRef);
        if (logic.leftRef.path.length === 0 && exprForks.has(leftTk)) {
          leftStr =
            serializeElemExprTree(leftTk, OP_PREC_SER[info.op] ?? 0) ??
            sRef(logic.leftRef, true);
        } else {
          leftStr = logic.leftRef.element
            ? "ITER." + serPath(logic.leftRef.path)
            : sRef(logic.leftRef, true);
        }

        let rightStr: string;
        if (logic.rightRef) {
          const rightTk = refTrunkKey(logic.rightRef);
          if (logic.rightRef.path.length === 0 && exprForks.has(rightTk)) {
            rightStr =
              serializeElemExprTree(rightTk, OP_PREC_SER[info.op] ?? 0) ??
              sRef(logic.rightRef, true);
          } else {
            rightStr = logic.rightRef.element
              ? "ITER." + serPath(logic.rightRef.path)
              : sRef(logic.rightRef, true);
          }
        } else if (logic.rightValue != null) {
          rightStr = formatExprValue(logic.rightValue);
        } else {
          rightStr = "0";
        }

        let result = `${leftStr} ${info.op} ${rightStr}`;
        const myPrec = OP_PREC_SER[info.op] ?? 0;
        if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
        return result;
      }

      let leftStr: string | null = null;
      if (info.aWire) {
        const fromTk = refTrunkKey(info.aWire.from);
        if (info.aWire.from.path.length === 0 && exprForks.has(fromTk)) {
          leftStr = serializeElemExprTree(fromTk, OP_PREC_SER[info.op] ?? 0);
        } else {
          leftStr = info.aWire.from.element
            ? "ITER." + serPath(info.aWire.from.path)
            : sRef(info.aWire.from, true);
        }
      }

      let rightStr: string;
      if (info.bWire && "value" in info.bWire) {
        rightStr = formatExprValue(info.bWire.value);
      } else if (info.bWire && "from" in info.bWire) {
        const bFrom = (info.bWire as FW).from;
        const bTk = refTrunkKey(bFrom);
        if (bFrom.path.length === 0 && exprForks.has(bTk)) {
          rightStr =
            serializeElemExprTree(bTk, OP_PREC_SER[info.op] ?? 0) ??
            sRef(bFrom, true);
        } else {
          rightStr = bFrom.element
            ? "ITER." + serPath(bFrom.path)
            : sRef(bFrom, true);
        }
      } else {
        rightStr = "0";
      }

      if (leftStr == null) return rightStr;
      if (info.op === "not") return `not ${leftStr}`;
      let result = `${leftStr} ${info.op} ${rightStr}`;
      const myPrec = OP_PREC_SER[info.op] ?? 0;
      if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
      return result;
    }

    const exprStr = serializeElemExprTree(tk);
    if (exprStr) {
      elementExprWires.push({
        toPath: outWire.to.path,
        sourceStr: exprStr,
      });
    }
  }

  // Pre-compute element-targeting concat (template string) wires
  for (const [tk, outWire] of fromOutMap.entries()) {
    if (!concatForks.has(tk) || !outWire.to.element) continue;
    const templateStr = reconstructTemplateString(tk);
    if (templateStr) {
      elementExprWires.push({
        toPath: outWire.to.path,
        sourceStr: templateStr,
      });
    }
  }

  /** Serialize a ref in element context, resolving element refs to iterator name. */
  function serializeElemRef(
    ref: NodeRef,
    parentIterName: string,
    ancestorIterNames: string[],
  ): string {
    if (ref.element) {
      let resolvedIterName = parentIterName;
      if (ref.elementDepth) {
        const stack = [...ancestorIterNames, parentIterName];
        const idx = stack.length - 1 - ref.elementDepth;
        if (idx >= 0) resolvedIterName = stack[idx];
      }
      return ref.path.length > 0
        ? resolvedIterName + "." + serPath(ref.path, ref.rootSafe, ref.pathSafe)
        : resolvedIterName;
    }
    // Expression fork — serialize and replace ITER. placeholder
    const tk = refTrunkKey(ref);
    if (ref.path.length === 0 && exprForks.has(tk)) {
      const exprStr = serializeElemExprTreeFn(
        tk,
        parentIterName,
        ancestorIterNames,
      );
      if (exprStr) return exprStr;
    }
    return sRef(ref, true);
  }

  /** Recursively serialize an expression fork tree in element context. */
  function serializeElemExprTreeFn(
    forkTk: string,
    parentIterName: string,
    ancestorIterNames: string[],
    parentPrec?: number,
  ): string | null {
    const info = exprForks.get(forkTk);
    if (!info) return null;

    if (info.logicWire) {
      const logic =
        "condAnd" in info.logicWire
          ? info.logicWire.condAnd
          : info.logicWire.condOr;
      let leftStr: string;
      const leftTk = refTrunkKey(logic.leftRef);
      if (logic.leftRef.path.length === 0 && exprForks.has(leftTk)) {
        leftStr =
          serializeElemExprTreeFn(
            leftTk,
            parentIterName,
            ancestorIterNames,
            OP_PREC_SER[info.op] ?? 0,
          ) ??
          serializeElemRef(logic.leftRef, parentIterName, ancestorIterNames);
      } else {
        leftStr = serializeElemRef(
          logic.leftRef,
          parentIterName,
          ancestorIterNames,
        );
      }

      let rightStr: string;
      if (logic.rightRef) {
        const rightTk = refTrunkKey(logic.rightRef);
        if (logic.rightRef.path.length === 0 && exprForks.has(rightTk)) {
          rightStr =
            serializeElemExprTreeFn(
              rightTk,
              parentIterName,
              ancestorIterNames,
              OP_PREC_SER[info.op] ?? 0,
            ) ??
            serializeElemRef(logic.rightRef, parentIterName, ancestorIterNames);
        } else {
          rightStr = serializeElemRef(
            logic.rightRef,
            parentIterName,
            ancestorIterNames,
          );
        }
      } else if (logic.rightValue != null) {
        rightStr = formatExprValue(logic.rightValue);
      } else {
        rightStr = "0";
      }

      let result = `${leftStr} ${info.op} ${rightStr}`;
      const myPrec = OP_PREC_SER[info.op] ?? 0;
      if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
      return result;
    }

    let leftStr: string | null = null;
    if (info.aWire) {
      const fromTk = refTrunkKey(info.aWire.from);
      if (info.aWire.from.path.length === 0 && exprForks.has(fromTk)) {
        leftStr = serializeElemExprTreeFn(
          fromTk,
          parentIterName,
          ancestorIterNames,
          OP_PREC_SER[info.op] ?? 0,
        );
      } else {
        leftStr = serializeElemRef(
          info.aWire.from,
          parentIterName,
          ancestorIterNames,
        );
      }
    }

    let rightStr: string;
    if (info.bWire && "value" in info.bWire) {
      rightStr = formatExprValue(info.bWire.value);
    } else if (info.bWire && "from" in info.bWire) {
      const bFrom = (info.bWire as FW).from;
      const bTk = refTrunkKey(bFrom);
      if (bFrom.path.length === 0 && exprForks.has(bTk)) {
        rightStr =
          serializeElemExprTreeFn(
            bTk,
            parentIterName,
            ancestorIterNames,
            OP_PREC_SER[info.op] ?? 0,
          ) ?? serializeElemRef(bFrom, parentIterName, ancestorIterNames);
      } else {
        rightStr = serializeElemRef(bFrom, parentIterName, ancestorIterNames);
      }
    } else {
      rightStr = "0";
    }

    if (leftStr == null) return rightStr;
    if (info.op === "not") return `not ${leftStr}`;
    let result = `${leftStr} ${info.op} ${rightStr}`;
    const myPrec = OP_PREC_SER[info.op] ?? 0;
    if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
    return result;
  }

  /**
   * Recursively serialize element wires for an array mapping block.
   * Handles nested array-in-array mappings by detecting inner iterators.
   */
  function serializeArrayElements(
    arrayPath: string[],
    parentIterName: string,
    indent: string,
    ancestorIterNames: string[] = [],
  ): void {
    const arrayPathStr = arrayPath.join(".");
    const pathDepth = arrayPath.length;

    // Find element constant wires at this level (path starts with arrayPath + one more segment)
    const levelConsts = elementConstAll.filter((ew) => {
      if (ew.to.path.length !== pathDepth + 1) return false;
      for (let i = 0; i < pathDepth; i++) {
        if (ew.to.path[i] !== arrayPath[i]) return false;
      }
      return true;
    });

    // Find element pull wires at this level (direct fields, not nested array children)
    const levelPulls = elementPullAll.filter((ew) => {
      // Tool-targeting wires: include if the tool belongs to this scope
      const ewToTk = refTrunkKey(ew.to);
      if (elementToolTrunkKeys.has(ewToTk)) {
        return elementToolScope.get(ewToTk) === arrayPathStr;
      }
      // Tool-output wires: include if the tool belongs to this scope
      const ewFromTk = refTrunkKey(ew.from);
      if (elementToolTrunkKeys.has(ewFromTk)) {
        return elementToolScope.get(ewFromTk) === arrayPathStr;
      }
      if (ew.to.path.length < pathDepth + 1) return false;
      for (let i = 0; i < pathDepth; i++) {
        if (ew.to.path[i] !== arrayPath[i]) return false;
      }
      // Check this wire is a direct field (depth == pathDepth+1)
      // or a nested array source (its path matches a nested iterator key)
      return true;
    });

    // Partition pulls into direct-level fields vs nested-array sources
    const nestedArrayPaths = new Set<string>();
    for (const key of Object.keys(arrayIterators)) {
      // A nested array key starts with the current array path
      if (
        key.length > arrayPathStr.length &&
        (arrayPathStr === "" ? true : key.startsWith(arrayPathStr + ".")) &&
        !key
          .substring(arrayPathStr === "" ? 0 : arrayPathStr.length + 1)
          .includes(".")
      ) {
        nestedArrayPaths.add(key);
      }
    }

    // Emit block-scoped local bindings: alias <source> as <name>
    for (const [alias, info] of localBindingsByAlias) {
      // Ternary alias in element scope
      if (info.ternaryWire) {
        const tw = info.ternaryWire;
        const condStr = serializeElemRef(
          tw.cond,
          parentIterName,
          ancestorIterNames,
        );
        const thenStr = tw.thenRef
          ? serializeElemRef(tw.thenRef, parentIterName, ancestorIterNames)
          : (tw.thenValue ?? "null");
        const elseStr = tw.elseRef
          ? serializeElemRef(tw.elseRef, parentIterName, ancestorIterNames)
          : (tw.elseValue ?? "null");
        const fallbackStr = (tw.fallbacks ?? [])
          .map((f) => {
            const op = f.type === "falsy" ? "||" : "??";
            if (f.control) return ` ${op} ${serializeControl(f.control)}`;
            if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
            return ` ${op} ${f.value}`;
          })
          .join("");
        const errf =
          "catchControl" in tw && tw.catchControl
            ? ` catch ${serializeControl(tw.catchControl)}`
            : tw.catchFallbackRef
              ? ` catch ${sPipeOrRef(tw.catchFallbackRef)}`
              : tw.catchFallback
                ? ` catch ${tw.catchFallback}`
                : "";
        lines.push(
          `${indent}alias ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf} as ${alias}`,
        );
        continue;
      }
      const srcWire = info.sourceWire!;
      // Reconstruct the source expression
      const fromRef = srcWire.from;
      let sourcePart: string;
      if (fromRef.element) {
        sourcePart =
          parentIterName +
          (fromRef.path.length > 0 ? "." + serPath(fromRef.path) : "");
      } else {
        // Check if the source is a pipe fork — reconstruct pipe:source syntax
        const srcTk = refTrunkKey(fromRef);
        if (fromRef.path.length === 0 && pipeHandleTrunkKeys.has(srcTk)) {
          // Walk the pipe chain backward to reconstruct pipe:source
          const parts: string[] = [];
          let currentTk = srcTk;
          while (true) {
            const handleName = handleMap.get(currentTk);
            if (!handleName) break;
            parts.push(handleName);
            const inWire = toInMap.get(currentTk);
            if (!inWire) break;
            if (inWire.from.element) {
              parts.push(
                parentIterName +
                  (inWire.from.path.length > 0
                    ? "." + serPath(inWire.from.path)
                    : ""),
              );
              break;
            }
            const innerTk = refTrunkKey(inWire.from);
            if (
              inWire.from.path.length === 0 &&
              pipeHandleTrunkKeys.has(innerTk)
            ) {
              currentTk = innerTk;
            } else {
              parts.push(sRef(inWire.from, true));
              break;
            }
          }
          sourcePart = parts.join(":");
        } else {
          sourcePart = sRef(fromRef, true);
        }
      }
      lines.push(`${indent}alias ${sourcePart} as ${alias}`);
    }

    // Emit element-scoped tool declarations: with <tool> as <handle>
    for (let hi = 0; hi < bridge.handles.length; hi++) {
      const h = bridge.handles[hi];
      if (h.kind !== "tool" || !h.element) continue;
      // Only emit if this tool belongs to the current array scope
      const scope = elementHandleScope.get(hi);
      if (scope !== arrayPathStr) continue;
      const vTag = h.version ? `@${h.version}` : "";
      const memoize = h.memoize ? " memoize" : "";
      const lastDot = h.name.lastIndexOf(".");
      const defaultHandle =
        lastDot !== -1 ? h.name.substring(lastDot + 1) : h.name;
      if (h.handle === defaultHandle && !vTag) {
        lines.push(`${indent}with ${h.name}${memoize}`);
      } else {
        lines.push(`${indent}with ${h.name}${vTag} as ${h.handle}${memoize}`);
      }
    }

    // Emit constant element wires
    for (const ew of levelConsts) {
      const fieldPath = ew.to.path.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      lines.push(`${indent}${elemTo} = ${formatBareValue(ew.value)}`);
    }

    // Emit pull element wires (direct level only)
    for (const ew of levelPulls) {
      const toPathStr = ew.to.path.join(".");

      // Skip wires that belong to a nested array level
      if (ew.to.path.length > pathDepth + 1) {
        // Check if this wire's immediate child segment forms a nested array
        const childPath = ew.to.path.slice(0, pathDepth + 1).join(".");
        if (nestedArrayPaths.has(childPath)) continue; // handled by nested block
      }

      // Check if this wire IS a nested array source
      if (nestedArrayPaths.has(toPathStr) && !serializedArrays.has(toPathStr)) {
        serializedArrays.add(toPathStr);
        const nestedIterName = arrayIterators[toPathStr];
        let nestedFromIter = parentIterName;
        if (ew.from.element && ew.from.elementDepth) {
          const stack = [...ancestorIterNames, parentIterName];
          const idx = stack.length - 1 - ew.from.elementDepth;
          if (idx >= 0) nestedFromIter = stack[idx];
        }
        const fromPart = ew.from.element
          ? nestedFromIter + "." + serPath(ew.from.path)
          : sRef(ew.from, true);
        const fieldPath = ew.to.path.slice(pathDepth);
        const elemTo = "." + serPath(fieldPath);
        lines.push(
          `${indent}${elemTo} <- ${fromPart}[] as ${nestedIterName} {`,
        );
        serializeArrayElements(ew.to.path, nestedIterName, indent + "  ", [
          ...ancestorIterNames,
          parentIterName,
        ]);
        lines.push(`${indent}}`);
        continue;
      }

      // Regular element pull wire
      let resolvedIterName = parentIterName;
      if (ew.from.element && ew.from.elementDepth) {
        const stack = [...ancestorIterNames, parentIterName];
        const idx = stack.length - 1 - ew.from.elementDepth;
        if (idx >= 0) resolvedIterName = stack[idx];
      }
      const fromPart = ew.from.element
        ? resolvedIterName +
          (ew.from.path.length > 0 ? "." + serPath(ew.from.path) : "")
        : sRef(ew.from, true);
      // Tool input wires target an element-scoped tool handle
      const toTk = refTrunkKey(ew.to);
      const toToolHandle = elementToolTrunkKeys.has(toTk)
        ? handleMap.get(toTk)
        : undefined;
      const elemTo = toToolHandle
        ? toToolHandle +
          (ew.to.path.length > 0 ? "." + serPath(ew.to.path) : "")
        : "." + serPath(ew.to.path.slice(pathDepth));

      const fallbackStr = (ew.fallbacks ?? [])
        .map((f) => {
          const op = f.type === "falsy" ? "||" : "??";
          if (f.control) return ` ${op} ${serializeControl(f.control)}`;
          if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
          return ` ${op} ${f.value}`;
        })
        .join("");
      const errf =
        "catchControl" in ew && ew.catchControl
          ? ` catch ${serializeControl(ew.catchControl)}`
          : "catchFallbackRef" in ew && ew.catchFallbackRef
            ? ` catch ${sPipeOrRef(ew.catchFallbackRef)}`
            : "catchFallback" in ew && ew.catchFallback
              ? ` catch ${ew.catchFallback}`
              : "";
      lines.push(`${indent}${elemTo} <- ${fromPart}${fallbackStr}${errf}`);
    }

    // Emit expression element wires at this level
    for (const eew of elementExprWires) {
      if (eew.toPath.length !== pathDepth + 1) continue;
      let match = true;
      for (let i = 0; i < pathDepth; i++) {
        if (eew.toPath[i] !== arrayPath[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const fieldPath = eew.toPath.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      // Replace ITER. placeholder with actual iterator name
      const src = eew.sourceStr.replaceAll("ITER.", parentIterName + ".");
      lines.push(`${indent}${elemTo} <- ${src}`);
    }

    // Emit element-scoped ternary wires at this level
    for (const tw of elementTernaryWires) {
      if (tw.to.path.length !== pathDepth + 1) continue;
      let match = true;
      for (let i = 0; i < pathDepth; i++) {
        if (tw.to.path[i] !== arrayPath[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const fieldPath = tw.to.path.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      // Serialize condition — resolve element refs to iterator name
      const condStr = serializeElemRef(
        tw.cond,
        parentIterName,
        ancestorIterNames,
      );
      const thenStr = tw.thenRef
        ? serializeElemRef(tw.thenRef, parentIterName, ancestorIterNames)
        : (tw.thenValue ?? "null");
      const elseStr = tw.elseRef
        ? serializeElemRef(tw.elseRef, parentIterName, ancestorIterNames)
        : (tw.elseValue ?? "null");
      const fallbackStr = (tw.fallbacks ?? [])
        .map((f) => {
          const op = f.type === "falsy" ? "||" : "??";
          if (f.control) return ` ${op} ${serializeControl(f.control)}`;
          if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
          return ` ${op} ${f.value}`;
        })
        .join("");
      const errf =
        "catchControl" in tw && tw.catchControl
          ? ` catch ${serializeControl(tw.catchControl)}`
          : tw.catchFallbackRef
            ? ` catch ${sPipeOrRef(tw.catchFallbackRef)}`
            : tw.catchFallback
              ? ` catch ${tw.catchFallback}`
              : "";
      lines.push(
        `${indent}${elemTo} <- ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf}`,
      );
    }

    // Emit local-binding read wires at this level (.field <- alias.path)
    for (const lw of localReadWires) {
      if (lw.to.path.length < pathDepth + 1) continue;
      let match = true;
      for (let i = 0; i < pathDepth; i++) {
        if (lw.to.path[i] !== arrayPath[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const fieldPath = lw.to.path.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      const alias = lw.from.field; // __local:Shadow:<alias>
      const safeSep = lw.safe || lw.from.rootSafe ? "?." : ".";
      const fromPart =
        lw.from.path.length > 0
          ? alias +
            safeSep +
            serPath(lw.from.path, lw.from.rootSafe, lw.from.pathSafe)
          : alias;
      lines.push(`${indent}${elemTo} <- ${fromPart}`);
    }
  }

  // ── Helper: serialize an expression fork tree for a ref (used for cond) ──
  /** Resolve a ref to a concat template string if it points to a __concat fork output. */
  function tryResolveConcat(ref: NodeRef): string | null {
    if (ref.path.length === 1 && ref.path[0] === "value") {
      const tk = refTrunkKey(ref);
      if (concatForks.has(tk)) {
        return reconstructTemplateString(tk);
      }
    }
    return null;
  }

  function serializeExprOrRef(ref: NodeRef): string {
    const tk = refTrunkKey(ref);
    // Check if ref is a concat output first
    const concatStr = tryResolveConcat(ref);
    if (concatStr) return concatStr;
    if (ref.path.length === 0 && exprForks.has(tk)) {
      // Recursively serialize expression fork
      function serFork(forkTk: string): string {
        const info = exprForks.get(forkTk);
        if (!info) return "?";
        let leftStr: string | null = null;
        if (info.aWire) {
          const aTk = refTrunkKey(info.aWire.from);
          const concatLeft = tryResolveConcat(info.aWire.from);
          if (concatLeft) {
            leftStr = concatLeft;
          } else if (info.aWire.from.path.length === 0 && exprForks.has(aTk)) {
            leftStr = serFork(aTk);
          } else {
            leftStr = sRef(info.aWire.from, true);
          }
        }
        let rightStr: string;
        if (info.bWire && "value" in info.bWire) {
          rightStr = formatExprValue(info.bWire.value);
        } else if (info.bWire && "from" in info.bWire) {
          const bFrom = (info.bWire as FW).from;
          const bTk = refTrunkKey(bFrom);
          const concatRight = tryResolveConcat(bFrom);
          if (concatRight) {
            rightStr = concatRight;
          } else {
            rightStr =
              bFrom.path.length === 0 && exprForks.has(bTk)
                ? serFork(bTk)
                : sRef(bFrom, true);
          }
        } else {
          rightStr = "0";
        }
        if (leftStr == null) return rightStr;
        if (info.op === "not") return `not ${leftStr}`;
        return `${leftStr} ${info.op} ${rightStr}`;
      }
      return serFork(tk) ?? sRef(ref, true);
    }
    return sRef(ref, true);
  }

  for (const w of regularWires) {
    // Conditional (ternary) wire
    if ("cond" in w) {
      const toStr = sRef(w.to, false);
      const condStr = serializeExprOrRef(w.cond);
      const thenStr = w.thenRef
        ? sRef(w.thenRef, true)
        : (w.thenValue ?? "null");
      const elseStr = w.elseRef
        ? sRef(w.elseRef, true)
        : (w.elseValue ?? "null");
      const fallbackStr = (w.fallbacks ?? [])
        .map((f) => {
          const op = f.type === "falsy" ? "||" : "??";
          if (f.control) return ` ${op} ${serializeControl(f.control)}`;
          if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
          return ` ${op} ${f.value}`;
        })
        .join("");
      const errf =
        "catchControl" in w && w.catchControl
          ? ` catch ${serializeControl(w.catchControl)}`
          : w.catchFallbackRef
            ? ` catch ${sPipeOrRef(w.catchFallbackRef)}`
            : w.catchFallback
              ? ` catch ${w.catchFallback}`
              : "";
      lines.push(
        `${toStr} <- ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf}`,
      );
      continue;
    }

    // Constant wire
    if ("value" in w) {
      const toStr = sRef(w.to, false);
      lines.push(`${toStr} = ${formatBareValue(w.value)}`);
      continue;
    }

    // Skip condAnd/condOr wires (handled in expression tree serialization)
    if ("condAnd" in w || "condOr" in w) continue;

    // Array mapping — emit brace-delimited element block
    const arrayKey = w.to.path.join(".");
    if (arrayKey in arrayIterators && !serializedArrays.has(arrayKey)) {
      serializedArrays.add(arrayKey);
      const iterName = arrayIterators[arrayKey];
      const fromStr = sRef(w.from, true) + "[]";
      const toStr = sRef(w.to, false);
      lines.push(`${toStr} <- ${fromStr} as ${iterName} {`);
      serializeArrayElements(w.to.path, iterName, "  ");
      lines.push(`}`);
      continue;
    }

    // Regular wire
    let fromStr = sRef(w.from, true);
    // Legacy safe flag without per-segment info: put ?. after root
    if (w.safe) {
      const ref = w.from;
      if (!ref.rootSafe && !ref.pathSafe?.some((s) => s)) {
        if (fromStr.includes(".")) {
          fromStr = fromStr.replace(".", "?.");
        }
      }
    }
    const toStr = sRef(w.to, false);
    const fallbackStr = (w.fallbacks ?? [])
      .map((f) => {
        const op = f.type === "falsy" ? "||" : "??";
        if (f.control) return ` ${op} ${serializeControl(f.control)}`;
        if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
        return ` ${op} ${f.value}`;
      })
      .join("");
    const errf =
      "catchControl" in w && w.catchControl
        ? ` catch ${serializeControl(w.catchControl)}`
        : w.catchFallbackRef
          ? ` catch ${sPipeOrRef(w.catchFallbackRef)}`
          : w.catchFallback
            ? ` catch ${w.catchFallback}`
            : "";
    lines.push(`${toStr} <- ${fromStr}${fallbackStr}${errf}`);
  }

  // ── Top-level alias declarations ─────────────────────────────────────
  // Emit `alias <source> as <name>` for __local bindings that are NOT
  // element-scoped (those are handled inside serializeArrayElements).
  for (const [alias, info] of localBindingsByAlias) {
    // Ternary alias: emit `alias <cond> ? <then> : <else> [fallbacks] as <name>`
    if (info.ternaryWire) {
      const tw = info.ternaryWire;
      const condStr = serializeExprOrRef(tw.cond);
      const thenStr = tw.thenRef
        ? sRef(tw.thenRef, true)
        : (tw.thenValue ?? "null");
      const elseStr = tw.elseRef
        ? sRef(tw.elseRef, true)
        : (tw.elseValue ?? "null");
      const fallbackStr = (tw.fallbacks ?? [])
        .map((f) => {
          const op = f.type === "falsy" ? "||" : "??";
          if (f.control) return ` ${op} ${serializeControl(f.control)}`;
          if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
          return ` ${op} ${f.value}`;
        })
        .join("");
      const errf =
        "catchControl" in tw && tw.catchControl
          ? ` catch ${serializeControl(tw.catchControl)}`
          : tw.catchFallbackRef
            ? ` catch ${sPipeOrRef(tw.catchFallbackRef)}`
            : tw.catchFallback
              ? ` catch ${tw.catchFallback}`
              : "";
      lines.push(
        `alias ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf} as ${alias}`,
      );
      continue;
    }
    const srcWire = info.sourceWire!;
    const fromRef = srcWire.from;
    // Element-scoped bindings are emitted inside array blocks
    if (fromRef.element) continue;
    // Check if source is a pipe fork with element-sourced input (array-scoped)
    const srcTk = refTrunkKey(fromRef);
    if (fromRef.path.length === 0 && pipeHandleTrunkKeys.has(srcTk)) {
      const inWire = toInMap.get(srcTk);
      if (inWire && inWire.from.element) continue;
    }
    // Reconstruct source expression
    let sourcePart: string;
    if (fromRef.path.length === 0 && pipeHandleTrunkKeys.has(srcTk)) {
      const parts: string[] = [];
      let currentTk = srcTk;
      while (true) {
        const handleName = handleMap.get(currentTk);
        if (!handleName) break;
        parts.push(handleName);
        const inWire = toInMap.get(currentTk);
        if (!inWire) break;
        const innerTk = refTrunkKey(inWire.from);
        if (inWire.from.path.length === 0 && pipeHandleTrunkKeys.has(innerTk)) {
          currentTk = innerTk;
        } else {
          parts.push(sRef(inWire.from, true));
          break;
        }
      }
      sourcePart = parts.join(":");
    } else {
      sourcePart = sRef(fromRef, true);
    }
    lines.push(`alias ${sourcePart} as ${alias}`);
  }
  // Also emit wires reading from top-level __local bindings
  for (const lw of localReadWires) {
    // Skip element-targeting reads (emitted inside array blocks)
    if (
      lw.to.module === SELF_MODULE &&
      lw.to.type === bridge.type &&
      lw.to.field === bridge.field
    ) {
      // Check if this targets an array element path
      const toPathStr = lw.to.path.join(".");
      if (toPathStr in arrayIterators) continue;
      // Check if any array iterator path is a prefix of this path
      let isArrayElement = false;
      for (const iterPath of Object.keys(arrayIterators)) {
        if (iterPath === "" || toPathStr.startsWith(iterPath + ".")) {
          isArrayElement = true;
          break;
        }
      }
      if (isArrayElement) continue;
    }
    const alias = lw.from.field;
    const safeSep = lw.safe || lw.from.rootSafe ? "?." : ".";
    const fromPart =
      lw.from.path.length > 0
        ? alias +
          safeSep +
          serPath(lw.from.path, lw.from.rootSafe, lw.from.pathSafe)
        : alias;
    const toStr = sRef(lw.to, false);
    lines.push(`${toStr} <- ${fromPart}`);
  }

  // ── Pipe wires ───────────────────────────────────────────────────────
  for (const [tk, outWire] of fromOutMap.entries()) {
    if (pipeHandleTrunkKeys.has(refTrunkKey(outWire.to))) continue;

    // ── Expression chain detection ────────────────────────────────────
    // If the outermost fork is an expression fork, recursively reconstruct
    // the infix expression tree, respecting precedence grouping.
    if (exprForks.has(tk)) {
      // Element-targeting expressions are handled in serializeArrayElements
      if (isUnderArrayScope(outWire.to)) continue;
      // Recursively serialize an expression fork into infix notation.
      function serializeExprTree(
        forkTk: string,
        parentPrec?: number,
      ): string | null {
        const info = exprForks.get(forkTk);
        if (!info) return null;

        // condAnd/condOr logic wire — reconstruct from leftRef/rightRef
        if (info.logicWire) {
          const logic =
            "condAnd" in info.logicWire
              ? info.logicWire.condAnd
              : info.logicWire.condOr;
          let leftStr: string;
          const leftTk = refTrunkKey(logic.leftRef);
          if (logic.leftRef.path.length === 0 && exprForks.has(leftTk)) {
            leftStr =
              serializeExprTree(leftTk, OP_PREC_SER[info.op] ?? 0) ??
              sRef(logic.leftRef, true);
          } else {
            leftStr = logic.leftRef.element
              ? "ITER." + serPath(logic.leftRef.path)
              : sRef(logic.leftRef, true);
          }

          let rightStr: string;
          if (logic.rightRef) {
            const rightTk = refTrunkKey(logic.rightRef);
            if (logic.rightRef.path.length === 0 && exprForks.has(rightTk)) {
              rightStr =
                serializeExprTree(rightTk, OP_PREC_SER[info.op] ?? 0) ??
                sRef(logic.rightRef, true);
            } else {
              rightStr = logic.rightRef.element
                ? "ITER." + serPath(logic.rightRef.path)
                : sRef(logic.rightRef, true);
            }
          } else if (logic.rightValue != null) {
            rightStr = formatExprValue(logic.rightValue);
          } else {
            rightStr = "0";
          }

          let result = `${leftStr} ${info.op} ${rightStr}`;
          const myPrec = OP_PREC_SER[info.op] ?? 0;
          if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
          return result;
        }

        // Serialize left operand (from .a wire)
        let leftStr: string | null = null;
        if (info.aWire) {
          const fromTk = refTrunkKey(info.aWire.from);
          if (info.aWire.from.path.length === 0 && exprForks.has(fromTk)) {
            leftStr = serializeExprTree(fromTk, OP_PREC_SER[info.op] ?? 0);
          } else {
            leftStr = info.aWire.from.element
              ? "ITER." + serPath(info.aWire.from.path)
              : sRef(info.aWire.from, true);
          }
        }

        // Serialize right operand (from .b wire)
        let rightStr: string;
        if (info.bWire && "value" in info.bWire) {
          rightStr = formatExprValue(info.bWire.value);
        } else if (info.bWire && "from" in info.bWire) {
          const bFrom = (info.bWire as FW).from;
          const bTk = refTrunkKey(bFrom);
          if (bFrom.path.length === 0 && exprForks.has(bTk)) {
            rightStr =
              serializeExprTree(bTk, OP_PREC_SER[info.op] ?? 0) ??
              sRef(bFrom, true);
          } else {
            rightStr = bFrom.element
              ? "ITER." + serPath(bFrom.path)
              : sRef(bFrom, true);
          }
        } else {
          rightStr = "0";
        }

        if (leftStr == null) return rightStr;
        // Unary `not` — only has .a operand
        if (info.op === "not") return `not ${leftStr}`;
        let result = `${leftStr} ${info.op} ${rightStr}`;
        const myPrec = OP_PREC_SER[info.op] ?? 0;
        if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
        return result;
      }

      const exprStr = serializeExprTree(tk);
      if (exprStr) {
        const destStr = sRef(outWire.to, false);
        const fallbackStr = (outWire.fallbacks ?? [])
          .map((f) => {
            const op = f.type === "falsy" ? "||" : "??";
            if (f.control) return ` ${op} ${serializeControl(f.control)}`;
            if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
            return ` ${op} ${f.value}`;
          })
          .join("");
        const errf =
          "catchControl" in outWire && outWire.catchControl
            ? ` catch ${serializeControl(outWire.catchControl)}`
            : outWire.catchFallbackRef
              ? ` catch ${sPipeOrRef(outWire.catchFallbackRef)}`
              : outWire.catchFallback
                ? ` catch ${outWire.catchFallback}`
                : "";
        lines.push(`${destStr} <- ${exprStr}${fallbackStr}${errf}`);
      }
      continue;
    }

    // ── Concat (template string) detection ───────────────────────────
    if (concatForks.has(tk)) {
      if (isUnderArrayScope(outWire.to)) continue; // handled in serializeArrayElements
      const templateStr = reconstructTemplateString(tk);
      if (templateStr) {
        const destStr = sRef(outWire.to, false);
        const fallbackStr = (outWire.fallbacks ?? [])
          .map((f) => {
            const op = f.type === "falsy" ? "||" : "??";
            if (f.control) return ` ${op} ${serializeControl(f.control)}`;
            if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
            return ` ${op} ${f.value}`;
          })
          .join("");
        const errf =
          "catchControl" in outWire && outWire.catchControl
            ? ` catch ${serializeControl(outWire.catchControl)}`
            : outWire.catchFallbackRef
              ? ` catch ${sPipeOrRef(outWire.catchFallbackRef)}`
              : outWire.catchFallback
                ? ` catch ${outWire.catchFallback}`
                : "";
        lines.push(`${destStr} <- ${templateStr}${fallbackStr}${errf}`);
      }
      continue;
    }

    // ── Normal pipe chain ─────────────────────────────────────────────
    const handleChain: string[] = [];
    let currentTk = tk;
    let actualSourceRef: NodeRef | null = null;
    for (;;) {
      const handleName = handleMap.get(currentTk);
      if (!handleName) break;
      const inWire = toInMap.get(currentTk);
      const fieldName = inWire?.to.path[0] ?? "in";
      const token =
        fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
      handleChain.push(token);
      if (!inWire) break;
      const fromTk = refTrunkKey(inWire.from);
      if (inWire.from.path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
        currentTk = fromTk;
      } else {
        actualSourceRef = inWire.from;
        break;
      }
    }

    if (actualSourceRef && handleChain.length > 0) {
      const sourceStr = sRef(actualSourceRef, true);
      const destStr = sRef(outWire.to, false);
      const fallbackStr = (outWire.fallbacks ?? [])
        .map((f) => {
          const op = f.type === "falsy" ? "||" : "??";
          if (f.control) return ` ${op} ${serializeControl(f.control)}`;
          if (f.ref) return ` ${op} ${sPipeOrRef(f.ref)}`;
          return ` ${op} ${f.value}`;
        })
        .join("");
      const errf =
        "catchControl" in outWire && outWire.catchControl
          ? ` catch ${serializeControl(outWire.catchControl)}`
          : outWire.catchFallbackRef
            ? ` catch ${sPipeOrRef(outWire.catchFallbackRef)}`
            : outWire.catchFallback
              ? ` catch ${outWire.catchFallback}`
              : "";
      lines.push(
        `${destStr} <- ${handleChain.join(":")}:${sourceStr}${fallbackStr}${errf}`,
      );
    }
  }

  // Force statements
  if (bridge.forces) {
    for (const f of bridge.forces) {
      lines.push(
        f.catchError ? `force ${f.handle} catch null` : `force ${f.handle}`,
      );
    }
  }

  // Indent wire body lines and close the block
  for (let i = wireBodyStart; i < lines.length; i++) {
    if (lines[i] !== "") lines[i] = `  ${lines[i]}`;
  }
  lines.push(`}`);

  return lines.join("\n");
}

/**
 * Recomputes instance numbers from handle bindings in declaration order.
 */
function buildHandleMap(bridge: Bridge): {
  handleMap: Map<string, string>;
  inputHandle?: string;
  outputHandle?: string;
} {
  const handleMap = new Map<string, string>();
  const instanceCounters = new Map<string, number>();
  let inputHandle: string | undefined;
  let outputHandle: string | undefined;

  for (const h of bridge.handles) {
    switch (h.kind) {
      case "tool": {
        const lastDot = h.name.lastIndexOf(".");
        if (lastDot !== -1) {
          // Dotted name: module.field
          const modulePart = h.name.substring(0, lastDot);
          const fieldPart = h.name.substring(lastDot + 1);
          const ik = `${modulePart}:${fieldPart}`;
          const instance = (instanceCounters.get(ik) ?? 0) + 1;
          instanceCounters.set(ik, instance);
          handleMap.set(
            `${modulePart}:${bridge.type}:${fieldPart}:${instance}`,
            h.handle,
          );
        } else {
          // Simple name: inline tool
          const ik = `Tools:${h.name}`;
          const instance = (instanceCounters.get(ik) ?? 0) + 1;
          instanceCounters.set(ik, instance);
          handleMap.set(`${SELF_MODULE}:Tools:${h.name}:${instance}`, h.handle);
        }
        break;
      }
      case "input":
        inputHandle = h.handle;
        break;
      case "output":
        outputHandle = h.handle;
        break;
      case "context":
        handleMap.set(`${SELF_MODULE}:Context:context`, h.handle);
        break;
      case "const":
        handleMap.set(`${SELF_MODULE}:Const:const`, h.handle);
        break;
      case "define":
        handleMap.set(
          `__define_${h.handle}:${bridge.type}:${bridge.field}`,
          h.handle,
        );
        break;
    }
  }

  return { handleMap, inputHandle, outputHandle };
}

function serializeRef(
  ref: NodeRef,
  bridge: Bridge,
  handleMap: Map<string, string>,
  inputHandle: string | undefined,
  outputHandle: string | undefined,
  isFrom: boolean,
): string {
  if (ref.element) {
    // Element refs are only serialized inside brace blocks (using the iterator name).
    // This path should not be reached in normal serialization.
    return "item." + serPath(ref.path);
  }

  const hasSafe = ref.rootSafe || ref.pathSafe?.some((s) => s);
  const firstSep = hasSafe && ref.rootSafe ? "?." : ".";

  /** Join a handle/prefix with a serialized path, omitting the dot when
   *  the path starts with a bracket index (e.g. `geo` + `[0].lat` → `geo[0].lat`). */
  function joinHandlePath(
    prefix: string,
    sep: string,
    pathStr: string,
  ): string {
    if (pathStr.startsWith("[")) return prefix + pathStr;
    return prefix + sep + pathStr;
  }

  // Bridge's own trunk (no instance, no element)
  const isBridgeTrunk =
    ref.module === SELF_MODULE &&
    ref.type === bridge.type &&
    ref.field === bridge.field &&
    !ref.instance &&
    !ref.element;

  if (isBridgeTrunk) {
    if (isFrom && inputHandle) {
      // From side: use input handle (data comes from args)
      return ref.path.length > 0
        ? joinHandlePath(
            inputHandle,
            firstSep,
            serPath(ref.path, ref.rootSafe, ref.pathSafe),
          )
        : inputHandle;
    }
    if (!isFrom && outputHandle) {
      // To side: use output handle
      return ref.path.length > 0
        ? joinHandlePath(outputHandle, ".", serPath(ref.path))
        : outputHandle;
    }
    // Fallback (no handle declared — legacy/serializer-only path)
    return serPath(ref.path, ref.rootSafe, ref.pathSafe);
  }

  // Lookup by trunk key
  const trunkStr =
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;
  const handle = handleMap.get(trunkStr);
  if (handle) {
    if (ref.path.length === 0) return handle;
    return joinHandlePath(
      handle,
      firstSep,
      serPath(ref.path, ref.rootSafe, ref.pathSafe),
    );
  }

  // Fallback: bare path
  return serPath(ref.path, ref.rootSafe, ref.pathSafe);
}

/**
 * Serialize a path array to dot notation with [n] for numeric indices.
 * When `rootSafe` or `pathSafe` are provided, emits `?.` for safe segments.
 */
function serPath(
  path: string[],
  rootSafe?: boolean,
  pathSafe?: boolean[],
): string {
  let result = "";
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const isSafe = i === 0 ? !!rootSafe : !!pathSafe?.[i];
    if (/^\d+$/.test(segment)) {
      result += `[${segment}]`;
    } else {
      if (result.length > 0) result += isSafe ? "?." : ".";
      result += segment;
    }
  }
  return result;
}
