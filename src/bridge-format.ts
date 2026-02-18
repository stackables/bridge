import type {
    Bridge,
    HandleBinding,
    Instruction,
    NodeRef,
    ToolDef,
    ToolDep,
    ToolWire,
    Wire,
} from "./types.js";
import { SELF_MODULE } from "./types.js";

// ── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse .bridge text format into structured instructions.
 *
 * The .bridge format is a human-readable representation of connection wires.
 * Multiple blocks are separated by `---`.
 * Tool blocks define API tools, bridge blocks define wire mappings.
 *
 * @param text - Bridge definition text
 * @returns Array of instructions (Bridge, ToolDef)
 */
export function parseBridge(text: string): Instruction[] {
  // Normalize: CRLF → LF, tabs → 2 spaces
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const allLines = normalized.split("\n");

  // Find separator lines (--- with optional surrounding whitespace)
  const isSep = (line: string) => /^\s*---\s*$/.test(line);

  // Collect block ranges as [start, end) line indices
  const blockRanges: { start: number; end: number }[] = [];
  let blockStart = 0;
  for (let i = 0; i < allLines.length; i++) {
    if (isSep(allLines[i])) {
      blockRanges.push({ start: blockStart, end: i });
      blockStart = i + 1;
    }
  }
  blockRanges.push({ start: blockStart, end: allLines.length });

  const instructions: Instruction[] = [];

  for (const { start, end } of blockRanges) {
    const blockLines = allLines.slice(start, end);

    // Split into sub-blocks by top-level `tool` or `bridge` keywords
    const subBlocks: { startOffset: number; lines: string[] }[] = [];
    let currentLines: string[] = [];
    let currentOffset = start;

    for (let i = 0; i < blockLines.length; i++) {
      const trimmed = blockLines[i].trim();
      if (/^(tool|bridge)\s/i.test(trimmed) && currentLines.length > 0) {
        // Check if any non-blank content exists
        if (currentLines.some((l) => l.trim())) {
          subBlocks.push({ startOffset: currentOffset, lines: currentLines });
        }
        currentLines = [blockLines[i]];
        currentOffset = start + i;
      } else {
        currentLines.push(blockLines[i]);
      }
    }
    if (currentLines.some((l) => l.trim())) {
      subBlocks.push({ startOffset: currentOffset, lines: currentLines });
    }

    for (const sub of subBlocks) {
      const subText = sub.lines.join("\n").trim();
      if (!subText) continue;

      let firstContentLine = 0;
      while (firstContentLine < sub.lines.length && !sub.lines[firstContentLine].trim())
        firstContentLine++;

      const firstLine = sub.lines[firstContentLine]?.trim();
      if (firstLine && /^tool\s/i.test(firstLine)) {
        instructions.push(parseToolBlock(subText, sub.startOffset + firstContentLine));
      } else if (firstLine && /^bridge\s/i.test(firstLine)) {
        instructions.push(...parseBridgeBlock(subText, sub.startOffset + firstContentLine));
      } else if (firstLine && !firstLine.startsWith("#")) {
        throw new Error(
          `Line ${sub.startOffset + firstContentLine + 1}: Expected "tool" or "bridge" declaration, got: ${firstLine}`,
        );
      }
    }
  }

  return instructions;
}

// ── Handle resolution type ──────────────────────────────────────────────────

type HandleResolution = {
  module: string;
  type: string;
  field: string;
  instance?: number;
};

// ── Bridge block parser ─────────────────────────────────────────────────────

