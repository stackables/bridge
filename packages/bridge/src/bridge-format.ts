import type {
  Bridge,
  ConstDef,
  DefineDef,
  Instruction,
  NodeRef,
  ToolDef,
  Wire,
} from "./types.js";
import { SELF_MODULE } from "./types.js";
import { parseBridgeChevrotain } from "./parser/index.js";
export { parsePath } from "./utils.js";

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
 */
function needsQuoting(v: string): boolean {
  if (v === "" || v === "true" || v === "false" || v === "null") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) return false; // number
  if (/^\/[\w./-]*$/.test(v)) return false; // /path
  if (/^[a-zA-Z_][\w-]*$/.test(v)) return false; // identifier / keyword
  return true;
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
    if (
      fw.from.path.length === 0 &&
      pipeHandleTrunkKeys.has(refTrunkKey(fw.from))
    ) {
      fromOutMap.set(refTrunkKey(fw.from), fw);
    }
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
  const elementPullAll = [...elementPullWires];
  const elementConstAll = [...elementConstWires];

  // Detect array source wires: a regular wire whose to.path (joined) matches
  // a key in arrayIterators. This includes root-level arrays (path=[]).
  const arrayIterators = bridge.arrayIterators ?? {};

  // ── Exclude pipe, element-pull, and element-const wires from main loop
  const regularWires = bridge.wires.filter(
    (w) =>
      !pipeWireSet.has(w) &&
      (!("from" in w) || !w.from.element) &&
      (!("value" in w) || !w.to.element),
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

    // Emit constant element wires
    for (const ew of levelConsts) {
      const fieldPath = ew.to.path.slice(pathDepth);
      const elemTo = "." + serPath(fieldPath);
      lines.push(`${indent}${elemTo} = "${ew.value}"`);
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
  }

  for (const w of regularWires) {
    // Constant wire
    if ("value" in w) {
      const toStr = sRef(w.to, false);
      lines.push(`${toStr} = "${w.value}"`);
      continue;
    }

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
    const fromStr = sRef(w.from, true);
    const toStr = sRef(w.to, false);
    const arrow = w.force ? "<-!" : "<-";
    const nfb = w.nullFallback ? ` || ${w.nullFallback}` : "";
    const errf = w.fallbackRef
      ? ` ?? ${sPipeOrRef(w.fallbackRef)}`
      : w.fallback
        ? ` ?? ${w.fallback}`
        : "";
    lines.push(`${toStr} ${arrow} ${fromStr}${nfb}${errf}`);
  }

  // ── Pipe wires ───────────────────────────────────────────────────────
  for (const [tk, outWire] of fromOutMap.entries()) {
    if (pipeHandleTrunkKeys.has(refTrunkKey(outWire.to))) continue;

    const handleChain: string[] = [];
    let currentTk = tk;
    let actualSourceRef: NodeRef | null = null;
    let chainForced = false;

    for (;;) {
      const handleName = handleMap.get(currentTk);
      if (!handleName) break;
      const inWire = toInMap.get(currentTk);
      const fieldName = inWire?.to.path[0] ?? "in";
      const token =
        fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
      handleChain.push(token);
      if (inWire?.force) chainForced = true;
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
      const arrow = chainForced ? "<-!" : "<-";
      const nfb = outWire.nullFallback ? ` || ${outWire.nullFallback}` : "";
      const errf = outWire.fallbackRef
        ? ` ?? ${sPipeOrRef(outWire.fallbackRef)}`
        : outWire.fallback
          ? ` ?? ${outWire.fallback}`
          : "";
      lines.push(
        `${destStr} ${arrow} ${handleChain.join(":")}:${sourceStr}${nfb}${errf}`,
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
