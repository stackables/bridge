import type {
    Bridge,
    ConstDef,
    DefineDef,
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
const BRIDGE_VERSION = "1.4";

// Keywords that cannot be used as tool names, aliases, or const names
const RESERVED_KEYWORDS = new Set(["bridge", "with", "as", "from", "const", "tool", "version", "define"]);
// Source identifiers reserved for their special meaning inside bridge/tool blocks
const SOURCE_IDENTIFIERS = new Set(["input", "output", "context"]);

function assertNotReserved(name: string, lineNum: number, label: string) {
  if (RESERVED_KEYWORDS.has(name.toLowerCase())) {
    throw new Error(`Line ${lineNum}: "${name}" is a reserved keyword and cannot be used as a ${label}`);
  }
  if (SOURCE_IDENTIFIERS.has(name.toLowerCase())) {
    throw new Error(`Line ${lineNum}: "${name}" is a reserved source identifier and cannot be used as a ${label}`);
  }
}

export function parseBridge(text: string): Instruction[] {
  // Normalize: CRLF → LF, tabs → 2 spaces
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const allLines = normalized.split("\n");

  // Version check — first non-blank, non-comment line must be `version 1.4`
  const firstContentIdx = allLines.findIndex(
    (l) => l.trim() !== "" && !l.trim().startsWith("#"),
  );
  if (firstContentIdx === -1 || !/^version\s+/.test(allLines[firstContentIdx].trim())) {
    throw new Error(
      `Missing version declaration. Bridge files must begin with: version ${BRIDGE_VERSION}`,
    );
  }
  const versionToken = allLines[firstContentIdx].trim().replace(/^version\s+/, "");
  if (versionToken !== BRIDGE_VERSION) {
    throw new Error(
      `Unsupported bridge version "${versionToken}". This parser requires: version ${BRIDGE_VERSION}`,
    );
  }
  // Blank out the version line so block-splitting ignores it
  allLines[firstContentIdx] = "";

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
      if (/^(tool|bridge|const|define)\s/i.test(trimmed) && currentLines.length > 0) {
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
        instructions.push(parseToolBlock(subText, sub.startOffset + firstContentLine, instructions));
      } else if (firstLine && /^define\s/i.test(firstLine)) {
        instructions.push(parseDefineBlock(subText, sub.startOffset + firstContentLine));
      } else if (firstLine && /^bridge\s/i.test(firstLine)) {
        instructions.push(...parseBridgeBlock(subText, sub.startOffset + firstContentLine, instructions));
      } else if (firstLine && /^const\s/i.test(firstLine)) {
        instructions.push(...parseConstLines(subText, sub.startOffset + firstContentLine));
      } else if (firstLine && !firstLine.startsWith("#")) {
        throw new Error(
          `Line ${sub.startOffset + firstContentLine + 1}: Expected "tool", "define", "bridge", or "const" declaration, got: ${firstLine}`,
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

/**
 * Returns true when the token looks like a JSON literal rather than a
 * source reference (dotted path or pipe chain).
 * JSON start chars: `"`, `{`, `[`, digit, `-` + digit, `true`, `false`, `null`.
 */
function isJsonLiteral(s: string): boolean {
  return /^["\{\[\d]/.test(s) || /^-\d/.test(s) ||
    s === "true" || s === "false" || s === "null";
}

function parseBridgeBlock(block: string, lineOffset: number, previousInstructions?: Instruction[]): Instruction[] {
  // ── Passthrough shorthand: `bridge Type.field with <name>` ──────────
  // Expands into a full bridge that wires all input through the named
  // handle (typically a define) and returns its output directly.
  const shorthandMatch = block.match(/^bridge\s+(\w+)\.(\w+)\s+with\s+(\S+)\s*$/im);
  if (shorthandMatch) {
    const [, sType, sField, sName] = shorthandMatch;
    const sHandle = sName.includes(".") ? sName.substring(sName.lastIndexOf(".") + 1) : sName;
    const expanded = [
      `bridge ${sType}.${sField} {`,
      `  with ${sName} as ${sHandle}`,
      `  with input`,
      `  with output as __out`,
      `  ${sHandle} <- input`,
      `  __out <- ${sHandle}`,
      `}`,
    ].join("\n");
    const result = parseBridgeBlock(expanded, lineOffset, previousInstructions);
    // Tag the bridge instruction with the passthrough name for serialization
    const bridgeInst = result.find((i): i is Bridge => i.kind === "bridge");
    if (bridgeInst) bridgeInst.passthrough = sName;
    return result;
  }

  // Validate mandatory braces: `bridge Foo.bar {` ... `}`
  const rawLines = block.split("\n");
  const keywordIdx = rawLines.findIndex((l) => /^bridge\s/i.test(l.trim()));
  if (keywordIdx !== -1) {
    const kw = rawLines[keywordIdx].trim();
    if (!kw.endsWith("{")) {
      throw new Error(`Line ${lineOffset + keywordIdx + 1}: bridge block must use braces: bridge Type.field {`);
    }
    const hasClose = rawLines.some((l) => l.trimEnd() === "}");
    if (!hasClose) {
      throw new Error(`Line ${lineOffset + keywordIdx + 1}: bridge block missing closing }`);
    }
  }

  // Strip braces for internal parsing
  const lines = rawLines.map((l) => {
    const trimmed = l.trimEnd();
    if (trimmed === "}") return "";
    if (/^bridge\s/i.test(trimmed) && trimmed.endsWith("{")) return trimmed.replace(/\s*\{\s*$/, "");
    return trimmed;
  });
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
        previousInstructions ?? [],
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
  let currentIterHandle: string | null = null;
  const arrayIterators: Record<string, string> = {};
  /** Monotonically-increasing index; combined with a high base to produce
   *  fork instances that can never collide with regular handle instances. */
  let nextForkSeq = 0;
  const pipeHandleEntries: NonNullable<Bridge["pipeHandles"]> = [];

  /**
   * Parse a source expression (`handle.path` or `h1:h2:source`) into bridge
   * wires, returning the terminal NodeRef.
   *
   * For pipe chains: pushes the intermediate `.in <- prev` wires and registers
   * the fork instances, then returns the fork-root ref. The caller is
   * responsible for pushing the TERMINAL wire (forkRoot → target).
   *
   * For simple refs: returns the resolved NodeRef directly (no wires pushed).
   *
   * @param forceOnOutermost  When true, marks the outermost intermediate pipe
   *                          wire with `force: true` (used for `<-!`).
   */
  function buildSourceExpr(sourceStr: string, lineNum: number, forceOnOutermost: boolean): NodeRef {
    const parts = sourceStr.split(":");
    if (parts.length === 1) {
      return resolveAddress(sourceStr, handleRes, bridgeType, bridgeField, lineNum);
    }

    // Pipe chain
    const actualSource = parts[parts.length - 1];
    const tokenChain = parts.slice(0, -1);

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
          `Line ${lineNum}: Undeclared handle in pipe: "${handleName}". Add 'with <tool> as ${handleName}' to the bridge header.`,
        );
      }
    }

    let prevOutRef = resolveAddress(actualSource, handleRes, bridgeType, bridgeField, lineNum);
    const reversedTokens = [...tokenChain].reverse();
    for (let idx = 0; idx < reversedTokens.length; idx++) {
      const tok = reversedTokens[idx];
      const { handleName, fieldName } = parseToken(tok);
      const res = handleRes.get(handleName)!;
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
      wires.push({ from: prevOutRef, to: forkInRef, pipe: true, ...(forceOnOutermost && isOutermost ? { force: true as const } : {}) });
      prevOutRef = forkRootRef;
    }
    return prevOutRef; // fork-root ref
  }

  // ── Whether we are inside an element-mapping brace block
  let inElementBlock = false;

  for (let i = bodyStartIndex; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    // Closing brace of an element mapping block `{ ... }`
    if (line === "}") {
      if (inElementBlock) {
        currentArrayToPath = null;
        currentIterHandle = null;
        inElementBlock = false;
        continue;
      }
      throw new Error(`Line ${ln(i)}: Unexpected "}" — not inside an element block`);
    }

    // Element mapping lines (inside a brace block)
    if (inElementBlock && currentArrayToPath) {
      if (!line.startsWith(".")) {
        throw new Error(`Line ${ln(i)}: Element mapping lines must start with ".": ${line}`);
      }

      // Constant: .target = "value" or .target = value
      const elemConstMatch = line.match(/^\.(\S+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
      if (elemConstMatch) {
        const [, fieldName, quotedValue, unquotedValue] = elemConstMatch;
        const value = quotedValue ?? unquotedValue;
        wires.push({
          value,
          to: {
            module: SELF_MODULE,
            type: bridgeType,
            field: bridgeField,
            element: true,
            path: [...currentArrayToPath, ...parsePath(fieldName)],
          },
        });
        continue;
      }

      // Simple pull: .target <- <iter>.source (element-relative, no fallbacks)
      const iterPfx = `${currentIterHandle!}.`;
      const elemRelMatch = line.match(/^\.(\S+)\s*<-\s*(\S+)$/);
      if (elemRelMatch && elemRelMatch[2].startsWith(iterPfx)) {
        const toPath = [...currentArrayToPath, ...parsePath(elemRelMatch[1])];
        const fromPath = parsePath(elemRelMatch[2].slice(iterPfx.length));
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

      // Pull with fallbacks: .target <- source || "fallback" ?? errorSrc (relative or handle path)
      const elemArrowMatch = line.match(/^\.(\S+)\s*<-\s*(.+)$/);
      if (elemArrowMatch) {
        const [, toField, rhs] = elemArrowMatch;
        const toPath = [...currentArrayToPath, ...parsePath(toField)];
        const toRef: NodeRef = { module: SELF_MODULE, type: bridgeType, field: bridgeField, path: toPath };

        // Strip ?? tail
        let exprCore = rhs.trim();
        let fallback: string | undefined;
        let fallbackRefStr: string | undefined;
        const qqIdx = exprCore.lastIndexOf(" ?? ");
        if (qqIdx !== -1) {
          const tail = exprCore.slice(qqIdx + 4).trim();
          exprCore = exprCore.slice(0, qqIdx).trim();
          if (isJsonLiteral(tail)) fallback = tail;
          else fallbackRefStr = tail;
        }

        // Split on || — last may be JSON literal (nullFallback)
        const orParts = exprCore.split(" || ").map((s) => s.trim());
        let nullFallback: string | undefined;
        let sourceParts = orParts;
        if (orParts.length > 1 && isJsonLiteral(orParts[orParts.length - 1])) {
          nullFallback = orParts[orParts.length - 1];
          sourceParts = orParts.slice(0, -1);
        }

        let fallbackRef: NodeRef | undefined;
        let fallbackInternalWires: Wire[] = [];
        if (fallbackRefStr) {
          const preLen = wires.length;
          fallbackRef = buildSourceExpr(fallbackRefStr, ln(i), false);
          fallbackInternalWires = wires.splice(preLen);
        }

        for (let ci = 0; ci < sourceParts.length; ci++) {
          const srcStr = sourceParts[ci];
          const isLast = ci === sourceParts.length - 1;

          // Element-relative source: starts with "<iter>."
          const iterPrefix = `${currentIterHandle!}.`;
          let fromRef: NodeRef;
          if (srcStr.startsWith(iterPrefix)) {
            fromRef = {
              module: SELF_MODULE,
              type: bridgeType,
              field: bridgeField,
              element: true,
              path: parsePath(srcStr.slice(iterPrefix.length)),
            };
          } else if (srcStr.startsWith(".")) {
            throw new Error(`Line ${ln(i)}: Use "${currentIterHandle!}.field" to reference element fields, not ".field"`);
          } else {
            fromRef = buildSourceExpr(srcStr, ln(i), false);
          }

          const lastAttrs = isLast ? {
            ...(nullFallback ? { nullFallback } : {}),
            ...(fallback     ? { fallback }     : {}),
            ...(fallbackRef  ? { fallbackRef }  : {}),
          } : {};

          wires.push({ from: fromRef, to: toRef, ...lastAttrs });
        }
        wires.push(...fallbackInternalWires);
        continue;
      }

      throw new Error(`Line ${ln(i)}: Invalid element mapping line: ${line}`);
    }

    // Constant wire: target = "value" or target = value (unquoted)
    const constantMatch = line.match(/^(\S+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
    if (constantMatch) {
      const [, targetStr, quotedValue, unquotedValue] = constantMatch;
      const value = quotedValue ?? unquotedValue;
      const toRef = resolveAddress(targetStr, handleRes, bridgeType, bridgeField, ln(i));
      wires.push({ value, to: toRef });
      continue;
    }

    // ── Wire: target <- A [|| B [|| C]] [|| "nullLiteral"] [?? errorSrc|"errorLiteral"]
    const arrowMatch = line.match(/^(\S+)\s*<-(!?)\s*(.+)$/);
    if (arrowMatch) {
      const [, targetStr, forceFlag, rhs] = arrowMatch;
      const force = forceFlag === "!";
      const rhsTrimmed = rhs.trim();

      // ── Array mapping: target <- source[] as <iter> {
      //    Opens a brace-delimited element block.
      const arrayBraceMatch = rhsTrimmed.match(/^(\S+)\[\]\s+as\s+(\w+)\s*\{\s*$/);
      if (arrayBraceMatch) {
        const fromClean = arrayBraceMatch[1];
        const iterHandle = arrayBraceMatch[2];
        assertNotReserved(iterHandle, ln(i), "iterator handle");
        const fromRef = resolveAddress(fromClean, handleRes, bridgeType, bridgeField, ln(i));
        const toRef = resolveAddress(targetStr, handleRes, bridgeType, bridgeField, ln(i));
        wires.push({ from: fromRef, to: toRef });
        currentArrayToPath = toRef.path;
        currentIterHandle = iterHandle;
        arrayIterators[toRef.path[0]] = iterHandle;
        inElementBlock = true;
        continue;
      }

      // ── Strip the ?? tail (last " ?? " wins in case source contains " ?? ")
      let exprCore = rhsTrimmed;
      let fallback: string | undefined;
      let fallbackRefStr: string | undefined;
      const qqIdx = rhsTrimmed.lastIndexOf(" ?? ");
      if (qqIdx !== -1) {
        exprCore = rhsTrimmed.slice(0, qqIdx).trim();
        const tail = rhsTrimmed.slice(qqIdx + 4).trim();
        if (isJsonLiteral(tail)) {
          fallback = tail;
        } else {
          fallbackRefStr = tail;
        }
      }

      // ── Split on " || " to get coalesce chain parts
      const orParts = exprCore.split(" || ").map((s) => s.trim());

      // Last part may be a JSON literal → becomes nullFallback on the last source wire
      let nullFallback: string | undefined;
      let sourceParts = orParts;
      if (orParts.length > 1 && isJsonLiteral(orParts[orParts.length - 1])) {
        nullFallback = orParts[orParts.length - 1];
        sourceParts = orParts.slice(0, -1);
      }

      if (sourceParts.length === 0) {
        throw new Error(`Line ${ln(i)}: Wire has no source expression: ${line}`);
      }

      let fallbackRef: NodeRef | undefined;
      let fallbackInternalWires: Wire[] = [];
      if (fallbackRefStr) {
        const preLen = wires.length;
        fallbackRef = buildSourceExpr(fallbackRefStr, ln(i), false);
        fallbackInternalWires = wires.splice(preLen);
      }

      const toRef = resolveAddress(targetStr, handleRes, bridgeType, bridgeField, ln(i));

      for (let ci = 0; ci < sourceParts.length; ci++) {
        const isFirst = ci === 0;
        const isLast  = ci === sourceParts.length - 1;
        const srcStr  = sourceParts[ci];

        const termRef = buildSourceExpr(srcStr, ln(i), force && isFirst);
        const isPipeFork = termRef.instance != null && termRef.path.length === 0
          && srcStr.includes(":");

        const lastAttrs = isLast ? {
          ...(nullFallback  ? { nullFallback }  : {}),
          ...(fallback      ? { fallback }      : {}),
          ...(fallbackRef   ? { fallbackRef }   : {}),
        } : {};

        if (isPipeFork) {
          wires.push({ from: termRef, to: toRef, pipe: true, ...lastAttrs });
        } else {
          wires.push({
            from: termRef,
            to: toRef,
            ...(force && isFirst ? { force: true as const } : {}),
            ...lastAttrs,
          });
        }
      }

      wires.push(...fallbackInternalWires);
      continue;
    }

    throw new Error(`Line ${ln(i)}: Unrecognized line: ${line}`);
  }

  // ── Inline define invocations ───────────────────────────────────────
  const nextForkSeqRef = { value: nextForkSeq };
  for (const hb of handleBindings) {
    if (hb.kind !== "define") continue;
    const def = previousInstructions?.find(
      (inst): inst is DefineDef => inst.kind === "define" && inst.name === hb.name,
    );
    if (!def) {
      throw new Error(`Define "${hb.name}" referenced by handle "${hb.handle}" not found`);
    }
    inlineDefine(
      hb.handle,
      def,
      bridgeType,
      bridgeField,
      wires,
      pipeHandleEntries,
      handleBindings,
      instanceCounters,
      nextForkSeqRef,
    );
  }

  instructions.unshift({
    kind: "bridge",
    type: bridgeType,
    field: bridgeField,
    handles: handleBindings,
    wires,
    arrayIterators: Object.keys(arrayIterators).length > 0 ? arrayIterators : undefined,
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

  // with input (shorthand — handle defaults to "input")
  match = line.match(/^with\s+input$/i);
  if (match) {
    const handle = "input";
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "input" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: bridgeType,
      field: bridgeField,
    });
    return;
  }

  // with output as <handle>
  match = line.match(/^with\s+output\s+as\s+(\w+)$/i);
  if (match) {
    const handle = match[1];
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "output" });
    handleRes.set(handle, {
      module: SELF_MODULE,
      type: bridgeType,
      field: bridgeField,
    });
    return;
  }

  // with output (shorthand — handle defaults to "output")
  match = line.match(/^with\s+output$/i);
  if (match) {
    const handle = "output";
    checkDuplicate(handle);
    handleBindings.push({ handle, kind: "output" });
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

  // with <name> as <handle> — check for define invocation first
  match = line.match(/^with\s+(\S+)\s+as\s+(\w+)$/i);
  if (match) {
    const name = match[1];
    const handle = match[2];
    checkDuplicate(handle);
    assertNotReserved(handle, lineNum, "handle alias");

    // Check if name matches a known define
    const defineDef = instructions.find(
      (inst): inst is DefineDef => inst.kind === "define" && inst.name === name,
    );
    if (defineDef) {
      handleBindings.push({ handle, kind: "define", name });
      handleRes.set(handle, {
        module: `__define_${handle}`,
        type: bridgeType,
        field: bridgeField,
      });
      return;
    }

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

    // Check if name matches a known define
    const defineDef = instructions.find(
      (inst): inst is DefineDef => inst.kind === "define" && inst.name === name,
    );
    if (defineDef) {
      handleBindings.push({ handle, kind: "define", name });
      handleRes.set(handle, {
        module: `__define_${handle}`,
        type: bridgeType,
        field: bridgeField,
      });
      return;
    }

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

// ── Define inlining ─────────────────────────────────────────────────────────

/**
 * Inline a define invocation into a bridge's wires.
 *
 * Splits the define handle into separate input/output synthetic trunks,
 * clones the define's internal wires with remapped references, and adds
 * them to the bridge. Tool instances are remapped to avoid collisions.
 *
 * The executor treats synthetic trunks (module starting with `__define_`)
 * as pass-through data containers — no tool function is called.
 */
function inlineDefine(
  defineHandle: string,
  defineDef: DefineDef,
  bridgeType: string,
  bridgeField: string,
  wires: Wire[],
  pipeHandleEntries: NonNullable<Bridge["pipeHandles"]>,
  handleBindings: HandleBinding[],
  instanceCounters: Map<string, number>,
  nextForkSeqRef: { value: number },
): void {
  const genericModule = `__define_${defineHandle}`;
  const inModule = `__define_in_${defineHandle}`;
  const outModule = `__define_out_${defineHandle}`;

  // The define was parsed as synthetic `bridge Define.<name>`, so its
  // internal refs use type="Define", field=defineName for I/O, and
  // standard tool resolutions for tools.
  const defType = "Define";
  const defField = defineDef.name;

  // ── 1. Build trunk remapping for define's tool handles ──────────────

  // Replay define's instance counter to determine original instances
  const defCounters = new Map<string, number>();
  const trunkRemap = new Map<string, { module: string; type: string; field: string; instance: number }>();

  for (const hb of defineDef.handles) {
    if (hb.kind === "input" || hb.kind === "output" || hb.kind === "context" || hb.kind === "const") continue;
    if (hb.kind === "define") continue; // nested defines — future

    const name = hb.kind === "tool" ? hb.name : "";
    if (!name) continue;

    const lastDot = name.lastIndexOf(".");
    let oldModule: string, oldType: string, oldField: string, instanceKey: string, bridgeKey: string;

    if (lastDot !== -1) {
      oldModule = name.substring(0, lastDot);
      oldType = defType;
      oldField = name.substring(lastDot + 1);
      instanceKey = `${oldModule}:${oldField}`;
      bridgeKey = instanceKey;
    } else {
      oldModule = SELF_MODULE;
      oldType = "Tools";
      oldField = name;
      instanceKey = `Tools:${name}`;
      bridgeKey = instanceKey;
    }

    // Old instance (from define's isolated counter)
    const oldInstance = (defCounters.get(instanceKey) ?? 0) + 1;
    defCounters.set(instanceKey, oldInstance);

    // New instance (from bridge's counter)
    const newInstance = (instanceCounters.get(bridgeKey) ?? 0) + 1;
    instanceCounters.set(bridgeKey, newInstance);

    const oldKey = `${oldModule}:${oldType}:${oldField}:${oldInstance}`;
    trunkRemap.set(oldKey, { module: oldModule, type: oldType, field: oldField, instance: newInstance });

    // Add internal tool handle to bridge's handle bindings (namespaced)
    handleBindings.push({ handle: `${defineHandle}$${hb.handle}`, kind: "tool", name });
  }

  // ── 2. Remap bridge wires involving the define handle ───────────────

  for (const wire of wires) {
    if ("from" in wire) {
      if (wire.to.module === genericModule) {
        wire.to = { ...wire.to, module: inModule };
      }
      if (wire.from.module === genericModule) {
        wire.from = { ...wire.from, module: outModule };
      }
      if (wire.fallbackRef?.module === genericModule) {
        wire.fallbackRef = { ...wire.fallbackRef, module: outModule };
      }
    }
    if ("value" in wire && wire.to.module === genericModule) {
      wire.to = { ...wire.to, module: inModule };
    }
  }

  // ── 3. Clone, remap, and add define's wires ────────────────────────

  // Compute fork instance offset (define's fork instances start at 100000,
  // bridge's may overlap — offset them to avoid collision)
  const forkOffset = nextForkSeqRef.value;
  let maxDefForkSeq = 0;

  function remapRef(ref: NodeRef, side: "from" | "to"): NodeRef {
    // Define I/O trunk → split into input/output synthetic trunks
    if (ref.module === SELF_MODULE && ref.type === defType && ref.field === defField) {
      const targetModule = side === "from" ? inModule : outModule;
      return { ...ref, module: targetModule, type: bridgeType, field: bridgeField };
    }

    // Tool trunk → remap instance
    const key = `${ref.module}:${ref.type}:${ref.field}:${ref.instance ?? ""}`;
    const newTrunk = trunkRemap.get(key);
    if (newTrunk) {
      return { ...ref, module: newTrunk.module, type: newTrunk.type, field: newTrunk.field, instance: newTrunk.instance };
    }

    // Fork instance → offset (fork instances are >= 100000)
    if (ref.instance != null && ref.instance >= 100000) {
      const defSeq = ref.instance - 100000;
      if (defSeq + 1 > maxDefForkSeq) maxDefForkSeq = defSeq + 1;
      return { ...ref, instance: ref.instance + forkOffset };
    }

    return ref;
  }

  for (const wire of defineDef.wires) {
    const cloned: Wire = JSON.parse(JSON.stringify(wire));

    if ("from" in cloned) {
      cloned.from = remapRef(cloned.from, "from");
      cloned.to = remapRef(cloned.to, "to");
      if (cloned.fallbackRef) {
        cloned.fallbackRef = remapRef(cloned.fallbackRef, "from");
      }
    } else {
      // Constant wire
      cloned.to = remapRef(cloned.to, "to");
    }

    wires.push(cloned);
  }

  // Advance bridge's fork counter past define's forks
  nextForkSeqRef.value += maxDefForkSeq;

  // ── 4. Remap and merge pipe handles ─────────────────────────────────

  if (defineDef.pipeHandles) {
    for (const ph of defineDef.pipeHandles) {
      const parts = ph.key.split(":");
      // key format: "module:type:field:instance"
      const phInstance = parseInt(parts[parts.length - 1]);
      let newKey = ph.key;
      if (phInstance >= 100000) {
        const newInst = phInstance + forkOffset;
        parts[parts.length - 1] = String(newInst);
        newKey = parts.join(":");
      }

      // Remap baseTrunk
      const bt = ph.baseTrunk;
      const btKey = `${bt.module}:${defType}:${bt.field}:${bt.instance ?? ""}`;
      const newBt = trunkRemap.get(btKey);

      // Also try with Tools type for simple names
      const btKey2 = `${bt.module}:Tools:${bt.field}:${bt.instance ?? ""}`;
      const newBt2 = trunkRemap.get(btKey2);
      const resolvedBt = newBt ?? newBt2;

      pipeHandleEntries.push({
        key: newKey,
        handle: `${defineHandle}$${ph.handle}`,
        baseTrunk: resolvedBt
          ? { module: resolvedBt.module, type: resolvedBt.type, field: resolvedBt.field, instance: resolvedBt.instance }
          : ph.baseTrunk,
      });
    }
  }
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
  lineNum?: number,
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
    // Strict scoping: every reference must go through a declared handle.
    throw new Error(
      `${lineNum != null ? `Line ${lineNum}: ` : ""}Undeclared reference "${address}". ` +
      `Add 'with output as o' for output fields, or 'with ${address}' for a tool.`,
    );
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

  // Strict scoping: prefix must be a known handle.
  throw new Error(
    `${lineNum != null ? `Line ${lineNum}: ` : ""}Undeclared handle "${prefix}". ` +
    `Add 'with ${prefix}' or 'with ${prefix} as ${prefix}' to the bridge header.`,
  );
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
    assertNotReserved(name, ln(i), "const name");
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

// ── Define block parser ─────────────────────────────────────────────────────

/**
 * Parse a `define` block into a DefineDef instruction.
 *
 * Delegates to parseBridgeBlock with a synthetic `bridge Define.<name>` header,
 * then converts the resulting Bridge to a DefineDef template.
 *
 * Example:
 *   define secureProfile {
 *     with userApi as api
 *     with input as i
 *     with output as o
 *     api.id <- i.userId
 *     o.name <- api.login
 *   }
 */
function parseDefineBlock(block: string, lineOffset: number): DefineDef {
  const rawLines = block.split("\n");

  // Find the define header line
  let headerIdx = -1;
  let defineName = "";
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^define\s+(\w+)\s*\{?\s*$/i);
    if (!m) {
      throw new Error(`Line ${lineOffset + i + 1}: Expected define declaration: define <name> {. Got: ${line}`);
    }
    defineName = m[1];
    assertNotReserved(defineName, lineOffset + i + 1, "define name");
    headerIdx = i;
    break;
  }

  if (!defineName) {
    throw new Error(`Line ${lineOffset + 1}: Missing define declaration`);
  }

  // Validate braces
  const kw = rawLines[headerIdx].trim();
  if (!kw.endsWith("{")) {
    throw new Error(`Line ${lineOffset + headerIdx + 1}: define block must use braces: define ${defineName} {`);
  }
  const hasClose = rawLines.some((l) => l.trimEnd() === "}");
  if (!hasClose) {
    throw new Error(`Line ${lineOffset + headerIdx + 1}: define block missing closing }`);
  }

  // Rewrite header to a synthetic bridge: `bridge Define.<name> {`
  const syntheticLines = [...rawLines];
  syntheticLines[headerIdx] = rawLines[headerIdx]
    .replace(/^(\s*)define\s+\w+/i, `$1bridge Define.${defineName}`);

  const syntheticBlock = syntheticLines.join("\n");
  const results = parseBridgeBlock(syntheticBlock, lineOffset);
  const bridge = results[0] as Bridge;

  return {
    kind: "define",
    name: defineName,
    handles: bridge.handles,
    wires: bridge.wires,
    ...(bridge.arrayIterators ? { arrayIterators: bridge.arrayIterators } : {}),
    ...(bridge.pipeHandles ? { pipeHandles: bridge.pipeHandles } : {}),
  };
}

// ── Tool block parser ───────────────────────────────────────────────────────

/**
 * Parse a `tool` block into a ToolDef instruction.
 *
 * Format:
 *   tool hereapi from httpCall {
 *     with context
 *     .baseUrl = "https://geocode.search.hereapi.com/v1"
 *     .headers.apiKey <- context.hereapi.apiKey
 *   }
 *
 *   tool hereapi.geocode from hereapi {
 *     .method = GET
 *     .path = /geocode
 *   }
 *
 * When the source matches a previously-defined tool name,
 * it's treated as inheritance (child inherits parent). Otherwise the source
 * is treated as a function name.
 */
function parseToolBlock(block: string, lineOffset: number, previousInstructions?: Instruction[]): ToolDef {
  // Validate mandatory braces for blocks that have a body (deps / wires)
  const rawLines = block.split("\n");
  const keywordIdx = rawLines.findIndex((l) => /^tool\s/i.test(l.trim()));
  if (keywordIdx !== -1) {
    // Check if there are non-blank, non-comment body lines after the keyword
    const bodyLines = rawLines.slice(keywordIdx + 1).filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("#") && t !== "}";
    });
    const kw = rawLines[keywordIdx].trim();
    if (bodyLines.length > 0) {
      if (!kw.endsWith("{")) {
        throw new Error(`Line ${lineOffset + keywordIdx + 1}: tool block with body must use braces: tool foo from bar {`);
      }
      const hasClose = rawLines.some((l) => l.trimEnd() === "}");
      if (!hasClose) {
        throw new Error(`Line ${lineOffset + keywordIdx + 1}: tool block missing closing }`);
      }
    }
  }

  // Strip braces for internal parsing
  const lines = rawLines.map((l) => {
    const trimmed = l.trimEnd();
    if (trimmed === "}") return "";
    if (/^tool\s/i.test(trimmed) && trimmed.endsWith("{")) return trimmed.replace(/\s*\{\s*$/, "");
    return trimmed;
  });

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

    // Tool declaration: tool <name> from <source>
    if (/^tool\s/i.test(line)) {
      const toolMatch = line.match(/^tool\s+(\S+)\s+from\s+(\S+)$/i);
      if (!toolMatch) {
        throw new Error(`Line ${ln(i)}: Invalid tool declaration: ${line}. Expected: tool <name> from <source>`);
      }
      toolName = toolMatch[1];
      const source = toolMatch[2];
      assertNotReserved(toolName, ln(i), "tool name");
      // If source matches a previously-defined tool, it's inheritance; otherwise it's a function name
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

    // Constant wire: .target = "value" or .target = value (unquoted)
    const constantMatch = line.match(/^\.(\S+)\s*=\s*(?:"([^"]*)"|(\S+))$/);
    if (constantMatch) {
      const value = constantMatch[2] ?? constantMatch[3];
      wires.push({
        target: constantMatch[1],
        kind: "constant",
        value,
      });
      continue;
    }

    // Pull wire: .target <- source
    const pullMatch = line.match(/^\.(\S+)\s*<-\s*(\S+)$/);
    if (pullMatch) {
      wires.push({ target: pullMatch[1], kind: "pull", source: pullMatch[2] });
      continue;
    }

    // Catch bare param lines without leading dot — give a helpful error
    if (/^[a-zA-Z]/.test(line)) {
      throw new Error(`Line ${ln(i)}: Tool params require a dot prefix: ".${line.split(/[\s=<]/)[0]} ...". Only 'with' and 'on error' lines are unprefixed.`);
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
  const defines = instructions.filter(
    (i): i is DefineDef => i.kind === "define",
  );
  if (bridges.length === 0 && tools.length === 0 && consts.length === 0 && defines.length === 0) return "";

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

function serializeToolBlock(tool: ToolDef): string {
  const lines: string[] = [];
  const hasBody = tool.deps.length > 0 || tool.wires.length > 0;

  // Declaration line — use `tool <name> from <source>` format
  const source = tool.extends ?? tool.fn;
  lines.push(hasBody ? `tool ${tool.name} from ${source} {` : `tool ${tool.name} from ${source}`);

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
  const refTk = ref.instance != null
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
      const token = fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
      handleChain.push(token);
      if (!inWire) break;
      const fromTk = inWire.from.instance != null
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
      const sourceStr = serializeRef(actualSourceRef, bridge, handleMap, inputHandle, outputHandle, true);
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
        const defaultHandle = lastDot !== -1 ? h.name.substring(lastDot + 1) : h.name;
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
  const toInMap    = new Map<string, FW>();
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
    if (fw.from.path.length === 0 && pipeHandleTrunkKeys.has(refTrunkKey(fw.from))) {
      fromOutMap.set(refTrunkKey(fw.from), fw);
    }
  }

  // ── Group element wires by array-destination field ──────────────────
  // Pull wires: from.element=true
  const elementPullWires = bridge.wires.filter(
    (w): w is Extract<Wire, { from: NodeRef }> => "from" in w && !!w.from.element,
  );
  // Constant wires: "value" in w && to.element=true
  const elementConstWires = bridge.wires.filter(
    (w): w is Extract<Wire, { value: string }> => "value" in w && !!w.to.element,
  );

  // Build grouped maps keyed by the array-destination field name (to.path[0])
  const elementPullGroups  = new Map<string, Array<Extract<Wire, { from: NodeRef }>>>();
  const elementConstGroups = new Map<string, Array<Extract<Wire, { value: string }>>>();
  for (const w of elementPullWires) {
    const key = w.to.path[0];
    if (!elementPullGroups.has(key)) elementPullGroups.set(key, []);
    elementPullGroups.get(key)!.push(w);
  }
  for (const w of elementConstWires) {
    const key = w.to.path[0];
    if (!elementConstGroups.has(key)) elementConstGroups.set(key, []);
    elementConstGroups.get(key)!.push(w);
  }

  // Union of keys that have any element wire (pull or constant)
  const allElementKeys = new Set([...elementPullGroups.keys(), ...elementConstGroups.keys()]);

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
    serializePipeOrRef(ref, pipeHandleTrunkKeys, toInMap, handleMap, bridge, inputHandle, outputHandle);

  for (const w of regularWires) {
    // Constant wire
    if ("value" in w) {
      const toStr = sRef(w.to, false);
      lines.push(`${toStr} = "${w.value}"`);
      continue;
    }

    // Array mapping — emit brace-delimited element block
    const arrayKey = w.to.path.length === 1 ? w.to.path[0] : null;
    if (arrayKey && allElementKeys.has(arrayKey) && !serializedArrays.has(arrayKey)) {
      serializedArrays.add(arrayKey);
      const iterName = bridge.arrayIterators?.[arrayKey] ?? "item";
      const fromStr = sRef(w.from, true) + "[]";
      const toStr   = sRef(w.to, false);
      lines.push(`${toStr} <- ${fromStr} as ${iterName} {`);

      // Element constant wires (e.g. .provider = "RENFE")
      for (const ew of elementConstGroups.get(arrayKey) ?? []) {
        const fieldPath = ew.to.path.slice(1); // strip arrayKey prefix
        const elemTo = "." + serPath(fieldPath);
        lines.push(`  ${elemTo} = "${ew.value}"`);
      }
      // Element pull wires (e.g. .name <- iter.title)
      for (const ew of elementPullGroups.get(arrayKey) ?? []) {
        const fromPart = ew.from.element
          ? iterName + "." + serPath(ew.from.path)
          : sRef(ew.from, true);
        const elemTo = "." + serPath(ew.to.path.slice(1));

        // Handle fallbacks on element pull wires
        const nfb = "nullFallback" in ew && ew.nullFallback ? ` || ${ew.nullFallback}` : "";
        const errf = "fallbackRef" in ew && ew.fallbackRef
          ? ` ?? ${sPipeOrRef(ew.fallbackRef)}`
          : "fallback" in ew && ew.fallback ? ` ?? ${ew.fallback}` : "";
        lines.push(`  ${elemTo} <- ${fromPart}${nfb}${errf}`);
      }
      lines.push(`}`);
      continue;
    }

    // Regular wire
    const fromStr = sRef(w.from, true);
    const toStr   = sRef(w.to, false);
    const arrow = w.force ? "<-!" : "<-";
    const nfb = w.nullFallback ? ` || ${w.nullFallback}` : "";
    const errf = w.fallbackRef
      ? ` ?? ${sPipeOrRef(w.fallbackRef)}`
      : w.fallback ? ` ?? ${w.fallback}` : "";
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
      const token = fieldName === "in" ? handleName : `${handleName}.${fieldName}`;
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
      const destStr   = sRef(outWire.to, false);
      const arrow = chainForced ? "<-!" : "<-";
      const nfb = outWire.nullFallback ? ` || ${outWire.nullFallback}` : "";
      const errf = outWire.fallbackRef
        ? ` ?? ${sPipeOrRef(outWire.fallbackRef)}`
        : outWire.fallback ? ` ?? ${outWire.fallback}` : "";
      lines.push(`${destStr} ${arrow} ${handleChain.join(":")}:${sourceStr}${nfb}${errf}`);
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
        handleMap.set(`__define_${h.handle}:${bridge.type}:${bridge.field}`, h.handle);
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