function parseBridgeBlock(block: string, lineOffset: number): Instruction[] {
  const lines = block.split("\n").map((l) => l.trimEnd());
  const instructions: Instruction[] = [];

  /** 1-based global line number for error messages */
  const ln = (i: number) => lineOffset + i + 1;

  // ── Parse header ────────────────────────────────────────────────────
  let bridgeType = "";
  let bridgeField = "";
  const handleRes = new Map<string, HandleResolution>();
  const handleBindings: HandleBinding[] = [];
  const instanceCounters = new Map<string, number>();
  let bodyStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    if (/^bridge\s/i.test(line)) {
      const match = line.match(/^bridge\s+(\w+)\.(\w+)$/i);
      if (!match)
        throw new Error(`Line ${ln(i)}: Invalid bridge declaration: ${line}`);
      bridgeType = match[1];
      bridgeField = match[2];
      continue;
    }

    if (/^with\s/i.test(line)) {
      if (!bridgeType) {
        throw new Error(
          `Line ${ln(i)}: "with" declaration must come after "bridge" declaration`,
        );
      }
      parseWithDeclaration(
        line,
        bridgeType,
        bridgeField,
        handleRes,
        handleBindings,
        instanceCounters,
        instructions,
        ln(i),
      );
      continue;
    }

    // First non-header line — body starts here
    bodyStartIndex = i;
    break;
  }

  if (!bridgeType || !bridgeField) {
    throw new Error(`Line ${ln(0)}: Missing bridge declaration`);
  }

  // ── Parse wire lines ────────────────────────────────────────────────
  const wires: Wire[] = [];
  let currentArrayToPath: string[] | null = null;

  for (let i = bodyStartIndex; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    // Element mapping: indented line starting with "."
    const indent = raw.search(/\S/);
    if (indent >= 2 && line.startsWith(".") && currentArrayToPath) {
      const match = line.match(/^\.(\S+)\s*<-\s*\.(\S+)$/);
      if (!match)
        throw new Error(`Line ${ln(i)}: Invalid element mapping: ${line}`);
      const toPath = [...currentArrayToPath, ...parsePath(match[1])];
      const fromPath = parsePath(match[2]);
      wires.push({
        from: {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          element: true,
          path: fromPath,
        },
        to: {
          module: SELF_MODULE,
          type: bridgeType,
          field: bridgeField,
          path: toPath,
        },
      });
      continue;
    }

    // End of array mapping block
    currentArrayToPath = null;

    // Constant wire: target = "value" or target = value (unquoted)
    const constantMatch = line.match(/^(\S+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
    if (constantMatch) {
      const [, targetStr, quotedValue, unquotedValue] = constantMatch;
      const value = quotedValue ?? unquotedValue;
      const toRef = resolveAddress(
        targetStr,
        handleRes,
        bridgeType,
        bridgeField,
      );
      wires.push({ value, to: toRef });
      continue;
    }

    // Wire: target <- source
    const arrowMatch = line.match(/^(\S+)\s*<-\s*(\S+)$/);
    if (arrowMatch) {
      const [, targetStr, sourceStr] = arrowMatch;

      // Array mapping: target[] <- source[]
      if (targetStr.endsWith("[]") && sourceStr.endsWith("[]")) {
        const toClean = targetStr.slice(0, -2);
        const fromClean = sourceStr.slice(0, -2);
        const fromRef = resolveAddress(
          fromClean,
          handleRes,
          bridgeType,
          bridgeField,
        );
        const toRef = resolveAddress(
          toClean,
          handleRes,
          bridgeType,
          bridgeField,
        );
        wires.push({ from: fromRef, to: toRef });
        currentArrayToPath = toRef.path;
        continue;
      }

      const fromRef = resolveAddress(
        sourceStr,
        handleRes,
        bridgeType,
        bridgeField,
      );
      const toRef = resolveAddress(
        targetStr,
        handleRes,
        bridgeType,
        bridgeField,
      );
      wires.push({ from: fromRef, to: toRef });
      continue;
    }

    throw new Error(`Line ${ln(i)}: Unrecognized line: ${line}`);
  }

  instructions.unshift({
    kind: "bridge",
    type: bridgeType,
    field: bridgeField,
    handles: handleBindings,
    wires,
  });

  return instructions;
}

/**
 * Parse a `with` declaration into handle bindings + resolution map.
 *
 * Supported forms:
 *   with <name> as <handle>     — tool reference (dotted or simple name)
 *   with input as <handle>
 *   with config as <handle>
 *   with config                 — shorthand for `with config as config`
 */
function parseWithDeclaration(
  line: string,
  bridgeType: string,
  bridgeField: string,
  handleRes: Map<string, HandleResolution>,
  handleBindings: HandleBinding[],
  instanceCounters: Map<string, number>,
  instructions: Instruction[],
  lineNum: number,
): void {
  /** Guard: reject duplicate handle names */
  const checkDuplicate = (handle: string) => {
    if (handleRes.has(handle)) {
      throw new Error(`Line ${lineNum}: Duplicate handle name "${handle}"`);
    }
  };

  // with input as <handle>
  let match = line.match(/^with\s+input\s+as\s+(\w+)$/i);
  if (match) {
    const handle = match[1];
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "input" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: bridgeType,
      field: bridgeField,
    });
    return;
  }

  // with config as <handle>
  match = line.match(/^with\s+config\s+as\s+(\w+)$/i);
  if (match) {
    const handle = match[1];
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "config" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: "Config",
      field: "config",
    });
    return;
  }

  // with config (shorthand — handle defaults to "config")
  match = line.match(/^with\s+config$/i);
  if (match) {
    const handle = "config";
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "config" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: "Config",
      field: "config",
    });
    return;
  }

  // with <name> as <handle> — tool reference (covers dotted names like hereapi.geocode)
  match = line.match(/^with\s+(\S+)\s+as\s+(\w+)$/i);
  if (match) {
    const name = match[1];
    const handle = match[2];
    checkDuplicate(handle);

    // Split dotted name into module.field for NodeRef resolution
    const lastDot = name.lastIndexOf(".");
    if (lastDot !== -1) {
      const modulePart = name.substring(0, lastDot);
      const fieldPart = name.substring(lastDot + 1);
      const key = `${modulePart}:${fieldPart}`;
      const instance = (instanceCounters.get(key) ?? 0) + 1;
      instanceCounters.set(key, instance);
      handleBindings.push({ handle, kind: "tool", name });
      handleRes.set(handle, {
        module: modulePart,
        type: bridgeType,
        field: fieldPart,
        instance,
      });
    } else {
      // Simple name — inline tool function
      const key = `Tools:${name}`;
      const instance = (instanceCounters.get(key) ?? 0) + 1;
      instanceCounters.set(key, instance);
      handleBindings.push({ handle, kind: "tool", name });
      handleRes.set(handle, {
        module: SELF_MODULE,
        type: "Tools",
        field: name,
        instance,
      });
    }
    return;
  }

  throw new Error(`Line ${lineNum}: Invalid with declaration: ${line}`);
}

