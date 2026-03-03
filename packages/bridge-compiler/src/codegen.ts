/**
 * AOT code generator — turns a Bridge AST into a standalone JavaScript function.
 *
 * Supports:
 *  - Pull wires (`target <- source`)
 *  - Constant wires (`target = "value"`)
 *  - Nullish coalescing (`?? fallback`)
 *  - Falsy fallback (`|| fallback`)
 *  - Catch fallback (`catch`)
 *  - Conditional wires (ternary)
 *  - Array mapping (`[] as iter { }`)
 *  - Force statements (`force <handle>`, `force <handle> catch null`)
 *  - ToolDef merging (tool blocks with wires and `on error`)
 */

import type {
  BridgeDocument,
  Bridge,
  Wire,
  NodeRef,
  ToolDef,
} from "@stackables/bridge-core";

const SELF_MODULE = "_";

// ── Public API ──────────────────────────────────────────────────────────────

export interface CompileOptions {
  /** The operation to compile, e.g. "Query.livingStandard" */
  operation: string;
}

export interface CompileResult {
  /** Generated JavaScript source code */
  code: string;
  /** The exported function name */
  functionName: string;
  /** The function body (without the function signature wrapper) */
  functionBody: string;
}

/**
 * Compile a single bridge operation into a standalone async JavaScript function.
 *
 * The generated function has the signature:
 *   `async function <Type>_<field>(input, tools, context) → Promise<any>`
 *
 * It calls tools in topological dependency order and returns the output object.
 */
export function compileBridge(
  document: BridgeDocument,
  options: CompileOptions,
): CompileResult {
  const { operation } = options;
  const dotIdx = operation.indexOf(".");
  if (dotIdx === -1)
    throw new Error(
      `Invalid operation: "${operation}". Expected "Type.field".`,
    );
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);

  const bridge = document.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge) throw new Error(`No bridge found for operation: ${operation}`);

  // Collect const definitions from the document
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) {
    if (inst.kind === "const") constDefs.set(inst.name, inst.value);
  }

  // Collect tool definitions from the document
  const toolDefs = document.instructions.filter(
    (i): i is ToolDef => i.kind === "tool",
  );

  const ctx = new CodegenContext(bridge, constDefs, toolDefs);
  return ctx.compile();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a wire has catch fallback modifiers. */
function hasCatchFallback(w: Wire): boolean {
  return (
    ("catchFallback" in w && w.catchFallback != null) ||
    ("catchFallbackRef" in w && !!w.catchFallbackRef)
  );
}

/** Check if any wire in a set has a control flow instruction (break/continue). */
function detectControlFlow(wires: Wire[]): "break" | "continue" | null {
  for (const w of wires) {
    if ("nullishControl" in w && w.nullishControl) {
      return w.nullishControl.kind as "break" | "continue";
    }
    if ("falsyControl" in w && w.falsyControl) {
      return w.falsyControl.kind as "break" | "continue";
    }
    if ("catchControl" in w && w.catchControl) {
      return w.catchControl.kind as "break" | "continue";
    }
  }
  return null;
}

function splitToolName(name: string): { module: string; fieldName: string } {
  const dotIdx = name.indexOf(".");
  if (dotIdx === -1) return { module: SELF_MODULE, fieldName: name };
  return {
    module: name.substring(0, dotIdx),
    fieldName: name.substring(dotIdx + 1),
  };
}

/** Build a trunk key from a NodeRef (same logic as bridge-core's trunkKey). */
function refTrunkKey(ref: NodeRef): string {
  if (ref.element) return `${ref.module}:${ref.type}:${ref.field}:*`;
  return `${ref.module}:${ref.type}:${ref.field}${ref.instance != null ? `:${ref.instance}` : ""}`;
}

/**
 * Emit a coerced constant value as a JavaScript literal.
 * Mirrors the runtime's `coerceConstant` semantics.
 */
function emitCoerced(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "true") return "true";
  if (trimmed === "false") return "false";
  if (trimmed === "null") return "null";
  // JSON-encoded string literal: '"hello"' → "hello"
  if (
    trimmed.length >= 2 &&
    trimmed.charCodeAt(0) === 0x22 &&
    trimmed.charCodeAt(trimmed.length - 1) === 0x22
  ) {
    return trimmed; // already a valid JS string literal
  }
  // Numeric literal
  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num) && isFinite(num)) return String(num);
  // Fallback: raw string
  return JSON.stringify(raw);
}

/**
 * Parse a const value at compile time and emit it as an inline JS literal.
 * Since const values are JSON, we can JSON.parse at compile time and
 * re-serialize as a JavaScript expression, avoiding runtime JSON.parse.
 */
function emitParsedConst(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    // If JSON.parse fails, fall back to runtime parsing
    return `JSON.parse(${JSON.stringify(raw)})`;
  }
}

// ── Code-generation context ─────────────────────────────────────────────────

interface ToolInfo {
  trunkKey: string;
  toolName: string;
  varName: string;
}

/** Set of internal tool field names that can be inlined by the AOT compiler. */
const INTERNAL_TOOLS = new Set([
  "concat",
  "add",
  "subtract",
  "multiply",
  "divide",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "not",
  "and",
  "or",
]);

class CodegenContext {
  private bridge: Bridge;
  private constDefs: Map<string, string>;
  private toolDefs: ToolDef[];
  private selfTrunkKey: string;
  private varMap = new Map<string, string>();
  private tools = new Map<string, ToolInfo>();
  private toolCounter = 0;
  /** Set of trunk keys for define-in/out virtual containers. */
  private defineContainers = new Set<string>();
  /** Trunk keys of pipe/expression tools that use internal implementations. */
  private internalToolKeys = new Set<string>();
  /** Trunk keys of tools compiled in catch-guarded mode (have a `_err` variable). */
  private catchGuardedTools = new Set<string>();

