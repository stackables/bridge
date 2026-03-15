import type {
  Bridge,
  BridgeDocument,
  ConstDef,
  ControlFlowInstruction,
  DefineDef,
  Expression,
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

// ── Wire shape helpers ──────────────────────────────────────────────
type RefExpr = Extract<Expression, { type: "ref" }>;
type LitExpr = Extract<Expression, { type: "literal" }>;
type TernExpr = Extract<Expression, { type: "ternary" }>;
type AndOrExpr =
  | Extract<Expression, { type: "and" }>
  | Extract<Expression, { type: "or" }>;

const isPull = (w: Wire): boolean => w.sources[0]?.expr.type === "ref";
const isLit = (w: Wire): boolean => w.sources[0]?.expr.type === "literal";
const isTern = (w: Wire): boolean => w.sources[0]?.expr.type === "ternary";
const isAndW = (w: Wire): boolean => w.sources[0]?.expr.type === "and";
const isOrW = (w: Wire): boolean => w.sources[0]?.expr.type === "or";

const wRef = (w: Wire): NodeRef => (w.sources[0].expr as RefExpr).ref;
const wVal = (w: Wire): string => (w.sources[0].expr as LitExpr).value;
const wSafe = (w: Wire): true | undefined => {
  const e = w.sources[0].expr;
  return e.type === "ref" ? e.safe : undefined;
};
const wTern = (w: Wire): TernExpr => w.sources[0].expr as TernExpr;
const wAndOr = (w: Wire): AndOrExpr => w.sources[0].expr as AndOrExpr;
const eRef = (e: Expression): NodeRef => (e as RefExpr).ref;
const eVal = (e: Expression): string => (e as LitExpr).value;

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

/**
 * Serialize fallback entries (sources after the first) as `|| val` / `?? val`.
 * `refFn` renders NodeRef→string; `valFn` renders literal value→string.
 */
function serFallbacks(
  w: Wire,
  refFn: (ref: NodeRef) => string,
  valFn: (v: string) => string = (v) => v,
): string {
  if (w.sources.length <= 1) return "";
  return w.sources
    .slice(1)
    .map((s) => {
      const op = s.gate === "nullish" ? "??" : "||";
      const e = s.expr;
      if (e.type === "control") return ` ${op} ${serializeControl(e.control)}`;
      if (e.type === "ref") return ` ${op} ${refFn(e.ref)}`;
      if (e.type === "literal") return ` ${op} ${valFn(e.value)}`;
      return "";
    })
    .join("");
}

/** Serialize catch handler as ` catch <value>`. */
function serCatch(
  w: Wire,
  refFn: (ref: NodeRef) => string,
  valFn: (v: string) => string = (v) => v,
): string {
  if (!w.catch) return "";
  if ("control" in w.catch)
    return ` catch ${serializeControl(w.catch.control)}`;
  if ("ref" in w.catch) return ` catch ${refFn(w.catch.ref)}`;
  return ` catch ${valFn(w.catch.value)}`;
}

// ── Serializer ───────────────────────────────────────────────────────────────

export function serializeBridge(doc: BridgeDocument): string {
  const version = doc.version ?? BRIDGE_VERSION;
  const { instructions } = doc;
  if (instructions.length === 0) return "";

  const blocks: string[] = [];

  // Group consecutive const declarations into a single block
  let i = 0;
  while (i < instructions.length) {
    const instr = instructions[i]!;
    if (instr.kind === "const") {
      const constLines: string[] = [];
      while (i < instructions.length && instructions[i]!.kind === "const") {
        const c = instructions[i] as ConstDef;
        constLines.push(`const ${c.name} = ${c.value}`);
        i++;
      }
      blocks.push(constLines.join("\n"));
    } else if (instr.kind === "tool") {
      blocks.push(serializeToolBlock(instr as ToolDef));
      i++;
    } else if (instr.kind === "define") {
      blocks.push(serializeDefineBlock(instr as DefineDef));
      i++;
    } else {
      blocks.push(serializeBridgeBlock(instr as Bridge));
      i++;
    }
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
  const toolWires: Wire[] = tool.wires;
  const lines: string[] = [];
  const hasBody =
    tool.handles.length > 0 || toolWires.length > 0 || !!tool.onError;

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
    aWire: Wire | undefined;
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
      let aWire: Wire | undefined;
      let bWire: Wire | undefined;
      for (const w of toolWires) {
        const wTo = w.to;
        if (refTk(wTo) !== ph.key || wTo.path.length !== 1) continue;
        if (wTo.path[0] === "a" && isPull(w)) aWire = w as Wire;
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
      for (const w of toolWires) {
        const wTo = w.to;
        if (refTk(wTo) !== ph.key) continue;
        if (wTo.path.length !== 2 || wTo.path[0] !== "parts") continue;
        const idx = parseInt(wTo.path[1], 10);
        if (isNaN(idx)) continue;
        if (isLit(w) && !isPull(w)) {
          partsMap.set(idx, { kind: "text", value: wVal(w) });
        } else if (isPull(w)) {
          partsMap.set(idx, {
            kind: "ref",
            ref: wRef(w),
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
  for (const w of toolWires) {
    if (!isPull(w)) continue;
    const fromTk = refTk(wRef(w));
    if (
      wRef(w).path.length === 0 &&
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
      const aFromTk = refTk(wRef(info.aWire!));
      if (exprForks.has(aFromTk)) {
        left = reconstructExpr(
          aFromTk,
          TOOL_PREC[info.op as keyof typeof TOOL_PREC],
        );
      } else {
        left = serToolRef(wRef(info.aWire!));
      }
    } else {
      left = "?";
    }

    // Reconstruct right operand
    let right: string;
    if (info.bWire) {
      if (isPull(info.bWire)) {
        const bFromTk = refTk(wRef(info.bWire!));
        if (exprForks.has(bFromTk)) {
          right = reconstructExpr(
            bFromTk,
            TOOL_PREC[info.op as keyof typeof TOOL_PREC],
          );
        } else {
          right = serToolRef(wRef(info.bWire!));
        }
      } else if (isLit(info.bWire)) {
        right = formatExprValue(wVal(info.bWire!));
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
  for (const wire of toolWires) {
    // Skip internal expression/concat wires
    if (exprInternalWires.has(wire) || concatInternalWires.has(wire)) continue;

    const isSelfWire =
      wire.to.module === SELF_MODULE &&
      wire.to.type === "Tools" &&
      wire.to.field === tool.name;
    const prefix = isSelfWire ? "." : "";

    // Check if this wire's source is an expression or concat fork
    if (isPull(wire)) {
      const fromTk = refTk(wRef(wire));

      // Expression fork output wire
      if (wRef(wire).path.length === 0 && exprForks.has(fromTk)) {
        const target = wire.to.path.join(".");
        const exprStr = reconstructExpr(fromTk);
        // Check for ternary, coalesce, fallbacks, catch on the wire
        let suffix = "";
        if (isTern(wire)) {
          const tern = wTern(wire);
          const trueVal =
            tern.then.type === "literal"
              ? formatBareValue(eVal(tern.then))
              : serToolRef(eRef(tern.then));
          const falseVal =
            tern.else.type === "literal"
              ? formatBareValue(eVal(tern.else))
              : serToolRef(eRef(tern.else));
          lines.push(
            `  ${prefix}${target} <- ${exprStr} ? ${trueVal} : ${falseVal}`,
          );
          continue;
        }
        suffix += serFallbacks(wire, serToolRef, formatBareValue);
        suffix += serCatch(wire, serToolRef, formatBareValue);
        lines.push(`  ${prefix}${target} <- ${exprStr}${suffix}`);
        continue;
      }

      // Concat fork output wire (template string)
      if (
        wRef(wire).path.length <= 1 &&
        concatForks.has(
          wRef(wire).path.length === 0
            ? fromTk
            : refTk({ ...wRef(wire), path: [] }),
        )
      ) {
        const concatTk =
          wRef(wire).path.length === 0
            ? fromTk
            : refTk({ ...wRef(wire), path: [] });
        // Only handle .value path (standard concat output)
        if (
          wRef(wire).path.length === 0 ||
          (wRef(wire).path.length === 1 && wRef(wire).path[0] === "value")
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
      if (wire.pipe && pipeHandleTrunkKeys.has(refTk(wire.to))) {
        continue;
      }
    }

    // Ternary wire: has `cond` (condition ref), `thenValue`/`thenRef`, `elseValue`/`elseRef`
    if (isTern(wire)) {
      const tern = wTern(wire);
      const target = wire.to.path.join(".");
      const condStr = serToolRef(eRef(tern.cond));
      const thenVal =
        tern.then.type === "literal"
          ? formatBareValue(eVal(tern.then))
          : serToolRef(eRef(tern.then));
      const elseVal =
        tern.else.type === "literal"
          ? formatBareValue(eVal(tern.else))
          : serToolRef(eRef(tern.else));
      lines.push(
        `  ${prefix}${target} <- ${condStr} ? ${thenVal} : ${elseVal}`,
      );
      continue;
    }

    if (isLit(wire) && !isTern(wire)) {
      // Constant wire
      const target = wire.to.path.join(".");
      if (needsQuoting(wVal(wire))) {
        lines.push(`  ${prefix}${target} = "${wVal(wire)}"`);
      } else {
        lines.push(`  ${prefix}${target} = ${formatBareValue(wVal(wire))}`);
      }
    } else if (isPull(wire)) {
      // Pull wire — reconstruct source from handle map
      const sourceStr = serializeToolWireSource(wRef(wire), tool);
      const target = wire.to.path.join(".");
      let suffix = "";
      suffix += serFallbacks(wire, serToolRef, formatBareValue);
      suffix += serCatch(wire, serToolRef, formatBareValue);
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
  toInMap: Map<string, Wire>,
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
        wRef(inWire).instance != null
          ? `${wRef(inWire).module}:${wRef(inWire).type}:${wRef(inWire).field}:${wRef(inWire).instance}`
          : `${wRef(inWire).module}:${wRef(inWire).type}:${wRef(inWire).field}`;
      if (wRef(inWire).path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
        currentTk = fromTk;
      } else {
        actualSourceRef = wRef(inWire);
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
  const bridgeWires: Wire[] = bridge.wires;

  // ── Passthrough shorthand ───────────────────────────────────────────
  if (bridge.passthrough) {
    return `bridge ${bridge.type}.${bridge.field} with ${bridge.passthrough}`;
  }

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  lines.push(`bridge ${bridge.type}.${bridge.field} {`);

  // Collect trunk keys of define-inlined tools (handle contains $)
  const defineInlinedTrunkKeys = new Set<string>();
  for (const h of bridge.handles) {
    if (h.kind === "tool" && h.handle.includes("$")) {
      const lastDot = h.name.lastIndexOf(".");
      if (lastDot !== -1) {
        const mod = h.name.substring(0, lastDot);
        const fld = h.name.substring(lastDot + 1);
        // Count instances to match trunk key
        let inst = 0;
        for (const h2 of bridge.handles) {
          if (h2.kind !== "tool") continue;
          const ld2 = h2.name.lastIndexOf(".");
          if (
            ld2 !== -1 &&
            h2.name.substring(0, ld2) === mod &&
            h2.name.substring(ld2 + 1) === fld
          )
            inst++;
          if (h2 === h) break;
        }
        defineInlinedTrunkKeys.add(`${mod}:${bridge.type}:${fld}:${inst}`);
      } else {
        // Tool name without module prefix (e.g. "userApi")
        let inst = 0;
        for (const h2 of bridge.handles) {
          if (h2.kind !== "tool") continue;
          if (h2.name.lastIndexOf(".") === -1 && h2.name === h.name) inst++;
          if (h2 === h) break;
        }
        defineInlinedTrunkKeys.add(`${SELF_MODULE}:Tools:${h.name}:${inst}`);
      }
    }
  }

  // Detect element-scoped define handles: defines whose __define_in_ wires
  // originate from element scope (i.e., the define is used inside an array block)
  const elementScopedDefines = new Set<string>();
  for (const w of bridgeWires) {
    if (
      isPull(w) &&
      wRef(w).element &&
      w.to.module.startsWith("__define_in_")
    ) {
      const defineHandle = w.to.module.substring("__define_in_".length);
      elementScopedDefines.add(defineHandle);
    }
  }

  for (const h of bridge.handles) {
    // Element-scoped tool handles are emitted inside their array block
    if (h.kind === "tool" && h.element) continue;
    // Define-inlined tool handles are part of the define block, not the bridge
    if (h.kind === "tool" && h.handle.includes("$")) continue;
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
        if (!elementScopedDefines.has(h.handle)) {
          lines.push(`  with ${h.name} as ${h.handle}`);
        }
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

  type FW = Wire;
  const toInMap = new Map<string, FW>();
  const fromOutMap = new Map<string, FW>();
  const pipeWireSet = new Set<Wire>();

  for (const w of bridgeWires) {
    if (!isPull(w) || !w.pipe) continue;
    const fw = w as FW;
    pipeWireSet.add(w);
    const toTk = refTrunkKey(fw.to);
    if (fw.to.path.length === 1 && pipeHandleTrunkKeys.has(toTk)) {
      toInMap.set(toTk, fw);
    }
    const fromTk = refTrunkKey(wRef(fw));
    if (wRef(fw).path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
      fromOutMap.set(fromTk, fw);
    }
    // Concat fork output: from.path=["value"], target is not a pipe handle
    if (
      wRef(fw).path.length === 1 &&
      wRef(fw).path[0] === "value" &&
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
    logicWire?: Wire | Wire;
  };
  const exprForks = new Map<string, ExprForkInfo>();
  const exprPipeWireSet = new Set<Wire>(); // wires that belong to expression forks

  for (const ph of bridge.pipeHandles ?? []) {
    if (!ph.handle.startsWith("__expr_")) continue;
    const op = FN_TO_OP[ph.baseTrunk.field];
    if (!op) continue;

    // For condAnd/condOr wires (field === "__and" or "__or")
    if (ph.baseTrunk.field === "__and" || ph.baseTrunk.field === "__or") {
      const isAndField = ph.baseTrunk.field === "__and";
      const logicWire = bridgeWires.find(
        (w) =>
          (isAndField ? isAndW(w) : isOrW(w)) && refTrunkKey(w.to) === ph.key,
      ) as Wire | undefined;

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
    for (const w of bridgeWires) {
      const wTo = w.to as NodeRef;
      if (!wTo || refTrunkKey(wTo) !== ph.key || wTo.path.length !== 1)
        continue;
      if (wTo.path[0] === "a" && isPull(w)) aWire = w as FW;
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
    for (const w of bridgeWires) {
      const wTo = w.to as NodeRef;
      if (!wTo || refTrunkKey(wTo) !== ph.key) continue;
      if (wTo.path.length !== 2 || wTo.path[0] !== "parts") continue;
      const idx = parseInt(wTo.path[1], 10);
      if (isNaN(idx)) continue;
      if (isLit(w) && !isPull(w)) {
        partsMap.set(idx, { kind: "text", value: wVal(w) });
      } else if (isPull(w)) {
        partsMap.set(idx, { kind: "ref", ref: wRef(w) });
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
  // OR define-output wires targeting an array-scoped bridge path
  const isElementToolWire = (w: Wire): boolean => {
    if (!isPull(w)) return false;
    if (elementToolTrunkKeys.has(refTrunkKey(wRef(w)))) return true;
    if (elementToolTrunkKeys.has(refTrunkKey(w.to))) return true;
    return false;
  };
  const isDefineOutElementWire = (w: Wire): boolean => {
    if (!isPull(w)) return false;
    if (!wRef(w).module.startsWith("__define_out_")) return false;
    // Check if target is a bridge trunk path under any array iterator
    const to = w.to;
    if (
      to.module !== SELF_MODULE ||
      to.type !== bridge.type ||
      to.field !== bridge.field
    )
      return false;
    const ai = bridge.arrayIterators ?? {};
    const p = to.path.join(".");
    for (const iterPath of Object.keys(ai)) {
      if (iterPath === "" || p.startsWith(iterPath + ".")) return true;
    }
    return false;
  };
  const elementPullWires = bridgeWires.filter(
    (w): w is Wire =>
      isPull(w) &&
      (!!wRef(w).element || isElementToolWire(w) || isDefineOutElementWire(w)),
  );
  // Constant wires: isLit(w) && to.element=true
  const elementConstWires = bridgeWires.filter(
    (w): w is Wire => isLit(w) && !!w.to.element,
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

  // Collect element-targeting pipe chain wires
  // These use ITER. as a placeholder for element refs, replaced in serializeArrayElements
  type ElementPipeInfo = {
    toPath: string[];
    sourceStr: string; // "handle:ITER.field" or "h1:h2:ITER.field"
    fallbackStr: string;
    errStr: string;
  };
  const elementPipeWires: ElementPipeInfo[] = [];

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
    for (const w of bridgeWires) {
      if (!isPull(w)) continue;
      const fromTk = refTrunkKey(wRef(w));
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

  // ── Helper: is a wire endpoint a define-inlined tool? ─────────────
  const isDefineInlinedRef = (ref: NodeRef): boolean => {
    const tk =
      ref.instance != null
        ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
        : `${ref.module}:${ref.type}:${ref.field}`;
    return defineInlinedTrunkKeys.has(tk);
  };

  // ── Helper: is a module a define-boundary internal? ────────────────
  const isDefineBoundaryModule = (mod: string): boolean =>
    mod.startsWith("__define_in_") || mod.startsWith("__define_out_");

  // ── Helper: is a wire fully internal to define expansion? ──────────
  // User-authored wires have one define-boundary endpoint + one regular endpoint.
  // Internal expansion wires have both endpoints in define-boundary/inlined-tool space.
  const isDefineInternalWire = (w: Wire): boolean => {
    const toIsDefine =
      isDefineBoundaryModule(w.to.module) || isDefineInlinedRef(w.to);
    if (!toIsDefine) return false;
    if (!isPull(w)) return false;
    const fromRef = wRef(w) as NodeRef;
    return (
      isDefineBoundaryModule(fromRef.module) || isDefineInlinedRef(fromRef)
    );
  };

  // ── Exclude pipe, element-pull, element-const, expression-internal, concat-internal, __local, define-internal, and element-scoped ternary wires from main loop
  const regularWires = bridgeWires.filter(
    (w) =>
      !pipeWireSet.has(w) &&
      !exprPipeWireSet.has(w) &&
      !concatPipeWireSet.has(w) &&
      (!isPull(w) || !wRef(w).element) &&
      !isElementToolWire(w) &&
      (!isLit(w) || !w.to.element) &&
      w.to.module !== "__local" &&
      (!isPull(w) || (wRef(w) as NodeRef).module !== "__local") &&
      (!isTern(w) || !isUnderArrayScope(w.to)) &&
      (!isPull(w) || !isDefineInlinedRef(wRef(w))) &&
      !isDefineInlinedRef(w.to) &&
      !isDefineOutElementWire(w) &&
      !isDefineInternalWire(w),
  );

  // ── Collect __local binding wires for array-scoped `with` declarations ──
  type LocalBindingInfo = {
    alias: string;
    sourceWire?: Wire;
    ternaryWire?: Wire;
  };
  const localBindingsByAlias = new Map<string, LocalBindingInfo>();
  const localReadWires: Wire[] = [];
  for (const w of bridgeWires) {
    if (w.to.module === "__local" && isPull(w)) {
      localBindingsByAlias.set(w.to.field, {
        alias: w.to.field,
        sourceWire: w as Wire,
      });
    }
    if (w.to.module === "__local" && isTern(w)) {
      localBindingsByAlias.set(w.to.field, {
        alias: w.to.field,
        ternaryWire: w as Wire,
      });
    }
    if (isPull(w) && (wRef(w) as NodeRef).module === "__local") {
      localReadWires.push(w as Wire);
    }
  }

  // ── Collect element-scoped ternary wires ────────────────────────────
  const elementTernaryWires = bridgeWires.filter(
    (w): w is Wire => isTern(w) && isUnderArrayScope(w.to),
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
        const logic = wAndOr(info.logicWire!);
        let leftStr: string;
        const leftTk = refTrunkKey(eRef(logic.left));
        if (eRef(logic.left).path.length === 0 && exprForks.has(leftTk)) {
          leftStr =
            serializeElemExprTree(leftTk, OP_PREC_SER[info.op] ?? 0) ??
            sRef(eRef(logic.left), true);
        } else {
          leftStr = eRef(logic.left).element
            ? "ITER." + serPath(eRef(logic.left).path)
            : sRef(eRef(logic.left), true);
        }

        let rightStr: string;
        if (logic.right.type === "ref") {
          const rightTk = refTrunkKey(eRef(logic.right));
          if (eRef(logic.right).path.length === 0 && exprForks.has(rightTk)) {
            rightStr =
              serializeElemExprTree(rightTk, OP_PREC_SER[info.op] ?? 0) ??
              sRef(eRef(logic.right), true);
          } else {
            rightStr = eRef(logic.right).element
              ? "ITER." + serPath(eRef(logic.right).path)
              : sRef(eRef(logic.right), true);
          }
        } else if (logic.right.type === "literal") {
          rightStr = formatExprValue(eVal(logic.right));
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
        const fromTk = refTrunkKey(wRef(info.aWire!));
        if (wRef(info.aWire!).path.length === 0 && exprForks.has(fromTk)) {
          leftStr = serializeElemExprTree(fromTk, OP_PREC_SER[info.op] ?? 0);
        } else {
          leftStr = wRef(info.aWire!).element
            ? "ITER." + serPath(wRef(info.aWire!).path)
            : sRef(wRef(info.aWire!), true);
        }
      }

      let rightStr: string;
      if (info.bWire && isLit(info.bWire)) {
        rightStr = formatExprValue(wVal(info.bWire!));
      } else if (info.bWire && isPull(info.bWire)) {
        const bFrom = wRef(info.bWire!);
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

  // Pre-compute element-targeting normal pipe chain wires
  for (const [tk, outWire] of fromOutMap.entries()) {
    if (exprForks.has(tk) || concatForks.has(tk)) continue;
    if (!isUnderArrayScope(outWire.to)) continue;

    // Walk the pipe chain backward to reconstruct handle:source
    const handleChain: string[] = [];
    let currentTk = tk;
    let sourceStr: string | null = null;
    for (;;) {
      const handleName = handleMap.get(currentTk);
      if (!handleName) break;
      const inWire = toInMap.get(currentTk);
      const fieldName = inWire?.to.path[0] ?? "in";
      const token =
        fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
      handleChain.push(token);
      if (!inWire) break;
      if (wRef(inWire).element) {
        sourceStr =
          wRef(inWire).path.length > 0
            ? "ITER." + serPath(wRef(inWire).path)
            : "ITER";
        break;
      }
      const fromTk = refTrunkKey(wRef(inWire));
      if (wRef(inWire).path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
        currentTk = fromTk;
      } else {
        sourceStr = sRef(wRef(inWire), true);
        break;
      }
    }
    if (sourceStr && handleChain.length > 0) {
      const fallbackStr = serFallbacks(outWire, sPipeOrRef);
      const errf = serCatch(outWire, sPipeOrRef);
      elementPipeWires.push({
        toPath: outWire.to.path,
        sourceStr: `${handleChain.join(":")}:${sourceStr}`,
        fallbackStr,
        errStr: errf,
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
      const logic = wAndOr(info.logicWire!);
      let leftStr: string;
      const leftTk = refTrunkKey(eRef(logic.left));
      if (eRef(logic.left).path.length === 0 && exprForks.has(leftTk)) {
        leftStr =
          serializeElemExprTreeFn(
            leftTk,
            parentIterName,
            ancestorIterNames,
            OP_PREC_SER[info.op] ?? 0,
          ) ??
          serializeElemRef(eRef(logic.left), parentIterName, ancestorIterNames);
      } else {
        leftStr = serializeElemRef(
          eRef(logic.left),
          parentIterName,
          ancestorIterNames,
        );
      }

      let rightStr: string;
      if (logic.right.type === "ref") {
        const rightTk = refTrunkKey(eRef(logic.right));
        if (eRef(logic.right).path.length === 0 && exprForks.has(rightTk)) {
          rightStr =
            serializeElemExprTreeFn(
              rightTk,
              parentIterName,
              ancestorIterNames,
              OP_PREC_SER[info.op] ?? 0,
            ) ??
            serializeElemRef(
              eRef(logic.right),
              parentIterName,
              ancestorIterNames,
            );
        } else {
          rightStr = serializeElemRef(
            eRef(logic.right),
            parentIterName,
            ancestorIterNames,
          );
        }
      } else if (logic.right.type === "literal") {
        rightStr = formatExprValue(eVal(logic.right));
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
      const fromTk = refTrunkKey(wRef(info.aWire!));
      if (wRef(info.aWire!).path.length === 0 && exprForks.has(fromTk)) {
        leftStr = serializeElemExprTreeFn(
          fromTk,
          parentIterName,
          ancestorIterNames,
          OP_PREC_SER[info.op] ?? 0,
        );
      } else {
        leftStr = serializeElemRef(
          wRef(info.aWire!),
          parentIterName,
          ancestorIterNames,
        );
      }
    }

    let rightStr: string;
    if (info.bWire && isLit(info.bWire)) {
      rightStr = formatExprValue(wVal(info.bWire!));
    } else if (info.bWire && isPull(info.bWire)) {
      const bFrom = wRef(info.bWire!);
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
      const ewFromTk = refTrunkKey(wRef(ew));
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

    // Emit block-scoped local bindings: alias <name> <- <source>
    for (const [alias, info] of localBindingsByAlias) {
      // Ternary alias in element scope
      if (info.ternaryWire) {
        const tw = info.ternaryWire;
        const condStr = serializeElemRef(
          eRef(wTern(tw).cond),
          parentIterName,
          ancestorIterNames,
        );
        const thenStr =
          wTern(tw).then.type === "ref"
            ? serializeElemRef(
                eRef(wTern(tw).then),
                parentIterName,
                ancestorIterNames,
              )
            : (eVal(wTern(tw).then) ?? "null");
        const elseStr =
          wTern(tw).else.type === "ref"
            ? serializeElemRef(
                eRef(wTern(tw).else),
                parentIterName,
                ancestorIterNames,
              )
            : (eVal(wTern(tw).else) ?? "null");
        const fallbackStr = serFallbacks(tw, sPipeOrRef);
        const errf = serCatch(tw, sPipeOrRef);
        lines.push(
          `${indent}alias ${alias} <- ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf}`,
        );
        continue;
      }
      const srcWire = info.sourceWire!;
      // Reconstruct the source expression
      const fromRef = wRef(srcWire);

      // Determine if this alias is element-scoped (skip top-level aliases)
      let isElementScoped = fromRef.element;
      if (!isElementScoped) {
        const srcTk = refTrunkKey(fromRef);
        if (fromRef.path.length === 0 && pipeHandleTrunkKeys.has(srcTk)) {
          // Walk pipe chain — element-scoped if any input is element-scoped
          let walkTk = srcTk;
          while (true) {
            const inWire = toInMap.get(walkTk);
            if (!inWire) break;
            if (wRef(inWire).element) {
              isElementScoped = true;
              break;
            }
            const innerTk = refTrunkKey(wRef(inWire));
            if (
              wRef(inWire).path.length === 0 &&
              pipeHandleTrunkKeys.has(innerTk)
            ) {
              walkTk = innerTk;
            } else {
              break;
            }
          }
        }
      }
      if (!isElementScoped) continue;

      let sourcePart: string;
      if (fromRef.element) {
        sourcePart =
          parentIterName +
          (fromRef.path.length > 0 ? "." + serPath(fromRef.path) : "");
      } else {
        // Check if the source is an expression fork, concat fork, or pipe fork
        const srcTk = refTrunkKey(fromRef);
        if (fromRef.path.length === 0 && exprForks.has(srcTk)) {
          // Expression fork → reconstruct infix expression
          const exprStr = serializeElemExprTreeFn(
            srcTk,
            parentIterName,
            ancestorIterNames,
          );
          sourcePart = exprStr ?? sRef(fromRef, true);
        } else if (
          fromRef.path.length === 0 &&
          pipeHandleTrunkKeys.has(srcTk)
        ) {
          // Walk the pipe chain backward to reconstruct pipe:source
          const parts: string[] = [];
          let currentTk = srcTk;
          while (true) {
            const handleName = handleMap.get(currentTk);
            if (!handleName) break;
            parts.push(handleName);
            const inWire = toInMap.get(currentTk);
            if (!inWire) break;
            if (wRef(inWire).element) {
              parts.push(
                parentIterName +
                  (wRef(inWire).path.length > 0
                    ? "." + serPath(wRef(inWire).path)
                    : ""),
              );
              break;
            }
            const innerTk = refTrunkKey(wRef(inWire));
            if (
              wRef(inWire).path.length === 0 &&
              pipeHandleTrunkKeys.has(innerTk)
            ) {
              currentTk = innerTk;
            } else {
              parts.push(sRef(wRef(inWire), true));
              break;
            }
          }
          sourcePart = parts.join(":");
        } else {
          sourcePart = sRef(fromRef, true);
        }
      }
      const elemFb = serFallbacks(srcWire, sPipeOrRef);
      const elemErrf = serCatch(srcWire, sPipeOrRef);
      lines.push(
        `${indent}alias ${alias} <- ${sourcePart}${elemFb}${elemErrf}`,
      );
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

    // Emit element-scoped define declarations: with <defineName> as <handle>
    // Only emit at root array level (pathDepth === 0) for now
    if (pathDepth === 0) {
      for (const h of bridge.handles) {
        if (h.kind !== "define") continue;
        if (!elementScopedDefines.has(h.handle)) continue;
        lines.push(`${indent}with ${h.name} as ${h.handle}`);
      }
    }

    // Emit constant element wires
    for (const ew of levelConsts) {
      const fieldPath = ew.to.path.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      lines.push(`${indent}${elemTo} = ${formatBareValue(wVal(ew))}`);
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
        if (wRef(ew).element && wRef(ew).elementDepth) {
          const stack = [...ancestorIterNames, parentIterName];
          const idx = stack.length - 1 - wRef(ew).elementDepth!;
          if (idx >= 0) nestedFromIter = stack[idx];
        }
        const fromPart = wRef(ew).element
          ? nestedFromIter + "." + serPath(wRef(ew).path)
          : sRef(wRef(ew), true);
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
      if (wRef(ew).element && wRef(ew).elementDepth) {
        const stack = [...ancestorIterNames, parentIterName];
        const idx = stack.length - 1 - wRef(ew).elementDepth!;
        if (idx >= 0) resolvedIterName = stack[idx];
      }
      const fromPart = wRef(ew).element
        ? resolvedIterName +
          (wRef(ew).path.length > 0 ? "." + serPath(wRef(ew).path) : "")
        : sRef(wRef(ew), true);
      // Tool input or define-in wires target a scoped handle
      const toTk = refTrunkKey(ew.to);
      const toToolHandle =
        elementToolTrunkKeys.has(toTk) ||
        ew.to.module.startsWith("__define_in_")
          ? handleMap.get(toTk)
          : undefined;
      const elemTo = toToolHandle
        ? toToolHandle +
          (ew.to.path.length > 0 ? "." + serPath(ew.to.path) : "")
        : "." + serPath(ew.to.path.slice(pathDepth));

      const fallbackStr = serFallbacks(ew, sPipeOrRef);
      const errf = serCatch(ew, sPipeOrRef);
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

    // Emit pipe chain element wires at this level
    for (const epw of elementPipeWires) {
      if (epw.toPath.length !== pathDepth + 1) continue;
      let match = true;
      for (let i = 0; i < pathDepth; i++) {
        if (epw.toPath[i] !== arrayPath[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const fieldPath = epw.toPath.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      // Replace ITER placeholder with actual iterator name
      const src = epw.sourceStr
        .replaceAll("ITER.", parentIterName + ".")
        .replaceAll(/ITER(?!\.)/g, parentIterName);
      lines.push(`${indent}${elemTo} <- ${src}${epw.fallbackStr}${epw.errStr}`);
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
        eRef(wTern(tw).cond),
        parentIterName,
        ancestorIterNames,
      );
      const thenStr =
        wTern(tw).then.type === "ref"
          ? serializeElemRef(
              eRef(wTern(tw).then),
              parentIterName,
              ancestorIterNames,
            )
          : (eVal(wTern(tw).then) ?? "null");
      const elseStr =
        wTern(tw).else.type === "ref"
          ? serializeElemRef(
              eRef(wTern(tw).else),
              parentIterName,
              ancestorIterNames,
            )
          : (eVal(wTern(tw).else) ?? "null");
      const fallbackStr = serFallbacks(tw, sPipeOrRef);
      const errf = serCatch(tw, sPipeOrRef);
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
      const alias = wRef(lw).field; // __local:Shadow:<alias>
      const safeSep = wSafe(lw) || wRef(lw).rootSafe ? "?." : ".";
      const fromPart =
        wRef(lw).path.length > 0
          ? alias +
            safeSep +
            serPath(wRef(lw).path, wRef(lw).rootSafe, wRef(lw).pathSafe)
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
      function serFork(forkTk: string, parentPrec?: number): string {
        const info = exprForks.get(forkTk);
        if (!info) return "?";
        const myPrec = OP_PREC_SER[info.op] ?? 0;
        let leftStr: string | null = null;
        if (info.aWire) {
          const aTk = refTrunkKey(wRef(info.aWire!));
          const concatLeft = tryResolveConcat(wRef(info.aWire!));
          if (concatLeft) {
            leftStr = concatLeft;
          } else if (
            wRef(info.aWire!).path.length === 0 &&
            exprForks.has(aTk)
          ) {
            leftStr = serFork(aTk, myPrec);
          } else {
            leftStr = sRef(wRef(info.aWire!), true);
          }
        }
        let rightStr: string;
        if (info.bWire && isLit(info.bWire)) {
          rightStr = formatExprValue(wVal(info.bWire!));
        } else if (info.bWire && isPull(info.bWire)) {
          const bFrom = wRef(info.bWire!);
          const bTk = refTrunkKey(bFrom);
          const concatRight = tryResolveConcat(bFrom);
          if (concatRight) {
            rightStr = concatRight;
          } else {
            rightStr =
              bFrom.path.length === 0 && exprForks.has(bTk)
                ? serFork(bTk, myPrec)
                : sRef(bFrom, true);
          }
        } else {
          rightStr = "0";
        }
        if (leftStr == null) return rightStr;
        if (info.op === "not") return `not ${leftStr}`;
        let result = `${leftStr} ${info.op} ${rightStr}`;
        if (parentPrec != null && myPrec < parentPrec) result = `(${result})`;
        return result;
      }
      return serFork(tk) ?? sRef(ref, true);
    }
    return sRef(ref, true);
  }

  // ── Identify spread wires and their sibling wires ───────────────────
  // Spread wires must be emitted inside path scope blocks: `target { ...source; .field <- ... }`
  // Group each spread wire with sibling wires whose to.path extends the spread's to.path.
  type SpreadGroup = {
    spreadWires: Wire[];
    siblingWires: Wire[];
    scopePath: string[];
  };
  const spreadGroups: SpreadGroup[] = [];
  const spreadConsumedWires = new Set<Wire>();

  {
    const spreadWiresInRegular = regularWires.filter(
      (w): w is Wire => isPull(w) && !!w.spread,
    );
    // Group by to.path (scope path)
    const groupMap = new Map<string, SpreadGroup>();
    for (const sw of spreadWiresInRegular) {
      const key = sw.to.path.join(".");
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          spreadWires: [],
          siblingWires: [],
          scopePath: sw.to.path,
        });
      }
      groupMap.get(key)!.spreadWires.push(sw);
      spreadConsumedWires.add(sw);
    }
    // Find sibling wires: non-spread wires whose to.path starts with the scope path
    if (groupMap.size > 0) {
      for (const w of regularWires) {
        if (spreadConsumedWires.has(w)) continue;
        for (const [key, group] of groupMap) {
          const wPath = w.to.path.join(".");
          const prefix = key === "" ? "" : key + ".";
          if (key === "" ? wPath.length > 0 : wPath.startsWith(prefix)) {
            group.siblingWires.push(w);
            spreadConsumedWires.add(w);
            break;
          }
        }
      }
      for (const g of groupMap.values()) {
        spreadGroups.push(g);
      }
    }
  }

  // ── Emit spread scope blocks ───────────────────────────────────────
  for (const group of spreadGroups) {
    const scopePrefix =
      group.scopePath.length > 0
        ? sRef(
            {
              module: SELF_MODULE,
              type: bridge.type,
              field: bridge.field,
              path: group.scopePath,
            },
            false,
          )
        : (outputHandle ?? "o");
    lines.push(`${scopePrefix} {`);
    // Emit spread lines
    for (const sw of group.spreadWires) {
      let fromStr = sRef(wRef(sw), true);
      if (wSafe(sw)) {
        const ref = wRef(sw);
        if (!ref.rootSafe && !ref.pathSafe?.some((s) => s)) {
          if (fromStr.includes(".")) {
            fromStr = fromStr.replace(".", "?.");
          }
        }
      }
      lines.push(`  ... <- ${fromStr}`);
    }
    // Emit sibling wires with paths relative to the scope
    const scopeLen = group.scopePath.length;
    for (const w of group.siblingWires) {
      const relPath = w.to.path.slice(scopeLen);
      if (isLit(w)) {
        lines.push(`  .${relPath.join(".")} = ${formatBareValue(wVal(w))}`);
      } else if (isPull(w)) {
        let fromStr = sRef(wRef(w), true);
        if (wSafe(w)) {
          const ref = wRef(w);
          if (!ref.rootSafe && !ref.pathSafe?.some((s) => s)) {
            if (fromStr.includes(".")) {
              fromStr = fromStr.replace(".", "?.");
            }
          }
        }
        const fallbackStr = serFallbacks(w, sPipeOrRef);
        const errf = serCatch(w, sPipeOrRef);
        lines.push(
          `  .${relPath.join(".")} <- ${fromStr}${fallbackStr}${errf}`,
        );
      }
    }
    lines.push(`}`);
  }

  for (const w of regularWires) {
    // Skip wires already emitted in spread scope blocks
    if (spreadConsumedWires.has(w)) continue;

    // Conditional (ternary) wire
    if (isTern(w)) {
      const toStr = sRef(w.to, false);
      const condStr = serializeExprOrRef(eRef(wTern(w).cond));
      const thenStr =
        wTern(w).then.type === "ref"
          ? sRef(eRef(wTern(w).then), true)
          : (eVal(wTern(w).then) ?? "null");
      const elseStr =
        wTern(w).else.type === "ref"
          ? sRef(eRef(wTern(w).else), true)
          : (eVal(wTern(w).else) ?? "null");
      const fallbackStr = serFallbacks(w, sPipeOrRef);
      const errf = serCatch(w, sPipeOrRef);
      lines.push(
        `${toStr} <- ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf}`,
      );
      continue;
    }

    // Constant wire
    if (isLit(w)) {
      const toStr = sRef(w.to, false);
      lines.push(`${toStr} = ${formatBareValue(wVal(w))}`);
      continue;
    }

    // Skip condAnd/condOr wires (handled in expression tree serialization)
    if (isAndW(w) || isOrW(w)) continue;

    // Array mapping — emit brace-delimited element block
    const arrayKey = w.to.path.join(".");
    if (
      arrayKey in arrayIterators &&
      !serializedArrays.has(arrayKey) &&
      w.to.module === SELF_MODULE &&
      w.to.type === bridge.type &&
      w.to.field === bridge.field
    ) {
      serializedArrays.add(arrayKey);
      const iterName = arrayIterators[arrayKey];
      const fromStr = sRef(wRef(w), true) + "[]";
      const toStr = sRef(w.to, false);
      lines.push(`${toStr} <- ${fromStr} as ${iterName} {`);
      serializeArrayElements(w.to.path, iterName, "  ");
      lines.push(`}`);
      continue;
    }

    // Regular wire
    let fromStr = sRef(wRef(w), true);
    // Legacy safe flag without per-segment info: put ?. after root
    if (wSafe(w)) {
      const ref = wRef(w);
      if (!ref.rootSafe && !ref.pathSafe?.some((s) => s)) {
        if (fromStr.includes(".")) {
          fromStr = fromStr.replace(".", "?.");
        }
      }
    }
    const toStr = sRef(w.to, false);
    const fallbackStr = serFallbacks(w, sPipeOrRef);
    const errf = serCatch(w, sPipeOrRef);
    lines.push(`${toStr} <- ${fromStr}${fallbackStr}${errf}`);
  }

  // ── Top-level alias declarations ─────────────────────────────────────
  // Emit `alias <name> <- <source>` for __local bindings that are NOT
  // element-scoped (those are handled inside serializeArrayElements).
  for (const [alias, info] of localBindingsByAlias) {
    // Ternary alias: emit `alias <cond> ? <then> : <else> [fallbacks] as <name>`
    if (info.ternaryWire) {
      const tw = info.ternaryWire;
      const condStr = serializeExprOrRef(eRef(wTern(tw).cond));
      const thenStr =
        wTern(tw).then.type === "ref"
          ? sRef(eRef(wTern(tw).then), true)
          : (eVal(wTern(tw).then) ?? "null");
      const elseStr =
        wTern(tw).else.type === "ref"
          ? sRef(eRef(wTern(tw).else), true)
          : (eVal(wTern(tw).else) ?? "null");
      const fallbackStr = serFallbacks(tw, sPipeOrRef);
      const errf = serCatch(tw, sPipeOrRef);
      lines.push(
        `alias ${alias} <- ${condStr} ? ${thenStr} : ${elseStr}${fallbackStr}${errf}`,
      );
      continue;
    }
    const srcWire = info.sourceWire!;
    const fromRef = wRef(srcWire);
    // Element-scoped bindings are emitted inside array blocks
    if (fromRef.element) continue;
    // Check if source is a pipe fork with element-sourced input (array-scoped)
    const srcTk = refTrunkKey(fromRef);
    if (fromRef.path.length === 0 && pipeHandleTrunkKeys.has(srcTk)) {
      const inWire = toInMap.get(srcTk);
      if (inWire && wRef(inWire).element) continue;
    }
    // Reconstruct source expression
    let sourcePart: string;
    if (fromRef.path.length === 0 && exprForks.has(srcTk)) {
      // Expression fork → reconstruct infix expression
      sourcePart = serializeExprOrRef(fromRef);
    } else if (tryResolveConcat(fromRef)) {
      // Concat fork → reconstruct template string
      sourcePart = tryResolveConcat(fromRef)!;
    } else if (fromRef.path.length === 0 && pipeHandleTrunkKeys.has(srcTk)) {
      const parts: string[] = [];
      let currentTk = srcTk;
      while (true) {
        const handleName = handleMap.get(currentTk);
        if (!handleName) break;
        parts.push(handleName);
        const inWire = toInMap.get(currentTk);
        if (!inWire) break;
        const innerTk = refTrunkKey(wRef(inWire));
        if (
          wRef(inWire).path.length === 0 &&
          pipeHandleTrunkKeys.has(innerTk)
        ) {
          currentTk = innerTk;
        } else {
          parts.push(sRef(wRef(inWire), true));
          break;
        }
      }
      sourcePart = parts.join(":");
    } else {
      sourcePart = sRef(fromRef, true);
    }
    // Serialize safe navigation on alias source
    if (wSafe(srcWire)) {
      const ref = wRef(srcWire);
      if (!ref.rootSafe && !ref.pathSafe?.some((s) => s)) {
        if (sourcePart.includes(".")) {
          sourcePart = sourcePart.replace(".", "?.");
        }
      }
    }
    const aliasFb = serFallbacks(srcWire, sPipeOrRef);
    const aliasErrf = serCatch(srcWire, sPipeOrRef);
    lines.push(`alias ${alias} <- ${sourcePart}${aliasFb}${aliasErrf}`);
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
    const alias = wRef(lw).field;
    const safeSep = wSafe(lw) || wRef(lw).rootSafe ? "?." : ".";
    const fromPart =
      wRef(lw).path.length > 0
        ? alias +
          safeSep +
          serPath(wRef(lw).path, wRef(lw).rootSafe, wRef(lw).pathSafe)
        : alias;
    const toStr = sRef(lw.to, false);
    const lwFb = serFallbacks(lw, sPipeOrRef);
    const lwErrf = serCatch(lw, sPipeOrRef);
    lines.push(`${toStr} <- ${fromPart}${lwFb}${lwErrf}`);
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
          const logic = wAndOr(info.logicWire!);
          let leftStr: string;
          const leftTk = refTrunkKey(eRef(logic.left));
          if (eRef(logic.left).path.length === 0 && exprForks.has(leftTk)) {
            leftStr =
              serializeExprTree(leftTk, OP_PREC_SER[info.op] ?? 0) ??
              sRef(eRef(logic.left), true);
          } else {
            leftStr = eRef(logic.left).element
              ? "ITER." + serPath(eRef(logic.left).path)
              : sRef(eRef(logic.left), true);
          }

          let rightStr: string;
          if (logic.right.type === "ref") {
            const rightTk = refTrunkKey(eRef(logic.right));
            if (eRef(logic.right).path.length === 0 && exprForks.has(rightTk)) {
              rightStr =
                serializeExprTree(rightTk, OP_PREC_SER[info.op] ?? 0) ??
                sRef(eRef(logic.right), true);
            } else {
              rightStr = eRef(logic.right).element
                ? "ITER." + serPath(eRef(logic.right).path)
                : sRef(eRef(logic.right), true);
            }
          } else if (logic.right.type === "literal") {
            rightStr = formatExprValue(eVal(logic.right));
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
          const fromTk = refTrunkKey(wRef(info.aWire!));
          if (wRef(info.aWire!).path.length === 0 && exprForks.has(fromTk)) {
            leftStr = serializeExprTree(fromTk, OP_PREC_SER[info.op] ?? 0);
          } else {
            leftStr = wRef(info.aWire!).element
              ? "ITER." + serPath(wRef(info.aWire!).path)
              : sRef(wRef(info.aWire!), true);
          }
        }

        // Serialize right operand (from .b wire)
        let rightStr: string;
        if (info.bWire && isLit(info.bWire)) {
          rightStr = formatExprValue(wVal(info.bWire!));
        } else if (info.bWire && isPull(info.bWire)) {
          const bFrom = wRef(info.bWire!);
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
        const fallbackStr = serFallbacks(outWire, sPipeOrRef);
        const errf = serCatch(outWire, sPipeOrRef);
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
        const fallbackStr = serFallbacks(outWire, sPipeOrRef);
        const errf = serCatch(outWire, sPipeOrRef);
        lines.push(`${destStr} <- ${templateStr}${fallbackStr}${errf}`);
      }
      continue;
    }

    // ── Normal pipe chain ─────────────────────────────────────────────
    // Element-targeting pipe chains are handled in serializeArrayElements
    if (isUnderArrayScope(outWire.to)) continue;

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
      const fromTk = refTrunkKey(wRef(inWire));
      if (wRef(inWire).path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
        currentTk = fromTk;
      } else {
        actualSourceRef = wRef(inWire);
        break;
      }
    }

    if (actualSourceRef && handleChain.length > 0) {
      const sourceStr = sRef(actualSourceRef, true);
      const destStr = sRef(outWire.to, false);
      const fallbackStr = serFallbacks(outWire, sPipeOrRef);
      const errf = serCatch(outWire, sPipeOrRef);
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
        handleMap.set(
          `__define_in_${h.handle}:${bridge.type}:${bridge.field}`,
          h.handle,
        );
        handleMap.set(
          `__define_out_${h.handle}:${bridge.type}:${bridge.field}`,
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
    if (isFrom && !inputHandle && outputHandle) {
      // From side reading the output itself (self-referencing bridge trunk)
      return ref.path.length > 0
        ? joinHandlePath(
            outputHandle,
            firstSep,
            serPath(ref.path, ref.rootSafe, ref.pathSafe),
          )
        : outputHandle;
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