/**
 * Resolve an address string into a structured NodeRef.
 *
 * Resolution rules:
 *   1. No dot → output field on the bridge trunk
 *   2. Prefix matches a declared handle → resolve via handle binding
 *   3. Otherwise → nested output path (e.g., topPick.address)
 */
function resolveAddress(
  address: string,
  handles: Map<string, HandleResolution>,
  bridgeType: string,
  bridgeField: string,
): NodeRef {
  const dotIndex = address.indexOf(".");

  // No dot — output reference on bridge trunk
  if (dotIndex === -1) {
    return {
      module: SELF_MODULE,
      type: bridgeType,
      field: bridgeField,
      path: parsePath(address),
    };
  }

  const prefix = address.substring(0, dotIndex);
  const rest = address.substring(dotIndex + 1);
  const pathParts = parsePath(rest);

  // Known handle
  const resolution = handles.get(prefix);
  if (resolution) {
    const ref: NodeRef = {
      module: resolution.module,
      type: resolution.type,
      field: resolution.field,
      path: pathParts,
    };
    if (resolution.instance != null) {
      ref.instance = resolution.instance;
    }
    return ref;
  }

  // No handle match — nested local path (e.g., topPick.address)
  return {
    module: SELF_MODULE,
    type: bridgeType,
    field: bridgeField,
    path: [prefix, ...pathParts],
  };
}

// ── Tool block parser ───────────────────────────────────────────────────────

/**
 * Parse a `tool` block into a ToolDef instruction.
 *
 * Format (root tool):
 *   tool hereapi httpCall
 *     with config
 *     baseUrl = "https://geocode.search.hereapi.com/v1"
 *     headers.apiKey <- config.hereapi.apiKey
 *
 * Format (child tool with extends):
 *   tool hereapi.geocode extends hereapi
 *     method = GET
 *     path = /geocode
 */