  constructor(
    bridge: Bridge,
    constDefs: Map<string, string>,
    toolDefs: ToolDef[],
  ) {
    this.bridge = bridge;
    this.constDefs = constDefs;
    this.toolDefs = toolDefs;
    this.selfTrunkKey = `${SELF_MODULE}:${bridge.type}:${bridge.field}`;

    for (const h of bridge.handles) {
      switch (h.kind) {
        case "input":
        case "output":
          // Input and output share the self trunk key; distinguished by wire direction
          break;
        case "context":
          this.varMap.set(`${SELF_MODULE}:Context:context`, "context");
          break;
        case "const":
          // Constants are inlined directly
          break;
        case "define": {
          // Define blocks are inlined at parse time. The parser creates
          // __define_in_<handle> and __define_out_<handle> modules that act
          // as virtual data containers for routing data in/out of the define.
          const inModule = `__define_in_${h.handle}`;
          const outModule = `__define_out_${h.handle}`;
          const inTk = `${inModule}:${bridge.type}:${bridge.field}`;
          const outTk = `${outModule}:${bridge.type}:${bridge.field}`;
          const inVn = `_d${++this.toolCounter}`;
          const outVn = `_d${++this.toolCounter}`;
          this.varMap.set(inTk, inVn);
          this.varMap.set(outTk, outVn);
          this.defineContainers.add(inTk);
          this.defineContainers.add(outTk);
          break;
        }
        case "tool": {
          const { module, fieldName } = splitToolName(h.name);
          // Module-prefixed tools use the bridge's type; self-module tools use "Tools".
          // However, tools inlined from define blocks may use type "Define".
          // We detect the correct type by scanning the wires for a matching ref.
          let refType = module === SELF_MODULE ? "Tools" : bridge.type;
          for (const w of bridge.wires) {
            if (
              w.to.module === module &&
              w.to.field === fieldName &&
              w.to.instance != null
            ) {
              refType = w.to.type;
              break;
            }
            if (
              "from" in w &&
              w.from.module === module &&
              w.from.field === fieldName &&
              w.from.instance != null
            ) {
              refType = w.from.type;
              break;
            }
          }
          const instance = this.findInstance(module, refType, fieldName);
          const tk = `${module}:${refType}:${fieldName}:${instance}`;
          const vn = `_t${++this.toolCounter}`;
          this.varMap.set(tk, vn);
          this.tools.set(tk, { trunkKey: tk, toolName: h.name, varName: vn });
          break;
        }
      }
    }

    // Register pipe handles (synthetic tool instances for interpolation,
    // expressions, and explicit pipe operators)
    if (bridge.pipeHandles) {
      for (const ph of bridge.pipeHandles) {
        // Use the pipe handle's key directly — it already includes the correct instance
        const tk = ph.key;
        if (!this.tools.has(tk)) {
          const vn = `_t${++this.toolCounter}`;
          this.varMap.set(tk, vn);
          const field = ph.baseTrunk.field;
          this.tools.set(tk, { trunkKey: tk, toolName: field, varName: vn });
          if (INTERNAL_TOOLS.has(field)) {
            this.internalToolKeys.add(tk);
          }
        }
      }
    }

    // Detect alias declarations — wires targeting __local:Shadow:<name> modules.
    // These act as virtual containers (like define modules).
    for (const w of bridge.wires) {
      const toTk = refTrunkKey(w.to);
      if (
        w.to.module === "__local" &&
        w.to.type === "Shadow" &&
        !this.varMap.has(toTk)
      ) {
        const vn = `_a${++this.toolCounter}`;
        this.varMap.set(toTk, vn);
        this.defineContainers.add(toTk);
      }
      if (
        "from" in w &&
        w.from.module === "__local" &&
        w.from.type === "Shadow"
      ) {
        const fromTk = refTrunkKey(w.from);
        if (!this.varMap.has(fromTk)) {
          const vn = `_a${++this.toolCounter}`;
          this.varMap.set(fromTk, vn);
          this.defineContainers.add(fromTk);
        }
      }
    }
  }

  /** Find the instance number for a tool from the wires. */
  private findInstance(module: string, type: string, field: string): number {
    for (const w of this.bridge.wires) {
      if (
        w.to.module === module &&
        w.to.type === type &&
        w.to.field === field &&
        w.to.instance != null
      )
        return w.to.instance;
      if (
        "from" in w &&
        w.from.module === module &&
        w.from.type === type &&
        w.from.field === field &&
        w.from.instance != null
      )
        return w.from.instance;
    }
    return 1;
  }

  // ── Main compilation entry point ──────────────────────────────────────────

