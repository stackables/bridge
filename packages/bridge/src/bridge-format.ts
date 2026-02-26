import type {
  Bridge,
  ConstDef,
  DefineDef,
  Instruction,
  NodeRef,
  ToolDef,
  Wire,
} from "./types.ts";
import { SELF_MODULE } from "./types.ts";
import { parseBridgeChevrotain } from "./parser/index.ts";
export { parsePath } from "./utils.ts";

/**
 * Parse .bridge text — delegates to the Chevrotain parser.
 */
export function parseBridge(text: string): Instruction[] {
  return parseBridgeChevrotain(text);
}

const BRIDGE_VERSION = "1.4";

// ── Serializer ───────────────────────────────────────────────────────────────

export function serializeBridge(instructions: Instruction[]): string {
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

  return `version ${BRIDGE_VERSION}\n\n` + blocks.join("\n\n") + "\n";
}

/**
 * Whether a value string needs quoting to be re-parseable as a bare value.
 * Safe unquoted: number, boolean, null, /path, simple-identifier, keyword.
 * Already-quoted JSON strings (produced by the updated parser) are also safe.
 */
function needsQuoting(v: string): boolean {
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return false; // JSON string literal
  if (v === "" || v === "true" || v === "false" || v === "null") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) return false; // number
  if (/^\/[\w./-]*$/.test(v)) return false; // /path
  if (/^[a-zA-Z_][\w-]*$/.test(v)) return false; // identifier / keyword
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

function serializeToolBlock(tool: ToolDef): string {
  const lines: string[] = [];
  const hasBody = tool.deps.length > 0 || tool.wires.length > 0;

  // Declaration line — use `tool <name> from <source>` format
  const source = tool.extends ?? tool.fn;
  lines.push(
    hasBody
      ? `tool ${tool.name} from ${source} {`
      : `tool ${tool.name} from ${source}`,
  );

  // Dependencies
  for (const dep of tool.deps) {
    if (dep.kind === "context") {
      if (dep.handle === "context") {
        lines.push(`  with context`);
      } else {
        lines.push(`  with context as ${dep.handle}`);
      }
    } else if (dep.kind === "const") {
      if (dep.handle === "const") {
        lines.push(`  with const`);
      } else {
        lines.push(`  with const as ${dep.handle}`);
      }
    } else {
      lines.push(`  with ${dep.tool} as ${dep.handle}`);
    }
  }

  // Wires
  for (const wire of tool.wires) {
    if (wire.kind === "onError") {
      if ("value" in wire) {
        lines.push(`  on error = ${wire.value}`);
      } else {
        lines.push(`  on error <- ${wire.source}`);
      }
    } else if (wire.kind === "constant") {
      if (needsQuoting(wire.value)) {
        lines.push(`  .${wire.target} = "${wire.value}"`);
      } else {
        lines.push(`  .${wire.target} = ${wire.value}`);
      }
    } else {
      lines.push(`  .${wire.target} <- ${wire.source}`);
    }
  }

  if (hasBody) lines.push(`}`);

  return lines.join("\n");
}

