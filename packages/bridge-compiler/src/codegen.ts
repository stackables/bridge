/**
 * AOT code generator — turns a Bridge AST into a standalone JavaScript function.
 *
 * SECURITY NOTE: This entire file is a compiler back-end. Its sole purpose is
 * to transform a fully-parsed, validated Bridge AST into JavaScript source
 * strings. Every template-literal interpolation below assembles *generated
 * code* from deterministic AST walks — no raw external / user input is ever
 * spliced into the output. Security scanners (CodeQL js/code-injection,
 * Semgrep, LGTM) correctly flag dynamic code construction as a pattern worth
 * reviewing; after review the usage here is intentional and safe.
 *
 * lgtm [js/code-injection]
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
import type { SourceLocation } from "@stackables/bridge-types";
import { assertBridgeCompilerCompatible } from "./bridge-asserts.ts";

const SELF_MODULE = "_";

function matchesRequestedFields(
  fieldPath: string,
  requestedFields: string[] | undefined,
): boolean {
  if (!requestedFields || requestedFields.length === 0) return true;

  for (const pattern of requestedFields) {
    if (pattern === fieldPath) return true;

    if (fieldPath.startsWith(pattern + ".")) return true;

    if (pattern.startsWith(fieldPath + ".")) return true;

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (fieldPath.startsWith(prefix + ".")) {
        const rest = fieldPath.slice(prefix.length + 1);
        if (!rest.includes(".")) return true;
      }
      if (fieldPath === prefix) return true;
    }
  }

  return false;
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface CompileOptions {
  /** The operation to compile, e.g. "Query.livingStandard" */
  operation: string;
  /**
   * Sparse fieldset filter — only emit code for the listed output fields.
   * Supports dot-separated paths and a trailing `*` wildcard.
   * Omit or pass an empty array to compile all output fields.
   */
  requestedFields?: string[];
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
      `Invalid operation: "${operation}", expected "Type.field".`,
    );
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);

  const bridge = document.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge)
    throw new Error(`No bridge definition found for operation: ${operation}`);

  assertBridgeCompilerCompatible(bridge);

  // Collect const definitions from the document
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) {
    if (inst.kind === "const") constDefs.set(inst.name, inst.value);
  }

  // Collect tool definitions from the document
  const toolDefs = document.instructions.filter(
    (i): i is ToolDef => i.kind === "tool",
  );

  const ctx = new CodegenContext(
    bridge,
    constDefs,
    toolDefs,
    options.requestedFields,
  );
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

type DetectedControlFlow = {
  kind: "break" | "continue" | "throw" | "panic";
  levels: number;
};

/** Check if any wire in a set has a control flow instruction (break/continue/throw/panic). */
function detectControlFlow(wires: Wire[]): DetectedControlFlow | null {
  for (const w of wires) {
    if ("fallbacks" in w && w.fallbacks) {
      for (const fb of w.fallbacks) {
        if (fb.control) {
          const kind = fb.control.kind as
            | "break"
            | "continue"
            | "throw"
            | "panic";
          const levels =
            kind === "break" || kind === "continue"
              ? Math.max(1, Number((fb.control as any).levels) || 1)
              : 1;
          return { kind, levels };
        }
      }
    }
    if ("catchControl" in w && w.catchControl) {
      const kind = w.catchControl.kind as
        | "break"
        | "continue"
        | "throw"
        | "panic";
      const levels =
        kind === "break" || kind === "continue"
          ? Math.max(1, Number((w.catchControl as any).levels) || 1)
          : 1;
      return { kind, levels };
    }
  }
  return null;
}