  compile(): CompileResult {
    const { bridge } = this;
    const fnName = `${bridge.type}_${bridge.field}`;

    // Build a set of force tool trunk keys and their catch behavior
    const forceMap = new Map<string, { catchError?: boolean }>();
    if (bridge.forces) {
      for (const f of bridge.forces) {
        const tk = `${f.module}:${f.type}:${f.field}:${f.instance ?? 1}`;
        forceMap.set(tk, { catchError: f.catchError });
      }
    }

    // Separate wires into tool inputs, define containers, and output
    const outputWires: Wire[] = [];
    const toolWires = new Map<string, Wire[]>();
    const defineWires = new Map<string, Wire[]>();

    for (const w of bridge.wires) {
      // Element wires (from array mapping) target the output, not a tool
      const toKey = refTrunkKey(w.to);
      if (toKey === this.selfTrunkKey) {
        outputWires.push(w);
      } else if (this.defineContainers.has(toKey)) {
        // Wire targets a define-in/out container
        const arr = defineWires.get(toKey) ?? [];
        arr.push(w);
        defineWires.set(toKey, arr);
      } else {
        const arr = toolWires.get(toKey) ?? [];
        arr.push(w);
        toolWires.set(toKey, arr);
      }
    }

    // Ensure force-only tools (no wires targeting them from output) are
    // still included in the tool map for scheduling
    for (const [tk] of forceMap) {
      if (!toolWires.has(tk) && this.tools.has(tk)) {
        toolWires.set(tk, []);
      }
    }

    // Detect tools whose output is only referenced by catch-guarded wires.
    // These tools need try/catch wrapping to prevent unhandled rejections.
    for (const w of outputWires) {
      if (hasCatchFallback(w) && "from" in w) {
        const srcKey = refTrunkKey(w.from);
        this.catchGuardedTools.add(srcKey);
      }
    }

    // Merge define container entries into toolWires for topological sorting.
    // Define containers are scheduled like tools (they have dependencies and
    // dependants) but they emit simple object assignments instead of tool calls.
    for (const [tk, wires] of defineWires) {
      toolWires.set(tk, wires);
    }

    // Topological sort of tool calls (including define containers)
    const toolOrder = this.topologicalSort(toolWires);

    // Build code lines
    const lines: string[] = [];
    lines.push(`// AOT-compiled bridge: ${bridge.type}.${bridge.field}`);
    lines.push(`// Generated by @stackables/bridge-compiler`);
    lines.push("");
    lines.push(
      `export default async function ${fnName}(input, tools, context, __opts) {`,
    );
    lines.push(`  const __signal = __opts?.signal;`);
    lines.push(`  const __timeoutMs = __opts?.toolTimeoutMs ?? 0;`);
    lines.push(
      `  const __ctx = { logger: __opts?.logger ?? {}, signal: __signal };`,
    );
    lines.push(`  async function __call(fn, input) {`);
    lines.push(`    if (__signal?.aborted) throw new Error("aborted");`);
    lines.push(`    const p = fn(input, __ctx);`);
    lines.push(`    if (__timeoutMs > 0) {`);
    lines.push(
      `      let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("Tool timeout")), __timeoutMs); });`,
    );
    lines.push(
      `      try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }`,
    );
    lines.push(`    }`);
    lines.push(`    return p;`);
    lines.push(`  }`);

    // Emit tool calls and define container assignments
    for (const tk of toolOrder) {
      if (this.defineContainers.has(tk)) {
        // Emit define container as a plain object assignment
        const wires = defineWires.get(tk) ?? [];
        const varName = this.varMap.get(tk)!;
        const inputObj = this.buildObjectLiteral(wires, (w) => w.to.path, 4);
        lines.push(`  const ${varName} = ${inputObj};`);
        continue;
      }
      const tool = this.tools.get(tk)!;
      const wires = toolWires.get(tk) ?? [];
      const forceInfo = forceMap.get(tk);

      if (forceInfo?.catchError) {
        this.emitToolCall(lines, tool, wires, "fire-and-forget");
      } else if (this.catchGuardedTools.has(tk)) {
        this.emitToolCall(lines, tool, wires, "catch-guarded");
      } else {
        this.emitToolCall(lines, tool, wires, "normal");
      }
    }

    // Emit output
    this.emitOutput(lines, outputWires);

    lines.push("}");
    lines.push("");

    // Extract function body (lines after the signature, before the closing brace)
    const signatureIdx = lines.findIndex((l) =>
      l.startsWith("export default async function"),
    );
    const closingIdx = lines.lastIndexOf("}");
    const bodyLines = lines.slice(signatureIdx + 1, closingIdx);
    const functionBody = bodyLines.join("\n");

    return { code: lines.join("\n"), functionName: fnName, functionBody };
  }

  // ── Tool call emission ─────────────────────────────────────────────────────

  /**
   * Emit a tool call with ToolDef wire merging and onError support.
   *
   * If a ToolDef exists for the tool:
   * 1. Apply ToolDef constant wires as base input
   * 2. Apply ToolDef pull wires (resolved at runtime from tool deps)
   * 3. Apply bridge wires on top (override)
   * 4. Call the ToolDef's fn function (not the tool name)
   * 5. Wrap in try/catch if onError wire exists
   */
  private emitToolCall(
    lines: string[],
    tool: ToolInfo,
    bridgeWires: Wire[],
    mode: "normal" | "fire-and-forget" | "catch-guarded" = "normal",
  ): void {
    const toolDef = this.resolveToolDef(tool.toolName);

    if (!toolDef) {
      // Check if this is an internal pipe tool (expressions, interpolation)
      if (this.internalToolKeys.has(tool.trunkKey)) {
        this.emitInternalToolCall(lines, tool, bridgeWires);
        return;
      }
      // Simple tool call — no ToolDef
      const inputObj = this.buildObjectLiteral(
        bridgeWires,
        (w) => w.to.path,
        4,
      );
      if (mode === "fire-and-forget") {
        lines.push(
          `  try { await __call(tools[${JSON.stringify(tool.toolName)}], ${inputObj}); } catch (_e) {}`,
        );
        lines.push(`  const ${tool.varName} = undefined;`);
      } else if (mode === "catch-guarded") {
        // Catch-guarded: store result AND the actual error so unguarded wires can re-throw.
        lines.push(`  let ${tool.varName}, ${tool.varName}_err;`);
        lines.push(
          `  try { ${tool.varName} = await __call(tools[${JSON.stringify(tool.toolName)}], ${inputObj}); } catch (_e) { ${tool.varName}_err = _e; }`,
        );
      } else {
        lines.push(
          `  const ${tool.varName} = await __call(tools[${JSON.stringify(tool.toolName)}], ${inputObj});`,
        );
      }
      return;
    }

    // ToolDef-backed tool call
    const fnName = toolDef.fn ?? tool.toolName;
    const onErrorWire = toolDef.wires.find((w) => w.kind === "onError");

    // Build input: ToolDef wires first, then bridge wires override
    // Track entries by key for precise override matching
    const inputEntries = new Map<string, string>();

    // ToolDef constant wires
    for (const tw of toolDef.wires) {
      if (tw.kind === "constant") {
        inputEntries.set(
          tw.target,
          `    ${JSON.stringify(tw.target)}: ${emitCoerced(tw.value)}`,
        );
      }
    }

    // ToolDef pull wires — resolved from tool dependencies
    for (const tw of toolDef.wires) {
      if (tw.kind === "pull") {
        const expr = this.resolveToolDepSource(tw.source, toolDef);
        inputEntries.set(
          tw.target,
          `    ${JSON.stringify(tw.target)}: ${expr}`,
        );
      }
    }

    // Bridge wires override ToolDef wires
    for (const bw of bridgeWires) {
      const path = bw.to.path;
      if (path.length >= 1) {
        const key = path[0]!;
        inputEntries.set(
          key,
          `    ${JSON.stringify(key)}: ${this.wireToExpr(bw)}`,
        );
      }
    }

    const inputParts = [...inputEntries.values()];

    const inputObj =
      inputParts.length > 0 ? `{\n${inputParts.join(",\n")},\n  }` : "{}";

    if (onErrorWire) {
      // Wrap in try/catch for onError
      lines.push(`  let ${tool.varName};`);
      lines.push(`  try {`);
      lines.push(
        `    ${tool.varName} = await __call(tools[${JSON.stringify(fnName)}], ${inputObj});`,
      );
      lines.push(`  } catch (_e) {`);
      if ("value" in onErrorWire) {
        lines.push(
          `    ${tool.varName} = JSON.parse(${JSON.stringify(onErrorWire.value)});`,
        );
      } else {
        const fallbackExpr = this.resolveToolDepSource(
          onErrorWire.source,
          toolDef,
        );
        lines.push(`    ${tool.varName} = ${fallbackExpr};`);
      }
      lines.push(`  }`);
    } else if (mode === "fire-and-forget") {
      lines.push(
        `  try { await __call(tools[${JSON.stringify(fnName)}], ${inputObj}); } catch (_e) {}`,
      );
      lines.push(`  const ${tool.varName} = undefined;`);
    } else if (mode === "catch-guarded") {
      // Catch-guarded: store result AND the actual error so unguarded wires can re-throw.
      lines.push(`  let ${tool.varName}, ${tool.varName}_err;`);
      lines.push(
        `  try { ${tool.varName} = await __call(tools[${JSON.stringify(fnName)}], ${inputObj}); } catch (_e) { ${tool.varName}_err = _e; }`,
      );
    } else {
      lines.push(
        `  const ${tool.varName} = await __call(tools[${JSON.stringify(fnName)}], ${inputObj});`,
      );
    }
  }

