import type {
    Bridge,
    ConstDef,
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
      if (/^(tool|bridge|const|extend)\s/i.test(trimmed) && currentLines.length > 0) {
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
      if (firstLine && /^(tool|extend)\s/i.test(firstLine)) {
        instructions.push(parseToolBlock(subText, sub.startOffset + firstContentLine, instructions));
      } else if (firstLine && /^bridge\s/i.test(firstLine)) {
        instructions.push(...parseBridgeBlock(subText, sub.startOffset + firstContentLine));
      } else if (firstLine && /^const\s/i.test(firstLine)) {
        instructions.push(...parseConstLines(subText, sub.startOffset + firstContentLine));
      } else if (firstLine && !firstLine.startsWith("#")) {
        throw new Error(
          `Line ${sub.startOffset + firstContentLine + 1}: Expected "tool", "extend", "bridge", or "const" declaration, got: ${firstLine}`,
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
  /** Monotonically-increasing index; combined with a high base to produce
   *  fork instances that can never collide with regular handle instances. */
  let nextForkSeq = 0;
  const pipeHandleEntries: NonNullable<Bridge["pipeHandles"]> = [];

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

    // Wire: target <- source  OR  target <-! source (forced)
    // Optional fallback: target <- source ?? <json_value>
    const arrowMatch = line.match(/^(\S+)\s*<-(!?)\s*(\S+(?:\|\S+)*)(?:\s*\?\?\s*(.+))?$/);
    if (arrowMatch) {
      const [, targetStr, forceFlag, sourceStr, fallbackRaw] = arrowMatch;
      const force = forceFlag === "!";
      const fallback = fallbackRaw?.trim();
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

      // Pipe chain: target <- tok1|tok2|...|source
      // Each token is either "handle" (input field defaults to "in") or
      // "handle.field" (explicit input field name).
      // Every token creates an INDEPENDENT fork — a fresh tool invocation with
      // its own instance number — so repeated use of the same handle produces
      // separate calls.
      // Execution order: source → tokN → … → tok1 → target (right-to-left).
      const parts = sourceStr.split("|");
      if (parts.length > 1) {
        const actualSource = parts[parts.length - 1];
        const tokenChain = parts.slice(0, -1); // [tok1, …, tokN] outermost→innermost

        /** Parse "handle" or "handle.field" → {handleName, fieldName} */
        const parseToken = (t: string) => {
          const dot = t.indexOf(".");
          return dot === -1
            ? { handleName: t, fieldName: "in" }
            : { handleName: t.substring(0, dot), fieldName: t.substring(dot + 1) };
        };

        for (const tok of tokenChain) {
          const { handleName } = parseToken(tok);
          if (!handleRes.has(handleName)) {
            throw new Error(
              `Line ${ln(i)}: Undeclared handle in pipe: "${handleName}". Add 'with <tool> as ${handleName}' to the bridge header.`,
            );
          }
        }

        let prevOutRef = resolveAddress(actualSource, handleRes, bridgeType, bridgeField);
        const reversedTokens = [...tokenChain].reverse();
        for (let idx = 0; idx < reversedTokens.length; idx++) {
          const tok = reversedTokens[idx];
          const { handleName, fieldName } = parseToken(tok);
          const res = handleRes.get(handleName)!;
          // Allocate a unique fork instance (100000+ avoids collision with
          // regular instances which start at 1).
          const forkInstance = 100000 + nextForkSeq++;
          const forkKey = `${res.module}:${res.type}:${res.field}:${forkInstance}`;
          pipeHandleEntries.push({
            key: forkKey,
            handle: handleName,
            baseTrunk: { module: res.module, type: res.type, field: res.field, instance: res.instance },
          });
          const forkInRef: NodeRef = { module: res.module, type: res.type, field: res.field, instance: forkInstance, path: parsePath(fieldName) };
          const forkRootRef: NodeRef = { module: res.module, type: res.type, field: res.field, instance: forkInstance, path: [] };
          const isOutermost = idx === reversedTokens.length - 1;
          wires.push({ from: prevOutRef, to: forkInRef, pipe: true, ...(force && isOutermost ? { force: true } : {}) });
          prevOutRef = forkRootRef;
        }
        const toRef = resolveAddress(targetStr, handleRes, bridgeType, bridgeField);
        wires.push({ from: prevOutRef, to: toRef, pipe: true, ...(fallback ? { fallback } : {}) });
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
      wires.push({
        from: fromRef,
        to: toRef,
        ...(force ? { force: true } : {}),
        ...(fallback ? { fallback } : {}),
      });
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
    pipeHandles: pipeHandleEntries.length > 0 ? pipeHandleEntries : undefined,
  });

  return instructions;
}

/**
 * Parse a `with` declaration into handle bindings + resolution map.
 *
 * Supported forms:
 *   with <name> as <handle>     — tool reference (dotted or simple name)
 *   with <name>                 — shorthand: handle defaults to last segment of name
 *   with input as <handle>
 *   with context as <handle>
 *   with context                — shorthand for `with context as context`
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

  // with context as <handle>
  match = line.match(/^with\s+context\s+as\s+(\w+)$/i);
  if (match) {
    const handle = match[1];
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "context" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: "Context",
      field: "context",
    });
    return;
  }

  // with context (shorthand — handle defaults to "context")
  match = line.match(/^with\s+context$/i);
  if (match) {
    const handle = "context";
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "context" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: "Context",
      field: "context",
    });
    return;
  }

  // with const as <handle>
  match = line.match(/^with\s+const\s+as\s+(\w+)$/i);
  if (match) {
    const handle = match[1];
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "const" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: "Const",
      field: "const",
    });
    return;
  }

  // with const (shorthand — handle defaults to "const")
  match = line.match(/^with\s+const$/i);
  if (match) {
    const handle = "const";
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "const" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: "Const",
      field: "const",
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

  // with <name>  — shorthand: handle defaults to the last segment of name
  // Must come after the `with input` / `with context` guards above.
  match = line.match(/^with\s+(\S+)$/i);
  if (match) {
    const name = match[1];
    const lastDot = name.lastIndexOf(".");
    const handle = lastDot !== -1 ? name.substring(lastDot + 1) : name;
    checkDuplicate(handle);

    if (lastDot !== -1) {
      const modulePart = name.substring(0, lastDot);
      const fieldPart  = name.substring(lastDot + 1);
      const key = `${modulePart}:${fieldPart}`;
      const instance = (instanceCounters.get(key) ?? 0) + 1;
      instanceCounters.set(key, instance);
      handleBindings.push({ handle, kind: "tool", name });
      handleRes.set(handle, { module: modulePart, type: bridgeType, field: fieldPart, instance });
    } else {
      const key = `Tools:${name}`;
      const instance = (instanceCounters.get(key) ?? 0) + 1;
      instanceCounters.set(key, instance);
      handleBindings.push({ handle, kind: "tool", name });
      handleRes.set(handle, { module: SELF_MODULE, type: "Tools", field: name, instance });
    }
    return;
  }

  throw new Error(`Line ${lineNum}: Invalid with declaration: ${line}`);
}

/**
 * Resolve an address string into a structured NodeRef.
 *
 * Resolution rules:
 *   1. No dot, but whole address is a declared handle → handle root (path: [])
 *   2. No dot, not a handle → output field on the bridge trunk
 *   3. Prefix matches a declared handle → resolve via handle binding
 *   4. Otherwise → nested output path (e.g., topPick.address)
 */
function resolveAddress(
  address: string,
  handles: Map<string, HandleResolution>,
  bridgeType: string,
  bridgeField: string,
): NodeRef {
  const dotIndex = address.indexOf(".");

  if (dotIndex === -1) {
    // Whole address is a declared handle → resolve to its root (path: [])
    const resolution = handles.get(address);
    if (resolution) {
      const ref: NodeRef = {
        module: resolution.module,
        type: resolution.type,
        field: resolution.field,
        path: [],
      };
      if (resolution.instance != null) ref.instance = resolution.instance;
      return ref;
    }
    // No dot, not a handle — output reference on bridge trunk
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
  // UNLESS the prefix IS the bridge field itself (e.g., doubled.a when bridge is Query.doubled)
  // — in that case strip the prefix so path = ["a"], matching the GraphQL resolver path.
  if (prefix === bridgeField) {
    return {
      module: SELF_MODULE,
      type: bridgeType,
      field: bridgeField,
      path: pathParts,
    };
  }
  return {
    module: SELF_MODULE,
    type: bridgeType,
    field: bridgeField,
    path: [prefix, ...pathParts],
  };
}

// ── Const block parser ──────────────────────────────────────────────────────

/**
 * Parse `const` declarations into ConstDef instructions.
 *
 * Supports single-line and multi-line JSON values:
 *   const fallbackGeo = { "lat": 0, "lon": 0 }
 *   const bigConfig = {
 *     "timeout": 5000,
 *     "retries": 3
 *   }
 *   const defaultCurrency = "EUR"
 *   const limit = 10
 */
function parseConstLines(block: string, lineOffset: number): ConstDef[] {
  const lines = block.split("\n");
  const results: ConstDef[] = [];

  const ln = (i: number) => lineOffset + i + 1;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) { i++; continue; }

    const constMatch = line.match(/^const\s+(\w+)\s*=\s*(.*)/i);
    if (!constMatch) {
      throw new Error(`Line ${ln(i)}: Expected const declaration, got: ${line}`);
    }

    const name = constMatch[1];
    let valuePart = constMatch[2].trim();

    // Multi-line: if value starts with { or [ and isn't balanced, read more lines
    if (/^[{[]/.test(valuePart)) {
      let depth = 0;
      for (const ch of valuePart) {
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") depth--;
      }
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const nextLine = lines[i];
        valuePart += "\n" + nextLine;
        for (const ch of nextLine) {
          if (ch === "{" || ch === "[") depth++;
          if (ch === "}" || ch === "]") depth--;
        }
      }
      if (depth !== 0) {
        throw new Error(`Line ${ln(i)}: Unbalanced brackets in const "${name}"`);
      }
    }

    // Validate the value is parseable JSON
    const jsonValue = valuePart.trim();
    try {
      JSON.parse(jsonValue);
    } catch {
      throw new Error(`Line ${ln(i)}: Invalid JSON value for const "${name}": ${jsonValue}`);
    }

    results.push({ kind: "const", name, value: jsonValue });
    i++;
  }

  return results;
}

// ── Tool block parser ───────────────────────────────────────────────────────

/**
 * Parse a `tool` or `extend` block into a ToolDef instruction.
 *
 * Legacy format (root tool):
 *   tool hereapi httpCall
 *     with context
 *     baseUrl = "https://geocode.search.hereapi.com/v1"
 *     headers.apiKey <- context.hereapi.apiKey
 *
 * Legacy format (child tool with extends):
 *   tool hereapi.geocode extends hereapi
 *     method = GET
 *     path = /geocode
 *
 * New format (extend):
 *   extend httpCall as hereapi
 *     with context
 *     baseUrl = "https://geocode.search.hereapi.com/v1"
 *
 *   extend hereapi as hereapi.geocode
 *     method = GET
 *     path = /geocode
 *
 * When using `extend`, if the source matches a previously-defined tool name,
 * it's treated as an extends (child inherits parent). Otherwise the source
 * is treated as a function name.
 */
function parseToolBlock(block: string, lineOffset: number, previousInstructions?: Instruction[]): ToolDef {
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

    // Extend declaration: extend <source> as <name>
    if (/^extend\s/i.test(line)) {
      const extendMatch = line.match(/^extend\s+(\S+)\s+as\s+(\S+)$/i);
      if (!extendMatch) {
        throw new Error(`Line ${ln(i)}: Invalid extend declaration: ${line}. Expected: extend <source> as <name>`);
      }
      const source = extendMatch[1];
      toolName = extendMatch[2];
      // If source matches a previously-defined tool, it's an extends; otherwise it's a function name
      const isKnownTool = previousInstructions?.some(
        (inst) => inst.kind === "tool" && inst.name === source,
      );
      if (isKnownTool) {
        toolExtends = source;
      } else {
        toolFn = source;
      }
      continue;
    }

    // with context or with context as <handle>
    const contextMatch = line.match(/^with\s+context(?:\s+as\s+(\w+))?$/i);
    if (contextMatch) {
      const handle = contextMatch[1] ?? "context";
      deps.push({ kind: "context", handle });
      continue;
    }

    // with const or with const as <handle>
    const constDepMatch = line.match(/^with\s+const(?:\s+as\s+(\w+))?$/i);
    if (constDepMatch) {
      const handle = constDepMatch[1] ?? "const";
      deps.push({ kind: "const", handle });
      continue;
    }

    // with <tool> as <handle>
    const toolDepMatch = line.match(/^with\s+(\S+)\s+as\s+(\w+)$/i);
    if (toolDepMatch) {
      deps.push({ kind: "tool", handle: toolDepMatch[2], tool: toolDepMatch[1] });
      continue;
    }

    // on error = <json> (constant fallback)
    const onErrorConstMatch = line.match(/^on\s+error\s*=\s*(.+)$/i);
    if (onErrorConstMatch) {
      let valuePart = onErrorConstMatch[1].trim();
      // Multi-line JSON: if starts with { or [ and isn't balanced, read more lines
      if (/^[{[]/.test(valuePart)) {
        let depth = 0;
        for (const ch of valuePart) {
          if (ch === "{" || ch === "[") depth++;
          if (ch === "}" || ch === "]") depth--;
        }
        while (depth > 0 && i + 1 < lines.length) {
          i++;
          const nextLine = lines[i];
          valuePart += "\n" + nextLine;
          for (const ch of nextLine) {
            if (ch === "{" || ch === "[") depth++;
            if (ch === "}" || ch === "]") depth--;
          }
        }
      }
      wires.push({ kind: "onError", value: valuePart.trim() });
      continue;
    }

    // on error <- source (pull fallback from context/dep)
    const onErrorPullMatch = line.match(/^on\s+error\s*<-\s*(\S+)$/i);
    if (onErrorPullMatch) {
      wires.push({ kind: "onError", source: onErrorPullMatch[1] });
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
  const consts = instructions.filter(
    (i): i is ConstDef => i.kind === "const",
  );
  if (bridges.length === 0 && tools.length === 0 && consts.length === 0) return "";

  const blocks: string[] = [];

  // Group const declarations into a single block
  if (consts.length > 0) {
    blocks.push(consts.map((c) => `const ${c.name} = ${c.value}`).join("\n"));
  }
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

  // Declaration line — use `extend` format
  if (tool.extends) {
    lines.push(`extend ${tool.extends} as ${tool.name}`);
  } else {
    lines.push(`extend ${tool.fn} as ${tool.name}`);
  }

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
      case "tool": {
        // Short form `with <name>` when handle == last segment of name
        const lastDot = h.name.lastIndexOf(".");
        const defaultHandle = lastDot !== -1 ? h.name.substring(lastDot + 1) : h.name;
        if (h.handle === defaultHandle) {
          lines.push(`  with ${h.name}`);
        } else {
          lines.push(`  with ${h.name} as ${h.handle}`);
        }
        break;
      }
      case "input":
        lines.push(`  with input as ${h.handle}`);
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
    }
  }

  lines.push("");

  // ── Build handle map for reverse resolution ─────────────────────────
  const { handleMap, inputHandle } = buildHandleMap(bridge);

  // ── Pipe fork registry ──────────────────────────────────────────────
  // Extend handleMap with fork → handle-name entries and build the set of
  // known fork trunk keys so the wire classifiers below can use it.
  const pipeHandleTrunkKeys = new Set<string>();
  for (const ph of bridge.pipeHandles ?? []) {
    handleMap.set(ph.key, ph.handle);
    pipeHandleTrunkKeys.add(ph.key);
  }

  // ── Pipe wire detection ───────────────────────────────────────────────────────
  // Pipe wires are marked pipe:true.  Classify them into two maps:
  //   toInMap:    forkTrunkKey → wire feeding the fork's input field
  //   fromOutMap: forkTrunkKey → wire reading the fork's root result
  // Terminal out-wires (destination is NOT another fork) are chain anchors.
  const refTrunkKey = (ref: NodeRef): string =>
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;

  type FW = Extract<Wire, { from: NodeRef }>;
  const toInMap    = new Map<string, FW>(); // forkTrunkKey → wire with to = fork's input field
  const fromOutMap = new Map<string, FW>(); // forkTrunkKey → wire with from = fork root (path:[])
  const pipeWireSet = new Set<Wire>();

  for (const w of bridge.wires) {
    if (!("from" in w) || !(w as any).pipe) continue;
    const fw = w as FW;
    pipeWireSet.add(w);
    const toTk = refTrunkKey(fw.to);
    // In-wire: single-segment path targeting a known pipe fork
    if (fw.to.path.length === 1 && pipeHandleTrunkKeys.has(toTk)) {
      toInMap.set(toTk, fw);
    }
    // Out-wire: empty path from a known pipe fork
    if (fw.from.path.length === 0 && pipeHandleTrunkKeys.has(refTrunkKey(fw.from))) {
      fromOutMap.set(refTrunkKey(fw.from), fw);
    }
  }

  // ── Wires ───────────────────────────────────────────────────────────
  const elementWires = bridge.wires.filter(
    (w): w is Extract<Wire, { from: NodeRef }> =>
      "from" in w && !!w.from.element,
  );
  // Exclude pipe wires and element wires from the regular loop
  const regularWires = bridge.wires.filter(
    (w) => !pipeWireSet.has(w) && (!("from" in w) || !w.from.element),
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
    const arrow = w.force ? "<-!" : "<-";
    const fb = w.fallback ? ` ?? ${w.fallback}` : "";
    lines.push(`${toStr} ${arrow} ${fromStr}${fb}`);
  }

  // ── Pipe wires ───────────────────────────────────────────────────────
  // Find terminal fromOutMap entries — their destination is NOT another
  // pipe handle's .in. Follow the chain backward to reconstruct:
  //   dest <- h1|h2|…|source
  const serializedPipeTrunks = new Set<string>();

  for (const [tk, outWire] of fromOutMap.entries()) {
    // Non-terminal: this fork's result feeds another fork's input field
    if (pipeHandleTrunkKeys.has(refTrunkKey(outWire.to))) continue;

    // Follow chain backward to collect handle names (outermost-first)
    const handleChain: string[] = [];
    let currentTk = tk;
    let actualSourceRef: NodeRef | null = null;
    let chainForced = false;

    for (;;) {
      const handleName = handleMap.get(currentTk);
      if (!handleName) break;
      // Token: "handle" when field is "in" (default), otherwise "handle.field"
      const inWire = toInMap.get(currentTk);
      const fieldName = inWire?.to.path[0] ?? "in";
      const token = fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
      handleChain.push(token);
      serializedPipeTrunks.add(currentTk);
      if (inWire?.force) chainForced = true;
      if (!inWire) break;
      const fromTk = refTrunkKey(inWire.from);
      // Inner source is another pipe fork root (empty path) → continue chain
      if (inWire.from.path.length === 0 && pipeHandleTrunkKeys.has(fromTk)) {
        currentTk = fromTk;
      } else {
        actualSourceRef = inWire.from;
        break;
      }
    }

    if (actualSourceRef && handleChain.length > 0) {
      const sourceStr = serializeRef(actualSourceRef, bridge, handleMap, inputHandle, true);
      const destStr   = serializeRef(outWire.to,     bridge, handleMap, inputHandle, false);
      const arrow = chainForced ? "<-!" : "<-";
      const fb = outWire.fallback ? ` ?? ${outWire.fallback}` : "";
      lines.push(`${destStr} ${arrow} ${handleChain.join("|")}|${sourceStr}${fb}`);
    }
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
      case "context":
        handleMap.set(`${SELF_MODULE}:Context:context`, h.handle);
        break;
      case "const":
        handleMap.set(`${SELF_MODULE}:Const:const`, h.handle);
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
    // To side: sub-fields of the bridge's own return type are prefixed with the
    // bridge field name so `path: ["a"]` serializes as `doubled.a` (not bare "a").
    // This is needed for bridges whose output type has named sub-fields
    // (e.g. `bridge Query.doubled` with `doubled.a <- ...`).
    if (!isFrom && ref.path.length > 0) {
      return bridge.field + "." + serPath(ref.path);
    }
    // Bare path (e.g. top-level scalar output, or no-path for the bridge trunk itself)
    return serPath(ref.path);
  }

  // Lookup by trunk key
  const trunkStr =
    ref.instance != null
      ? `${ref.module}:${ref.type}:${ref.field}:${ref.instance}`
      : `${ref.module}:${ref.type}:${ref.field}`;
  const handle = handleMap.get(trunkStr);
  if (handle) {
    // Empty path — just the handle name (e.g. pipe result = tool root)
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