/**
 * Serialize a fallback NodeRef as a human-readable source string.
 *
 * If the ref is a pipe-fork root, reconstructs the pipe chain by walking
 * the `toInMap` backward (same logic as the main pipe serializer).
 * Otherwise delegates to `serializeRef`.
 *
 * This is used to emit `?? handle.path` or `?? pipe:source` for wire
 * `fallbackRef` values.
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
    switch (h.kind) {
      case "tool": {
        // Short form `with <name>` when handle == last segment of name
        const lastDot = h.name.lastIndexOf(".");
        const defaultHandle =
          lastDot !== -1 ? h.name.substring(lastDot + 1) : h.name;
        if (h.handle === defaultHandle) {
          lines.push(`  with ${h.name}`);
        } else {
          lines.push(`  with ${h.name} as ${h.handle}`);
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
    if (
      fw.from.path.length === 0 &&
      pipeHandleTrunkKeys.has(fromTk)
    ) {
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
    "*": 4, "/": 4, "+": 3, "-": 3,
    "==": 2, "!=": 2, ">": 2, ">=": 2, "<": 2, "<=": 2,
    "and": 1, "or": 0, "not": -1,
  };
  // Collect expression fork metadata: forkTk → { op, bWire, aWire }
  type ExprForkInfo = {
    op: string;
    bWire: Wire | undefined;
    aWire: FW | undefined;
    /** For condAnd/condOr wires: the logic wire itself */
    logicWire?: Extract<Wire, { condAnd: any }> | Extract<Wire, { condOr: any }>;
  };
  const exprForks = new Map<string, ExprForkInfo>();
  const exprPipeWireSet = new Set<Wire>(); // wires that belong to expression forks

  for (const ph of bridge.pipeHandles ?? []) {
    if (!ph.handle.startsWith("__expr_")) continue;
    const op = FN_TO_OP[ph.baseTrunk.field];
    if (!op) continue;

    // For condAnd/condOr wires (field === "__and" or "__or")
    if (ph.baseTrunk.field === "__and" || ph.baseTrunk.field === "__or") {
      const logicWire = bridge.wires.find(
        (w) => {
          const prop = ph.baseTrunk.field === "__and" ? "condAnd" : "condOr";
          return prop in w && refTrunkKey(w.to) === ph.key;
        },
      ) as Extract<Wire, { condAnd: any }> | Extract<Wire, { condOr: any }> | undefined;

      if (logicWire) {
        exprForks.set(ph.key, { op, bWire: undefined, aWire: undefined, logicWire });
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
    const partsMap = new Map<number, { kind: "text"; value: string } | { kind: "ref"; ref: NodeRef }>();
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
  // Pull wires: from.element=true
  const elementPullWires = bridge.wires.filter(
    (w): w is Extract<Wire, { from: NodeRef }> =>
      "from" in w && !!w.from.element,
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
    (w) => !exprPipeWireSet.has(w) && !pipeWireSet.has(w) && !concatPipeWireSet.has(w),
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

  // ── Exclude pipe, element-pull, element-const, expression-internal, concat-internal, and __local wires from main loop
  const regularWires = bridge.wires.filter(
    (w) =>
      !pipeWireSet.has(w) &&
      !exprPipeWireSet.has(w) &&
      !concatPipeWireSet.has(w) &&
      (!("from" in w) || !w.from.element) &&
      (!("value" in w) || !w.to.element) &&
      w.to.module !== "__local" &&
      (!("from" in w) || (w.from as NodeRef).module !== "__local"),
  );

  // ── Collect __local binding wires for array-scoped `with` declarations ──
  type LocalBindingInfo = {
    alias: string;
    sourceWire: Extract<Wire, { from: NodeRef }>;
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
    if ("from" in w && (w.from as NodeRef).module === "__local") {
      localReadWires.push(w as Extract<Wire, { from: NodeRef }>);
    }
  }

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
    if (!exprForks.has(tk) || !outWire.to.element) continue;

    // Recursively serialize expression fork tree
    function serializeElemExprTree(forkTk: string, parentPrec?: number): string | null {
      const info = exprForks.get(forkTk);
      if (!info) return null;

      // condAnd/condOr logic wire — reconstruct from leftRef/rightRef
      if (info.logicWire) {
        const logic = "condAnd" in info.logicWire ? info.logicWire.condAnd : info.logicWire.condOr;
        let leftStr: string;
        const leftTk = refTrunkKey(logic.leftRef);
        if (logic.leftRef.path.length === 0 && exprForks.has(leftTk)) {
          leftStr = serializeElemExprTree(leftTk, OP_PREC_SER[info.op] ?? 0) ?? sRef(logic.leftRef, true);
        } else {
          leftStr = logic.leftRef.element
            ? "ITER." + serPath(logic.leftRef.path)
            : sRef(logic.leftRef, true);
        }

        let rightStr: string;
        if (logic.rightRef) {
          const rightTk = refTrunkKey(logic.rightRef);
          if (logic.rightRef.path.length === 0 && exprForks.has(rightTk)) {
            rightStr = serializeElemExprTree(rightTk, OP_PREC_SER[info.op] ?? 0) ?? sRef(logic.rightRef, true);
          } else {
            rightStr = logic.rightRef.element
              ? "ITER." + serPath(logic.rightRef.path)
              : sRef(logic.rightRef, true);
          }
        } else if (logic.rightValue != null) {
          rightStr = logic.rightValue;
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
        rightStr = info.bWire.value;
      } else if (info.bWire && "from" in info.bWire) {
        const bFrom = (info.bWire as FW).from;
        const bTk = refTrunkKey(bFrom);
        if (bFrom.path.length === 0 && exprForks.has(bTk)) {
          rightStr = serializeElemExprTree(bTk, OP_PREC_SER[info.op] ?? 0) ?? sRef(bFrom, true);
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

  /**
   * Recursively serialize element wires for an array mapping block.
   * Handles nested array-in-array mappings by detecting inner iterators.
   */
  function serializeArrayElements(
    arrayPath: string[],
    parentIterName: string,
    indent: string,
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
      const srcWire = info.sourceWire;
      // Reconstruct the source expression
      const fromRef = srcWire.from;
      let sourcePart: string;
      if (fromRef.element) {
        sourcePart = parentIterName + (fromRef.path.length > 0 ? "." + serPath(fromRef.path) : "");
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
              parts.push(parentIterName + (inWire.from.path.length > 0 ? "." + serPath(inWire.from.path) : ""));
              break;
            }
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
      }
      lines.push(`${indent}alias ${sourcePart} as ${alias}`);
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
        const fromPart = ew.from.element
          ? parentIterName + "." + serPath(ew.from.path)
          : sRef(ew.from, true);
        const fieldPath = ew.to.path.slice(pathDepth);
        const elemTo = "." + serPath(fieldPath);
        lines.push(
          `${indent}${elemTo} <- ${fromPart}[] as ${nestedIterName} {`,
        );
        serializeArrayElements(ew.to.path, nestedIterName, indent + "  ");
        lines.push(`${indent}}`);
        continue;
      }

      // Regular element pull wire
      const fromPart = ew.from.element
        ? parentIterName + "." + serPath(ew.from.path)
        : sRef(ew.from, true);
      const fieldPath = ew.to.path.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);

      const nfb =
        "nullFallback" in ew && ew.nullFallback ? ` || ${ew.nullFallback}` : "";
      const errf =
        "fallbackRef" in ew && ew.fallbackRef
          ? ` ?? ${sPipeOrRef(ew.fallbackRef)}`
          : "fallback" in ew && ew.fallback
            ? ` ?? ${ew.fallback}`
            : "";
      lines.push(`${indent}${elemTo} <- ${fromPart}${nfb}${errf}`);
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
      const fromPart = lw.from.path.length > 0
        ? alias + "." + serPath(lw.from.path)
        : alias;
      lines.push(`${indent}${elemTo} <- ${fromPart}`);
    }
  }

  // ── Helper: serialize an expression fork tree for a ref (used for cond) ──
  function serializeExprOrRef(ref: NodeRef): string {
    const tk = refTrunkKey(ref);
    if (ref.path.length === 0 && exprForks.has(tk)) {
      // Recursively serialize expression fork
      function serFork(forkTk: string): string {
        const info = exprForks.get(forkTk);
        if (!info) return "?";
        let leftStr: string | null = null;
        if (info.aWire) {
          const aTk = refTrunkKey(info.aWire.from);
          if (info.aWire.from.path.length === 0 && exprForks.has(aTk)) {
            leftStr = serFork(aTk);
          } else {
            leftStr = sRef(info.aWire.from, true);
          }
        }
        let rightStr: string;
        if (info.bWire && "value" in info.bWire) {
          rightStr = info.bWire.value;
        } else if (info.bWire && "from" in info.bWire) {
          const bFrom = (info.bWire as FW).from;
          const bTk = refTrunkKey(bFrom);
          rightStr =
            bFrom.path.length === 0 && exprForks.has(bTk)
              ? serFork(bTk)
              : sRef(bFrom, true);
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
      const nfb = w.nullFallback ? ` || ${w.nullFallback}` : "";
      const errf = w.fallbackRef
        ? ` ?? ${sPipeOrRef(w.fallbackRef)}`
        : w.fallback
          ? ` ?? ${w.fallback}`
          : "";
      lines.push(
        `${toStr} <- ${condStr} ? ${thenStr} : ${elseStr}${nfb}${errf}`,
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
    // ?. safe execution — replace first dot with ?.
    if (w.safe && fromStr.includes(".")) {
      fromStr = fromStr.replace(".", "?.");
    }
    const toStr = sRef(w.to, false);
    const nfb = w.nullFallback ? ` || ${w.nullFallback}` : "";
    const errf = w.fallbackRef
      ? ` ?? ${sPipeOrRef(w.fallbackRef)}`
      : w.fallback
        ? ` ?? ${w.fallback}`
        : "";
    lines.push(`${toStr} <- ${fromStr}${nfb}${errf}`);
  }

  // ── Top-level alias declarations ─────────────────────────────────────
  // Emit `alias <source> as <name>` for __local bindings that are NOT
  // element-scoped (those are handled inside serializeArrayElements).
  for (const [alias, info] of localBindingsByAlias) {
    const srcWire = info.sourceWire;
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
    const fromPart =
      lw.from.path.length > 0 ? alias + "." + serPath(lw.from.path) : alias;
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
      if (outWire.to.element) continue;
      // Recursively serialize an expression fork into infix notation.
      function serializeExprTree(forkTk: string, parentPrec?: number): string | null {
        const info = exprForks.get(forkTk);
        if (!info) return null;

        // condAnd/condOr logic wire — reconstruct from leftRef/rightRef
        if (info.logicWire) {
          const logic = "condAnd" in info.logicWire ? info.logicWire.condAnd : info.logicWire.condOr;
          let leftStr: string;
          const leftTk = refTrunkKey(logic.leftRef);
          if (logic.leftRef.path.length === 0 && exprForks.has(leftTk)) {
            leftStr = serializeExprTree(leftTk, OP_PREC_SER[info.op] ?? 0) ?? sRef(logic.leftRef, true);
          } else {
            leftStr = logic.leftRef.element
              ? "ITER." + serPath(logic.leftRef.path)
              : sRef(logic.leftRef, true);
          }

          let rightStr: string;
          if (logic.rightRef) {
            const rightTk = refTrunkKey(logic.rightRef);
            if (logic.rightRef.path.length === 0 && exprForks.has(rightTk)) {
              rightStr = serializeExprTree(rightTk, OP_PREC_SER[info.op] ?? 0) ?? sRef(logic.rightRef, true);
            } else {
              rightStr = logic.rightRef.element
                ? "ITER." + serPath(logic.rightRef.path)
                : sRef(logic.rightRef, true);
            }
          } else if (logic.rightValue != null) {
            rightStr = logic.rightValue;
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
          rightStr = info.bWire.value;
        } else if (info.bWire && "from" in info.bWire) {
          const bFrom = (info.bWire as FW).from;
          const bTk = refTrunkKey(bFrom);
          if (bFrom.path.length === 0 && exprForks.has(bTk)) {
            rightStr = serializeExprTree(bTk, OP_PREC_SER[info.op] ?? 0) ?? sRef(bFrom, true);
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
        const nfb = outWire.nullFallback ? ` || ${outWire.nullFallback}` : "";
        const errf = outWire.fallbackRef
          ? ` ?? ${sPipeOrRef(outWire.fallbackRef)}`
          : outWire.fallback
            ? ` ?? ${outWire.fallback}`
            : "";
        lines.push(`${destStr} <- ${exprStr}${nfb}${errf}`);
      }
      continue;
    }

    // ── Concat (template string) detection ───────────────────────────
    if (concatForks.has(tk)) {
      if (outWire.to.element) continue; // handled in serializeArrayElements
      const templateStr = reconstructTemplateString(tk);
      if (templateStr) {
        const destStr = sRef(outWire.to, false);
        const nfb = outWire.nullFallback ? ` || ${outWire.nullFallback}` : "";
        const errf = outWire.fallbackRef
          ? ` ?? ${sPipeOrRef(outWire.fallbackRef)}`
          : outWire.fallback
            ? ` ?? ${outWire.fallback}`
            : "";
        lines.push(`${destStr} <- ${templateStr}${nfb}${errf}`);
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
      const nfb = outWire.nullFallback ? ` || ${outWire.nullFallback}` : "";
      const errf = outWire.fallbackRef
        ? ` ?? ${sPipeOrRef(outWire.fallbackRef)}`
        : outWire.fallback
          ? ` ?? ${outWire.fallback}`
          : "";
      lines.push(
        `${destStr} <- ${handleChain.join(":")}:${sourceStr}${nfb}${errf}`,
      );
    }
  }

  // Force statements
  if (bridge.forces) {
    for (const f of bridge.forces) {
      lines.push(
        f.catchError ? `force ${f.handle} ?? null` : `force ${f.handle}`,
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
        ? inputHandle + "." + serPath(ref.path)
        : inputHandle;
    }
    if (!isFrom && outputHandle) {
      // To side: use output handle
      return ref.path.length > 0
        ? outputHandle + "." + serPath(ref.path)
        : outputHandle;
    }
    // Fallback (no handle declared — legacy/serializer-only path)
    return serPath(ref.path);
  }

  // Lookup by trunk key
  const trunkStr =
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;
  const handle = handleMap.get(trunkStr);
  if (handle) {
    if (ref.path.length === 0) return handle;
    return handle + "." + serPath(ref.path);
  }

  // Fallback: bare path
  return serPath(ref.path);
}

/** Serialize a path array to dot notation with [n] for numeric indices */
function serPath(path: string[]): string {
  let result = "";
  for (const segment of path) {
    if (/^\d+$/.test(segment)) {
      result += `[${segment}]`;
    } else {
      if (result.length > 0) result += ".";
      result += segment;
    }
  }
  return result;
}