  /**
   * Emit an inlined internal tool call (expressions, string interpolation).
   *
   * Instead of calling through the tools map, these are inlined as direct
   * JavaScript operations — e.g., multiply becomes `Number(a) * Number(b)`.
   */
  private emitInternalToolCall(
    lines: string[],
    tool: ToolInfo,
    bridgeWires: Wire[],
  ): void {
    const fieldName = tool.toolName;

    // Collect input wires by their target path
    const inputs = new Map<string, string>();
    for (const w of bridgeWires) {
      const path = w.to.path;
      const key = path.join(".");
      inputs.set(key, this.wireToExpr(w));
    }

    let expr: string;
    const a = inputs.get("a") ?? "undefined";
    const b = inputs.get("b") ?? "undefined";

    switch (fieldName) {
      case "add":
        expr = `(Number(${a}) + Number(${b}))`;
        break;
      case "subtract":
        expr = `(Number(${a}) - Number(${b}))`;
        break;
      case "multiply":
        expr = `(Number(${a}) * Number(${b}))`;
        break;
      case "divide":
        expr = `(Number(${a}) / Number(${b}))`;
        break;
      case "eq":
        expr = `(${a} === ${b})`;
        break;
      case "neq":
        expr = `(${a} !== ${b})`;
        break;
      case "gt":
        expr = `(Number(${a}) > Number(${b}))`;
        break;
      case "gte":
        expr = `(Number(${a}) >= Number(${b}))`;
        break;
      case "lt":
        expr = `(Number(${a}) < Number(${b}))`;
        break;
      case "lte":
        expr = `(Number(${a}) <= Number(${b}))`;
        break;
      case "not":
        expr = `(!${a})`;
        break;
      case "and":
        expr = `(Boolean(${a}) && Boolean(${b}))`;
        break;
      case "or":
        expr = `(Boolean(${a}) || Boolean(${b}))`;
        break;
      case "concat": {
        const parts: string[] = [];
        for (let i = 0; ; i++) {
          const partExpr = inputs.get(`parts.${i}`);
          if (partExpr === undefined) break;
          parts.push(partExpr);
        }
        // concat returns { value: string } — same as the runtime internal tool
        const concatParts = parts
          .map((p) => `(${p} == null ? "" : String(${p}))`)
          .join(" + ");
        expr = `{ value: ${concatParts || '""'} }`;
        break;
      }
      default: {
        // Unknown internal tool — fall back to tools map call
        const inputObj = this.buildObjectLiteral(
          bridgeWires,
          (w) => w.to.path,
          4,
        );
        lines.push(
          `  const ${tool.varName} = await __call(tools[${JSON.stringify(tool.toolName)}], ${inputObj});`,
        );
        return;
      }
    }

    lines.push(`  const ${tool.varName} = ${expr};`);
  }

  /**
   * Resolve a ToolDef source reference (e.g. "ctx.apiKey") to a JS expression.
   * Handles context, const, and tool dependencies.
   */
  private resolveToolDepSource(source: string, toolDef: ToolDef): string {
    const dotIdx = source.indexOf(".");
    const handle = dotIdx === -1 ? source : source.substring(0, dotIdx);
    const restPath =
      dotIdx === -1 ? [] : source.substring(dotIdx + 1).split(".");

    const dep = toolDef.deps.find((d) => d.handle === handle);
    if (!dep) return "undefined";

    let baseExpr: string;
    if (dep.kind === "context") {
      baseExpr = "context";
    } else if (dep.kind === "const") {
      // Resolve from the const definitions — inline parsed value
      if (restPath.length > 0) {
        const constName = restPath[0]!;
        const val = this.constDefs.get(constName);
        if (val != null) {
          const base = emitParsedConst(val);
          if (restPath.length === 1) return base;
          const tail = restPath
            .slice(1)
            .map((p) => `?.[${JSON.stringify(p)}]`)
            .join("");
          return `(${base})${tail}`;
        }
      }
      return "undefined";
    } else if (dep.kind === "tool") {
      // Tool dependency — reference the tool's variable
      const depToolInfo = this.findToolByName(dep.tool);
      if (depToolInfo) {
        baseExpr = depToolInfo.varName;
      } else {
        return "undefined";
      }
    } else {
      return "undefined";
    }

    if (restPath.length === 0) return baseExpr;
    return baseExpr + restPath.map((p) => `?.[${JSON.stringify(p)}]`).join("");
  }

  /** Find a tool info by tool name. */
  private findToolByName(name: string): ToolInfo | undefined {
    for (const [, info] of this.tools) {
      if (info.toolName === name) return info;
    }
    return undefined;
  }