/** Check if a wire has a catch control flow instruction. */
function hasCatchControl(w: Wire): boolean {
  return "catchControl" in w && w.catchControl != null;
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
  /** Trunk keys of tools whose inputs depend on element wires (must be inlined in map callbacks). */
  private elementScopedTools = new Set<string>();
  /** Trunk keys of tools that are only referenced in ternary branches (can be lazily evaluated). */
  private ternaryOnlyTools = new Set<string>();
  /** Map from element-scoped non-internal tool trunk key to loop-local variable name.
   *  Populated during array body generation to deduplicate tool calls within one element. */
  private elementLocalVars = new Map<string, string>();
  /** Current element variable name, set during element wire expression generation. */
  private currentElVar: string | undefined;
  /** Stack of active element variables from outermost to innermost array scopes. */
  private elementVarStack: string[] = [];
  /** Map from ToolDef dependency tool name to its emitted variable name.
   *  Populated lazily by emitToolDeps to avoid duplicating calls. */
  private toolDepVars = new Map<string, string>();
  /** Sparse fieldset filter for output wire pruning. */
  private requestedFields: string[] | undefined;
  /** Per tool signature cursor used to assign distinct wire instances to repeated handle bindings. */
  private toolInstanceCursors = new Map<string, number>();
  /** Tool trunk keys declared with `memoize`. */
  private memoizedToolKeys = new Set<string>();

  constructor(
    bridge: Bridge,
    constDefs: Map<string, string>,
    toolDefs: ToolDef[],
    requestedFields?: string[],
  ) {
    this.bridge = bridge;
    this.constDefs = constDefs;
    this.toolDefs = toolDefs;
    this.selfTrunkKey = `${SELF_MODULE}:${bridge.type}:${bridge.field}`;
    this.requestedFields = requestedFields?.length
      ? requestedFields
      : undefined;

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
          const instance = this.findNextInstance(module, refType, fieldName);
          const tk = `${module}:${refType}:${fieldName}:${instance}`;
          const vn = `_t${++this.toolCounter}`;
          this.varMap.set(tk, vn);
          this.tools.set(tk, { trunkKey: tk, toolName: h.name, varName: vn });
          if (h.memoize) {
            this.memoizedToolKeys.add(tk);
          }
          break;
        }
      }
    }

    // Register pipe handles (synthetic tool instances for interpolation,
    // expressions, and explicit pipe operators)
    if (bridge.pipeHandles) {
      // Build handle→fullName map for resolving dotted tool names (e.g. "std.str.toUpperCase")
      const handleToolNames = new Map<string, string>();
      for (const h of bridge.handles) {
        if (h.kind === "tool") handleToolNames.set(h.handle, h.name);
      }

      for (const ph of bridge.pipeHandles) {
        // Use the pipe handle's key directly — it already includes the correct instance
        const tk = ph.key;
        if (!this.tools.has(tk)) {
          const vn = `_t${++this.toolCounter}`;
          this.varMap.set(tk, vn);
          const field = ph.baseTrunk.field;
          // Use the full tool name from the handle binding (e.g. "std.str.toUpperCase")
          // falling back to just the field name for internal/synthetic handles
          const fullToolName = handleToolNames.get(ph.handle) ?? field;
          this.tools.set(tk, {
            trunkKey: tk,
            toolName: fullToolName,
            varName: vn,
          });
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
  private findNextInstance(
    module: string,
    type: string,
    field: string,
  ): number {
    const sig = `${module}:${type}:${field}`;
    const instances: number[] = [];
    for (const w of this.bridge.wires) {
      if (
        w.to.module === module &&
        w.to.type === type &&
        w.to.field === field &&
        w.to.instance != null
      )
        instances.push(w.to.instance);
      if (
        "from" in w &&
        w.from.module === module &&
        w.from.type === type &&
        w.from.field === field &&
        w.from.instance != null
      )
        instances.push(w.from.instance);
    }
    const uniqueInstances = [...new Set(instances)].sort((a, b) => a - b);
    const nextIndex = this.toolInstanceCursors.get(sig) ?? 0;
    this.toolInstanceCursors.set(sig, nextIndex + 1);
    if (uniqueInstances[nextIndex] != null) return uniqueInstances[nextIndex]!;
    const lastInstance = uniqueInstances.at(-1) ?? 0;
    // Some repeated handle bindings are never referenced in wires (for example,
    // an unused shadowed tool alias in a nested loop). In that case we still
    // need a distinct synthetic instance number so later bindings don't collide
    // with earlier tool registrations.
    return lastInstance + (nextIndex - uniqueInstances.length) + 1;
  }

  // ── Main compilation entry point ──────────────────────────────────────────

  compile(): CompileResult {
    const { bridge } = this;
    const fnName = `${bridge.type}_${bridge.field}`;

    // ── Prototype pollution guards ──────────────────────────────────────
    // Validate all wire paths and tool names at compile time, matching the
    // runtime's setNested / pullSingle / lookupToolFn guards.
    const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

    // 1. setNested guard — reject unsafe keys in wire target paths
    for (const w of bridge.wires) {
      for (const seg of w.to.path) {
        if (UNSAFE_KEYS.has(seg))
          throw new Error(`Unsafe assignment key: ${seg}`);
      }
    }

    // 2. pullSingle guard — reject unsafe keys in wire source paths
    for (const w of bridge.wires) {
      const refs: NodeRef[] = [];
      if ("from" in w) refs.push(w.from);
      if ("cond" in w) {
        refs.push(w.cond);
        if (w.thenRef) refs.push(w.thenRef);
        if (w.elseRef) refs.push(w.elseRef);
      }
      if ("condAnd" in w) {
        refs.push(w.condAnd.leftRef);
        if (w.condAnd.rightRef) refs.push(w.condAnd.rightRef);
      }
      if ("condOr" in w) {
        refs.push(w.condOr.leftRef);
        if (w.condOr.rightRef) refs.push(w.condOr.rightRef);
      }
      for (const ref of refs) {
        for (const seg of ref.path) {
          if (UNSAFE_KEYS.has(seg))
            throw new Error(`Unsafe property traversal: ${seg}`);
        }
      }
    }

    // 3. tool lookup guard — reject unsafe segments in dotted tool names
    for (const h of bridge.handles) {
      if (h.kind !== "tool") continue;
      const segments = h.name.split(".");
      for (const seg of segments) {
        if (UNSAFE_KEYS.has(seg))
          throw new Error(
            `No tool found for "${h.name}" — prototype-pollution attempt blocked`,
          );
      }
    }

    // Build a set of force tool trunk keys and their catch behavior
    const forceMap = new Map<string, { catchError?: boolean }>();
    if (bridge.forces) {
      for (const f of bridge.forces) {
        const tk = `${f.module}:${f.type}:${f.field}:${f.instance ?? 1}`;
        forceMap.set(tk, { catchError: f.catchError });
      }
    }

    // Separate wires into tool inputs, define containers, and output
    const allOutputWires: Wire[] = [];
    const toolWires = new Map<string, Wire[]>();
    const defineWires = new Map<string, Wire[]>();

    for (const w of bridge.wires) {
      // Element wires (from array mapping) target the output, not a tool
      const toKey = refTrunkKey(w.to);
      // Output wires target self trunk — including element wires (to.element = true)
      // which produce a key like "_:Type:field:*" instead of "_:Type:field"
      const toTrunkNoElement = w.to.element
        ? `${w.to.module}:${w.to.type}:${w.to.field}`
        : toKey;
      if (toTrunkNoElement === this.selfTrunkKey) {
        allOutputWires.push(w);
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

    // ── Sparse fieldset filtering ──────────────────────────────────────
    // When requestedFields is provided, drop output wires for fields that
    // weren't requested.  Kahn's algorithm will then naturally eliminate
    // tools that only feed into those dropped wires.
    const filteredOutputWires = this.requestedFields
      ? allOutputWires.filter((w) => {
          // Root wires (path length 0) and element wires are always included
          if (w.to.path.length === 0) return true;
          const fieldPath = w.to.path.join(".");
          return matchesRequestedFields(fieldPath, this.requestedFields);
        })
      : allOutputWires;
    const outputWires = this.reorderOverdefinedOutputWires(filteredOutputWires);

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
      if ((hasCatchFallback(w) || hasCatchControl(w)) && "from" in w) {
        const srcKey = refTrunkKey(w.from);
        this.catchGuardedTools.add(srcKey);
      }
    }
    // Also mark tools catch-guarded if referenced by catch-guarded or safe define wires
    for (const [, dwires] of defineWires) {
      for (const w of dwires) {
        const needsCatch =
          hasCatchFallback(w) || hasCatchControl(w) || ("safe" in w && w.safe);
        if (!needsCatch) continue;
        if ("from" in w) {
          const srcKey = refTrunkKey(w.from);
          this.catchGuardedTools.add(srcKey);
        }
        if ("cond" in w) {
          this.catchGuardedTools.add(refTrunkKey(w.cond));
          if (w.thenRef) this.catchGuardedTools.add(refTrunkKey(w.thenRef));
          if (w.elseRef) this.catchGuardedTools.add(refTrunkKey(w.elseRef));
        }
      }
    }

    // Detect element-scoped tools/containers: any node that directly receives
    // element input, or depends on another element-scoped node, must be emitted
    // inside the array callback rather than at the top level.
    const elementScopeEntries = [
      ...toolWires.entries(),
      ...defineWires.entries(),
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [tk, wires] of elementScopeEntries) {
        if (this.elementScopedTools.has(tk)) continue;
        for (const w of wires) {
          if ("from" in w && w.from.element) {
            this.elementScopedTools.add(tk);
            changed = true;
            break;
          }
          if (
            this.getSourceTrunks(w).some((srcKey) =>
              this.elementScopedTools.has(srcKey),
            )
          ) {
            this.elementScopedTools.add(tk);
            changed = true;
            break;
          }
        }
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
    // Layer-based grouping for parallel emission
    const toolLayers = this.topologicalLayers(toolWires);

    // ── Overdefinition bypass analysis ────────────────────────────────────
    // When multiple wires target the same output path ("overdefinition"),
    // the runtime's pull-based model skips later tools if earlier sources
    // resolve non-null.  The compiler replicates this: if a tool's output
    // contributions are ALL in secondary (non-first) position, the tool
    // call is wrapped in a null-check on the prior sources.
    const conditionalTools = this.analyzeOverdefinitionBypass(
      outputWires,
      toolOrder,
      forceMap,
    );

    // ── Lazy ternary analysis ────────────────────────────────────────────
    // Identify tools that are ONLY referenced in ternary branches (thenRef/elseRef)
    // and never in regular pull wires. These can be lazily evaluated inline.
    this.analyzeTernaryOnlyTools(outputWires, toolWires, defineWires, forceMap);

    // Build code lines
    const lines: string[] = [];
    lines.push(`// AOT-compiled bridge: ${bridge.type}.${bridge.field}`);
    lines.push(`// Generated by @stackables/bridge-compiler`);
    lines.push("");
    lines.push(
      `export default async function ${fnName}(input, tools, context, __opts) {`,
    );
    lines.push(
      `  const __BridgePanicError = __opts?.__BridgePanicError ?? class extends Error { constructor(m) { super(m); this.name = "BridgePanicError"; } };`,
    );
    lines.push(
      `  const __BridgeAbortError = __opts?.__BridgeAbortError ?? class extends Error { constructor(m) { super(m ?? "Execution aborted by external signal"); this.name = "BridgeAbortError"; } };`,
    );
    lines.push(
      `  const __BridgeTimeoutError = __opts?.__BridgeTimeoutError ?? class extends Error { constructor(n, ms) { super('Tool "' + n + '" timed out after ' + ms + 'ms'); this.name = "BridgeTimeoutError"; } };`,
    );
    lines.push(
      `  const __BridgeRuntimeError = __opts?.__BridgeRuntimeError ?? class extends Error { constructor(message, options) { super(message, options && "cause" in options ? { cause: options.cause } : undefined); this.name = "BridgeRuntimeError"; this.bridgeLoc = options?.bridgeLoc; } };`,
    );
    lines.push(`  const __signal = __opts?.signal;`);
    lines.push(`  const __timeoutMs = __opts?.toolTimeoutMs ?? 0;`);
    lines.push(
      `  const __ctx = { logger: __opts?.logger ?? {}, signal: __signal };`,
    );
    lines.push(
      `  const __queueMicrotask = globalThis.queueMicrotask ?? ((fn) => Promise.resolve().then(fn));`,
    );
    lines.push(`  const __batchQueues = new Map();`);
    lines.push(`  const __trace = __opts?.__trace;`);
    lines.push(`  function __toolExecutionLogLevel(fn) {`);
    lines.push(`    const log = fn?.bridge?.log;`);
    lines.push(`    if (log === false || log == null) return false;`);
    lines.push(`    if (log === true) return "info";`);
    lines.push(
      `    return log.execution === "info" ? "info" : log.execution ? "debug" : false;`,
    );
    lines.push(`  }`);
    lines.push(`  function __toolErrorLogLevel(fn) {`);
    lines.push(`    const log = fn?.bridge?.log;`);
    lines.push(`    if (log === false) return false;`);
    lines.push(`    if (log == null || log === true) return "error";`);
    lines.push(
      `    return log.errors === false ? false : log.errors === "warn" ? "warn" : "error";`,
    );
    lines.push(`  }`);
    lines.push(`  function __rethrowBridgeError(err, loc) {`);
    lines.push(
      `    if (err?.name === "BridgePanicError") throw __attachBridgeMeta(err, loc);`,
    );
    lines.push(`    if (err?.name === "BridgeAbortError") throw err;`);
    lines.push(
      `    if (err?.name === "BridgeRuntimeError" && err.bridgeLoc !== undefined) throw err;`,
    );
    lines.push(
      `    throw new __BridgeRuntimeError(err instanceof Error ? err.message : String(err), { cause: err, bridgeLoc: loc });`,
    );
    lines.push(`  }`);
    lines.push(`  function __wrapBridgeError(fn, loc) {`);
    lines.push(`    try {`);
    lines.push(`      return fn();`);
    lines.push(`    } catch (err) {`);
    lines.push(`      __rethrowBridgeError(err, loc);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  async function __wrapBridgeErrorAsync(fn, loc) {`);
    lines.push(`    try {`);
    lines.push(`      return await fn();`);
    lines.push(`    } catch (err) {`);
    lines.push(`      __rethrowBridgeError(err, loc);`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(`  function __attachBridgeMeta(err, loc) {`);
    lines.push(
      `    if (err && (typeof err === "object" || typeof err === "function")) {`,
    );
    lines.push(`      if (err.bridgeLoc === undefined) err.bridgeLoc = loc;`);
    lines.push(`    }`);
    lines.push(`    return err;`);
    lines.push(`  }`);
    lines.push(
      `  // Single-segment access is split out to preserve the compiled-path recovery documented in packages/bridge-compiler/performance.md (#2).`,
    );
    lines.push(
      `  function __get(base, segment, accessSafe, allowMissingBase) {`,
    );
    lines.push(`    if (base == null) {`);
    lines.push(`      if (allowMissingBase || accessSafe) return undefined;`);
    lines.push(
      `      throw new TypeError("Cannot read properties of " + base + " (reading '" + segment + "')");`,
    );
    lines.push(`    }`);
    lines.push(`    const next = base[segment];`);
    lines.push(
      `    const isPrimitiveBase = base !== null && typeof base !== "object" && typeof base !== "function";`,
    );
    lines.push(`    if (isPrimitiveBase && next === undefined) {`);
    lines.push(
      `      throw new TypeError("Cannot read properties of " + base + " (reading '" + segment + "')");`,
    );
    lines.push(`    }`);
    lines.push(`    return next;`);
    lines.push(`  }`);
    lines.push(`  function __path(base, path, safe, allowMissingBase) {`);
    lines.push(`    let result = base;`);
    lines.push(`    for (let i = 0; i < path.length; i++) {`);
    lines.push(`      const segment = path[i];`);
    lines.push(`      const accessSafe = safe?.[i] ?? false;`);
    lines.push(`      if (result == null) {`);
    lines.push(`        if ((i === 0 && allowMissingBase) || accessSafe) {`);
    lines.push(`          result = undefined;`);
    lines.push(`          continue;`);
    lines.push(`        }`);
    lines.push(
      `        throw new TypeError("Cannot read properties of " + result + " (reading '" + segment + "')");`,
    );
    lines.push(`      }`);
    lines.push(`      const next = result[segment];`);
    lines.push(
      `      const isPrimitiveBase = result !== null && typeof result !== "object" && typeof result !== "function";`,
    );
    lines.push(`      if (isPrimitiveBase && next === undefined) {`);
    lines.push(
      `        throw new TypeError("Cannot read properties of " + result + " (reading '" + segment + "')");`,
    );
    lines.push(`      }`);
    lines.push(`      result = next;`);
    lines.push(`    }`);
    lines.push(`    return result;`);
    lines.push(`  }`);
    lines.push(`  function __callBatch(fn, input, toolName) {`);
    lines.push(
      `    if (__signal?.aborted) return Promise.reject(new __BridgeAbortError());`,
    );
    lines.push(`    let queue = __batchQueues.get(fn);`);
    lines.push(`    if (!queue) {`);
    lines.push(
      `      queue = { items: [], scheduled: false, toolName, maxBatchSize: typeof fn.bridge?.batch === "object" && fn.bridge?.batch?.maxBatchSize > 0 ? Math.floor(fn.bridge.batch.maxBatchSize) : undefined };`,
    );
    lines.push(`      __batchQueues.set(fn, queue);`);
    lines.push(`    }`);
    lines.push(`    return new Promise((resolve, reject) => {`);
    lines.push(`      queue.items.push({ input, resolve, reject });`);
    lines.push(`      if (queue.scheduled) return;`);
    lines.push(`      queue.scheduled = true;`);
    lines.push(
      `      __queueMicrotask(() => { void __flushBatch(fn, queue); });`,
    );
    lines.push(`    });`);
    lines.push(`  }`);
    lines.push(`  async function __flushBatch(fn, queue) {`);
    lines.push(
      `    const pending = queue.items.splice(0, queue.items.length);`,
    );
    lines.push(`    queue.scheduled = false;`);
    lines.push(`    if (pending.length === 0) return;`);
    lines.push(`    if (__signal?.aborted) {`);
    lines.push(`      const err = new __BridgeAbortError();`);
    lines.push(`      for (const item of pending) item.reject(err);`);
    lines.push(`      return;`);
    lines.push(`    }`);
    lines.push(
      `    const chunkSize = queue.maxBatchSize && queue.maxBatchSize > 0 ? queue.maxBatchSize : pending.length;`,
    );
    lines.push(
      `    for (let start = 0; start < pending.length; start += chunkSize) {`,
    );
    lines.push(`      const chunk = pending.slice(start, start + chunkSize);`);
    lines.push(`      const inputs = chunk.map((item) => item.input);`);
    lines.push(
      `      const startTime = (__trace || __ctx.logger) ? performance.now() : 0;`,
    );
    lines.push(`      try {`);
    lines.push(`        const batchPromise = fn(inputs, __ctx);`);
    lines.push(`        let result;`);
    lines.push(
      `        if (__timeoutMs > 0 && batchPromise && typeof batchPromise.then === "function") {`,
    );
    lines.push(
      `          let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new __BridgeTimeoutError(queue.toolName, __timeoutMs)), __timeoutMs); });`,
    );
    lines.push(
      `          try { result = await Promise.race([batchPromise, timeout]); } finally { clearTimeout(t); }`,
    );
    lines.push(`        } else {`);
    lines.push(`          result = await batchPromise;`);
    lines.push(`        }`);
    lines.push(
      `        if (__trace) __trace(queue.toolName, startTime, performance.now(), inputs, result, null);`,
    );
    lines.push(`        const __execLevel = __toolExecutionLogLevel(fn);`);
    lines.push(
      `        if (__execLevel) __ctx.logger?.[__execLevel]?.({ tool: queue.toolName, fn: queue.toolName, durationMs: Math.round((performance.now() - startTime) * 1000) / 1000 }, "[bridge] tool completed");`,
    );
    lines.push(
      `        if (!Array.isArray(result)) throw new Error('Batch tool "' + queue.toolName + '" must return an array of results');`,
    );
    lines.push(
      `        if (result.length !== chunk.length) throw new Error('Batch tool "' + queue.toolName + '" returned ' + result.length + ' results for ' + chunk.length + ' queued calls');`,
    );
    lines.push(
      `        for (let i = 0; i < chunk.length; i++) { const value = result[i]; if (value instanceof Error) chunk[i].reject(value); else chunk[i].resolve(value); }`,
    );
    lines.push(`      } catch (err) {`);
    lines.push(
      `        if (__trace) __trace(queue.toolName, startTime, performance.now(), inputs, null, err);`,
    );
    lines.push(`        const __errorLevel = __toolErrorLogLevel(fn);`);
    lines.push(
      `        if (__errorLevel) __ctx.logger?.[__errorLevel]?.({ tool: queue.toolName, fn: queue.toolName, err: err instanceof Error ? err.message : String(err) }, "[bridge] tool failed");`,
    );
    lines.push(`        for (const item of chunk) item.reject(err);`);
    lines.push(`      }`);
    lines.push(`    }`);
    lines.push(`  }`);
    // Sync tool caller — no await, no timeout, enforces no-promise return.
    lines.push(`  function __callSync(fn, input, toolName) {`);
    lines.push(`    if (__signal?.aborted) throw new __BridgeAbortError();`);
    lines.push(`    const start = __trace ? performance.now() : 0;`);
    lines.push(`    try {`);
    lines.push(`      const result = fn(input, __ctx);`);
    lines.push(
      `      if (result && typeof result.then === "function") throw new Error("Tool \\"" + toolName + "\\" declared {sync:true} but returned a Promise");`,
    );
    lines.push(
      `      if (__trace) __trace(toolName, start, performance.now(), input, result, null);`,
    );
    lines.push(`      const __execLevel = __toolExecutionLogLevel(fn);`);
    lines.push(
      `      if (__execLevel) __ctx.logger?.[__execLevel]?.({ tool: toolName, fn: toolName, durationMs: Math.round((performance.now() - start) * 1000) / 1000 }, "[bridge] tool completed");`,
    );
    lines.push(`      return result;`);
    lines.push(`    } catch (err) {`);
    lines.push(
      `      if (__trace) __trace(toolName, start, performance.now(), input, null, err);`,
    );
    lines.push(`      const __errorLevel = __toolErrorLogLevel(fn);`);
    lines.push(
      `      if (__errorLevel) __ctx.logger?.[__errorLevel]?.({ tool: toolName, fn: toolName, err: err instanceof Error ? err.message : String(err) }, "[bridge] tool failed");`,
    );
    lines.push(`      throw err;`);
    lines.push(`    }`);
    lines.push(`  }`);
    lines.push(
      `  const __isLoopCtrl = (v) => (v?.__bridgeControl === "break" || v?.__bridgeControl === "continue") && Number.isInteger(v?.levels) && v.levels > 0;`,
    );
    lines.push(
      `  const __nextLoopCtrl = (v) => ({ __bridgeControl: v.__bridgeControl, levels: v.levels - 1 });`,
    );
    // Async tool caller — full promise handling with optional timeout.
    lines.push(`  async function __call(fn, input, toolName) {`);
    lines.push(`    if (__signal?.aborted) throw new __BridgeAbortError();`);
    lines.push(`    const start = __trace ? performance.now() : 0;`);
    lines.push(`    try {`);
    lines.push(`      const p = fn(input, __ctx);`);
    lines.push(`      let result;`);
    lines.push(`      if (__timeoutMs > 0) {`);
    lines.push(
      `        let t; const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new __BridgeTimeoutError(toolName, __timeoutMs)), __timeoutMs); });`,
    );
    lines.push(
      `        try { result = await Promise.race([p, timeout]); } finally { clearTimeout(t); }`,
    );
    lines.push(`      } else {`);
    lines.push(`        result = await p;`);
    lines.push(`      }`);
    lines.push(
      `      if (__trace) __trace(toolName, start, performance.now(), input, result, null);`,
    );
    lines.push(`      const __execLevel = __toolExecutionLogLevel(fn);`);
    lines.push(
      `      if (__execLevel) __ctx.logger?.[__execLevel]?.({ tool: toolName, fn: toolName, durationMs: Math.round((performance.now() - start) * 1000) / 1000 }, "[bridge] tool completed");`,
    );
    lines.push(`      return result;`);
    lines.push(`    } catch (err) {`);
    lines.push(
      `      if (__trace) __trace(toolName, start, performance.now(), input, null, err);`,
    );
    lines.push(`      const __errorLevel = __toolErrorLogLevel(fn);`);
    lines.push(
      `      if (__errorLevel) __ctx.logger?.[__errorLevel]?.({ tool: toolName, fn: toolName, err: err instanceof Error ? err.message : String(err) }, "[bridge] tool failed");`,
    );
    lines.push(`      throw err;`);
    lines.push(`    }`);
    lines.push(`  }`);
    if (this.memoizedToolKeys.size > 0) {
      lines.push(`  const __toolMemoCache = new Map();`);
      lines.push(`  function __stableMemoizeKey(value) {`);
      lines.push(`    if (value === undefined) return "undefined";`);
      lines.push('    if (typeof value === "bigint") return `${value}n`;');
      lines.push(
        `    if (value === null || typeof value !== "object") { const serialized = JSON.stringify(value); return serialized ?? String(value); }`,
      );
      lines.push(`    if (Array.isArray(value)) {`);
      lines.push(
        '      return `[${value.map((item) => __stableMemoizeKey(item)).join(",")}]`;',
      );
      lines.push(`    }`);
      lines.push(
        `    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));`,
      );
      lines.push(
        '    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${__stableMemoizeKey(entryValue)}`).join(",")}}`;',
      );
      lines.push(`  }`);
      lines.push(
        `  function __callMemoized(fn, input, toolName, memoizeKey) {`,
      );
      lines.push(`    let toolCache = __toolMemoCache.get(memoizeKey);`);
      lines.push(`    if (!toolCache) {`);
      lines.push(`      toolCache = new Map();`);
      lines.push(`      __toolMemoCache.set(memoizeKey, toolCache);`);
      lines.push(`    }`);
      lines.push(`    const cacheKey = __stableMemoizeKey(input);`);
      lines.push(`    const cached = toolCache.get(cacheKey);`);
      lines.push(`    if (cached !== undefined) return cached;`);
      lines.push(`    try {`);
      lines.push(
        `      const result = fn.bridge?.batch ? __callBatch(fn, input, toolName) : fn.bridge?.sync ? __callSync(fn, input, toolName) : __call(fn, input, toolName);`,
      );
      lines.push(`      if (result && typeof result.then === "function") {`);
      lines.push(
        `        const pending = Promise.resolve(result).catch((error) => {`,
      );
      lines.push(`          toolCache.delete(cacheKey);`);
      lines.push(`          throw error;`);
      lines.push(`        });`);
      lines.push(`        toolCache.set(cacheKey, pending);`);
      lines.push(`        return pending;`);
      lines.push(`      }`);
      lines.push(`      toolCache.set(cacheKey, result);`);
      lines.push(`      return result;`);
      lines.push(`    } catch (error) {`);
      lines.push(`      toolCache.delete(cacheKey);`);
      lines.push(`      throw error;`);
      lines.push(`    }`);
      lines.push(`  }`);
    }

    // ── Dead tool detection ────────────────────────────────────────────
    // Detect which tools are reachable from the (possibly filtered) output
    // wires.  Uses a backward reachability analysis: start from tools
    // referenced in output wires, then transitively follow tool-input
    // wires to discover all upstream dependencies.  Tools not in the
    // reachable set are dead code and can be skipped.

    /**
     * Extract all tool trunk keys referenced as **sources** in a set of
     * wires.  A "source key" is the trunk key of a node that feeds data
     * into a wire (the right-hand side of `target <- source`).  This
     * includes pull refs, ternary branches, condAnd/condOr operands,
     * and all fallback refs.  Used by the backward reachability analysis
     * to discover which tools are transitively needed by the output.
     */
    const collectSourceKeys = (wires: Wire[]): Set<string> => {
      const keys = new Set<string>();
      for (const w of wires) {
        if ("from" in w) keys.add(refTrunkKey(w.from));
        if ("cond" in w) {
          keys.add(refTrunkKey(w.cond));
          if (w.thenRef) keys.add(refTrunkKey(w.thenRef));
          if (w.elseRef) keys.add(refTrunkKey(w.elseRef));
        }
        if ("condAnd" in w) {
          keys.add(refTrunkKey(w.condAnd.leftRef));
          if (w.condAnd.rightRef) keys.add(refTrunkKey(w.condAnd.rightRef));
        }
        if ("condOr" in w) {
          keys.add(refTrunkKey(w.condOr.leftRef));
          if (w.condOr.rightRef) keys.add(refTrunkKey(w.condOr.rightRef));
        }
        if ("fallbacks" in w && w.fallbacks) {
          for (const fb of w.fallbacks) {
            if (fb.ref) keys.add(refTrunkKey(fb.ref));
          }
        }
        if ("catchFallbackRef" in w && w.catchFallbackRef) {
          keys.add(refTrunkKey(w.catchFallbackRef));
        }
      }
      return keys;
    };

    // Seed: tools directly referenced by output wires + forced tools
    const referencedToolKeys = collectSourceKeys(outputWires);
    for (const tk of forceMap.keys()) referencedToolKeys.add(tk);

    // Transitive closure: walk backward through tool input wires
    const visited = new Set<string>();
    const queue = [...referencedToolKeys];
    while (queue.length > 0) {
      const tk = queue.pop()!;
      if (visited.has(tk)) continue;
      visited.add(tk);
      const deps = toolWires.get(tk);
      if (!deps) continue;
      for (const key of collectSourceKeys(deps)) {
        if (!visited.has(key)) {
          referencedToolKeys.add(key);
          queue.push(key);
        }
      }
    }

    // Emit tool calls and define container assignments
    // Tools in the same topological layer have no mutual dependencies and
    // can execute in parallel — we emit them as a single Promise.all().
    for (const layer of toolLayers) {
      // Classify tools in this layer
      const parallelBatch: { tk: string; tool: ToolInfo; wires: Wire[] }[] = [];
      const sequentialKeys: string[] = [];

      for (const tk of layer) {
        if (this.elementScopedTools.has(tk)) continue;
        if (this.ternaryOnlyTools.has(tk)) continue;
        if (
          !referencedToolKeys.has(tk) &&
          !forceMap.has(tk) &&
          !this.defineContainers.has(tk)
        )
          continue;

        if (this.isParallelizableTool(tk, conditionalTools, forceMap)) {
          const tool = this.tools.get(tk)!;
          const wires = toolWires.get(tk) ?? [];
          parallelBatch.push({ tk, tool, wires });
        } else {
          sequentialKeys.push(tk);
        }
      }

      // Emit parallelizable tools first so their variables are in scope when
      // sequential tools (which may have bypass conditions referencing them) run.
      if (parallelBatch.length === 1) {
        const { tool, wires } = parallelBatch[0]!;
        this.emitToolCall(lines, tool, wires, "normal");
      } else if (parallelBatch.length > 1) {
        const varNames = parallelBatch
          .map(({ tool }) => tool.varName)
          .join(", ");
        lines.push(`  const [${varNames}] = await Promise.all([`);
        for (const { tool, wires } of parallelBatch) {
          const callExpr = this.buildNormalCallExpr(tool, wires);
          lines.push(`    ${callExpr},`);
        }
        lines.push(`  ]);`);
      }

      // Emit sequential (complex) tools one by one — same logic as before
      for (const tk of sequentialKeys) {
        if (this.defineContainers.has(tk)) {
          const wires = defineWires.get(tk) ?? [];
          const varName = this.varMap.get(tk)!;
          if (wires.length === 0) {
            lines.push(`  const ${varName} = undefined;`);
          } else if (wires.length === 1 && wires[0]!.to.path.length === 0) {
            const w = wires[0]!;
            let expr = this.wireToExpr(w);
            if ("safe" in w && w.safe) {
              const errFlags: string[] = [];
              const wAny = w as any;
              if (wAny.from) {
                const ef = this.getSourceErrorFlag(w);
                if (ef) errFlags.push(ef);
              }
              if (wAny.cond) {
                const condEf = this.getErrorFlagForRef(wAny.cond);
                if (condEf) errFlags.push(condEf);
                if (wAny.thenRef) {
                  const ef = this.getErrorFlagForRef(wAny.thenRef);
                  if (ef) errFlags.push(ef);
                }
                if (wAny.elseRef) {
                  const ef = this.getErrorFlagForRef(wAny.elseRef);
                  if (ef) errFlags.push(ef);
                }
              }
              if (errFlags.length > 0) {
                const errCheck = errFlags
                  .map((f) => `${f} !== undefined`)
                  .join(" || ");
                expr = `(${errCheck} ? undefined : ${expr})`;
              }
            }
            lines.push(`  const ${varName} = ${expr};`);
          } else {
            const inputObj = this.buildObjectLiteral(
              wires,
              (w) => w.to.path,
              4,
            );
            lines.push(`  const ${varName} = ${inputObj};`);
          }
          continue;
        }
        const tool = this.tools.get(tk)!;
        const wires = toolWires.get(tk) ?? [];
        const forceInfo = forceMap.get(tk);
        const bypass = conditionalTools.get(tk);
        if (bypass && !forceInfo && !this.catchGuardedTools.has(tk)) {
          const condition = bypass.checkExprs
            .map((expr) => `(${expr}) == null`)
            .join(" || ");
          lines.push(`  let ${tool.varName};`);
          lines.push(`  if (${condition}) {`);
          const buf: string[] = [];
          this.emitToolCall(buf, tool, wires, "normal");
          for (const line of buf) {
            lines.push(
              "  " +
                line.replace(`const ${tool.varName} = `, `${tool.varName} = `),
            );
          }
          lines.push(`  }`);
        } else if (forceInfo?.catchError) {
          this.emitToolCall(lines, tool, wires, "fire-and-forget");
        } else if (this.catchGuardedTools.has(tk)) {
          this.emitToolCall(lines, tool, wires, "catch-guarded");
        } else {
          this.emitToolCall(lines, tool, wires, "normal");
        }
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
   * Generate a tool call expression that uses __callSync for sync tools at runtime,
   * falling back to `await __call` for async tools. Used at individual call sites.
   */
  private syncAwareCall(
    fnName: string,
    inputObj: string,
    memoizeTrunkKey?: string,
  ): string {
    const fn = `tools[${JSON.stringify(fnName)}]`;
    const name = JSON.stringify(fnName);
    if (memoizeTrunkKey && this.memoizedToolKeys.has(memoizeTrunkKey)) {
      return `await __callMemoized(${fn}, ${inputObj}, ${name}, ${JSON.stringify(memoizeTrunkKey)})`;
    }
    return `(${fn}.bridge?.batch ? await __callBatch(${fn}, ${inputObj}, ${name}) : ${fn}.bridge?.sync ? __callSync(${fn}, ${inputObj}, ${name}) : await __call(${fn}, ${inputObj}, ${name}))`;
  }

  /**
   * Same as syncAwareCall but without await — for use inside Promise.all() and
   * in sync array map bodies.  Returns a value for sync tools, a Promise for async.
   */
  private syncAwareCallNoAwait(
    fnName: string,
    inputObj: string,
    memoizeTrunkKey?: string,
  ): string {
    const fn = `tools[${JSON.stringify(fnName)}]`;
    const name = JSON.stringify(fnName);
    if (memoizeTrunkKey && this.memoizedToolKeys.has(memoizeTrunkKey)) {
      return `__callMemoized(${fn}, ${inputObj}, ${name}, ${JSON.stringify(memoizeTrunkKey)})`;
    }
    return `(${fn}.bridge?.batch ? __callBatch(${fn}, ${inputObj}, ${name}) : ${fn}.bridge?.sync ? __callSync(${fn}, ${inputObj}, ${name}) : __call(${fn}, ${inputObj}, ${name}))`;
  }

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
          `  try { ${this.syncAwareCall(tool.toolName, inputObj, tool.trunkKey)}; } catch (_e) {}`,
        );
        lines.push(`  const ${tool.varName} = undefined;`);
      } else if (mode === "catch-guarded") {
        // Catch-guarded: store result AND the actual error so unguarded wires can re-throw.
        lines.push(`  let ${tool.varName}, ${tool.varName}_err;`);
        lines.push(
          `  try { ${tool.varName} = ${this.syncAwareCall(tool.toolName, inputObj, tool.trunkKey)}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; ${tool.varName}_err = _e; }`,
        );
      } else {
        lines.push(
          `  const ${tool.varName} = ${this.syncAwareCall(tool.toolName, inputObj, tool.trunkKey)};`,
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

    // Emit ToolDef-level tool dependency calls (e.g. `with authService as auth`)
    // These must be emitted before building the input so their vars are in scope.
    this.emitToolDeps(lines, toolDef);

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
    let spreadExprForToolDef: string | undefined;
    for (const bw of bridgeWires) {
      const path = bw.to.path;
      if (path.length === 0) {
        // Spread wire: ...sourceExpr — captures all fields from source
        spreadExprForToolDef = this.wireToExpr(bw);
      } else if (path.length >= 1) {
        const key = path[0]!;
        inputEntries.set(
          key,
          `    ${JSON.stringify(key)}: ${this.wireToExpr(bw)}`,
        );
      }
    }

    const inputParts = [...inputEntries.values()];

    let inputObj: string;
    if (spreadExprForToolDef !== undefined) {
      // Spread wire present: { ...spreadExpr, field1: ..., field2: ... }
      const spreadEntry = `    ...${spreadExprForToolDef}`;
      const allParts = [spreadEntry, ...inputParts];
      inputObj = `{\n${allParts.join(",\n")},\n  }`;
    } else {
      inputObj =
        inputParts.length > 0 ? `{\n${inputParts.join(",\n")},\n  }` : "{}";
    }

    if (onErrorWire) {
      // Wrap in try/catch for onError
      lines.push(`  let ${tool.varName};`);
      lines.push(`  try {`);
      lines.push(
        `    ${tool.varName} = ${this.syncAwareCall(fnName, inputObj, tool.trunkKey)};`,
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
        `  try { ${this.syncAwareCall(fnName, inputObj, tool.trunkKey)}; } catch (_e) {}`,
      );
      lines.push(`  const ${tool.varName} = undefined;`);
    } else if (mode === "catch-guarded") {
      // Catch-guarded: store result AND the actual error so unguarded wires can re-throw.
      lines.push(`  let ${tool.varName}, ${tool.varName}_err;`);
      lines.push(
        `  try { ${tool.varName} = ${this.syncAwareCall(fnName, inputObj, tool.trunkKey)}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; ${tool.varName}_err = _e; }`,
      );
    } else {
      lines.push(
        `  const ${tool.varName} = ${this.syncAwareCall(fnName, inputObj, tool.trunkKey)};`,
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
          `  const ${tool.varName} = ${this.syncAwareCall(tool.toolName, inputObj, tool.trunkKey)};`,
        );
        return;
      }
    }

    lines.push(`  const ${tool.varName} = ${expr};`);
  }

  /**
   * Emit ToolDef-level dependency tool calls.
   *
   * When a ToolDef declares `with authService as auth`, the auth handle
   * references a separate tool that must be called before the main tool.
   * This method recursively resolves the dependency chain, emitting calls
   * in dependency order. Independent deps are parallelized with Promise.all.
   *
   * Results are cached in `toolDepVars` so each dep is called at most once.
   */
  private emitToolDeps(lines: string[], toolDef: ToolDef): void {
    // Collect tool-kind deps that haven't been emitted yet
    const pendingDeps: { handle: string; toolName: string }[] = [];
    for (const dep of toolDef.deps) {
      if (dep.kind === "tool" && !this.toolDepVars.has(dep.tool)) {
        pendingDeps.push({ handle: dep.handle, toolName: dep.tool });
      }
    }
    if (pendingDeps.length === 0) return;

    // Recursively emit transitive deps first
    for (const pd of pendingDeps) {
      const depToolDef = this.resolveToolDef(pd.toolName);
      if (depToolDef) {
        this.emitToolDeps(lines, depToolDef);
      }
    }

    // Now emit the current level deps — only the ones still not emitted
    const toEmit = pendingDeps.filter(
      (pd) => !this.toolDepVars.has(pd.toolName),
    );
    if (toEmit.length === 0) return;

    // Build call expressions for each dep
    const depCalls: { toolName: string; varName: string; callExpr: string }[] =
      [];
    for (const pd of toEmit) {
      const depToolDef = this.resolveToolDef(pd.toolName);
      if (!depToolDef) continue;

      const fnName = depToolDef.fn ?? pd.toolName;
      const varName = `_td${++this.toolCounter}`;

      // Build input from the dep's ToolDef wires
      const inputParts: string[] = [];

      // Constant wires
      for (const tw of depToolDef.wires) {
        if (tw.kind === "constant") {
          inputParts.push(
            `      ${JSON.stringify(tw.target)}: ${emitCoerced(tw.value)}`,
          );
        }
      }

      // Pull wires — resolved from the dep's own deps
      for (const tw of depToolDef.wires) {
        if (tw.kind === "pull") {
          const expr = this.resolveToolDepSource(tw.source, depToolDef);
          inputParts.push(`      ${JSON.stringify(tw.target)}: ${expr}`);
        }
      }

      const inputObj =
        inputParts.length > 0 ? `{\n${inputParts.join(",\n")},\n    }` : "{}";

      // Build call expression (without `const X = await`)
      const callExpr = this.syncAwareCallNoAwait(fnName, inputObj);

      depCalls.push({ toolName: pd.toolName, varName, callExpr });
      this.toolDepVars.set(pd.toolName, varName);
    }

    if (depCalls.length === 0) return;

    if (depCalls.length === 1) {
      const dc = depCalls[0]!;
      lines.push(`  const ${dc.varName} = await ${dc.callExpr};`);
    } else {
      // Parallel: independent deps resolve concurrently
      const varNames = depCalls.map((dc) => dc.varName).join(", ");
      lines.push(`  const [${varNames}] = await Promise.all([`);
      for (const dc of depCalls) {
        lines.push(`    ${dc.callExpr},`);
      }
      lines.push(`  ]);`);
    }
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
            .map((p) => `[${JSON.stringify(p)}]`)
            .join("");
          return `(${base})${tail}`;
        }
      }
      return "undefined";
    } else if (dep.kind === "tool") {
      // Tool dependency — first check ToolDef-level dep vars (emitted by emitToolDeps),
      // then fall back to bridge-level tool handles
      const depVar = this.toolDepVars.get(dep.tool);
      if (depVar) {
        baseExpr = depVar;
      } else {
        const depToolInfo = this.findToolByName(dep.tool);
        if (depToolInfo) {
          baseExpr = depToolInfo.varName;
        } else {
          return "undefined";
        }
      }
    } else {
      return "undefined";
    }

    if (restPath.length === 0) return baseExpr;
    return baseExpr + restPath.map((p) => `[${JSON.stringify(p)}]`).join("");
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
      // Match the runtime's error when no wires target the output
      const { type, field } = this.bridge;
      const hasForce = this.bridge.forces && this.bridge.forces.length > 0;
      if (!hasForce) {
        lines.push(
          `  throw new Error(${JSON.stringify(`Bridge "${type}.${field}" has no output wires. Ensure at least one wire targets the output (e.g. \`o.field <- ...\`).`)});`,
        );
      } else {
        lines.push("  return {};");
      }
      return;
    }

    // Detect array iterators
    const arrayIterators = this.bridge.arrayIterators ?? {};
    const isRootArray = "" in arrayIterators;

    // Separate root wires into passthrough vs spread
    const rootWires = outputWires.filter((w) => w.to.path.length === 0);
    const spreadRootWires = rootWires.filter(
      (w) => "from" in w && "spread" in w && w.spread,
    );
    const passthroughRootWire = rootWires.find(
      (w) => !("from" in w && "spread" in w && w.spread),
    );

    // Passthrough (non-spread root wire) — return directly
    if (passthroughRootWire && !isRootArray) {
      lines.push(`  return ${this.wireToExpr(passthroughRootWire)};`);
      return;
    }

    // Check for root passthrough (wire with empty path) — but not if it's a root array source
    const rootWire = rootWires[0]; // for backwards compat with array handling below

    // Handle root array output (o <- src.items[] as item { ... })
    if (isRootArray && rootWire) {
      const elemWires = outputWires.filter(
        (w) => w !== rootWire && w.to.path.length > 0,
      );
      const dispatchIndexExpr = rootWire.dispatchIndexRef
        ? this.refToExprInElementScope(rootWire.dispatchIndexRef, "_el0")
        : undefined;
      let arrayExpr = this.wireToExpr(rootWire);
      // Check for catch control on root wire (e.g., `catch continue` returns [])
      const rootCatchCtrl =
        "catchControl" in rootWire ? rootWire.catchControl : undefined;
      if (
        rootCatchCtrl &&
        (rootCatchCtrl.kind === "continue" || rootCatchCtrl.kind === "break")
      ) {
        arrayExpr = `await (async () => { try { return ${arrayExpr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; return null; } })()`;
      }
      // Only check control flow on direct element wires, not sub-array element wires
      const directElemWires = elemWires.filter((w) => w.to.path.length === 1);
      const currentScopeElemWires = this.filterCurrentElementWires(
        elemWires,
        arrayIterators,
      );
      const cf = detectControlFlow(directElemWires);
      const anyCf = detectControlFlow(elemWires);
      const requiresLabeledLoop = !cf && !!anyCf && anyCf.levels > 1;
      // Check if any element wire generates `await` (element-scoped tools or catch fallbacks)
      const needsAsync = elemWires.some((w) => this.wireNeedsAwait(w));

      if (needsAsync) {
        // Check if async is only from element-scoped tools (no catch fallbacks).
        // If so, generate a dual sync/async path with a runtime check.
        const canDualPath =
          !cf && !requiresLabeledLoop && this.asyncOnlyFromTools(elemWires);
        const toolRefs = canDualPath
          ? this.collectElementToolRefs(currentScopeElemWires)
          : [];
        const hasDualPath = canDualPath && toolRefs.length > 0;

        if (hasDualPath) {
          // ── Dual path: sync .map() when all element tools are sync ──
          const syncCheck = toolRefs
            .map((r) => `${r}.bridge?.sync`)
            .join(" && ");

          // Sync branch — .map() with __callSync
          const syncPreamble: string[] = [];
          this.elementLocalVars.clear();
          this.collectElementPreamble(
            currentScopeElemWires,
            "_el0",
            syncPreamble,
            true,
          );
          const syncBody = this.buildElementBody(
            elemWires,
            arrayIterators,
            0,
            6,
          );
          lines.push(`  if (${syncCheck}) {`);
          if (syncPreamble.length > 0) {
            lines.push(
              `    return (${arrayExpr} ?? []).map((_el0) => { ${syncPreamble.join(" ")} return ${syncBody}; });`,
            );
          } else {
            lines.push(
              `    return (${arrayExpr} ?? []).map((_el0) => (${syncBody}));`,
            );
          }
          lines.push(`  }`);
          this.elementLocalVars.clear();
        }

        // Async branch — Promise.all over async element callbacks so batched
        // tool calls can coalesce before the first microtask flush. Control
        // flow still requires an explicit loop.
        const preambleLines: string[] = [];
        this.elementLocalVars.clear();
        this.collectElementPreamble(
          currentScopeElemWires,
          "_el0",
          preambleLines,
        );

        if (
          cf?.kind === "break" ||
          cf?.kind === "continue" ||
          requiresLabeledLoop
        ) {
          const body = cf
            ? this.buildElementBodyWithControlFlow(
                elemWires,
                arrayIterators,
                0,
                4,
                cf.kind === "continue" ? "for-continue" : "break",
                dispatchIndexExpr,
              )
            : dispatchIndexExpr
              ? `    _result[${dispatchIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, 0, 4)};`
              : `    _result.push(${this.buildElementBody(elemWires, arrayIterators, 0, 4)});`;

          lines.push(`  const _result = [];`);
          lines.push(`  __loop0: for (const _el0 of (${arrayExpr} ?? [])) {`);
          lines.push(`    try {`);
          for (const pl of preambleLines) {
            lines.push(`      ${pl}`);
          }
          lines.push(`    ${body.trimStart()}`);
          lines.push(`    } catch (_ctrl) {`);
          lines.push(
            `      if (__isLoopCtrl(_ctrl)) { if (_ctrl.levels > 1) throw __nextLoopCtrl(_ctrl); if (_ctrl.__bridgeControl === "break") break; continue; }`,
          );
          lines.push(`      throw _ctrl;`);
          lines.push(`    }`);
          lines.push(`  }`);
          lines.push(`  return _result;`);
        } else if (!dispatchIndexExpr) {
          lines.push(
            `  return await Promise.all((${arrayExpr} ?? []).map(async (_el0) => {`,
          );
          for (const pl of preambleLines) {
            lines.push(`    ${pl}`);
          }
          lines.push(
            `    return ${this.buildElementBody(elemWires, arrayIterators, 0, 4)};`,
          );
          lines.push(`  }));`);
        } else {
          lines.push(`  const _result = [];`);
          lines.push(`  for (const _el0 of (${arrayExpr} ?? [])) {`);
          for (const pl of preambleLines) {
            lines.push(`    ${pl}`);
          }
          lines.push(
            `    _result[${dispatchIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, 0, 4)};`,
          );
          lines.push(`  }`);
          lines.push(`  return _result;`);
        }
        this.elementLocalVars.clear();
      } else if (cf?.kind === "continue" && cf.levels === 1) {
        // Use flatMap — skip elements that trigger continue (sync only)
        const body = this.buildElementBodyWithControlFlow(
          elemWires,
          arrayIterators,
          0,
          4,
          "continue",
        );
        if (!dispatchIndexExpr) {
          lines.push(`  return (${arrayExpr} ?? []).flatMap((_el0) => {`);
          lines.push(body);
          lines.push(`  });`);
        } else {
          lines.push(`  const _result = [];`);
          lines.push(`  for (const _el0 of (${arrayExpr} ?? [])) {`);
          lines.push(`    const _entry = (() => {`);
          lines.push(body.replace(/^[ ]{4}/gm, "      "));
          lines.push(`    })();`);
          lines.push(`    if (Array.isArray(_entry) && _entry.length > 0) {`);
          lines.push(`      _result[${dispatchIndexExpr}] = _entry[0];`);
          lines.push(`    }`);
          lines.push(`  }`);
          lines.push(`  return _result;`);
        }
      } else if (
        cf?.kind === "break" ||
        cf?.kind === "continue" ||
        requiresLabeledLoop
      ) {
        // Use an explicit loop for:
        // - direct break/continue control
        // - nested multilevel control (e.g. break 2 / continue 2) that must
        //   escape from sub-array IIFEs through throw/catch propagation.
        // Use a loop with early break (sync)
        const body = cf
          ? this.buildElementBodyWithControlFlow(
              elemWires,
              arrayIterators,
              0,
              4,
              cf.kind === "continue" ? "for-continue" : "break",
              dispatchIndexExpr,
            )
          : dispatchIndexExpr
            ? `    _result[${dispatchIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, 0, 4)};`
            : `    _result.push(${this.buildElementBody(elemWires, arrayIterators, 0, 4)});`;
        lines.push(`  const _result = [];`);
        lines.push(`  __loop0: for (const _el0 of (${arrayExpr} ?? [])) {`);
        lines.push(`    try {`);
        lines.push(`    ${body.trimStart()}`);
        lines.push(`    } catch (_ctrl) {`);
        lines.push(
          `      if (__isLoopCtrl(_ctrl)) { if (_ctrl.levels > 1) throw __nextLoopCtrl(_ctrl); if (_ctrl.__bridgeControl === "break") break; continue; }`,
        );
        lines.push(`      throw _ctrl;`);
        lines.push(`    }`);
        lines.push(`  }`);
        lines.push(`  return _result;`);
      } else {
        const body = this.buildElementBody(elemWires, arrayIterators, 0, 4);
        if (!dispatchIndexExpr) {
          lines.push(`  return (${arrayExpr} ?? []).map((_el0) => (${body}));`);
        } else {
          lines.push(`  const _result = [];`);
          lines.push(`  for (const _el0 of (${arrayExpr} ?? [])) {`);
          lines.push(`    _result[${dispatchIndexExpr}] = ${body};`);
          lines.push(`  }`);
          lines.push(`  return _result;`);
        }
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
      const isElementWire =
        ("from" in w &&
          (w.from.element ||
            w.to.element ||
            this.elementScopedTools.has(refTrunkKey(w.from)))) ||
        (w.to.element && ("value" in w || "cond" in w)) ||
        // Cond wires targeting a field inside an array mapping are element wires
        ("cond" in w && arrayFields.has(topField) && w.to.path.length > 1) ||
        // Const wires targeting a field inside an array mapping are element wires
        ("value" in w && arrayFields.has(topField) && w.to.path.length > 1);
      if (isElementWire) {
        // Element wire — belongs to an array mapping
        const arr = elementWires.get(topField) ?? [];
        arr.push(w);
        elementWires.set(topField, arr);
      } else if (arrayFields.has(topField) && w.to.path.length === 1) {
        // Root wire for an array field
        arraySourceWires.set(topField, w);
      } else if (
        "from" in w &&
        "spread" in w &&
        w.spread &&
        w.to.path.length === 0
      ) {
        // Spread root wire — handled separately via spreadRootWires
      } else {
        scalarWires.push(w);
      }
    }

    // Build a nested tree from scalar wires using their full output path
    interface TreeNode {
      expr?: string;
      terminal?: boolean;
      spreadExprs?: string[];
      children: Map<string, TreeNode>;
    }
    const tree: TreeNode = { children: new Map() };

    // First pass: handle nested spread wires (spread with path.length > 0)
    const nestedSpreadWires = scalarWires.filter(
      (w) => "from" in w && "spread" in w && w.spread && w.to.path.length > 0,
    );
    const normalScalarWires = scalarWires.filter(
      (w) => !("from" in w && "spread" in w && w.spread),
    );

    // Add nested spread expressions to tree nodes
    for (const w of nestedSpreadWires) {
      const path = w.to.path;
      let current = tree;
      // Navigate to parent of the target
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
      // Add spread expression to this node
      if (!node.spreadExprs) node.spreadExprs = [];
      node.spreadExprs.push(this.wireToExpr(w));
    }

    for (const w of normalScalarWires) {
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
      this.mergeOverdefinedExpr(node, w);
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
      const currentScopeShifted = this.filterCurrentElementWires(
        shifted,
        this.relativeArrayIterators(arrayIterators, arrayField),
      );
      const cf = detectControlFlow(directShifted);
      const anyCf = detectControlFlow(shifted);
      const requiresLabeledLoop = !cf && !!anyCf && anyCf.levels > 1;
      // Check if any element wire generates `await` (element-scoped tools or catch fallbacks)
      const needsAsync = shifted.some((w) => this.wireNeedsAwait(w));
      let mapExpr: string;
      if (needsAsync) {
        // Check if we can generate a dual sync/async path
        const canDualPath =
          !cf && !requiresLabeledLoop && this.asyncOnlyFromTools(shifted);
        const toolRefs = canDualPath
          ? this.collectElementToolRefs(currentScopeShifted)
          : [];
        const hasDualPath = canDualPath && toolRefs.length > 0;

        if (hasDualPath) {
          // Sync branch — .map() with __callSync
          const syncCheck = toolRefs
            .map((r) => `${r}.bridge?.sync`)
            .join(" && ");
          const syncPreamble: string[] = [];
          this.elementLocalVars.clear();
          this.collectElementPreamble(
            currentScopeShifted,
            "_el0",
            syncPreamble,
            true,
          );
          const shiftedIterators = this.relativeArrayIterators(
            arrayIterators,
            arrayField,
          );
          const syncMapExpr =
            syncPreamble.length > 0
              ? `(${arrayExpr})?.map((_el0) => { ${syncPreamble.join(" ")} return ${this.buildElementBody(shifted, shiftedIterators, 0, 6)}; }) ?? null`
              : `(${arrayExpr})?.map((_el0) => (${this.buildElementBody(shifted, shiftedIterators, 0, 6)})) ?? null`;
          this.elementLocalVars.clear();

          // Async branch — for...of inside an async IIFE
          const preambleLines: string[] = [];
          this.elementLocalVars.clear();
          this.collectElementPreamble(
            currentScopeShifted,
            "_el0",
            preambleLines,
          );
          const preamble = preambleLines.map((l) => `      ${l}`).join("\n");
          const asyncExpr = `await ((async (__s) => Array.isArray(__s) ? Promise.all(__s.map(async (_el0) => {\n${preamble}${preamble ? "\n" : ""}      return ${this.buildElementBody(shifted, shiftedIterators, 0, 8)};\n    })) : null)(${arrayExpr}))`;
          this.elementLocalVars.clear();

          mapExpr = `(${syncCheck}) ? ${syncMapExpr} : ${asyncExpr}`;
        } else {
          // Standard async path — Promise.all over async element callbacks so
          // batched tools can queue together before the first flush. Control
          // flow still requires an explicit loop.
          const preambleLines: string[] = [];
          this.elementLocalVars.clear();
          this.collectElementPreamble(
            currentScopeShifted,
            "_el0",
            preambleLines,
          );
          const shiftedIterators = this.relativeArrayIterators(
            arrayIterators,
            arrayField,
          );

          const preamble = preambleLines.map((l) => `      ${l}`).join("\n");
          if (
            cf?.kind === "break" ||
            cf?.kind === "continue" ||
            requiresLabeledLoop
          ) {
            const asyncBody = cf
              ? this.buildElementBodyWithControlFlow(
                  shifted,
                  shiftedIterators,
                  0,
                  8,
                  cf.kind === "continue" ? "for-continue" : "break",
                )
              : `      _result.push(${this.buildElementBody(shifted, shiftedIterators, 0, 8)});`;
            mapExpr = `await (async () => { const _src = ${arrayExpr}; if (_src == null) return null; const _result = []; __loop0: for (const _el0 of _src) {\n      try {\n${preamble}\n${asyncBody}\n      } catch (_ctrl) { if (__isLoopCtrl(_ctrl)) { if (_ctrl.levels > 1) throw __nextLoopCtrl(_ctrl); if (_ctrl.__bridgeControl === "break") break; continue; } throw _ctrl; }\n    } return _result; })()`;
          } else {
            mapExpr = `await ((async (__s) => Array.isArray(__s) ? Promise.all(__s.map(async (_el0) => {\n${preamble}${preamble ? "\n" : ""}      return ${this.buildElementBody(shifted, shiftedIterators, 0, 8)};\n    })) : null)(${arrayExpr}))`;
          }
          this.elementLocalVars.clear();
        }
      } else if (cf?.kind === "continue" && cf.levels === 1) {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          this.relativeArrayIterators(arrayIterators, arrayField),
          0,
          6,
          "continue",
        );
        mapExpr = `((__s) => Array.isArray(__s) ? __s.flatMap((_el0) => {\n${cfBody}\n    }) ?? null : null)(${arrayExpr})`;
      } else if (
        cf?.kind === "break" ||
        cf?.kind === "continue" ||
        requiresLabeledLoop
      ) {
        // Same rationale as root array handling above: nested multilevel
        // control requires for-loop + throw/catch propagation instead of map.
        const loopBody = cf
          ? this.buildElementBodyWithControlFlow(
              shifted,
              this.relativeArrayIterators(arrayIterators, arrayField),
              0,
              8,
              cf.kind === "continue" ? "for-continue" : "break",
            )
          : `      _result.push(${this.buildElementBody(shifted, this.relativeArrayIterators(arrayIterators, arrayField), 0, 8)});`;
        mapExpr = `(() => { const _src = ${arrayExpr}; if (!Array.isArray(_src)) return null; const _result = []; __loop0: for (const _el0 of _src) {\n      try {\n${loopBody}\n      } catch (_ctrl) { if (__isLoopCtrl(_ctrl)) { if (_ctrl.levels > 1) throw __nextLoopCtrl(_ctrl); if (_ctrl.__bridgeControl === "break") break; continue; } throw _ctrl; }\n      } return _result; })()`;
      } else {
        const body = this.buildElementBody(
          shifted,
          this.relativeArrayIterators(arrayIterators, arrayField),
          0,
          6,
        );
        mapExpr = `((__s) => Array.isArray(__s) ? __s.map((_el0) => (${body})) ?? null : null)(${arrayExpr})`;
      }

      if (!tree.children.has(arrayField)) {
        tree.children.set(arrayField, { children: new Map() });
      }
      tree.children.get(arrayField)!.expr = mapExpr;
    }

    // Serialize the tree to a return statement
    // Include spread expressions at the start if present
    const spreadExprs = spreadRootWires.map((w) => this.wireToExpr(w));
    const objStr = this.serializeOutputTree(tree, 4, spreadExprs);
    lines.push(`  return ${objStr};`);
  }

  /** Serialize an output tree node into a JS object literal. */
  private serializeOutputTree(
    node: {
      children: Map<string, { expr?: string; children: Map<string, any> }>;
    },
    indent: number,
    spreadExprs?: string[],
  ): string {
    const pad = " ".repeat(indent);
    const keys = [...node.children.keys()];

    if (
      !spreadExprs?.length &&
      keys.length > 0 &&
      keys.every((key) => /^\d+$/.test(key))
    ) {
      const assignments: string[] = [];
      for (const [key, child] of node.children) {
        const childSpreadExprs = (child as { spreadExprs?: string[] })
          .spreadExprs;
        const valueExpr =
          child.expr != null && child.children.size === 0 && !childSpreadExprs
            ? child.expr
            : childSpreadExprs || child.children.size > 0
              ? this.serializeOutputTree(child, indent + 2, childSpreadExprs)
              : (child.expr ?? "undefined");
        assignments.push(`${pad}_result[${key}] = ${valueExpr};`);
      }
      const innerPad = " ".repeat(indent - 2);
      return `(() => {\n${pad}const _result = [];\n${assignments.join("\n")}\n${pad}return _result;\n${innerPad}})()`;
    }

    const entries: string[] = [];

    // Add spread expressions first (they come before field overrides)
    if (spreadExprs) {
      for (const expr of spreadExprs) {
        entries.push(`${pad}...${expr}`);
      }
    }

    for (const [key, child] of node.children) {
      // Check if child has spread expressions
      const childSpreadExprs = (child as { spreadExprs?: string[] })
        .spreadExprs;

      if (
        child.expr != null &&
        child.children.size === 0 &&
        !childSpreadExprs
      ) {
        // Simple leaf with just an expression
        entries.push(`${pad}${JSON.stringify(key)}: ${child.expr}`);
      } else if (childSpreadExprs || child.children.size > 0) {
        // Nested object: may have spreads, children, or both
        const nested = this.serializeOutputTree(
          child,
          indent + 2,
          childSpreadExprs,
        );
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

  private reorderOverdefinedOutputWires(outputWires: Wire[]): Wire[] {
    if (outputWires.length < 2) return outputWires;

    const groups = new Map<string, Wire[]>();
    for (const wire of outputWires) {
      const pathKey = wire.to.path.join(".");
      const group = groups.get(pathKey) ?? [];
      group.push(wire);
      groups.set(pathKey, group);
    }

    const emitted = new Set<string>();
    const reordered: Wire[] = [];
    let changed = false;

    for (const wire of outputWires) {
      const pathKey = wire.to.path.join(".");
      if (emitted.has(pathKey)) continue;
      emitted.add(pathKey);

      const group = groups.get(pathKey)!;
      if (group.length < 2) {
        reordered.push(...group);
        continue;
      }

      const ranked = group.map((candidate, index) => ({
        wire: candidate,
        index,
        cost: this.classifyOverdefinitionWire(candidate),
      }));
      ranked.sort((left, right) => {
        if (left.cost !== right.cost) {
          changed = true;
          return left.cost - right.cost;
        }
        return left.index - right.index;
      });
      reordered.push(...ranked.map((entry) => entry.wire));
    }

    return changed ? reordered : outputWires;
  }

  private classifyOverdefinitionWire(
    wire: Wire,
    visited = new Set<string>(),
  ): number {
    return this.canResolveWireCheaply(wire, visited) ? 0 : 1;
  }

  private canResolveWireCheaply(
    wire: Wire,
    visited = new Set<string>(),
  ): boolean {
    if ("value" in wire) return true;

    if ("from" in wire) {
      if (!this.refIsZeroCost(wire.from, visited)) return false;
      for (const fallback of wire.fallbacks ?? []) {
        if (fallback.ref && !this.refIsZeroCost(fallback.ref, visited)) {
          return false;
        }
      }
      if (
        wire.catchFallbackRef &&
        !this.refIsZeroCost(wire.catchFallbackRef, visited)
      ) {
        return false;
      }
      return true;
    }

    if ("cond" in wire) {
      if (!this.refIsZeroCost(wire.cond, visited)) return false;
      if (wire.thenRef && !this.refIsZeroCost(wire.thenRef, visited))
        return false;
      if (wire.elseRef && !this.refIsZeroCost(wire.elseRef, visited))
        return false;
      for (const fallback of wire.fallbacks ?? []) {
        if (fallback.ref && !this.refIsZeroCost(fallback.ref, visited)) {
          return false;
        }
      }
      if (
        wire.catchFallbackRef &&
        !this.refIsZeroCost(wire.catchFallbackRef, visited)
      ) {
        return false;
      }
      return true;
    }

    if ("condAnd" in wire) {
      if (!this.refIsZeroCost(wire.condAnd.leftRef, visited)) return false;
      if (
        wire.condAnd.rightRef &&
        !this.refIsZeroCost(wire.condAnd.rightRef, visited)
      ) {
        return false;
      }
      for (const fallback of wire.fallbacks ?? []) {
        if (fallback.ref && !this.refIsZeroCost(fallback.ref, visited)) {
          return false;
        }
      }
      if (
        wire.catchFallbackRef &&
        !this.refIsZeroCost(wire.catchFallbackRef, visited)
      ) {
        return false;
      }
      return true;
    }

    if ("condOr" in wire) {
      if (!this.refIsZeroCost(wire.condOr.leftRef, visited)) return false;
      if (
        wire.condOr.rightRef &&
        !this.refIsZeroCost(wire.condOr.rightRef, visited)
      ) {
        return false;
      }
      for (const fallback of wire.fallbacks ?? []) {
        if (fallback.ref && !this.refIsZeroCost(fallback.ref, visited)) {
          return false;
        }
      }
      if (
        wire.catchFallbackRef &&
        !this.refIsZeroCost(wire.catchFallbackRef, visited)
      ) {
        return false;
      }
      return true;
    }

    return false;
  }

  private refIsZeroCost(ref: NodeRef, visited = new Set<string>()): boolean {
    if (ref.element) return true;
    if (
      ref.module === SELF_MODULE &&
      ((ref.type === this.bridge.type && ref.field === this.bridge.field) ||
        (ref.type === "Context" && ref.field === "context") ||
        (ref.type === "Const" && ref.field === "const"))
    ) {
      return true;
    }
    if (ref.module.startsWith("__define_")) return false;

    const key = refTrunkKey(ref);
    if (visited.has(key)) return false;
    visited.add(key);

    if (ref.module === "__local") {
      const incoming = this.bridge.wires.filter(
        (wire) => refTrunkKey(wire.to) === key,
      );
      return incoming.some((wire) => this.canResolveWireCheaply(wire, visited));
    }

    return false;
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
      const innerArrayIterators = this.relativeArrayIterators(
        arrayIterators,
        field,
      );
      const innerCf = detectControlFlow(shifted);
      // Check if inner loop needs async (element-scoped tools or catch fallbacks)
      const innerNeedsAsync = shifted.some((w) => this.wireNeedsAwait(w));
      let mapExpr: string;
      if (innerNeedsAsync) {
        mapExpr = this.withElementLocalVarScope(() => {
          const innerCurrentScope = this.filterCurrentElementWires(
            shifted,
            innerArrayIterators,
          );
          const innerPreambleLines: string[] = [];
          this.collectElementPreamble(
            innerCurrentScope,
            innerElVar,
            innerPreambleLines,
          );
          const innerBody = innerCf
            ? this.buildElementBodyWithControlFlow(
                shifted,
                innerArrayIterators,
                depth + 1,
                indent + 4,
                innerCf.kind === "continue" ? "for-continue" : "break",
              )
            : `${" ".repeat(indent + 4)}_result.push(${this.buildElementBody(shifted, innerArrayIterators, depth + 1, indent + 4)});`;
          const innerPreamble = innerPreambleLines
            .map((line) => `${" ".repeat(indent + 4)}${line}`)
            .join("\n");
          return `await (async () => { const _src = ${srcExpr}; if (!Array.isArray(_src)) return null; const _result = []; __loop${depth + 1}: for (const ${innerElVar} of _src) {\n${" ".repeat(indent + 4)}try {\n${innerPreamble}${innerPreamble ? "\n" : ""}${innerBody}\n${" ".repeat(indent + 4)}} catch (_ctrl) { if (__isLoopCtrl(_ctrl)) { if (_ctrl.levels > 1) throw __nextLoopCtrl(_ctrl); if (_ctrl.__bridgeControl === "break") break; continue; } throw _ctrl; }\n${" ".repeat(indent + 2)}} return _result; })()`;
        });
      } else if (innerCf?.kind === "continue" && innerCf.levels === 1) {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          innerArrayIterators,
          depth + 1,
          indent + 2,
          "continue",
        );
        mapExpr = `((__s) => Array.isArray(__s) ? __s.flatMap((${innerElVar}) => {\n${cfBody}\n${" ".repeat(indent + 2)}}) ?? null : null)(${srcExpr})`;
      } else if (innerCf?.kind === "break" || innerCf?.kind === "continue") {
        const cfBody = this.buildElementBodyWithControlFlow(
          shifted,
          innerArrayIterators,
          depth + 1,
          indent + 4,
          innerCf.kind === "continue" ? "for-continue" : "break",
        );
        mapExpr = `(() => { const _src = ${srcExpr}; if (!Array.isArray(_src)) return null; const _result = []; __loop${depth + 1}: for (const ${innerElVar} of _src) {\n${" ".repeat(indent + 4)}try {\n${cfBody}\n${" ".repeat(indent + 4)}} catch (_ctrl) { if (__isLoopCtrl(_ctrl)) { if (_ctrl.levels > 1) throw __nextLoopCtrl(_ctrl); if (_ctrl.__bridgeControl === "break") break; continue; } throw _ctrl; }\n${" ".repeat(indent + 2)}} return _result; })()`;
      } else {
        const innerBody = this.buildElementBody(
          shifted,
          innerArrayIterators,
          depth + 1,
          indent + 2,
        );
        mapExpr = `((__s) => Array.isArray(__s) ? __s.map((${innerElVar}) => (${innerBody})) ?? null : null)(${srcExpr})`;
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
    mode: "break" | "continue" | "for-continue",
    resultIndexExpr?: string,
  ): string {
    const elVar = `_el${depth}`;
    const pad = " ".repeat(indent);

    // Find the wire with control flow at the current depth level only
    // (not sub-array element wires)
    const controlWire = elemWires.find(
      (w) =>
        w.to.path.length === 1 &&
        (("fallbacks" in w && w.fallbacks?.some((fb) => fb.control != null)) ||
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
      return resultIndexExpr
        ? `${pad}  _result[${resultIndexExpr}] = ${body};`
        : `${pad}  _result.push(${body});`;
    }

    // Build the check expression using elementWireToExpr to include fallbacks
    const checkExpr = this.elementWireToExpr(controlWire, elVar);

    // Determine the check type
    const isNullish =
      controlWire.fallbacks?.some(
        (fb) => fb.type === "nullish" && fb.control != null,
      ) ?? false;
    const ctrlFromFallback = controlWire.fallbacks?.find(
      (fb) => fb.control != null,
    )?.control;
    const ctrl = ctrlFromFallback ?? controlWire.catchControl;
    const controlKind = ctrl?.kind === "continue" ? "continue" : "break";
    const controlLevels =
      ctrl && (ctrl.kind === "continue" || ctrl.kind === "break")
        ? Math.max(1, Number(ctrl.levels) || 1)
        : 1;
    const controlStatement =
      controlLevels > 1
        ? `throw { __bridgeControl: ${JSON.stringify(controlKind)}, levels: ${controlLevels} };`
        : controlKind === "continue"
          ? "continue;"
          : "break;";

    if (mode === "continue") {
      if (isNullish) {
        return `${pad}  if (${checkExpr} == null) return [];\n${pad}  return [${this.buildElementBody(elemWires, arrayIterators, depth, indent)}];`;
      }
      // falsy fallback control
      return `${pad}  if (!${checkExpr}) return [];\n${pad}  return [${this.buildElementBody(elemWires, arrayIterators, depth, indent)}];`;
    }

    // mode === "for-continue" — same as break but uses native 'continue' keyword
    if (mode === "for-continue") {
      if (isNullish) {
        return `${pad}  if (${checkExpr} == null) ${controlStatement}\n${resultIndexExpr ? `${pad}  _result[${resultIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, depth, indent)};` : `${pad}  _result.push(${this.buildElementBody(elemWires, arrayIterators, depth, indent)});`}`;
      }
      return `${pad}  if (!${checkExpr}) ${controlStatement}\n${resultIndexExpr ? `${pad}  _result[${resultIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, depth, indent)};` : `${pad}  _result.push(${this.buildElementBody(elemWires, arrayIterators, depth, indent)});`}`;
    }

    // mode === "break"
    if (isNullish) {
      return `${pad}  if (${checkExpr} == null) ${controlStatement}\n${resultIndexExpr ? `${pad}  _result[${resultIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, depth, indent)};` : `${pad}  _result.push(${this.buildElementBody(elemWires, arrayIterators, depth, indent)});`}`;
    }
    return `${pad}  if (!${checkExpr}) ${controlStatement}\n${resultIndexExpr ? `${pad}  _result[${resultIndexExpr}] = ${this.buildElementBody(elemWires, arrayIterators, depth, indent)};` : `${pad}  _result.push(${this.buildElementBody(elemWires, arrayIterators, depth, indent)});`}`;
  }

  // ── Wire → expression ────────────────────────────────────────────────────

  /** Convert a wire to a JavaScript expression string. */
  wireToExpr(w: Wire): string {
    // Constant wire
    if ("value" in w) return emitCoerced(w.value);

    // Pull wire
    if ("from" in w) {
      let expr = this.wrapExprWithLoc(this.refToExpr(w.from), w.fromLoc);
      expr = this.applyFallbacks(w, expr);
      return this.wrapWireExpr(w, expr);
    }

    // Conditional wire (ternary)
    if ("cond" in w) {
      const condExpr = this.wrapExprWithLoc(
        this.refToExpr(w.cond),
        w.condLoc ?? w.loc,
      );
      const thenExpr =
        w.thenRef !== undefined
          ? this.wrapExprWithLoc(this.lazyRefToExpr(w.thenRef), w.thenLoc)
          : w.thenValue !== undefined
            ? emitCoerced(w.thenValue)
            : "undefined";
      const elseExpr =
        w.elseRef !== undefined
          ? this.wrapExprWithLoc(this.lazyRefToExpr(w.elseRef), w.elseLoc)
          : w.elseValue !== undefined
            ? emitCoerced(w.elseValue)
            : "undefined";
      let expr = `(${condExpr} ? ${thenExpr} : ${elseExpr})`;
      expr = this.applyFallbacks(w, expr);
      return this.wrapWireExpr(w, expr);
    }

    // Logical AND
    if ("condAnd" in w) {
      const { leftRef, rightRef, rightValue } = w.condAnd;
      const left = this.refToExpr(leftRef);
      let expr: string;
      if (rightRef)
        expr = `(Boolean(${left}) && Boolean(${this.refToExpr(rightRef)}))`;
      else if (rightValue !== undefined)
        expr = `(Boolean(${left}) && Boolean(${emitCoerced(rightValue)}))`;
      else expr = `Boolean(${left})`;
      expr = this.applyFallbacks(w, expr);
      return this.wrapWireExpr(w, expr);
    }

    // Logical OR
    if ("condOr" in w) {
      const { leftRef, rightRef, rightValue } = w.condOr;
      const left = this.refToExpr(leftRef);
      let expr: string;
      if (rightRef)
        expr = `(Boolean(${left}) || Boolean(${this.refToExpr(rightRef)}))`;
      else if (rightValue !== undefined)
        expr = `(Boolean(${left}) || Boolean(${emitCoerced(rightValue)}))`;
      else expr = `Boolean(${left})`;
      expr = this.applyFallbacks(w, expr);
      return this.wrapWireExpr(w, expr);
    }

    return "undefined";
  }

  /** Convert an element wire (inside array mapping) to an expression. */
  private elementWireToExpr(w: Wire, elVar = "_el0"): string {
    const prevElVar = this.currentElVar;
    this.elementVarStack.push(elVar);
    this.currentElVar = elVar;
    try {
      return this.wrapWireExpr(w, this._elementWireToExprInner(w, elVar));
    } finally {
      this.elementVarStack.pop();
      this.currentElVar = prevElVar;
    }
  }

  private wrapWireExpr(w: Wire, expr: string): string {
    const loc = this.serializeLoc(w.loc);
    if (expr.includes("await ")) {
      return `await __wrapBridgeErrorAsync(async () => (${expr}), ${loc})`;
    }
    return `__wrapBridgeError(() => (${expr}), ${loc})`;
  }

  private serializeLoc(loc?: SourceLocation): string {
    return JSON.stringify(loc ?? null);
  }

  private wrapExprWithLoc(expr: string, loc?: SourceLocation): string {
    if (!loc) return expr;
    const serializedLoc = this.serializeLoc(loc);
    if (expr.includes("await ")) {
      return `await __wrapBridgeErrorAsync(async () => (${expr}), ${serializedLoc})`;
    }
    return `__wrapBridgeError(() => (${expr}), ${serializedLoc})`;
  }

  private refToElementExpr(ref: NodeRef): string {
    const depth = ref.elementDepth ?? 0;
    const stackIndex = this.elementVarStack.length - 1 - depth;
    const elVar =
      stackIndex >= 0 ? this.elementVarStack[stackIndex] : this.currentElVar;
    if (!elVar) {
      throw new Error(`Missing element variable for ${JSON.stringify(ref)}`);
    }
    if (ref.path.length === 0) return elVar;
    return this.appendPathExpr(elVar, ref, true);
  }

  private _elementWireToExprInner(w: Wire, elVar: string): string {
    if ("value" in w) return emitCoerced(w.value);

    // Handle ternary (conditional) wires inside array mapping
    if ("cond" in w) {
      const condRef = w.cond;
      let condExpr: string;
      if (condRef.element) {
        condExpr = this.refToElementExpr(condRef);
      } else {
        const condKey = refTrunkKey(condRef);
        if (this.elementScopedTools.has(condKey)) {
          condExpr = this.buildInlineToolExpr(condKey, elVar);
          if (condRef.path.length > 0) {
            condExpr = this.appendPathExpr(`(${condExpr})`, condRef);
          }
        } else {
          condExpr = this.refToExpr(condRef);
        }
      }
      condExpr = this.wrapExprWithLoc(condExpr, w.condLoc ?? w.loc);
      const resolveBranch = (
        ref: NodeRef | undefined,
        val: string | undefined,
        loc: SourceLocation | undefined,
      ): string => {
        if (ref !== undefined) {
          if (ref.element) {
            return this.wrapExprWithLoc(this.refToElementExpr(ref), loc);
          }
          const branchKey = refTrunkKey(ref);
          if (this.elementScopedTools.has(branchKey)) {
            let e = this.buildInlineToolExpr(branchKey, elVar);
            if (ref.path.length > 0) e = this.appendPathExpr(`(${e})`, ref);
            return this.wrapExprWithLoc(e, loc);
          }
          return this.wrapExprWithLoc(this.refToExpr(ref), loc);
        }
        return val !== undefined ? emitCoerced(val) : "undefined";
      };
      const thenExpr = resolveBranch(w.thenRef, w.thenValue, w.thenLoc);
      const elseExpr = resolveBranch(w.elseRef, w.elseValue, w.elseLoc);
      let expr = `(${condExpr} ? ${thenExpr} : ${elseExpr})`;
      expr = this.applyFallbacks(w, expr);
      return expr;
    }

    if ("from" in w) {
      // Check if the source is an element-scoped tool (needs inline computation)
      if (!w.from.element) {
        const srcKey = refTrunkKey(w.from);
        if (this.elementScopedTools.has(srcKey)) {
          let expr = this.buildInlineToolExpr(srcKey, elVar);
          if (w.from.path.length > 0) {
            expr = this.appendPathExpr(`(${expr})`, w.from);
          }
          expr = this.wrapExprWithLoc(expr, w.fromLoc);
          expr = this.applyFallbacks(w, expr);
          return expr;
        }
        // Non-element ref inside array mapping — use normal refToExpr
        let expr = this.wrapExprWithLoc(this.refToExpr(w.from), w.fromLoc);
        expr = this.applyFallbacks(w, expr);
        return expr;
      }
      // Element refs: from.element === true, path = ["srcField"]
      let expr = this.appendPathExpr(elVar, w.from, true);
      expr = this.wrapExprWithLoc(expr, w.fromLoc);
      expr = this.applyFallbacks(w, expr);
      return expr;
    }
    return this.wireToExpr(w);
  }

  /**
   * Build an inline expression for an element-scoped tool.
   * Used when internal tools or define containers depend on element wires.
   */
  private buildInlineToolExpr(trunkKey: string, elVar: string): string {
    // If we have a loop-local variable for this tool, just reference it
    const localVar = this.elementLocalVars.get(trunkKey);
    if (localVar) return localVar;

    // Check if it's a define container (alias)
    if (this.defineContainers.has(trunkKey)) {
      // Find the wires that target this define container
      const wires = this.bridge.wires.filter(
        (w) => refTrunkKey(w.to) === trunkKey,
      );
      if (wires.length === 0) return "undefined";
      // A single root wire can be inlined directly. Field wires must preserve
      // the define container object shape for later path access.
      if (wires.length === 1 && wires[0]!.to.path.length === 0) {
        const w = wires[0]!;
        // Check if the wire itself is element-scoped
        if ("from" in w && w.from.element) {
          return this.elementWireToExpr(w, elVar);
        }
        if ("from" in w && !w.from.element) {
          // Check if the source is another element-scoped tool
          const srcKey = refTrunkKey(w.from);
          if (this.elementScopedTools.has(srcKey)) {
            return this.elementWireToExpr(w, elVar);
          }
        }
        // Check if this is a pipe tool call (alias tool:source as name)
        if ("from" in w && w.pipe) {
          return this.elementWireToExpr(w, elVar);
        }
        return this.wireToExpr(w);
      }
      return this.buildElementContainerExpr(wires, elVar);
    }

    // Internal tool — rebuild inline
    const tool = this.tools.get(trunkKey);
    if (!tool) return "undefined";

    const fieldName = tool.toolName;
    const toolWires = this.bridge.wires.filter(
      (w) => refTrunkKey(w.to) === trunkKey,
    );

    // Check if it's an internal tool we can inline
    if (this.internalToolKeys.has(trunkKey)) {
      const inputs = new Map<string, string>();
      for (const tw of toolWires) {
        const path = tw.to.path;
        const key = path.join(".");
        inputs.set(key, this.elementWireToExpr(tw, elVar));
      }

      const a = inputs.get("a") ?? "undefined";
      const b = inputs.get("b") ?? "undefined";

      switch (fieldName) {
        case "concat": {
          const parts: string[] = [];
          for (let i = 0; ; i++) {
            const partExpr = inputs.get(`parts.${i}`);
            if (partExpr === undefined) break;
            parts.push(partExpr);
          }
          const concatParts = parts
            .map((p) => `(${p} == null ? "" : String(${p}))`)
            .join(" + ");
          return `{ value: ${concatParts || '""'} }`;
        }
        case "add":
          return `(Number(${a}) + Number(${b}))`;
        case "subtract":
          return `(Number(${a}) - Number(${b}))`;
        case "multiply":
          return `(Number(${a}) * Number(${b}))`;
        case "divide":
          return `(Number(${a}) / Number(${b}))`;
        case "eq":
          return `(${a} === ${b})`;
        case "neq":
          return `(${a} !== ${b})`;
        case "gt":
          return `(Number(${a}) > Number(${b}))`;
        case "gte":
          return `(Number(${a}) >= Number(${b}))`;
        case "lt":
          return `(Number(${a}) < Number(${b}))`;
        case "lte":
          return `(Number(${a}) <= Number(${b}))`;
        case "not":
          return `(!${a})`;
        case "and":
          return `(Boolean(${a}) && Boolean(${b}))`;
        case "or":
          return `(Boolean(${a}) || Boolean(${b}))`;
      }
    }

    // Non-internal tool in element scope — inline as an await __call
    const inputObj = this.buildElementToolInput(toolWires, elVar);
    const fnName = this.resolveToolDef(tool.toolName)?.fn ?? tool.toolName;
    return this.memoizedToolKeys.has(trunkKey)
      ? `await __callMemoized(tools[${JSON.stringify(fnName)}], ${inputObj}, ${JSON.stringify(fnName)}, ${JSON.stringify(trunkKey)})`
      : `await __call(tools[${JSON.stringify(fnName)}], ${inputObj}, ${JSON.stringify(fnName)})`;
  }

  /**
   * Check if a wire's generated expression would contain `await`.
   * Used to determine whether array loops must be async (for...of) instead of .map()/.flatMap().
   */
  private wireNeedsAwait(w: Wire): boolean {
    // Element-scoped non-internal tool reference generates await __call()
    if ("from" in w && !w.from.element) {
      const srcKey = refTrunkKey(w.from);
      if (
        this.elementScopedTools.has(srcKey) &&
        !this.internalToolKeys.has(srcKey)
      )
        return true;
      if (
        this.elementScopedTools.has(srcKey) &&
        this.defineContainers.has(srcKey)
      ) {
        return this.hasAsyncElementDeps(srcKey);
      }
    }
    // Catch fallback/control without errFlag → applyFallbacks generates await (async () => ...)()
    if (
      (hasCatchFallback(w) || hasCatchControl(w)) &&
      !this.getSourceErrorFlag(w)
    )
      return true;
    return false;
  }

  /**
   * Returns true when all async needs in the given wires come ONLY from
   * element-scoped tool calls (no catch fallback/control).
   * When this is true, the array map can be made sync if all tools declare
   * `{ sync: true }` — we generate a dual sync/async path at runtime.
   */
  private asyncOnlyFromTools(wires: Wire[]): boolean {
    for (const w of wires) {
      if (
        (hasCatchFallback(w) || hasCatchControl(w)) &&
        !this.getSourceErrorFlag(w)
      )
        return false;
    }
    return true;
  }

  /** Check if an element-scoped tool has transitive async dependencies. */
  private hasAsyncElementDeps(trunkKey: string): boolean {
    const wires = this.bridge.wires.filter(
      (w) => refTrunkKey(w.to) === trunkKey,
    );
    for (const w of wires) {
      if ("from" in w && !w.from.element) {
        const srcKey = refTrunkKey(w.from);
        if (
          this.elementScopedTools.has(srcKey) &&
          !this.internalToolKeys.has(srcKey) &&
          !this.defineContainers.has(srcKey)
        )
          return true;
        if (
          this.elementScopedTools.has(srcKey) &&
          this.defineContainers.has(srcKey)
        ) {
          return this.hasAsyncElementDeps(srcKey);
        }
      }
      if ("from" in w && w.pipe) {
        const srcKey = refTrunkKey(w.from);
        if (
          this.elementScopedTools.has(srcKey) &&
          !this.internalToolKeys.has(srcKey)
        )
          return true;
      }
    }
    return false;
  }

  /**
   * Collect preamble lines for element-scoped tool calls that should be
   * computed once per element and stored in loop-local variables.
   *
   * @param syncOnly When true, emits `__callSync()` calls (no await) — used
   *   inside the sync `.map()` branch of the dual-path array map optimisation.
   */
  private collectElementPreamble(
    elemWires: Wire[],
    elVar: string,
    lines: string[],
    syncOnly = false,
  ): void {
    // Find all element-scoped non-internal tools referenced by element wires
    const needed = new Set<string>();
    const collectDeps = (tk: string) => {
      if (needed.has(tk)) return;
      needed.add(tk);
      // Check if this container depends on other element-scoped tools
      const depWires = this.bridge.wires.filter(
        (w) => refTrunkKey(w.to) === tk,
      );
      for (const w of depWires) {
        if ("from" in w && !w.from.element) {
          const srcKey = refTrunkKey(w.from);
          if (
            this.elementScopedTools.has(srcKey) &&
            !this.internalToolKeys.has(srcKey)
          ) {
            collectDeps(srcKey);
          }
        }
        if ("from" in w && w.pipe) {
          const srcKey = refTrunkKey(w.from);
          if (
            this.elementScopedTools.has(srcKey) &&
            !this.internalToolKeys.has(srcKey)
          ) {
            collectDeps(srcKey);
          }
        }
      }
    };

    for (const w of elemWires) {
      if ("from" in w && !w.from.element) {
        const srcKey = refTrunkKey(w.from);
        if (
          this.elementScopedTools.has(srcKey) &&
          !this.internalToolKeys.has(srcKey)
        ) {
          collectDeps(srcKey);
        }
      }
    }

    for (const tk of this.topologicalSortSubset(needed)) {
      const vn = `_el_${this.elementLocalVars.size}`;
      this.elementLocalVars.set(tk, vn);

      if (this.defineContainers.has(tk)) {
        // Define container — build inline object/value
        const wires = this.bridge.wires.filter((w) => refTrunkKey(w.to) === tk);
        if (wires.length === 1 && wires[0]!.to.path.length === 0) {
          const w = wires[0]!;
          const hasCatch = hasCatchFallback(w) || hasCatchControl(w);
          const hasSafe = "from" in w && w.safe;
          const expr = this.elementWireToExpr(w, elVar);
          if (hasCatch || hasSafe) {
            lines.push(
              `let ${vn}; try { ${vn} = ${expr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; ${vn} = undefined; }`,
            );
          } else {
            lines.push(`const ${vn} = ${expr};`);
          }
        } else {
          lines.push(
            `const ${vn} = ${this.buildElementContainerExpr(wires, elVar)};`,
          );
        }
      } else {
        // Real tool — emit tool call
        const tool = this.tools.get(tk);
        if (!tool) continue;
        const toolWires = this.bridge.wires.filter(
          (w) => refTrunkKey(w.to) === tk,
        );
        const inputObj = this.buildElementToolInput(toolWires, elVar);
        const fnName = this.resolveToolDef(tool.toolName)?.fn ?? tool.toolName;
        const isCatchGuarded = this.catchGuardedTools.has(tk);
        if (syncOnly) {
          const fn = `tools[${JSON.stringify(fnName)}]`;
          const syncExpr = this.memoizedToolKeys.has(tk)
            ? `__callMemoized(${fn}, ${inputObj}, ${JSON.stringify(fnName)}, ${JSON.stringify(tk)})`
            : `__callSync(${fn}, ${inputObj}, ${JSON.stringify(fnName)})`;
          if (isCatchGuarded) {
            lines.push(`let ${vn}, ${vn}_err;`);
            lines.push(
              `try { ${vn} = ${syncExpr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; ${vn}_err = _e; }`,
            );
          } else {
            lines.push(`const ${vn} = ${syncExpr};`);
          }
        } else {
          const asyncExpr = this.syncAwareCall(fnName, inputObj, tk);
          if (isCatchGuarded) {
            lines.push(`let ${vn}, ${vn}_err;`);
            lines.push(
              `try { ${vn} = ${asyncExpr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; ${vn}_err = _e; }`,
            );
          } else {
            lines.push(`const ${vn} = ${asyncExpr};`);
          }
        }
      }
    }
  }

  private topologicalSortSubset(keys: Iterable<string>): string[] {
    const needed = new Set(keys);
    const orderedKeys = [...this.tools.keys(), ...this.defineContainers].filter(
      (key) => needed.has(key),
    );
    const orderIndex = new Map(orderedKeys.map((key, index) => [key, index]));
    const adj = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    for (const key of orderedKeys) {
      adj.set(key, new Set());
      inDegree.set(key, 0);
    }

    for (const key of orderedKeys) {
      const wires = this.bridge.wires.filter((w) => refTrunkKey(w.to) === key);
      for (const w of wires) {
        for (const src of this.getSourceTrunks(w)) {
          if (!needed.has(src) || src === key) continue;
          const neighbors = adj.get(src);
          if (!neighbors || neighbors.has(key)) continue;
          neighbors.add(key);
          inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
        }
      }
    }

    const ready = orderedKeys.filter((key) => (inDegree.get(key) ?? 0) === 0);
    const sorted: string[] = [];

    while (ready.length > 0) {
      ready.sort(
        (left, right) =>
          (orderIndex.get(left) ?? 0) - (orderIndex.get(right) ?? 0),
      );
      const key = ready.shift()!;
      sorted.push(key);
      for (const neighbor of adj.get(key) ?? []) {
        const nextDegree = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, nextDegree);
        if (nextDegree === 0) {
          ready.push(neighbor);
        }
      }
    }

    return sorted.length === orderedKeys.length ? sorted : orderedKeys;
  }

  private filterCurrentElementWires(
    elemWires: Wire[],
    arrayIterators: Record<string, string>,
  ): Wire[] {
    return elemWires.filter(
      (w) => !(w.to.path.length > 1 && w.to.path[0]! in arrayIterators),
    );
  }

  private relativeArrayIterators(
    arrayIterators: Record<string, string>,
    prefix: string,
  ): Record<string, string> {
    const relative: Record<string, string> = {};
    const prefixWithDot = `${prefix}.`;

    for (const [path, alias] of Object.entries(arrayIterators)) {
      if (path === prefix) {
        relative[""] = alias;
      } else if (path.startsWith(prefixWithDot)) {
        relative[path.slice(prefixWithDot.length)] = alias;
      }
    }

    return relative;
  }

  private withElementLocalVarScope<T>(fn: () => T): T {
    const previous = this.elementLocalVars;
    this.elementLocalVars = new Map(previous);
    try {
      return fn();
    } finally {
      this.elementLocalVars = previous;
    }
  }

  private refToExprInElementScope(ref: NodeRef, elVar: string): string {
    const prevElVar = this.currentElVar;
    this.elementVarStack.push(elVar);
    this.currentElVar = elVar;
    try {
      return ref.element ? this.refToElementExpr(ref) : this.refToExpr(ref);
    } finally {
      this.elementVarStack.pop();
      this.currentElVar = prevElVar;
    }
  }

  /**
   * Collect the tool function references (as JS expressions) for all
   * element-scoped non-internal tools used by the given element wires.
   * Used to build runtime sync-check expressions for array map optimisation.
   */
  private collectElementToolRefs(elemWires: Wire[]): string[] {
    const needed = new Set<string>();
    const collectDeps = (tk: string) => {
      if (needed.has(tk)) return;
      needed.add(tk);
      const depWires = this.bridge.wires.filter(
        (w) => refTrunkKey(w.to) === tk,
      );
      for (const w of depWires) {
        if ("from" in w && !w.from.element) {
          const srcKey = refTrunkKey(w.from);
          if (
            this.elementScopedTools.has(srcKey) &&
            !this.internalToolKeys.has(srcKey)
          ) {
            collectDeps(srcKey);
          }
        }
        if ("from" in w && w.pipe) {
          const srcKey = refTrunkKey(w.from);
          if (
            this.elementScopedTools.has(srcKey) &&
            !this.internalToolKeys.has(srcKey)
          ) {
            collectDeps(srcKey);
          }
        }
      }
    };
    for (const w of elemWires) {
      if ("from" in w && !w.from.element) {
        const srcKey = refTrunkKey(w.from);
        if (
          this.elementScopedTools.has(srcKey) &&
          !this.internalToolKeys.has(srcKey)
        ) {
          collectDeps(srcKey);
        }
      }
    }

    const refs: string[] = [];
    for (const tk of needed) {
      if (this.defineContainers.has(tk)) continue;
      const tool = this.tools.get(tk);
      if (!tool) continue;
      const fnName = this.resolveToolDef(tool.toolName)?.fn ?? tool.toolName;
      refs.push(`tools[${JSON.stringify(fnName)}]`);
    }
    return refs;
  }

  /** Build an input object for a tool call inside an array map callback. */
  private buildElementToolInput(wires: Wire[], elVar: string): string {
    if (wires.length === 0) return "{}";
    const entries: string[] = [];
    for (const w of wires) {
      const path = w.to.path;
      const key = path[path.length - 1]!;
      entries.push(
        `${JSON.stringify(key)}: ${this.elementWireToExpr(w, elVar)}`,
      );
    }
    return `{ ${entries.join(", ")} }`;
  }

  private buildElementContainerExpr(wires: Wire[], elVar: string): string {
    if (wires.length === 0) return "undefined";

    let rootExpr: string | undefined;
    const fieldWires: Wire[] = [];

    for (const w of wires) {
      if (w.to.path.length === 0) {
        rootExpr = this.elementWireToExpr(w, elVar);
      } else {
        fieldWires.push(w);
      }
    }

    if (rootExpr !== undefined && fieldWires.length === 0) {
      return rootExpr;
    }

    interface TreeNode {
      expr?: string;
      children: Map<string, TreeNode>;
    }

    const root: TreeNode = { children: new Map() };

    for (const w of fieldWires) {
      let current = root;
      for (let index = 0; index < w.to.path.length - 1; index++) {
        const segment = w.to.path[index]!;
        if (!current.children.has(segment)) {
          current.children.set(segment, { children: new Map() });
        }
        current = current.children.get(segment)!;
      }
      const lastSegment = w.to.path[w.to.path.length - 1]!;
      if (!current.children.has(lastSegment)) {
        current.children.set(lastSegment, { children: new Map() });
      }
      current.children.get(lastSegment)!.expr = this.elementWireToExpr(
        w,
        elVar,
      );
    }

    return this.serializeTreeNode(root, 4, rootExpr);
  }

  /** Apply falsy (||), nullish (??) and catch fallback chains to an expression. */
  private applyFallbacks(w: Wire, expr: string): string {
    if ("fallbacks" in w && w.fallbacks) {
      for (const fb of w.fallbacks) {
        if (fb.type === "falsy") {
          if (fb.ref) {
            expr = `(${expr} || ${this.wrapExprWithLoc(this.refToExpr(fb.ref), fb.loc)})`; // lgtm [js/code-injection]
          } else if (fb.value != null) {
            expr = `(${expr} || ${emitCoerced(fb.value)})`; // lgtm [js/code-injection]
          } else if (fb.control) {
            const ctrl = fb.control;
            if (ctrl.kind === "throw") {
              expr = `(${expr} || (() => { throw new Error(${JSON.stringify(ctrl.message)}); })())`; // lgtm [js/code-injection]
            } else if (ctrl.kind === "panic") {
              expr = `(${expr} || (() => { throw new __BridgePanicError(${JSON.stringify(ctrl.message)}); })())`; // lgtm [js/code-injection]
            }
          }
        } else {
          // nullish
          if (fb.ref) {
            expr = `((__v) => (__v == null ? undefined : __v))((${expr} ?? ${this.wrapExprWithLoc(this.refToExpr(fb.ref), fb.loc)}))`; // lgtm [js/code-injection]
          } else if (fb.value != null) {
            expr = `((__v) => (__v == null ? undefined : __v))((${expr} ?? ${emitCoerced(fb.value)}))`; // lgtm [js/code-injection]
          } else if (fb.control) {
            const ctrl = fb.control;
            if (ctrl.kind === "throw") {
              expr = `(${expr} ?? (() => { throw new Error(${JSON.stringify(ctrl.message)}); })())`; // lgtm [js/code-injection]
            } else if (ctrl.kind === "panic") {
              expr = `(${expr} ?? (() => { throw new __BridgePanicError(${JSON.stringify(ctrl.message)}); })())`; // lgtm [js/code-injection]
            }
          }
        }
      }
    }

    // Catch fallback — use error flag from catch-guarded tool call
    const errFlag = this.getSourceErrorFlag(w);

    if (hasCatchFallback(w)) {
      let catchExpr: string;
      if ("catchFallbackRef" in w && w.catchFallbackRef) {
        catchExpr = this.wrapExprWithLoc(
          this.refToExpr(w.catchFallbackRef),
          "catchLoc" in w ? w.catchLoc : undefined,
        );
      } else if ("catchFallback" in w && w.catchFallback != null) {
        catchExpr = emitCoerced(w.catchFallback);
      } else {
        catchExpr = "undefined";
      }

      if (errFlag) {
        expr = `(${errFlag} !== undefined ? ${catchExpr} : ${expr})`; // lgtm [js/code-injection]
      } else {
        // Fallback: wrap in IIFE with try/catch (re-throw fatal errors)
        expr = `await (async () => { try { return ${expr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; return ${catchExpr}; } })()`; // lgtm [js/code-injection]
      }
    } else if (errFlag) {
      // This wire has NO catch fallback but its source tool is catch-guarded by another
      // wire. If the tool failed, re-throw the stored error rather than silently
      // returning undefined — swallowing the error here would be a silent data bug.
      expr = `(${errFlag} !== undefined ? (() => { throw ${errFlag}; })() : ${expr})`; // lgtm [js/code-injection]
    }

    // Catch control flow (throw/panic on catch gate)
    if ("catchControl" in w && w.catchControl) {
      const ctrl = w.catchControl;
      if (ctrl.kind === "throw") {
        // Wrap in catch IIFE — on error, throw the custom message
        if (errFlag) {
          expr = `(${errFlag} !== undefined ? (() => { throw new Error(${JSON.stringify(ctrl.message)}); })() : ${expr})`; // lgtm [js/code-injection]
        } else {
          expr = `await (async () => { try { return ${expr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; throw new Error(${JSON.stringify(ctrl.message)}); } })()`; // lgtm [js/code-injection]
        }
      } else if (ctrl.kind === "panic") {
        if (errFlag) {
          expr = `(${errFlag} !== undefined ? (() => { throw new __BridgePanicError(${JSON.stringify(ctrl.message)}); })() : ${expr})`; // lgtm [js/code-injection]
        } else {
          expr = `await (async () => { try { return ${expr}; } catch (_e) { if (_e?.name === "BridgePanicError" || _e?.name === "BridgeAbortError") throw _e; throw new __BridgePanicError(${JSON.stringify(ctrl.message)}); } })()`; // lgtm [js/code-injection]
        }
      }
    }

    return expr;
  }

  /** Get the error flag variable name for a wire's source tool, but ONLY if
   * that tool was compiled in catch-guarded mode (i.e. the `_err` variable exists). */
  private getSourceErrorFlag(w: Wire): string | undefined {
    if ("from" in w) {
      return this.getErrorFlagForRef(w.from);
    }
    // For ternary wires, check all referenced tools
    if ("cond" in w) {
      const flags: string[] = [];
      const cf = this.getErrorFlagForRef(w.cond);
      if (cf) flags.push(cf);
      if (w.thenRef) {
        const f = this.getErrorFlagForRef(w.thenRef);
        if (f && !flags.includes(f)) flags.push(f);
      }
      if (w.elseRef) {
        const f = this.getErrorFlagForRef(w.elseRef);
        if (f && !flags.includes(f)) flags.push(f);
      }
      if (flags.length > 0) return flags.join(" ?? "); // Combine error flags
    }
    return undefined;
  }

  /** Get error flag for a specific NodeRef (used by define container emission). */
  private getErrorFlagForRef(ref: NodeRef): string | undefined {
    const srcKey = refTrunkKey(ref);
    if (!this.catchGuardedTools.has(srcKey)) return undefined;
    if (this.internalToolKeys.has(srcKey) || this.defineContainers.has(srcKey))
      return undefined;
    const localVar = this.elementLocalVars.get(srcKey);
    if (localVar) return `${localVar}_err`;
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
          .map((p) => `[${JSON.stringify(p)}]`)
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
      return this.appendPathExpr("input", ref);
    }

    // Tool result reference
    const key = refTrunkKey(ref);

    // Handle element-scoped tools when in array context
    if (this.elementScopedTools.has(key) && this.currentElVar) {
      let expr = this.buildInlineToolExpr(key, this.currentElVar);
      if (ref.path.length > 0) {
        expr = this.appendPathExpr(`(${expr})`, ref);
      }
      return expr;
    }

    // Handle element refs (from.element = true)
    if (ref.element) {
      return this.refToElementExpr(ref);
    }

    const varName = this.varMap.get(key);
    if (!varName)
      throw new Error(`Unknown reference: ${key} (${JSON.stringify(ref)})`);
    if (ref.path.length === 0) return varName;
    return this.appendPathExpr(varName, ref);
  }

  private appendPathExpr(
    baseExpr: string,
    ref: NodeRef,
    allowMissingBase = false,
  ): string {
    if (ref.path.length === 0) return baseExpr;

    const safeFlags = ref.path.map(
      (_, i) =>
        ref.pathSafe?.[i] ?? (i === 0 ? (ref.rootSafe ?? false) : false),
    );
    // Prefer the dedicated single-segment helper on the dominant case.
    // See packages/bridge-compiler/performance.md (#2).
    if (ref.path.length === 1) {
      return `__get(${baseExpr}, ${JSON.stringify(ref.path[0])}, ${safeFlags[0] ? "true" : "false"}, ${allowMissingBase ? "true" : "false"})`;
    }
    return `__path(${baseExpr}, ${JSON.stringify(ref.path)}, ${JSON.stringify(safeFlags)}, ${allowMissingBase ? "true" : "false"})`;
  }

  /**
   * Like refToExpr, but for ternary-only tools, inlines the tool call.
   * This ensures lazy evaluation — only the chosen branch's tool is called.
   */
  private lazyRefToExpr(ref: NodeRef): string {
    const key = refTrunkKey(ref);
    if (this.ternaryOnlyTools.has(key)) {
      const tool = this.tools.get(key);
      if (tool) {
        const toolWires = this.bridge.wires.filter(
          (w) => refTrunkKey(w.to) === key,
        );
        const toolDef = this.resolveToolDef(tool.toolName);
        const fnName = toolDef?.fn ?? tool.toolName;

        // Build input object
        let inputObj: string;
        if (toolDef) {
          const inputEntries = new Map<string, string>();
          for (const tw of toolDef.wires) {
            if (tw.kind === "constant") {
              inputEntries.set(
                tw.target,
                `${JSON.stringify(tw.target)}: ${emitCoerced(tw.value)}`,
              );
            }
          }
          for (const tw of toolDef.wires) {
            if (tw.kind === "pull") {
              const expr = this.resolveToolDepSource(tw.source, toolDef);
              inputEntries.set(
                tw.target,
                `${JSON.stringify(tw.target)}: ${expr}`,
              );
            }
          }
          for (const bw of toolWires) {
            const path = bw.to.path;
            if (path.length >= 1) {
              const bKey = path[0]!;
              inputEntries.set(
                bKey,
                `${JSON.stringify(bKey)}: ${this.wireToExpr(bw)}`,
              );
            }
          }
          const parts = [...inputEntries.values()];
          inputObj = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
        } else {
          inputObj = this.buildObjectLiteral(toolWires, (w) => w.to.path, 4);
        }

        let expr = this.memoizedToolKeys.has(key)
          ? `(await __callMemoized(tools[${JSON.stringify(fnName)}], ${inputObj}, ${JSON.stringify(fnName)}, ${JSON.stringify(key)}))`
          : `(await __call(tools[${JSON.stringify(fnName)}], ${inputObj}, ${JSON.stringify(fnName)}))`;
        if (ref.path.length > 0) {
          expr = this.appendPathExpr(expr, ref);
        }
        return expr;
      }
    }
    return this.refToExpr(ref);
  }

  /**
   * Analyze which tools are only referenced in ternary branches (thenRef/elseRef)
   * and can be lazily evaluated inline instead of eagerly called.
   */
  private analyzeTernaryOnlyTools(
    outputWires: Wire[],
    toolWires: Map<string, Wire[]>,
    defineWires: Map<string, Wire[]>,
    forceMap: Map<string, { catchError?: boolean }>,
  ): void {
    // Collect all tool trunk keys referenced in any wire position
    const allRefs = new Set<string>();
    const ternaryBranchRefs = new Set<string>();

    const processWire = (w: Wire) => {
      if ("from" in w && !w.from.element) {
        allRefs.add(refTrunkKey(w.from));
      }
      if ("cond" in w) {
        allRefs.add(refTrunkKey(w.cond));
        if (w.thenRef) ternaryBranchRefs.add(refTrunkKey(w.thenRef));
        if (w.elseRef) ternaryBranchRefs.add(refTrunkKey(w.elseRef));
      }
      if ("condAnd" in w) {
        allRefs.add(refTrunkKey(w.condAnd.leftRef));
        if (w.condAnd.rightRef) allRefs.add(refTrunkKey(w.condAnd.rightRef));
      }
      if ("condOr" in w) {
        allRefs.add(refTrunkKey(w.condOr.leftRef));
        if (w.condOr.rightRef) allRefs.add(refTrunkKey(w.condOr.rightRef));
      }
      // Fallback refs
      if ("fallbacks" in w && w.fallbacks) {
        for (const fb of w.fallbacks) {
          if (fb.ref) allRefs.add(refTrunkKey(fb.ref));
        }
      }
      if ("catchFallbackRef" in w && w.catchFallbackRef)
        allRefs.add(refTrunkKey(w.catchFallbackRef));
    };

    for (const w of outputWires) processWire(w);
    for (const [, wires] of toolWires) {
      for (const w of wires) processWire(w);
    }
    for (const [, wires] of defineWires) {
      for (const w of wires) processWire(w);
    }

    // A tool is ternary-only if:
    // 1. It's a real tool (not define/internal)
    // 2. It appears ONLY in ternaryBranchRefs, never in allRefs (from regular pull wires, cond refs, etc.)
    // 3. It has no force statement
    // 4. It has no input wires from other ternary-only tools (simple first pass)
    for (const tk of ternaryBranchRefs) {
      if (!this.tools.has(tk)) continue;
      if (this.defineContainers.has(tk)) continue;
      if (this.internalToolKeys.has(tk)) continue;
      if (forceMap.has(tk)) continue;
      if (allRefs.has(tk)) continue; // Referenced outside ternary branches
      this.ternaryOnlyTools.add(tk);
    }
  }

  // ── Nested object literal builder ─────────────────────────────────────────

  private mergeOverdefinedExpr(
    node: { expr?: string; terminal?: boolean },
    wire: Wire,
  ): void {
    const nextExpr = this.wireToExpr(wire);
    const nextIsConstant = "value" in wire;

    if (node.expr == null) {
      node.expr = nextExpr;
      node.terminal = nextIsConstant;
      return;
    }

    if (node.terminal) return;

    if (nextIsConstant) {
      node.expr = `((__v) => (__v != null ? __v : ${nextExpr}))(${node.expr})`;
      node.terminal = true;
      return;
    }

    node.expr = `(${node.expr} ?? ${nextExpr})`;
  }

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

    // Separate root wire (path=[]) from field-specific wires
    let rootExpr: string | undefined;
    const fieldWires: Wire[] = [];

    for (const w of wires) {
      const path = getPath(w);
      if (path.length === 0) {
        rootExpr = this.wireToExpr(w);
      } else {
        fieldWires.push(w);
      }
    }

    // Only a root wire — simple passthrough expression
    if (rootExpr !== undefined && fieldWires.length === 0) {
      return rootExpr;
    }

    // Build tree from field-specific wires
    interface TreeNode {
      expr?: string;
      terminal?: boolean;
      children: Map<string, TreeNode>;
    }
    const root: TreeNode = { children: new Map() };

    for (const w of fieldWires) {
      const path = getPath(w);
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
      this.mergeOverdefinedExpr(node, w);
    }

    // Spread + field overrides: { ...rootExpr, field1: ..., field2: ... }
    return this.serializeTreeNode(root, indent, rootExpr);
  }

  private serializeTreeNode(
    node: {
      children: Map<string, { expr?: string; children: Map<string, unknown> }>;
    },
    indent: number,
    spreadExpr?: string,
  ): string {
    const pad = " ".repeat(indent);
    const entries: string[] = [];

    if (spreadExpr !== undefined) {
      entries.push(`${pad}...${spreadExpr}`);
    }

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

  // ── Overdefinition bypass ───────────────────────────────────────────────

  /**
   * Analyze output wires to identify tools that can be conditionally
   * skipped ("overdefinition bypass").
   *
   * When multiple wires target the same output path, the runtime's
   * pull-based model evaluates them in authored order and returns the
   * first non-null result — later tools are never called.
   *
   * This method detects tools whose output contributions are ALL in
   * secondary (non-first) position and returns check expressions that
   * the caller uses to wrap the tool call in a null-guarded `if` block.
   *
   * Returns a Map from tool trunk key → { checkExprs: string[] }.
   * The tool should only be called if ANY check expression is null.
   */
  private analyzeOverdefinitionBypass(
    outputWires: Wire[],
    toolOrder: string[],
    forceMap: Map<string, { catchError?: boolean }>,
  ): Map<string, { checkExprs: string[] }> {
    const result = new Map<string, { checkExprs: string[] }>();

    // Step 1: Group scalar output wires by path, preserving authored order.
    // Skip root wires (empty path) and element wires (array mapping).
    const outputByPath = new Map<string, Wire[]>();
    for (const w of outputWires) {
      if (w.to.path.length === 0) continue;
      if ("from" in w && w.from.element) continue;
      const pathKey = w.to.path.join(".");
      const arr = outputByPath.get(pathKey) ?? [];
      arr.push(w);
      outputByPath.set(pathKey, arr);
    }

    // Step 2: For each overdefined path, track tool positions.
    // toolTk → { secondaryPaths, hasPrimary }
    const toolInfo = new Map<
      string,
      {
        secondaryPaths: { pathKey: string; priorExpr: string }[];
        hasPrimary: boolean;
      }
    >();

    // Memoize tool sources referenced in prior chains per tool
    const priorToolDeps = new Map<string, Set<string>>();

    for (const [pathKey, wires] of outputByPath) {
      if (wires.length < 2) continue; // no overdefinition

      // Build progressive prior expression chain
      let priorExpr: string | null = null;
      const priorToolsForPath = new Set<string>();

      for (let i = 0; i < wires.length; i++) {
        const w = wires[i]!;
        const wireExpr = this.wireToExpr(w);

        // Check if this wire pulls from a tool
        if ("from" in w && !w.from.element) {
          const srcTk = refTrunkKey(w.from);
          if (this.tools.has(srcTk) && !this.defineContainers.has(srcTk)) {
            if (!toolInfo.has(srcTk)) {
              toolInfo.set(srcTk, { secondaryPaths: [], hasPrimary: false });
            }
            const info = toolInfo.get(srcTk)!;

            if (i === 0) {
              info.hasPrimary = true;
            } else {
              info.secondaryPaths.push({
                pathKey,
                priorExpr: priorExpr!,
              });
              // Record which tools are referenced in prior expressions
              if (!priorToolDeps.has(srcTk))
                priorToolDeps.set(srcTk, new Set());
              for (const dep of priorToolsForPath) {
                priorToolDeps.get(srcTk)!.add(dep);
              }
            }
          }
        }

        // Track tools referenced in this wire (for cascading conditionals)
        if ("from" in w && !w.from.element) {
          const refTk = refTrunkKey(w.from);
          if (this.tools.has(refTk)) priorToolsForPath.add(refTk);
        }

        // Extend prior expression chain
        if (i === 0) {
          priorExpr = wireExpr;
        } else {
          priorExpr = `(${priorExpr} ?? ${wireExpr})`;
        }
      }
    }

    // Step 3: Build topological order index for dependency checking
    const topoIndex = new Map(toolOrder.map((tk, i) => [tk, i]));

    // Step 4: Determine which tools qualify for bypass
    for (const [toolTk, info] of toolInfo) {
      // Must be fully secondary (no primary contributions)
      if (info.hasPrimary) continue;
      if (info.secondaryPaths.length === 0) continue;

      // Exclude force tools, catch-guarded tools, internal tools
      if (forceMap.has(toolTk)) continue;
      if (this.catchGuardedTools.has(toolTk)) continue;
      if (this.internalToolKeys.has(toolTk)) continue;

      // Exclude tools with onError in their ToolDef
      const tool = this.tools.get(toolTk);
      if (tool) {
        const toolDef = this.resolveToolDef(tool.toolName);
        if (toolDef?.wires.some((w) => w.kind === "onError")) continue;
      }

      // Check that all prior tool dependencies appear earlier in topological order
      const thisIdx = topoIndex.get(toolTk) ?? Infinity;
      const deps = priorToolDeps.get(toolTk);
      let valid = true;
      if (deps) {
        for (const dep of deps) {
          if ((topoIndex.get(dep) ?? Infinity) >= thisIdx) {
            valid = false;
            break;
          }
        }
      }
      if (!valid) continue;

      // Check that the tool has no uncaptured output contributions
      // (e.g., root wires or element wires that we skipped in analysis)
      let hasUncaptured = false;
      const capturedPaths = new Set(
        info.secondaryPaths.map((sp) => sp.pathKey),
      );
      for (const w of outputWires) {
        if (!("from" in w)) continue;
        if (w.from.element) continue;
        const srcTk = refTrunkKey(w.from);
        if (srcTk !== toolTk) continue;
        if (w.to.path.length === 0) {
          hasUncaptured = true;
          break;
        }
        const pk = w.to.path.join(".");
        if (!capturedPaths.has(pk)) {
          hasUncaptured = true;
          break;
        }
      }
      if (hasUncaptured) continue;

      // All checks passed — this tool can be conditionally skipped
      const checkExprs = info.secondaryPaths.map((sp) => sp.priorExpr);
      const uniqueChecks = [...new Set(checkExprs)];
      result.set(toolTk, { checkExprs: uniqueChecks });
    }

    return result;
  }

  // ── Dependency analysis & topological sort ────────────────────────────────

  /** Get all source trunk keys a wire depends on. */
  private getSourceTrunks(w: Wire): string[] {
    const trunks: string[] = [];
    const collectTrunk = (ref: NodeRef) => trunks.push(refTrunkKey(ref));

    if ("from" in w) {
      collectTrunk(w.from);
      if (w.fallbacks) {
        for (const fb of w.fallbacks) {
          if (fb.ref) collectTrunk(fb.ref);
        }
      }
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

  /**
   * Returns true if the tool can safely participate in a Promise.all() batch:
   * plain normal-mode call with no bypass condition, no catch guard, no
   * fire-and-forget, no onError ToolDef, and not an internal (sync) tool.
   */
  private isParallelizableTool(
    tk: string,
    conditionalTools: Map<string, { checkExprs: string[] }>,
    forceMap: Map<string, { catchError?: boolean }>,
  ): boolean {
    if (this.defineContainers.has(tk)) return false;
    if (this.internalToolKeys.has(tk)) return false;
    if (this.catchGuardedTools.has(tk)) return false;
    if (forceMap.get(tk)?.catchError) return false;
    if (conditionalTools.has(tk)) return false;
    const tool = this.tools.get(tk);
    if (!tool) return false;
    const toolDef = this.resolveToolDef(tool.toolName);
    if (toolDef?.wires.some((w) => w.kind === "onError")) return false;
    // Tools with ToolDef-level tool deps need their deps emitted first
    if (toolDef?.deps.some((d) => d.kind === "tool")) return false;
    return true;
  }

  /**
   * Build a raw `__call(tools[...], {...}, ...)` expression suitable for use
   * inside `Promise.all([...])` — no `await`, no `const` declaration.
   * Only call this for tools where `isParallelizableTool` returns true.
   */
  private buildNormalCallExpr(tool: ToolInfo, bridgeWires: Wire[]): string {
    const toolDef = this.resolveToolDef(tool.toolName);

    if (!toolDef) {
      const inputObj = this.buildObjectLiteral(
        bridgeWires,
        (w) => w.to.path,
        4,
      );
      return this.syncAwareCallNoAwait(tool.toolName, inputObj, tool.trunkKey);
    }

    const fnName = toolDef.fn ?? tool.toolName;
    const inputEntries = new Map<string, string>();
    for (const tw of toolDef.wires) {
      if (tw.kind === "constant") {
        inputEntries.set(
          tw.target,
          `    ${JSON.stringify(tw.target)}: ${emitCoerced(tw.value)}`,
        );
      }
    }
    for (const tw of toolDef.wires) {
      if (tw.kind === "pull") {
        const expr = this.resolveToolDepSource(tw.source, toolDef);
        inputEntries.set(
          tw.target,
          `    ${JSON.stringify(tw.target)}: ${expr}`,
        );
      }
    }
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
    return this.syncAwareCallNoAwait(fnName, inputObj, tool.trunkKey);
  }

  private topologicalLayers(toolWires: Map<string, Wire[]>): string[][] {
    const toolKeys = [...this.tools.keys()];
    const allKeys = [...toolKeys, ...this.defineContainers];
    const adj = new Map<string, Set<string>>();

    for (const key of allKeys) {
      adj.set(key, new Set());
    }

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

    const inDegree = new Map<string, number>();
    for (const key of allKeys) inDegree.set(key, 0);
    for (const [, neighbors] of adj) {
      for (const n of neighbors) {
        inDegree.set(n, (inDegree.get(n) ?? 0) + 1);
      }
    }

    const layers: string[][] = [];
    let frontier = allKeys.filter((k) => (inDegree.get(k) ?? 0) === 0);

    while (frontier.length > 0) {
      layers.push([...frontier]);
      const next: string[] = [];
      for (const node of frontier) {
        for (const neighbor of adj.get(node) ?? []) {
          const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDeg);
          if (newDeg === 0) next.push(neighbor);
        }
      }
      frontier = next;
    }

    return layers;
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
      const err = new Error("Circular dependency detected in tool calls");
      err.name = "BridgePanicError";
      throw err;
    }

    return sorted;
  }
}