function parseToolBlock(block: string, lineOffset: number): ToolDef {
  const lines = block.split("\n").map((l) => l.trimEnd());

  /** 1-based global line number for error messages */
  const ln = (i: number) => lineOffset + i + 1;

  let toolName = "";
  let toolFn: string | undefined;
  let toolExtends: string | undefined;
  const deps: ToolDep[] = [];
  const wires: ToolWire[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Tool declaration: tool <name> <fn> or tool <name> extends <parent>
    if (/^tool\s/i.test(line)) {
      const extendsMatch = line.match(/^tool\s+(\S+)\s+extends\s+(\S+)$/i);
      if (extendsMatch) {
        toolName = extendsMatch[1];
        toolExtends = extendsMatch[2];
        continue;
      }
      const fnMatch = line.match(/^tool\s+(\S+)\s+(\S+)$/i);
      if (fnMatch) {
        toolName = fnMatch[1];
        toolFn = fnMatch[2];
        continue;
      }
      throw new Error(`Line ${ln(i)}: Invalid tool declaration: ${line}`);
    }

    // with config or with config as <handle>
    const configMatch = line.match(/^with\s+config(?:\s+as\s+(\w+))?$/i);
    if (configMatch) {
      const handle = configMatch[1] ?? "config";
      deps.push({ kind: "config", handle });
      continue;
    }

    // with <tool> as <handle>
    const toolDepMatch = line.match(/^with\s+(\S+)\s+as\s+(\w+)$/i);
    if (toolDepMatch) {
      deps.push({ kind: "tool", handle: toolDepMatch[2], tool: toolDepMatch[1] });
      continue;
    }

    // Constant wire: target = "value" or target = value (unquoted)
    const constantMatch = line.match(/^(\S+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
    if (constantMatch) {
      const value = constantMatch[2] ?? constantMatch[3];
      wires.push({
        target: constantMatch[1],
        kind: "constant",
        value,
      });
      continue;
    }

    // Pull wire: target <- source
    const pullMatch = line.match(/^(\S+)\s*<-\s*(\S+)$/);
    if (pullMatch) {
      wires.push({ target: pullMatch[1], kind: "pull", source: pullMatch[2] });
      continue;
    }

    throw new Error(`Line ${ln(i)}: Unrecognized tool line: ${line}`);
  }

  if (!toolName) throw new Error(`Line ${ln(0)}: Missing tool name`);

  return {
    kind: "tool",
    name: toolName,
    fn: toolFn,
    extends: toolExtends,
    deps,
    wires,
  };
}

// ── Path parser ─────────────────────────────────────────────────────────────

/**
 * Parse a dot-separated path with optional array indices.
 *
 * "items[0].position.lat" → ["items", "0", "position", "lat"]
 * "properties[]"          → ["properties"]  ([] is stripped, signals array)
 * "x-message-id"          → ["x-message-id"]
 */
export function parsePath(text: string): string[] {
  const parts: string[] = [];
  for (const segment of text.split(".")) {
    const match = segment.match(/^([^[]+)(?:\[(\d*)\])?$/);
    if (match) {
      parts.push(match[1]);
      if (match[2] !== undefined && match[2] !== "") {
        parts.push(match[2]);
      }
    } else {
      parts.push(segment);
    }
  }
  return parts;
}

// ── Serializer ──────────────────────────────────────────────────────────────

/**
 * Serialize structured instructions back to .bridge text format.
 */
export function serializeBridge(instructions: Instruction[]): string {
  const bridges = instructions.filter((i): i is Bridge => i.kind === "bridge");
  const tools = instructions.filter(
    (i): i is ToolDef => i.kind === "tool",
  );
  if (bridges.length === 0 && tools.length === 0) return "";

  const blocks: string[] = [];

  for (const tool of tools) {
    blocks.push(serializeToolBlock(tool));
  }
  for (const bridge of bridges) {
    blocks.push(serializeBridgeBlock(bridge));
  }

  return blocks.join("\n\n---\n\n") + "\n";
}

function serializeToolBlock(tool: ToolDef): string {
  const lines: string[] = [];

  // Declaration line
  if (tool.extends) {
    lines.push(`tool ${tool.name} extends ${tool.extends}`);
  } else {
    lines.push(`tool ${tool.name} ${tool.fn}`);
  }

  // Dependencies
  for (const dep of tool.deps) {
    if (dep.kind === "config") {
      if (dep.handle === "config") {
        lines.push(`  with config`);
      } else {
        lines.push(`  with config as ${dep.handle}`);
      }
    } else {
      lines.push(`  with ${dep.tool} as ${dep.handle}`);
    }
  }

  // Wires
  for (const wire of tool.wires) {
    if (wire.kind === "constant") {
      // Use quoted form if value contains spaces or special chars, unquoted otherwise
      if (/\s/.test(wire.value) || wire.value === "") {
        lines.push(`  ${wire.target} = "${wire.value}"`);
      } else {
        lines.push(`  ${wire.target} = ${wire.value}`);
      }
    } else {
      lines.push(`  ${wire.target} <- ${wire.source}`);
    }
  }

  return lines.join("\n");
}

function serializeBridgeBlock(bridge: Bridge): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  lines.push(`bridge ${bridge.type}.${bridge.field}`);

  for (const h of bridge.handles) {
    switch (h.kind) {
      case "tool":
        lines.push(`  with ${h.name} as ${h.handle}`);
        break;
      case "input":
        lines.push(`  with input as ${h.handle}`);
        break;
      case "config":
        lines.push(`  with config as ${h.handle}`);
        break;
    }
  }

  lines.push("");

  // ── Build handle map for reverse resolution ─────────────────────────
  const { handleMap, inputHandle } = buildHandleMap(bridge);

  // ── Wires ───────────────────────────────────────────────────────────
  const elementWires = bridge.wires.filter(
    (w): w is Extract<Wire, { from: NodeRef }> =>
      "from" in w && !!w.from.element,
  );
  const regularWires = bridge.wires.filter(
    (w) => !("from" in w) || !w.from.element,
  );

  const elementGroups = new Map<string, Wire[]>();
  for (const w of elementWires) {
    const parent = w.to.path[0];
    if (!elementGroups.has(parent)) elementGroups.set(parent, []);
    elementGroups.get(parent)!.push(w);
  }

  const serializedArrays = new Set<string>();

  for (const w of regularWires) {
    // Constant wire
    if ("value" in w) {
      const toStr = serializeRef(w.to, bridge, handleMap, inputHandle, false);
      lines.push(`${toStr} = "${w.value}"`);
      continue;
    }

    // Array mapping
    const arrayKey = w.to.path.length === 1 ? w.to.path[0] : null;
    if (
      arrayKey &&
      elementGroups.has(arrayKey) &&
      !serializedArrays.has(arrayKey)
    ) {
      serializedArrays.add(arrayKey);
      const fromStr =
        serializeRef(w.from, bridge, handleMap, inputHandle, true) + "[]";
      const toStr =
        serializeRef(w.to, bridge, handleMap, inputHandle, false) + "[]";
      lines.push(`${toStr} <- ${fromStr}`);
      for (const ew of elementGroups.get(arrayKey)!) {
        const elemFrom = "." + serPath(ew.from.path);
        const elemTo = "." + serPath(ew.to.path.slice(1));
        lines.push(`  ${elemTo} <- ${elemFrom}`);
      }
      continue;
    }

    // Regular wire
    const fromStr = serializeRef(w.from, bridge, handleMap, inputHandle, true);
    const toStr = serializeRef(w.to, bridge, handleMap, inputHandle, false);
    lines.push(`${toStr} <- ${fromStr}`);
  }

  return lines.join("\n");
}

/**
 * Build a reverse lookup: trunk key → handle name.
 * Recomputes instance numbers from handle bindings in declaration order.
 */
function buildHandleMap(bridge: Bridge): {
  handleMap: Map<string, string>;
  inputHandle?: string;
} {
  const handleMap = new Map<string, string>();
  const instanceCounters = new Map<string, number>();
  let inputHandle: string | undefined;

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
      case "config":
        handleMap.set(`${SELF_MODULE}:Config:config`, h.handle);
        break;
    }
  }

  return { handleMap, inputHandle };
}

function serializeRef(
  ref: NodeRef,
  bridge: Bridge,
  handleMap: Map<string, string>,
  inputHandle: string | undefined,
  isFrom: boolean,
): string {
  if (ref.element) {
    return "." + serPath(ref.path);
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
      return inputHandle + "." + serPath(ref.path);
    }
    // To side: bare output path
    return serPath(ref.path);
  }

  // Lookup by trunk key
  const trunkStr =
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;
  const handle = handleMap.get(trunkStr);
  if (handle) {
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