  /**
   * Resolve a ToolDef by name, merging the extends chain.
   * Mirrors the runtime's resolveToolDefByName logic.
   */
  private resolveToolDef(name: string): ToolDef | undefined {
    const base = this.toolDefs.find((t) => t.name === name);
    if (!base) return undefined;

    // Build extends chain: root → ... → leaf
    const chain: ToolDef[] = [base];
    let current = base;
    while (current.extends) {
      const parent = this.toolDefs.find((t) => t.name === current.extends);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }

    // Merge: root provides base, each child overrides
    const merged: ToolDef = {
      kind: "tool",
      name,
      fn: chain[0]!.fn,
      deps: [],
      wires: [],
    };

    for (const def of chain) {
      for (const dep of def.deps) {
        if (!merged.deps.some((d) => d.handle === dep.handle)) {
          merged.deps.push(dep);
        }
      }
      for (const wire of def.wires) {
        if (wire.kind === "onError") {
          const idx = merged.wires.findIndex((w) => w.kind === "onError");
          if (idx >= 0) merged.wires[idx] = wire;
          else merged.wires.push(wire);
        } else if ("target" in wire) {
          const target = wire.target;
          const idx = merged.wires.findIndex(
            (w) => "target" in w && w.target === target,
          );
          if (idx >= 0) merged.wires[idx] = wire;
          else merged.wires.push(wire);
        }
      }
    }

    return merged;
  }

  // ── Output generation ────────────────────────────────────────────────────

  private emitOutput(lines: string[], outputWires: Wire[]): void {
    if (outputWires.length === 0) {
      lines.push("  return {};");
      return;
    }

    // Detect array iterators
    const arrayIterators = this.bridge.arrayIterators ?? {};
    const isRootArray = "" in arrayIterators;

    // Check for root passthrough (wire with empty path) — but not if it's a root array source
    const rootWire = outputWires.find((w) => w.to.path.length === 0);
    if (rootWire && !isRootArray) {
      lines.push(`  return ${this.wireToExpr(rootWire)};`);
      return;
    }

    // Handle root array output (o <- src.items[] as item { ... })
    if (isRootArray && rootWire) {
      const elemWires = outputWires.filter(
        (w) => "from" in w && w.from.element,
      );
      const arrayExpr = this.wireToExpr(rootWire);
      // Only check control flow on direct element wires, not sub-array element wires
      const directElemWires = elemWires.filter((w) => w.to.path.length === 1);
      const cf = detectControlFlow(directElemWires);
      if (cf === "continue") {
        // Use flatMap — skip elements that trigger continue
        const body = this.buildElementBodyWithControlFlow(
          elemWires,
          arrayIterators,
          0,
          4,
          "continue",
        );
        lines.push(`  return (${arrayExpr} ?? []).flatMap((_el0) => {`);
        lines.push(body);
        lines.push(`  });`);
      } else if (cf === "break") {
        // Use a loop with early break
        const body = this.buildElementBodyWithControlFlow(
          elemWires,
          arrayIterators,
          0,
          4,
          "break",
        );
        lines.push(`  const _result = [];`);
        lines.push(`  for (const _el0 of (${arrayExpr} ?? [])) {`);
        lines.push(body);
        lines.push(`  }`);
        lines.push(`  return _result;`);
      } else {
        const body = this.buildElementBody(elemWires, arrayIterators, 0, 4);
        lines.push(`  return (${arrayExpr} ?? []).map((_el0) => (${body}));`);
      }
      return;
    }

    const arrayFields = new Set(Object.keys(arrayIterators));

    // Separate element wires from scalar wires
    const elementWires = new Map<string, Wire[]>();
    const scalarWires: Wire[] = [];
    const arraySourceWires = new Map<string, Wire>();

    for (const w of outputWires) {
      const topField = w.to.path[0]!;
      if ("from" in w && w.from.element) {
        // Element wire — belongs to an array mapping
        const arr = elementWires.get(topField) ?? [];
        arr.push(w);
        elementWires.set(topField, arr);
      } else if (arrayFields.has(topField) && w.to.path.length === 1) {
        // Root wire for an array field
        arraySourceWires.set(topField, w);
      } else {
        scalarWires.push(w);
      }
    }

    // Build a nested tree from scalar wires using their full output path
    interface TreeNode {
      expr?: string;
      children: Map<string, TreeNode>;
    }
    const tree: TreeNode = { children: new Map() };

    for (const w of scalarWires) {
      const path = w.to.path;
      let current = tree;
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i]!;
        if (!current.children.has(seg)) {
          current.children.set(seg, { children: new Map() });
        }
        current = current.children.get(seg)!;
      }
      const lastSeg = path[path.length - 1]!;
      if (!current.children.has(lastSeg)) {
        current.children.set(lastSeg, { children: new Map() });
      }
      const node = current.children.get(lastSeg)!;
      if (node.expr != null) {
        // Overdefinition: combine with ?? — first non-null wins
        node.expr = `(${node.expr} ?? ${this.wireToExpr(w)})`;
      } else {
        node.expr = this.wireToExpr(w);
      }
    }

    // Emit array-mapped fields into the tree as well
    for (const [arrayField] of Object.entries(arrayIterators)) {
      if (arrayField === "") continue; // root array handled above
      const sourceW = arraySourceWires.get(arrayField);
      const elemWires = elementWires.get(arrayField) ?? [];
      if (!sourceW || elemWires.length === 0) continue;

      // Strip the array field prefix from element wire paths
      const shifted: Wire[] = elemWires.map((w) => ({
        ...w,
        to: { ...w.to, path: w.to.path.slice(1) },
      }));

      const arrayExpr = this.wireToExpr(sourceW);
      // Only check control flow on direct element wires (not sub-array element wires)
      const directShifted = shifted.filter((w) => w.to.path.length === 1);
      const cf = detectControlFlow(directShifted);
      let mapExpr: string;
      if (cf === "continue") {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          arrayIterators,
          0,
          6,
          "continue",
        );
        mapExpr = `(${arrayExpr})?.flatMap((_el0) => {\n${cfBody}\n    }) ?? null`;
      } else if (cf === "break") {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          arrayIterators,
          0,
          8,
          "break",
        );
        mapExpr = `(() => { const _src = ${arrayExpr}; if (_src == null) return null; const _result = []; for (const _el0 of _src) {\n${cfBody}\n      } return _result; })()`;
      } else {
        const body = this.buildElementBody(shifted, arrayIterators, 0, 6);
        mapExpr = `(${arrayExpr})?.map((_el0) => (${body})) ?? null`;
      }

      if (!tree.children.has(arrayField)) {
        tree.children.set(arrayField, { children: new Map() });
      }
      tree.children.get(arrayField)!.expr = mapExpr;
    }

    // Serialize the tree to a return statement
    const objStr = this.serializeOutputTree(tree, 4);
    lines.push(`  return ${objStr};`);
  }

  /** Serialize an output tree node into a JS object literal. */
  private serializeOutputTree(
    node: {
      children: Map<string, { expr?: string; children: Map<string, any> }>;
    },
    indent: number,
  ): string {
    const pad = " ".repeat(indent);
    const entries: string[] = [];

    for (const [key, child] of node.children) {
      if (child.expr != null && child.children.size === 0) {
        entries.push(`${pad}${JSON.stringify(key)}: ${child.expr}`);
      } else if (child.children.size > 0 && child.expr == null) {
        const nested = this.serializeOutputTree(child, indent + 2);
        entries.push(`${pad}${JSON.stringify(key)}: ${nested}`);
      } else {
        // Has both expr and children — use expr (children override handled elsewhere)
        entries.push(
          `${pad}${JSON.stringify(key)}: ${child.expr ?? "undefined"}`,
        );
      }
    }

    const innerPad = " ".repeat(indent - 2);
    return `{\n${entries.join(",\n")},\n${innerPad}}`;
  }

  /**
   * Build the body of a `.map()` callback from element wires.
   *
   * Handles nested array iterators: if an element wire targets a field that
   * is itself an array iterator, a nested `.map()` is generated.
   */
  private buildElementBody(
    elemWires: Wire[],
    arrayIterators: Record<string, string>,
    depth: number,
    indent: number,
  ): string {
    const elVar = `_el${depth}`;

    // Separate into scalar element wires and sub-array source/element wires
    interface TreeNode {
      expr?: string;
      children: Map<string, TreeNode>;
    }
    const tree: TreeNode = { children: new Map() };

    // Group wires by whether they target a sub-array field
    const subArraySources = new Map<string, Wire>(); // field → source wire
    const subArrayElements = new Map<string, Wire[]>(); // field → element wires

    for (const ew of elemWires) {
      const topField = ew.to.path[0]!;

      if (
        topField in arrayIterators &&
        ew.to.path.length === 1 &&
        !subArraySources.has(topField)
      ) {
        // This is the source wire for a sub-array (e.g., .legs <- c.sections[])
        subArraySources.set(topField, ew);
      } else if (topField in arrayIterators && ew.to.path.length > 1) {
        // This is an element wire for a sub-array (e.g., .legs.trainName <- s.name)
        const arr = subArrayElements.get(topField) ?? [];
        arr.push(ew);
        subArrayElements.set(topField, arr);
      } else {
        // Regular scalar element wire — add to tree using full path
        const path = ew.to.path;
        let current = tree;
        for (let i = 0; i < path.length - 1; i++) {
          const seg = path[i]!;
          if (!current.children.has(seg)) {
            current.children.set(seg, { children: new Map() });
          }
          current = current.children.get(seg)!;
        }
        const lastSeg = path[path.length - 1]!;
        if (!current.children.has(lastSeg)) {
          current.children.set(lastSeg, { children: new Map() });
        }
        current.children.get(lastSeg)!.expr = this.elementWireToExpr(ew, elVar);
      }
    }

    // Handle sub-array fields
    for (const [field, sourceW] of subArraySources) {
      const innerElems = subArrayElements.get(field) ?? [];
      if (innerElems.length === 0) continue;

      // Shift inner element paths: remove the first segment (the sub-array field name)
      const shifted: Wire[] = innerElems.map((w) => ({
        ...w,
        to: { ...w.to, path: w.to.path.slice(1) },
      }));

      const srcExpr = this.elementWireToExpr(sourceW, elVar);
      const innerElVar = `_el${depth + 1}`;
      const innerCf = detectControlFlow(shifted);
      let mapExpr: string;
      if (innerCf === "continue") {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          arrayIterators,
          depth + 1,
          indent + 2,
          "continue",
        );
        mapExpr = `(${srcExpr})?.flatMap((${innerElVar}) => {\n${cfBody}\n${" ".repeat(indent + 2)}}) ?? null`;
      } else if (innerCf === "break") {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          arrayIterators,
          depth + 1,
          indent + 4,
          "break",
        );
        mapExpr = `(() => { const _src = ${srcExpr}; if (_src == null) return null; const _result = []; for (const ${innerElVar} of _src) {\n${cfBody}\n${" ".repeat(indent + 2)}} return _result; })()`;
      } else {
        const innerBody = this.buildElementBody(
          shifted,
          arrayIterators,
          depth + 1,
          indent + 2,
        );
        mapExpr = `(${srcExpr})?.map((${innerElVar}) => (${innerBody})) ?? null`;
      }

      if (!tree.children.has(field)) {
        tree.children.set(field, { children: new Map() });
      }
      tree.children.get(field)!.expr = mapExpr;
    }

    return this.serializeOutputTree(tree, indent);
  }

  /**
   * Build the body of a loop/flatMap callback with break/continue support.
   *
   * For "continue": generates flatMap body that returns [] to skip elements
   * For "break": generates loop body that pushes to _result and breaks
   */
  private buildElementBodyWithControlFlow(
    elemWires: Wire[],
    arrayIterators: Record<string, string>,
    depth: number,
    indent: number,
    mode: "break" | "continue",
  ): string {
    const elVar = `_el${depth}`;
    const pad = " ".repeat(indent);

    // Find the wire with control flow at the current depth level only
    // (not sub-array element wires)
    const controlWire = elemWires.find(
      (w) =>
        w.to.path.length === 1 &&
        (("nullishControl" in w && w.nullishControl != null) ||
          ("falsyControl" in w && w.falsyControl != null) ||
          ("catchControl" in w && w.catchControl != null)),
    );

    if (!controlWire || !("from" in controlWire)) {
      // No control flow found — fall back to simple body
      const body = this.buildElementBody(
        elemWires,
        arrayIterators,
        depth,
        indent,
      );
      if (mode === "continue") {
        return `${pad}  return [${body}];`;
      }
      return `${pad}  _result.push(${body});`;
    }

    // Build the check expression using elementWireToExpr to include fallbacks
    const checkExpr = this.elementWireToExpr(controlWire, elVar);

    // Determine the check type
    const isNullish =
      "nullishControl" in controlWire && controlWire.nullishControl != null;

    if (mode === "continue") {
      if (isNullish) {
        return `${pad}  if (${checkExpr} == null) return [];\n${pad}  return [${this.buildElementBody(elemWires, arrayIterators, depth, indent)}];`;
      }
      // falsyControl
      return `${pad}  if (!${checkExpr}) return [];\n${pad}  return [${this.buildElementBody(elemWires, arrayIterators, depth, indent)}];`;
    }

    // mode === "break"
    if (isNullish) {
      return `${pad}  if (${checkExpr} == null) break;\n${pad}  _result.push(${this.buildElementBody(elemWires, arrayIterators, depth, indent)});`;
    }
    return `${pad}  if (!${checkExpr}) break;\n${pad}  _result.push(${this.buildElementBody(elemWires, arrayIterators, depth, indent)});`;
  }

  // ── Wire → expression ────────────────────────────────────────────────────

  /** Convert a wire to a JavaScript expression string. */
  wireToExpr(w: Wire): string {
    // Constant wire
    if ("value" in w) return emitCoerced(w.value);

    // Pull wire
    if ("from" in w) {
      let expr = this.refToExpr(w.from);
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    // Conditional wire (ternary)
    if ("cond" in w) {
      const condExpr = this.refToExpr(w.cond);
      const thenExpr =
        w.thenRef !== undefined
          ? this.refToExpr(w.thenRef)
          : w.thenValue !== undefined
            ? emitCoerced(w.thenValue)
            : "undefined";
      const elseExpr =
        w.elseRef !== undefined
          ? this.refToExpr(w.elseRef)
          : w.elseValue !== undefined
            ? emitCoerced(w.elseValue)
            : "undefined";
      let expr = `(${condExpr} ? ${thenExpr} : ${elseExpr})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    // Logical AND
    if ("condAnd" in w) {
      const { leftRef, rightRef, rightValue } = w.condAnd;
      const left = this.refToExpr(leftRef);
      let expr: string;
      if (rightRef) expr = `(${left} && ${this.refToExpr(rightRef)})`;
      else if (rightValue !== undefined)
        expr = `(${left} && ${emitCoerced(rightValue)})`;
      else expr = `Boolean(${left})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    // Logical OR
    if ("condOr" in w) {
      const { leftRef, rightRef, rightValue } = w.condOr;
      const left = this.refToExpr(leftRef);
      let expr: string;
      if (rightRef) expr = `(${left} || ${this.refToExpr(rightRef)})`;
      else if (rightValue !== undefined)
        expr = `(${left} || ${emitCoerced(rightValue)})`;
      else expr = `Boolean(${left})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    return "undefined";
  }

  /** Convert an element wire (inside array mapping) to an expression. */
  private elementWireToExpr(w: Wire, elVar = "_el0"): string {
    if ("value" in w) return emitCoerced(w.value);
    if ("from" in w) {
      // Element refs: from.element === true, path = ["srcField"]
      let expr =
        elVar + w.from.path.map((p) => `?.[${JSON.stringify(p)}]`).join("");
      expr = this.applyFallbacks(w, expr);
      return expr;
    }
    return this.wireToExpr(w);
  }

  /** Apply falsy (||), nullish (??) and catch fallback chains to an expression. */
  private applyFallbacks(w: Wire, expr: string): string {
    // Falsy fallback chain (||)
    if ("falsyFallbackRefs" in w && w.falsyFallbackRefs?.length) {
      for (const ref of w.falsyFallbackRefs) {
        expr = `(${expr} || ${this.refToExpr(ref)})`;
      }
    }
    if ("falsyFallback" in w && w.falsyFallback != null) {
      expr = `(${expr} || ${emitCoerced(w.falsyFallback)})`;
    }

    // Nullish coalescing (??)
    if ("nullishFallbackRef" in w && w.nullishFallbackRef) {
      expr = `(${expr} ?? ${this.refToExpr(w.nullishFallbackRef)})`;
    } else if ("nullishFallback" in w && w.nullishFallback != null) {
      expr = `(${expr} ?? ${emitCoerced(w.nullishFallback)})`;
    }

    // Catch fallback — use error flag from catch-guarded tool call
    const errFlag = this.getSourceErrorFlag(w);

    if (hasCatchFallback(w)) {
      let catchExpr: string;
      if ("catchFallbackRef" in w && w.catchFallbackRef) {
        catchExpr = this.refToExpr(w.catchFallbackRef);
      } else if ("catchFallback" in w && w.catchFallback != null) {
        catchExpr = emitCoerced(w.catchFallback);
      } else {
        catchExpr = "undefined";
      }

      if (errFlag) {
        expr = `(${errFlag} !== undefined ? ${catchExpr} : ${expr})`;
      } else {
        // Fallback: wrap in IIFE with try/catch
        expr = `(() => { try { return ${expr}; } catch (_e) { return ${catchExpr}; } })()`;
      }
    } else if (errFlag) {
      // This wire has NO catch fallback but its source tool is catch-guarded by another
      // wire. If the tool failed, re-throw the stored error rather than silently
      // returning undefined — swallowing the error here would be a silent data bug.
      expr = `(${errFlag} !== undefined ? (() => { throw ${errFlag}; })() : ${expr})`;
    }

    return expr;
  }

  /** Get the error flag variable name for a wire's source tool, but ONLY if
   * that tool was compiled in catch-guarded mode (i.e. the `_err` variable exists). */
  private getSourceErrorFlag(w: Wire): string | undefined {
    if (!("from" in w)) return undefined;
    const srcKey = refTrunkKey(w.from);
    if (!this.catchGuardedTools.has(srcKey)) return undefined;
    const tool = this.tools.get(srcKey);
    if (!tool) return undefined;
    return `${tool.varName}_err`;
  }

  // ── NodeRef → expression ──────────────────────────────────────────────────

  /** Convert a NodeRef to a JavaScript expression. */
  private refToExpr(ref: NodeRef): string {
    // Const access: parse the JSON value at runtime, then access path
    if (ref.type === "Const" && ref.field === "const" && ref.path.length > 0) {
      const constName = ref.path[0]!;
      const val = this.constDefs.get(constName);
      if (val != null) {
        const base = emitParsedConst(val);
        if (ref.path.length === 1) return base;
        const tail = ref.path
          .slice(1)
          .map((p) => `?.[${JSON.stringify(p)}]`)
          .join("");
        return `(${base})${tail}`;
      }
    }

    // Self-module input reference
    if (
      ref.module === SELF_MODULE &&
      ref.type === this.bridge.type &&
      ref.field === this.bridge.field &&
      !ref.element
    ) {
      if (ref.path.length === 0) return "input";
      return "input" + ref.path.map((p) => `?.[${JSON.stringify(p)}]`).join("");
    }

    // Tool result reference
    const key = refTrunkKey(ref);
    const varName = this.varMap.get(key);
    if (!varName)
      throw new Error(`Unknown reference: ${key} (${JSON.stringify(ref)})`);
    if (ref.path.length === 0) return varName;
    return varName + ref.path.map((p) => `?.[${JSON.stringify(p)}]`).join("");
  }

  // ── Nested object literal builder ─────────────────────────────────────────

  /**
   * Build a JavaScript object literal from a set of wires.
   * Handles nested paths by creating nested object literals.
   */
  private buildObjectLiteral(
    wires: Wire[],
    getPath: (w: Wire) => string[],
    indent: number,
  ): string {
    if (wires.length === 0) return "{}";

    // Build tree
    interface TreeNode {
      expr?: string;
      children: Map<string, TreeNode>;
    }
    const root: TreeNode = { children: new Map() };

    for (const w of wires) {
      const path = getPath(w);
      if (path.length === 0) return this.wireToExpr(w);
      let current = root;
      for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i]!;
        if (!current.children.has(seg)) {
          current.children.set(seg, { children: new Map() });
        }
        current = current.children.get(seg)!;
      }
      const lastSeg = path[path.length - 1]!;
      if (!current.children.has(lastSeg)) {
        current.children.set(lastSeg, { children: new Map() });
      }
      const node = current.children.get(lastSeg)!;
      if (node.expr != null) {
        node.expr = `(${node.expr} ?? ${this.wireToExpr(w)})`;
      } else {
        node.expr = this.wireToExpr(w);
      }
    }

    return this.serializeTreeNode(root, indent);
  }

  private serializeTreeNode(
    node: {
      children: Map<string, { expr?: string; children: Map<string, unknown> }>;
    },
    indent: number,
  ): string {
    const pad = " ".repeat(indent);
    const entries: string[] = [];

    for (const [key, child] of node.children) {
      if (child.children.size === 0) {
        entries.push(
          `${pad}${JSON.stringify(key)}: ${child.expr ?? "undefined"}`,
        );
      } else if (child.expr != null) {
        entries.push(`${pad}${JSON.stringify(key)}: ${child.expr}`);
      } else {
        const nested = this.serializeTreeNode(child as typeof node, indent + 2);
        entries.push(`${pad}${JSON.stringify(key)}: ${nested}`);
      }
    }

    const innerPad = " ".repeat(indent - 2);
    return `{\n${entries.join(",\n")},\n${innerPad}}`;
  }

  // ── Dependency analysis & topological sort ────────────────────────────────

  /** Get all source trunk keys a wire depends on. */
  private getSourceTrunks(w: Wire): string[] {
    const trunks: string[] = [];
    const collectTrunk = (ref: NodeRef) => trunks.push(refTrunkKey(ref));

    if ("from" in w) {
      collectTrunk(w.from);
      if ("falsyFallbackRefs" in w && w.falsyFallbackRefs)
        w.falsyFallbackRefs.forEach(collectTrunk);
      if ("nullishFallbackRef" in w && w.nullishFallbackRef)
        collectTrunk(w.nullishFallbackRef);
      if ("catchFallbackRef" in w && w.catchFallbackRef)
        collectTrunk(w.catchFallbackRef);
    }
    if ("cond" in w) {
      collectTrunk(w.cond);
      if (w.thenRef) collectTrunk(w.thenRef);
      if (w.elseRef) collectTrunk(w.elseRef);
    }
    if ("condAnd" in w) {
      collectTrunk(w.condAnd.leftRef);
      if (w.condAnd.rightRef) collectTrunk(w.condAnd.rightRef);
    }
    if ("condOr" in w) {
      collectTrunk(w.condOr.leftRef);
      if (w.condOr.rightRef) collectTrunk(w.condOr.rightRef);
    }
    return trunks;
  }

  private topologicalSort(toolWires: Map<string, Wire[]>): string[] {
    // All node keys: tools + define containers
    const toolKeys = [...this.tools.keys()];
    const allKeys = [...toolKeys, ...this.defineContainers];
    const adj = new Map<string, Set<string>>();

    for (const key of allKeys) {
      adj.set(key, new Set());
    }

    // Build adjacency: src → dst edges (deduplicated via Set)
    for (const key of allKeys) {
      const wires = toolWires.get(key) ?? [];
      for (const w of wires) {
        for (const src of this.getSourceTrunks(w)) {
          if (adj.has(src) && src !== key) {
            adj.get(src)!.add(key);
          }
        }
      }
    }

    // Compute in-degree from the adjacency sets (avoids double-counting)
    const inDegree = new Map<string, number>();
    for (const key of allKeys) inDegree.set(key, 0);
    for (const [, neighbors] of adj) {
      for (const n of neighbors) {
        inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    for (const [key, deg] of inDegree) {
      if (deg === 0) queue.push(key);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const node = queue.shift()!;
      sorted.push(node);
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== allKeys.length) {
      throw new Error("Circular dependency detected in tool calls");
    }

    return sorted;
  }
}
