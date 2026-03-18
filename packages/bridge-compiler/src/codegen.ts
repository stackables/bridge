/**
 * AOT code generator v2 — lazy-getter pull-based compilation.
 *
 * Compiles a Bridge AST (Statement[] body) into a standalone JavaScript
 * function that mirrors the core engine's pull-based evaluation model.
 *
 * Instead of topological sorting and eager tool calls, the generated code
 * uses memoized lazy getters — tools are only invoked when an output wire
 * explicitly asks for their data.
 *
 * SECURITY NOTE: This file is a compiler back-end. It transforms a fully-parsed,
 * validated Bridge AST into JavaScript source strings. No raw external / user
 * input is ever spliced into the output.
 *
 * lgtm [js/code-injection]
 */

import type {
  BridgeDocument,
  Bridge,
  Statement,
  Expression,
  NodeRef,
  WireSourceEntry,
  WireCatch,
  WireStatement,
  WireAliasStatement,
  ScopeStatement,
  WithStatement,
  SpreadStatement,
  ForceStatement,
  ToolDef,
  DefineDef,
} from "@stackables/bridge-core";
import { BridgeCompilerIncompatibleError } from "./bridge-asserts.ts";
import { matchesRequestedFields } from "@stackables/bridge-core";

// ── Public types ────────────────────────────────────────────────────────────

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

// ── Helpers ─────────────────────────────────────────────────────────────────

const SELF_MODULE = "_";

/** Safe JS identifier from a bridge handle name. */
function safeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/** Safe JS string literal (single-quoted). */
function jsStr(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/**
 * Compile a NodeRef path access into JS property access.
 * e.g. ref with path ["data", "items"] → `.data.items`
 * Handles rootSafe (?.) and pathSafe per-segment.
 */
function emitPath(ref: NodeRef, startIdx = 0, forceRootSafe = false): string {
  let code = "";
  for (let i = startIdx; i < ref.path.length; i++) {
    const seg = ref.path[i]!;
    const safe =
      ref.pathSafe?.[i] || (i === 0 && (ref.rootSafe || forceRootSafe));
    code += safe ? "?." : ".";
    // Use bracket notation for non-identifier segments
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(seg)) {
      code += seg;
    } else {
      code += `[${jsStr(seg)}]`;
    }
  }
  return code;
}

// ── Scope-based code generator ──────────────────────────────────────────────

/**
 * Tracks what bindings are visible in the current scope.
 * Each scope can shadow parent bindings.
 */
interface ScopeBinding {
  kind:
    | "tool"
    | "input"
    | "output"
    | "context"
    | "const"
    | "define"
    | "alias"
    | "iterator";
  /** JS expression to access this binding's value */
  jsExpr: string;
  /** For tools: the tool function name for lookup */
  toolName?: string;
  /** For defines: the define name for lookup */
  defineName?: string;
  /** For tools: whether this is memoized */
  memoize?: boolean;
  /** For tools: the tool instance identifier */
  instanceKey?: string;
}

class ScopeChain {
  private bindings = new Map<string, ScopeBinding>();
  constructor(private parent?: ScopeChain) {}

  set(handle: string, binding: ScopeBinding) {
    this.bindings.set(handle, binding);
  }

  get(handle: string): ScopeBinding | undefined {
    return this.bindings.get(handle) ?? this.parent?.get(handle);
  }

  /** Find a tool binding by tool name (not handle name), with instance matching. */
  findTool(
    toolName: string,
    instance: number | undefined,
  ): ScopeBinding | undefined {
    let instanceCount = 0;
    for (const [, binding] of this.bindings) {
      if (binding.kind === "tool" && binding.toolName === toolName) {
        instanceCount++;
        if (!instance || instanceCount === instance) {
          return binding;
        }
      }
    }
    return this.parent?.findTool(toolName, instance);
  }

  child(): ScopeChain {
    return new ScopeChain(this);
  }
}

class CodegenContext {
  private bridge: Bridge;
  private constDefs: Map<string, string>;
  private toolDefs: Map<string, ToolDef>;
  private defineDefs: Map<string, DefineDef>;
  private toolDefCache = new Map<string, ToolDef | null>();
  private toolGetterCount = 0;
  private lines: string[] = [];
  private indent = 1; // start inside function body
  private iteratorStack: { iterVar: string; outVar: string }[] = [];
  private arrayDepthCounter = 0;
  private overdefCount = 0;
  private needsToolCostHelper = false;
  private requestedFields: string[] | undefined;
  private parallelBatchCount = 0;

  constructor(
    bridge: Bridge,
    constDefs: Map<string, string>,
    toolDefs: Map<string, ToolDef>,
    defineDefs: Map<string, DefineDef>,
    requestedFields?: string[],
  ) {
    this.bridge = bridge;
    this.constDefs = constDefs;
    this.toolDefs = toolDefs;
    this.defineDefs = defineDefs;
    this.requestedFields = requestedFields;
  }

  /**
   * Resolve a ToolDef by name, walking the extends chain.
   * Mirrors the runtime's resolveToolDefByName logic:
   * - fn from root (chain[0])
   * - handles deduplicated (first-seen wins)
   * - body accumulated root → leaf
   * - onError last wins
   */
  private resolveToolDef(name: string): ToolDef | undefined {
    if (this.toolDefCache.has(name))
      return this.toolDefCache.get(name) ?? undefined;

    const base = this.toolDefs.get(name);
    if (!base) {
      this.toolDefCache.set(name, null);
      return undefined;
    }

    // Build extends chain: root → ... → leaf
    const chain: ToolDef[] = [base];
    let current = base;
    while (current.extends) {
      const parent = this.toolDefs.get(current.extends);
      if (!parent) break;
      chain.unshift(parent);
      current = parent;
    }

    // Merge
    const merged: ToolDef = {
      kind: "tool",
      name,
      fn: chain[0]!.fn,
      handles: [],
      body: [],
    };
    for (const def of chain) {
      for (const h of def.handles) {
        if (!merged.handles.some((mh) => mh.handle === h.handle))
          merged.handles.push(h);
      }
      if (def.body) merged.body.push(...def.body);
      if (def.onError) merged.onError = def.onError;
    }

    this.toolDefCache.set(name, merged);
    return merged;
  }

  compile(): CompileResult {
    const funcName = `${this.bridge.type}_${this.bridge.field}`;

    // Build root scope from bridge handles
    const rootScope = new ScopeChain();

    // Register handle bindings
    for (const h of this.bridge.handles) {
      switch (h.kind) {
        case "input":
          rootScope.set(h.handle, { kind: "input", jsExpr: "input" });
          break;
        case "output":
          rootScope.set(h.handle, { kind: "output", jsExpr: "__output" });
          break;
        case "context":
          rootScope.set(h.handle, { kind: "context", jsExpr: "context" });
          break;
        case "const": {
          rootScope.set(h.handle, { kind: "const", jsExpr: "__consts" });
          break;
        }
        case "tool":
          rootScope.set(h.handle, {
            kind: "tool",
            jsExpr: `__tool_${safeId(h.handle)}`,
            toolName: h.name,
            memoize: h.memoize === true || undefined,
          });
          break;
        case "define":
          rootScope.set(h.handle, {
            kind: "define",
            jsExpr: `__define_${safeId(h.handle)}`,
            defineName: h.name,
          });
          break;
      }
    }

    // Emit preamble
    this.emit("// --- AOT compiled (lazy-getter pull-based) ---");
    this.emit("const __trace = __opts?.__trace;");
    this.emitMemoHelper();
    this.emitPipeHelper();
    this.emitConsts();
    this.emitToolLookups(rootScope);
    this.emit("let __output = {};");
    this.emit("");

    // Compile the bridge body
    this.compileBody(this.bridge.body, rootScope, "__output");

    this.emit("");
    this.emit("return __output;");

    // Insert tool cost helper at the preamble position if needed
    if (this.needsToolCostHelper) {
      const helperLines = [
        "  function __toolCost(fn) {",
        "    const m = fn?.bridge;",
        "    if (m?.cost != null) return m.cost;",
        "    return m?.sync ? 1 : 2;",
        "  }",
        "",
      ];
      // Insert after the __pipe helper (after the first empty line after preamble block)
      const insertIdx = this.lines.findIndex(
        (l, i) => i > 5 && l.trim() === "" && this.lines[i - 1]?.trim() === "}",
      );
      if (insertIdx >= 0) {
        this.lines.splice(insertIdx + 1, 0, ...helperLines);
      }
    }

    const functionBody = this.lines.join("\n");
    const code =
      `export default async function ${funcName}(input, tools, context, __opts) {\n` +
      functionBody +
      "\n}";

    return { code, functionName: funcName, functionBody };
  }

  // ── Emit helpers ──────────────────────────────────────────────────────

  private emit(line: string) {
    const pad = "  ".repeat(this.indent);
    this.lines.push(pad + line);
  }

  private pushIndent() {
    this.indent++;
  }
  private popIndent() {
    this.indent--;
  }

  // ── Preamble ──────────────────────────────────────────────────────────

  private emitMemoHelper() {
    this.emit("function __memoize(fn) {");
    this.pushIndent();
    this.emit("let cached;");
    this.emit("return () => (cached ??= fn());");
    this.popIndent();
    this.emit("}");
    this.emit("");
  }

  private emitPipeHelper() {
    this.emit("async function __pipe(__fn, __name, __input) {");
    this.pushIndent();
    this.emit(
      "const __doTrace = __trace && (!__fn?.bridge || __fn.bridge.trace !== false);",
    );
    this.emit("const __start = __doTrace ? performance.now() : 0;");
    this.emit("try {");
    this.pushIndent();
    this.emit("const __result = await __fn(__input, context);");
    this.emit(
      "if (__doTrace) __trace(__name, __name, __start, performance.now(), __input, __result, null);",
    );
    this.emit("return __result;");
    this.popIndent();
    this.emit("} catch (__err) {");
    this.pushIndent();
    this.emit(
      "if (__doTrace) __trace(__name, __name, __start, performance.now(), __input, null, __err);",
    );
    this.emit("throw __err;");
    this.popIndent();
    this.emit("}");
    this.popIndent();
    this.emit("}");
    this.emit("");
  }

  private emitConsts() {
    if (this.constDefs.size === 0) return;
    this.emit("const __consts = {");
    this.pushIndent();
    for (const [name, value] of this.constDefs) {
      this.emit(`${safeId(name)}: ${value},`);
    }
    this.popIndent();
    this.emit("};");
    this.emit("");
  }

  private emitToolLookups(_scope: ScopeChain) {
    // Tool lookups are emitted by registerWithBinding during compileBody.
    // This method is kept as a no-op for structural clarity.
    this.emit("");
  }

  // ── Body compilation ──────────────────────────────────────────────────

  private compileBody(
    body: Statement[],
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[] = [],
    absolutePrefix: string[] = [],
  ) {
    // First pass: register any `with` bindings in this scope
    for (const stmt of body) {
      if (stmt.kind === "with") {
        this.registerWithBinding(stmt, scope);
      }
    }

    // Build a map of tool handles → input wires for memoized tool getters
    const toolInputs = this.collectToolInputs(body, scope);

    // Ensure tools with ToolDef bodies always get a getter (even with no bridge input wires)
    for (const h of this.bridge.handles) {
      if (h.kind === "tool" && !toolInputs.has(h.handle)) {
        const toolDef = this.resolveToolDef(h.name);
        if (toolDef && toolDef.body.length > 0) {
          toolInputs.set(h.handle, []);
        }
      }
    }
    // Also check with-bindings in the body (from inner scopes)
    for (const stmt of body) {
      if (stmt.kind === "with" && stmt.binding.kind === "tool") {
        const h = stmt.binding;
        if (!toolInputs.has(h.handle)) {
          const toolDef = this.resolveToolDef(h.name);
          if (toolDef && toolDef.body.length > 0) {
            toolInputs.set(h.handle, []);
          }
        }
      }
    }

    // Collect define input wires
    const defineInputs = this.collectDefineInputs(body, scope);

    // Emit memoized tool getters for this scope
    this.emitToolGetters(toolInputs, scope);

    // Emit memoized define getters for this scope
    this.emitDefineGetters(defineInputs, scope);

    // Group output-targeting wires by target path for overdefinition handling
    const outputWireGroups = this.groupOutputWiresByPath(
      body,
      scope,
      pathPrefix,
    );
    const emittedPaths = new Set<string>();

    // Second pass: compile wires, scopes, force statements.
    // Batch consecutive output wires for parallel execution via Promise.all.
    let pendingWires: {
      valueExpr: string;
      targetExpr: string;
      isRoot: boolean;
    }[] = [];
    const flushPending = () => {
      if (pendingWires.length === 0) return;
      this.emitParallelAssignments(
        pendingWires.map((w) => ({
          expr: w.valueExpr,
          assign: (v: string) =>
            w.isRoot
              ? `Object.assign(${outputVar}, ${v});`
              : `${w.targetExpr} = ${v};`,
        })),
      );
      pendingWires = [];
    };

    for (const stmt of body) {
      switch (stmt.kind) {
        case "wire": {
          // Skip tool input wires (handled by tool getters)
          const handleName = this.findTargetHandle(stmt.target, scope);
          if (handleName) {
            const binding = scope.get(handleName);
            if (binding?.kind === "tool") break;
          }

          // Skip define input wires (handled by define getters)
          if (stmt.target.module.startsWith("__define_")) break;

          // requestedFields filtering: skip output wires for unrequested fields
          if (this.requestedFields && this.requestedFields.length > 0) {
            const pathKey = this.wireOutputPathKey(stmt.target, pathPrefix);
            if (pathKey !== undefined) {
              const absolutePath = [...absolutePrefix, ...pathKey.split(".")]
                .filter(Boolean)
                .join(".");
              if (
                absolutePath &&
                !matchesRequestedFields(absolutePath, this.requestedFields)
              )
                break;
            }
          }

          // Overdefinition: emit grouped wires on first encounter
          {
            const pathKey = this.wireOutputPathKey(stmt.target, pathPrefix);
            if (pathKey !== undefined) {
              const group = outputWireGroups.get(pathKey);
              if (group && group.length > 1) {
                if (!emittedPaths.has(pathKey)) {
                  emittedPaths.add(pathKey);
                  flushPending();
                  this.compileOverdefinedWires(
                    group,
                    scope,
                    outputVar,
                    pathPrefix,
                  );
                }
                break;
              }
            }
          }

          // Single wire — collect for parallel execution
          {
            const isArrayWire =
              stmt.sources.length === 1 &&
              stmt.sources[0]!.expr.type === "array";
            if (isArrayWire) {
              flushPending();
              this.compileWire(stmt, scope, outputVar, pathPrefix);
            } else {
              const target = stmt.target;
              const targetExpr = this.compileTargetRef(
                target,
                scope,
                outputVar,
                pathPrefix,
              );
              const valueExpr = this.compileSourceChain(
                stmt.sources,
                stmt.catch,
                scope,
              );
              const isRoot =
                target.module === SELF_MODULE &&
                target.type === this.bridge.type &&
                target.field === this.bridge.field &&
                target.path.length === 0 &&
                pathPrefix.length === 0;
              pendingWires.push({ valueExpr, targetExpr, isRoot });
            }
          }
          break;
        }
        case "alias":
          flushPending();
          this.compileAlias(stmt, scope);
          break;
        case "scope":
          flushPending();
          this.compileScope(stmt, scope, outputVar, pathPrefix, absolutePrefix);
          break;
        case "spread":
          flushPending();
          this.compileSpread(stmt, scope, outputVar);
          break;
        case "force":
          flushPending();
          this.compileForce(stmt, scope);
          break;
        case "with":
          // Already handled in first pass
          break;
      }
    }
    flushPending();
  }

  private registerWithBinding(stmt: WithStatement, scope: ScopeChain) {
    const h = stmt.binding;
    switch (h.kind) {
      case "input":
        scope.set(h.handle, { kind: "input", jsExpr: "input" });
        break;
      case "output":
        scope.set(h.handle, { kind: "output", jsExpr: "__output" });
        break;
      case "context":
        scope.set(h.handle, { kind: "context", jsExpr: "context" });
        break;
      case "const":
        scope.set(h.handle, { kind: "const", jsExpr: "__consts" });
        break;
      case "tool": {
        const toolId = safeId(h.handle) + "_" + this.toolGetterCount++;
        scope.set(h.handle, {
          kind: "tool",
          jsExpr: `__toolFn_${toolId}`,
          toolName: h.name,
          memoize: h.memoize === true || undefined,
        });
        // Emit tool function lookup — resolve fn through ToolDef extends chain
        const toolDef = this.resolveToolDef(h.name);
        const fnName = toolDef?.fn ?? h.name;
        this.emit(`const __toolFn_${toolId} = tools[${jsStr(fnName)}];`);
        break;
      }
      case "define":
        scope.set(h.handle, {
          kind: "define",
          jsExpr: `__define_${safeId(h.handle)}`,
          defineName: h.name,
        });
        break;
    }
  }

  // ── Tool input collection ─────────────────────────────────────────────

  /**
   * Collect all wire statements that target tool inputs in this scope level.
   * Returns a map: toolHandle → [{ inputField, sourceExpr }]
   */
  private collectToolInputs(
    body: Statement[],
    scope: ScopeChain,
  ): Map<string, { field: string; stmt: WireStatement }[]> {
    const map = new Map<string, { field: string; stmt: WireStatement }[]>();

    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;
      const target = stmt.target;

      // Check if this wire targets a tool's input
      // Tool inputs look like: target.module=toolModule, target.type=toolType, etc.
      // In the statement model, tool input wires target the tool handle
      // We need to identify which handle this targets
      const handleName = this.findTargetHandle(target, scope);
      if (!handleName) continue;

      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "tool") continue;

      let entries = map.get(handleName);
      if (!entries) {
        entries = [];
        map.set(handleName, entries);
      }

      // The target path after the tool reference is the input field
      const field = target.path.join(".");
      entries.push({ field, stmt });
    }

    return map;
  }

  /**
   * Collect all wire statements that target define inputs.
   * Define input wires have target.module starting with "__define_".
   */
  private collectDefineInputs(
    body: Statement[],
    _scope: ScopeChain,
  ): Map<string, { field: string; stmt: WireStatement }[]> {
    const map = new Map<string, { field: string; stmt: WireStatement }[]>();

    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;
      if (!stmt.target.module.startsWith("__define_")) continue;

      // Extract handle name from module: "__define_sp" → "sp"
      const handleName = stmt.target.module.substring("__define_".length);
      let entries = map.get(handleName);
      if (!entries) {
        entries = [];
        map.set(handleName, entries);
      }

      const field = stmt.target.path.join(".");
      entries.push({ field, stmt });
    }

    return map;
  }

  /**
   * Emit memoized define getters for this scope.
   * Each define getter compiles the define body inline, using bridge wires as input.
   */
  private emitDefineGetters(
    defineInputs: Map<string, { field: string; stmt: WireStatement }[]>,
    scope: ScopeChain,
  ) {
    // Also emit getters for defines that have 0 input wires
    // (they might still be referenced as sources)
    for (const h of this.bridge.handles) {
      if (h.kind === "define" && !defineInputs.has(h.handle)) {
        defineInputs.set(h.handle, []);
      }
    }

    for (const [handleName, inputs] of defineInputs) {
      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "define") continue;

      const defineName = binding.defineName ?? handleName;
      const defineDef = this.defineDefs.get(defineName);
      if (!defineDef) continue;

      const getterId = safeId(handleName) + "_def_" + this.toolGetterCount++;
      const getterName = `__get_${getterId}`;

      this.emit(`const ${getterName} = __memoize(async () => {`);
      this.pushIndent();

      // Build define input from bridge wires
      this.emit("const __defInput = {};");
      const singleFields: { field: string; expr: string }[] = [];
      for (const { field, stmt } of inputs) {
        const valueExpr = this.compileSourceChain(
          stmt.sources,
          stmt.catch,
          scope,
        );
        if (field === "") {
          this.emit(`Object.assign(__defInput, ${valueExpr});`);
        } else {
          singleFields.push({ field, expr: valueExpr });
        }
      }
      this.emitParallelAssignments(
        singleFields.map((f) => ({
          expr: f.expr,
          assign: (v: string) => `__defInput[${jsStr(f.field)}] = ${v};`,
        })),
      );

      // Compile define body in a child scope
      this.emit("const __defOutput = {};");
      const defScope = scope.child();

      // Register marker for Define-type refs so compileRefExpr can resolve them
      defScope.set("__defineInput_" + defineName, {
        kind: "input",
        jsExpr: "__defInput",
      });

      // Register define body handles
      for (const stmt of defineDef.body) {
        if (stmt.kind === "with") {
          const h = stmt.binding;
          switch (h.kind) {
            case "input":
              defScope.set(h.handle, { kind: "input", jsExpr: "__defInput" });
              break;
            case "output":
              defScope.set(h.handle, {
                kind: "output",
                jsExpr: "__defOutput",
              });
              break;
            case "context":
              defScope.set(h.handle, { kind: "context", jsExpr: "context" });
              break;
            case "const":
              defScope.set(h.handle, { kind: "const", jsExpr: "__consts" });
              break;
            case "tool": {
              const toolId = safeId(h.handle) + "_" + this.toolGetterCount++;
              defScope.set(h.handle, {
                kind: "tool",
                jsExpr: `__toolFn_${toolId}`,
                toolName: h.name,
                memoize: h.memoize === true || undefined,
              });
              // Resolve fn through ToolDef extends chain
              const innerToolDef = this.resolveToolDef(h.name);
              const fnName = innerToolDef?.fn ?? h.name;
              this.emit(`const __toolFn_${toolId} = tools[${jsStr(fnName)}];`);
              break;
            }
            case "define":
              defScope.set(h.handle, {
                kind: "define",
                jsExpr: `__define_${safeId(h.handle)}`,
                defineName: h.name,
              });
              break;
          }
        }
      }

      // The define body is compiled like a mini-bridge, but with
      // __defInput as input and __defOutput as output.
      // We temporarily override the bridge's type/field context for
      // target resolution.
      this.compileDefineBody(defineDef.body, defScope, "__defOutput");

      this.emit("return __defOutput;");
      this.popIndent();
      this.emit("});");

      // Update the scope binding to use this getter
      binding.jsExpr = getterName;
    }
  }

  /**
   * Compile a define body — like compileBody but uses the define's
   * input/output handles instead of the bridge's.
   */
  private compileDefineBody(
    body: Statement[],
    scope: ScopeChain,
    outputVar: string,
  ) {
    // Collect tool inputs within the define body
    const toolInputs = this.collectDefineToolInputs(body, scope);

    // Emit tool getters for the define scope
    this.emitToolGetters(toolInputs, scope);

    // Compile wires targeting define output
    for (const stmt of body) {
      if (stmt.kind === "wire") {
        // Skip tool input wires (handled by tool getters)
        const handleName = this.findDefineTargetHandle(
          stmt.target,
          scope,
          body,
        );
        if (handleName) {
          const binding = scope.get(handleName);
          if (binding?.kind === "tool") continue;
        }

        // Skip define input wires
        if (stmt.target.module.startsWith("__define_")) continue;

        // This is an output wire in the define
        const targetExpr = this.compileDefineTargetRef(
          stmt.target,
          scope,
          outputVar,
        );
        const valueExpr = this.compileSourceChain(
          stmt.sources,
          stmt.catch,
          scope,
        );
        this.emit(`${targetExpr} = ${valueExpr};`);
      }
    }
  }

  /**
   * Collect tool input wires within a define body.
   */
  private collectDefineToolInputs(
    body: Statement[],
    scope: ScopeChain,
  ): Map<string, { field: string; stmt: WireStatement }[]> {
    const map = new Map<string, { field: string; stmt: WireStatement }[]>();

    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;
      const handleName = this.findDefineTargetHandle(stmt.target, scope, body);
      if (!handleName) continue;

      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "tool") continue;

      let entries = map.get(handleName);
      if (!entries) {
        entries = [];
        map.set(handleName, entries);
      }
      entries.push({ field: stmt.target.path.join("."), stmt });
    }

    return map;
  }

  /**
   * Find which handle a target node ref matches in a define body.
   * Similar to findTargetHandle but uses the define's handles from body.
   */
  private findDefineTargetHandle(
    target: NodeRef,
    _scope: ScopeChain,
    body: Statement[],
  ): string | undefined {
    let instanceCount = 0;
    for (const stmt of body) {
      if (stmt.kind !== "with") continue;
      const h = stmt.binding;
      if (h.kind === "tool") {
        const refName =
          target.module === SELF_MODULE
            ? target.field
            : `${target.module}.${target.field}`;
        const matches = refName === h.name;
        if (matches) {
          instanceCount++;
          if (!target.instance || instanceCount === target.instance) {
            return h.handle;
          }
        }
      }
    }
    return undefined;
  }

  /**
   * Compile a target ref in a define body's output context.
   */
  private compileDefineTargetRef(
    target: NodeRef,
    _scope: ScopeChain,
    outputVar: string,
  ): string {
    // All output wires in a define body target the define's output
    const path = target.path;
    if (path.length > 1) {
      this.emitEnsurePath(outputVar, path.slice(0, -1));
    }
    return `${outputVar}${path.map((p) => `[${jsStr(p)}]`).join("")}`;
  }

  /**
   * Find which handle a NodeRef targets by matching module/type/field against scope bindings.
   */
  private findTargetHandle(
    target: NodeRef,
    _scope: ScopeChain,
  ): string | undefined {
    // Tool input wires have target refs like:
    // { module: "_", type: "Tools", field: "constants", path: ["greeting"], instance: 1 }
    // or for module-scoped tools:
    // { module: "test.async", type: "SyncAsync", field: "multitool", path: [], instance: 1 }
    //
    // Output wires targeting the bridge itself have type === bridgeType (e.g. "Query").
    // We must NOT match output wires as tool input wires.
    //
    // For self-module tools, target.type is "Tools" (from the parser).
    // For module-scoped tools, target.module !== SELF_MODULE.
    if (target.module === SELF_MODULE && target.type !== "Tools") {
      return undefined;
    }

    let instanceCount = 0;
    for (const h of this.bridge.handles) {
      if (h.kind === "tool") {
        const refName =
          target.module === SELF_MODULE
            ? target.field
            : `${target.module}.${target.field}`;
        const matches = refName === h.name;
        if (matches) {
          instanceCount++;
          if (!target.instance || instanceCount === target.instance) {
            return h.handle;
          }
        }
      }
    }

    return undefined;
  }

  // ── Tool getter emission ──────────────────────────────────────────────

  private emitToolGetters(
    toolInputs: Map<string, { field: string; stmt: WireStatement }[]>,
    scope: ScopeChain,
  ) {
    for (const [handleName, inputs] of toolInputs) {
      const binding = scope.get(handleName);
      if (!binding || binding.kind !== "tool") continue;

      const getterId = safeId(handleName) + "_" + this.toolGetterCount++;
      const getterName = `__get_${getterId}`;

      this.emit(`const ${getterName} = __memoize(async () => {`);
      this.pushIndent();

      // Check for root wire (empty field) — passes entire value as tool input
      const rootEntries = inputs.filter((e) => e.field === "");
      const fieldEntries = inputs.filter((e) => e.field !== "");

      // Group field entries by field name for overdefinition handling
      const fieldGroupMap = new Map<string, WireStatement[]>();
      for (const { field, stmt } of fieldEntries) {
        let group = fieldGroupMap.get(field);
        if (!group) {
          group = [];
          fieldGroupMap.set(field, group);
        }
        group.push(stmt);
      }
      const fieldGroups = Array.from(fieldGroupMap, ([field, stmts]) => ({
        field,
        stmts,
      }));

      if (rootEntries.length > 0) {
        // For overdefined root entries, use the cheapest
        const rootStmts = rootEntries.map((e) => e.stmt);
        let rootExpr: string;
        if (rootStmts.length > 1) {
          const ranked = rootStmts.map((s, i) => ({
            stmt: s,
            index: i,
            cost: this.computeExprCost(s.sources[0]!.expr, scope),
          }));
          ranked.sort((a, b) =>
            a.cost !== b.cost ? a.cost - b.cost : a.index - b.index,
          );
          rootExpr = this.compileSourceChain(
            ranked[0]!.stmt.sources,
            ranked[0]!.stmt.catch,
            scope,
          );
        } else {
          rootExpr = this.compileSourceChain(
            rootStmts[0]!.sources,
            rootStmts[0]!.catch,
            scope,
          );
        }
        if (fieldGroups.length > 0) {
          this.emit(`const __toolInput = { ...${rootExpr} };`);
        } else {
          // Match runtime setPath(input, [], value) behavior:
          // non-null objects are spread, null/undefined/primitives become {}
          this.emit(`const __rv = ${rootExpr};`);
          this.emit(
            `const __toolInput = __rv != null && typeof __rv === 'object' && !Array.isArray(__rv) ? __rv : {};`,
          );
        }
      } else {
        this.emit("const __toolInput = {};");
      }

      // Emit ToolDef self-wire defaults (before bridge wires override)
      if (binding.toolName) {
        this.emitToolDefDefaults(binding.toolName, scope);
      }

      // Separate overdefined from single-source fields
      const singleFields: { field: string; expr: string }[] = [];
      for (const { field, stmts } of fieldGroups) {
        if (stmts.length === 1) {
          const valueExpr = this.compileSourceChain(
            stmts[0]!.sources,
            stmts[0]!.catch,
            scope,
          );
          singleFields.push({ field, expr: valueExpr });
        } else {
          // Overdefined — sort by cost and emit null-coalescing block
          const ranked = stmts.map((s, i) => ({
            stmt: s,
            index: i,
            cost: this.computeExprCost(s.sources[0]!.expr, scope),
          }));
          ranked.sort((a, b) =>
            a.cost !== b.cost ? a.cost - b.cost : a.index - b.index,
          );

          const errVar = `__ti_${safeId(field)}_err`;

          const firstExpr = this.compileSourceChain(
            ranked[0]!.stmt.sources,
            ranked[0]!.stmt.catch,
            scope,
          );
          if (ranked[0]!.cost === 0) {
            this.emit(`__toolInput[${jsStr(field)}] = ${firstExpr};`);
            this.emit(`let ${errVar};`);
          } else {
            this.emit(`let ${errVar};`);
            this.emit(
              `try { __toolInput[${jsStr(field)}] = ${firstExpr}; } catch (_e) { ${errVar} = _e; }`,
            );
          }

          for (let i = 1; i < ranked.length; i++) {
            const nextExpr = this.compileSourceChain(
              ranked[i]!.stmt.sources,
              ranked[i]!.stmt.catch,
              scope,
            );
            this.emit(`if (__toolInput[${jsStr(field)}] == null) {`);
            this.pushIndent();
            this.emit(
              `try { __toolInput[${jsStr(field)}] = ${nextExpr}; ${errVar} = undefined; } catch (_e) { ${errVar} = _e; }`,
            );
            this.popIndent();
            this.emit("}");
          }

          this.emit(
            `if (__toolInput[${jsStr(field)}] == null && ${errVar}) throw ${errVar};`,
          );
        }
      }

      // Emit single-source fields — parallelize async ones via Promise.all
      this.emitParallelAssignments(
        singleFields.map((f) => ({
          expr: f.expr,
          assign: (v: string) => `__toolInput[${jsStr(f.field)}] = ${v};`,
        })),
      );

      const toolFnExpr = this.resolveToolFnExpr(handleName, scope);
      const toolName = binding.toolName ?? handleName;
      const toolDef = binding.toolName
        ? this.resolveToolDef(binding.toolName)
        : undefined;

      // Call tool with tracing support (respecting trace:false on tool metadata)
      this.emit(
        `if (typeof ${toolFnExpr} !== 'function') throw new Error('Tool "${toolName}" not found');`,
      );
      this.emit(
        `const __doTrace = __trace && (!${toolFnExpr}?.bridge || ${toolFnExpr}.bridge.trace !== false);`,
      );
      this.emit("const __start = __doTrace ? performance.now() : 0;");
      this.emit("let __result;");
      this.emit("try {");
      this.pushIndent();
      this.emit(`__result = await ${toolFnExpr}(__toolInput, context);`);
      this.emit(
        `if (__doTrace) __trace(${jsStr(toolName)}, ${jsStr(toolName)}, __start, performance.now(), __toolInput, __result, null);`,
      );
      this.popIndent();
      this.emit("} catch (__err) {");
      this.pushIndent();
      this.emit(
        `if (__doTrace) __trace(${jsStr(toolName)}, ${jsStr(toolName)}, __start, performance.now(), __toolInput, null, __err);`,
      );
      // onError — return fallback instead of rethrowing
      if (toolDef?.onError) {
        if ("value" in toolDef.onError) {
          this.emit(`__result = ${toolDef.onError.value};`);
        } else if ("source" in toolDef.onError) {
          const parts = toolDef.onError.source.split(".");
          const src = parts[0]!;
          const path = parts.slice(1);
          const handle = toolDef.handles.find((h) => h.handle === src);
          if (handle?.kind === "context") {
            const pathExpr =
              path.length > 0
                ? path.map((p) => `?.[${jsStr(p)}]`).join("")
                : "";
            this.emit(`__result = context${pathExpr};`);
          } else {
            this.emit("throw __err;");
          }
        } else {
          this.emit("throw __err;");
        }
      } else {
        this.emit("throw __err;");
      }
      this.popIndent();
      this.emit("}");
      this.emit("return __result;");
      this.popIndent();
      this.emit("});");

      // Update the scope binding to use this getter
      binding.jsExpr = getterName;
      binding.instanceKey = getterId;
    }
  }

  private resolveToolFnExpr(handleName: string, scope: ScopeChain): string {
    const binding = scope.get(handleName);
    if (!binding || binding.kind !== "tool" || !binding.toolName) {
      return `tools[${jsStr(handleName)}]`;
    }
    // Check ToolDef extends chain for the root fn
    const toolDef = this.resolveToolDef(binding.toolName);
    const fnName = toolDef?.fn ?? binding.toolName;
    return `tools[${jsStr(fnName)}]`;
  }

  /**
   * Emit ToolDef self-wire defaults into __toolInput.
   * Compiles wires from the ToolDef body where instance==null (config wires)
   * and scope blocks into properties on __toolInput.
   * Also handles inner tool dependencies (instance!=null wires).
   */
  private emitToolDefDefaults(toolName: string, parentScope: ScopeChain) {
    const toolDef = this.resolveToolDef(toolName);
    if (!toolDef || toolDef.body.length === 0) return;

    // Build a child scope for ToolDef body handles (e.g. with const, with context, with innerTool)
    const defScope = parentScope.child();
    for (const stmt of toolDef.body) {
      if (stmt.kind === "with") {
        if (stmt.binding.kind === "tool") {
          // Inner tool dependency — emit a memoized getter for it
          const innerName = stmt.binding.name;
          const innerHandle = stmt.binding.handle;
          const innerDef = this.resolveToolDef(innerName);
          const innerFn = innerDef?.fn ?? innerName;
          const innerId =
            safeId(innerHandle) + "_inner_" + this.toolGetterCount++;
          const innerGetterName = `__get_${innerId}`;

          // Emit inner tool getter
          this.emit(`const ${innerGetterName} = __memoize(async () => {`);
          this.pushIndent();
          this.emit("const __innerInput = {};");

          // Compile inner tool's ToolDef defaults
          if (innerDef && innerDef.body.length > 0) {
            const innerDefScope = defScope.child();
            for (const is of innerDef.body) {
              if (is.kind === "with") {
                this.registerWithBinding(is, innerDefScope);
              }
            }
            for (const is of innerDef.body) {
              if (is.kind === "wire" && is.target.instance == null) {
                const value = this.compileSourceChain(
                  is.sources,
                  is.catch,
                  innerDefScope,
                );
                if (is.target.path.length === 0) {
                  this.emit(`Object.assign(__innerInput, ${value});`);
                } else {
                  this.emitSetPath("__innerInput", is.target.path, value);
                }
              } else if (is.kind === "scope") {
                this.emitToolDefScopeInner(
                  is,
                  innerDefScope,
                  [],
                  "__innerInput",
                );
              }
            }
          }

          // Collect inner tool input wires from ToolDef body (instance!=null targeting this inner tool)
          for (const stmt2 of toolDef.body) {
            if (stmt2.kind === "wire" && stmt2.target.instance != null) {
              // Check if this wire targets the inner tool
              const targetName =
                stmt2.target.module === SELF_MODULE
                  ? stmt2.target.field
                  : `${stmt2.target.module}.${stmt2.target.field}`;
              if (targetName === innerName) {
                const value = this.compileSourceChain(
                  stmt2.sources,
                  stmt2.catch,
                  defScope,
                );
                if (stmt2.target.path.length === 0) {
                  this.emit(`Object.assign(__innerInput, ${value});`);
                } else {
                  this.emitSetPath("__innerInput", stmt2.target.path, value);
                }
              }
            }
          }

          const innerFnExpr = `tools[${jsStr(innerFn)}]`;
          // onError for inner tool
          if (innerDef?.onError && "value" in innerDef.onError) {
            this.emit(`try {`);
            this.pushIndent();
            this.emit(
              `return await __pipe(${innerFnExpr}, ${jsStr(innerName)}, __innerInput);`,
            );
            this.popIndent();
            this.emit(`} catch (__err) {`);
            this.pushIndent();
            this.emit(`return ${innerDef.onError.value};`);
            this.popIndent();
            this.emit("}");
          } else {
            this.emit(
              `return await __pipe(${innerFnExpr}, ${jsStr(innerName)}, __innerInput);`,
            );
          }
          this.popIndent();
          this.emit("});");

          // Register inner tool in scope
          defScope.set(innerHandle, {
            kind: "tool",
            jsExpr: innerGetterName,
            toolName: innerName,
          });
        } else {
          this.registerWithBinding(stmt, defScope);
        }
      }
    }

    // Compile self-wires (instance==null, non-scope) and scope blocks
    for (const stmt of toolDef.body) {
      if (stmt.kind === "wire" && stmt.target.instance == null) {
        const value = this.compileSourceChain(
          stmt.sources,
          stmt.catch,
          defScope,
        );
        const path = stmt.target.path;
        if (path.length === 0) {
          // Root wire — spread into __toolInput
          this.emit(`Object.assign(__toolInput, ${value});`);
        } else {
          this.emitSetPath("__toolInput", path, value);
        }
      } else if (stmt.kind === "scope") {
        this.emitToolDefScope(stmt, defScope, []);
      }
    }
  }

  /**
   * Emit a ToolDef scope block, setting nested properties on __toolInput.
   */
  private emitToolDefScope(
    stmt: ScopeStatement,
    scope: ScopeChain,
    prefix: string[],
  ) {
    const path = [...prefix, ...stmt.target.path];
    for (const inner of stmt.body) {
      if (inner.kind === "wire" && inner.target.instance == null) {
        const value = this.compileSourceChain(
          inner.sources,
          inner.catch,
          scope,
        );
        const fullPath = [...path, ...inner.target.path];
        this.emitSetPath("__toolInput", fullPath, value);
      } else if (inner.kind === "scope") {
        this.emitToolDefScope(inner, scope, path);
      }
    }
  }

  /**
   * Emit scope blocks for inner tool input (used inside inner tool getters).
   */
  private emitToolDefScopeInner(
    stmt: ScopeStatement,
    scope: ScopeChain,
    prefix: string[],
    targetVar: string,
  ) {
    const path = [...prefix, ...stmt.target.path];
    for (const inner of stmt.body) {
      if (inner.kind === "wire" && inner.target.instance == null) {
        const value = this.compileSourceChain(
          inner.sources,
          inner.catch,
          scope,
        );
        const fullPath = [...path, ...inner.target.path];
        this.emitSetPath(targetVar, fullPath, value);
      } else if (inner.kind === "scope") {
        this.emitToolDefScopeInner(inner, scope, path, targetVar);
      }
    }
  }

  /**
   * Emit code to set a nested path on an object, ensuring parents exist.
   */
  private emitSetPath(objVar: string, path: string[], valueExpr: string) {
    // Ensure parent objects exist
    for (let i = 0; i < path.length - 1; i++) {
      const parentPath = path
        .slice(0, i + 1)
        .map((p) => `[${jsStr(p)}]`)
        .join("");
      this.emit(`${objVar}${parentPath} ??= {};`);
    }
    const fullPath = path.map((p) => `[${jsStr(p)}]`).join("");
    this.emit(`${objVar}${fullPath} = ${valueExpr};`);
  }

  // ── Wire compilation ──────────────────────────────────────────────────

  private compileWire(
    wire: WireStatement,
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ) {
    const target = wire.target;

    // Check if this wire targets a tool input (already handled by tool getters)
    const handleName = this.findTargetHandle(target, scope);
    if (handleName) {
      const binding = scope.get(handleName);
      if (binding?.kind === "tool") {
        // Tool input wire — already collected for the getter
        return;
      }
    }

    // This wire targets output or something else
    const targetExpr = this.compileTargetRef(
      target,
      scope,
      outputVar,
      pathPrefix,
    );

    // Special handling for array source expressions (e.g. i.list[] as item { ... })
    if (wire.sources.length === 1 && wire.sources[0]!.expr.type === "array") {
      this.compileArrayAssignment(
        wire.sources[0]!.expr as Extract<Expression, { type: "array" }>,
        targetExpr,
        scope,
      );
      return;
    }

    const valueExpr = this.compileSourceChain(wire.sources, wire.catch, scope);

    // Root output wire — spread into output object instead of reassigning
    if (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      target.path.length === 0 &&
      pathPrefix.length === 0
    ) {
      this.emit(`Object.assign(${outputVar}, ${valueExpr});`);
    } else {
      this.emit(`${targetExpr} = ${valueExpr};`);
    }
  }

  private compileAlias(alias: WireAliasStatement, scope: ScopeChain) {
    const valueExpr = this.compileSourceChain(
      alias.sources,
      alias.catch,
      scope,
    );
    const varName = `__alias_${safeId(alias.name)}`;
    this.emit(`const ${varName} = ${valueExpr};`);

    // Register alias in scope
    scope.set(alias.name, { kind: "alias", jsExpr: varName });
  }

  private compileScope(
    stmt: ScopeStatement,
    parentScope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
    absolutePrefix: string[] = [],
  ) {
    const target = stmt.target;
    // Scope targets are relative to the output
    // target.path is the nested path within the output
    const scopePath = [...pathPrefix, ...target.path];
    const absoluteScopePath = [...absolutePrefix, ...scopePath];

    // requestedFields filtering: skip scopes for unrequested fields
    if (this.requestedFields && this.requestedFields.length > 0) {
      const fieldPath = absoluteScopePath.join(".");
      if (fieldPath && !matchesRequestedFields(fieldPath, this.requestedFields))
        return;
    }

    const scopeVar = `__scope_${scopePath.join("_")}`;
    const childScope = parentScope.child();

    // Ensure parent objects exist
    this.emitEnsurePath(outputVar, scopePath);
    this.emit(
      `const ${scopeVar} = ${outputVar}${scopePath.map((p) => `[${jsStr(p)}]`).join("")};`,
    );

    this.compileBody(stmt.body, childScope, scopeVar, [], absoluteScopePath);
  }

  private compileSpread(
    _stmt: SpreadStatement,
    _scope: ScopeChain,
    _outputVar: string,
  ): never {
    // TODO: implement spread compilation
    throw new BridgeCompilerIncompatibleError(
      `${this.bridge.type}.${this.bridge.field}`,
      "Spread statements are not yet supported by the compiler.",
    );
  }

  private compileForce(stmt: ForceStatement, scope: ScopeChain) {
    const binding = scope.get(stmt.handle);
    if (!binding) return;

    if (binding.kind === "tool") {
      // Force the tool getter to execute
      if (stmt.catchError) {
        this.emit(`try { await ${binding.jsExpr}(); } catch (_) {}`);
      } else {
        this.emit(`await ${binding.jsExpr}();`);
      }
    }
  }

  // ── Overdefinition ────────────────────────────────────────────────────

  /**
   * Compute the output path key for a wire targeting the current bridge's output.
   * Returns undefined if the wire doesn't target output (e.g. targets another tool).
   */
  private wireOutputPathKey(
    target: NodeRef,
    pathPrefix: string[],
  ): string | undefined {
    if (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field
    ) {
      return [...pathPrefix, ...target.path].join(".");
    }
    return undefined;
  }

  /**
   * Group output-targeting wire statements by their target path key.
   * Only groups wires that target the bridge's own output (skips tool input wires).
   */
  private groupOutputWiresByPath(
    body: Statement[],
    scope: ScopeChain,
    pathPrefix: string[],
  ): Map<string, WireStatement[]> {
    const groups = new Map<string, WireStatement[]>();
    for (const stmt of body) {
      if (stmt.kind !== "wire") continue;

      // Skip tool input wires
      const handleName = this.findTargetHandle(stmt.target, scope);
      if (handleName) {
        const binding = scope.get(handleName);
        if (binding?.kind === "tool") continue;
      }

      const pathKey = this.wireOutputPathKey(stmt.target, pathPrefix);
      if (pathKey === undefined) continue;

      let group = groups.get(pathKey);
      if (!group) {
        group = [];
        groups.set(pathKey, group);
      }
      group.push(stmt);
    }
    return groups;
  }

  /**
   * Compile a group of overdefined wires targeting the same output path.
   * Sorts by expression cost (cheapest first) and emits a null-coalescing
   * block that short-circuits on the first non-null result.
   *
   * When all wires have equal static cost > 0 (e.g. all tool refs), emits
   * a runtime-sorted block using tool metadata for cost disambiguation.
   */
  private compileOverdefinedWires(
    wires: WireStatement[],
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ) {
    // Compute static costs
    const ranked = wires.map((wire, index) => ({
      wire,
      index,
      cost: this.computeExprCost(wire.sources[0]!.expr, scope),
    }));

    // Check if all costs are equal and > 0 (needs runtime sorting)
    const allSameCost =
      ranked.length > 1 &&
      ranked[0]!.cost > 0 &&
      ranked.every((r) => r.cost === ranked[0]!.cost);

    if (allSameCost) {
      this.compileRuntimeSortedOverdef(ranked, scope, outputVar, pathPrefix);
      return;
    }

    // Static sorting: cheapest first, authored order for ties
    ranked.sort((a, b) =>
      a.cost !== b.cost ? a.cost - b.cost : a.index - b.index,
    );
    const sorted = ranked.map((e) => e.wire);

    const target = sorted[0]!.target;
    const targetExpr = this.compileTargetRef(
      target,
      scope,
      outputVar,
      pathPrefix,
    );

    // Root output wire — special handling
    const isRoot =
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      target.path.length === 0 &&
      pathPrefix.length === 0;

    const odVar = `__od_${this.overdefCount++}`;
    const errVar = `${odVar}_err`;

    // Emit the first (cheapest) wire's value
    const firstVal = this.compileSourceChain(
      sorted[0]!.sources,
      sorted[0]!.catch,
      scope,
    );

    // If the first wire has cost 0, it can't throw a tool error — emit directly
    if (ranked[0]!.cost === 0) {
      this.emit(`let ${odVar} = ${firstVal};`);
      this.emit(`let ${errVar};`);
    } else {
      this.emit(`let ${odVar};`);
      this.emit(`let ${errVar};`);
      this.emit(
        `try { ${odVar} = ${firstVal}; } catch (_e) { ${errVar} = _e; }`,
      );
    }

    for (let i = 1; i < sorted.length; i++) {
      const nextVal = this.compileSourceChain(
        sorted[i]!.sources,
        sorted[i]!.catch,
        scope,
      );
      this.emit(`if (${odVar} == null) {`);
      this.pushIndent();
      this.emit(
        `try { ${odVar} = ${nextVal}; ${errVar} = undefined; } catch (_e) { ${errVar} = _e; }`,
      );
      this.popIndent();
      this.emit("}");
    }

    this.emit(`if (${odVar} == null && ${errVar}) throw ${errVar};`);

    if (isRoot) {
      this.emit(`Object.assign(${outputVar}, ${odVar});`);
    } else {
      this.emit(`${targetExpr} = ${odVar};`);
    }
  }

  /**
   * Emit a runtime-sorted overdefinition block for wires where all static
   * costs are equal. Uses tool metadata (`bridge.cost`, `bridge.sync`) to
   * determine cost at runtime and sort the evaluation order.
   */
  private compileRuntimeSortedOverdef(
    ranked: { wire: WireStatement; index: number; cost: number }[],
    scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ) {
    this.needsToolCostHelper = true;
    const target = ranked[0]!.wire.target;
    const targetExpr = this.compileTargetRef(
      target,
      scope,
      outputVar,
      pathPrefix,
    );
    const isRoot =
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field &&
      target.path.length === 0 &&
      pathPrefix.length === 0;

    const odVar = `__od_${this.overdefCount++}`;

    // Build an array of { cost, fn } entries sorted at runtime by cost
    // Each fn is a lazy async function that evaluates the wire's source chain
    const entries = ranked.map((r, _i) => {
      const runtimeCost = this.computeRuntimeCostExpr(
        r.wire.sources[0]!.expr,
        scope,
      );
      return { wire: r.wire, costExpr: runtimeCost, index: r.index };
    });

    // Emit: sort entries by runtime cost, then evaluate in order
    this.emit(`const ${odVar}_entries = [`);
    this.pushIndent();
    for (const entry of entries) {
      const valueExpr = this.compileSourceChain(
        entry.wire.sources,
        entry.wire.catch,
        scope,
      );
      this.emit(
        `{ cost: ${entry.costExpr}, idx: ${entry.index}, fn: async () => ${valueExpr} },`,
      );
    }
    this.popIndent();
    this.emit(
      `].sort((a, b) => a.cost !== b.cost ? a.cost - b.cost : a.idx - b.idx);`,
    );

    this.emit(`let ${odVar};`);
    this.emit(`let ${odVar}_err;`);
    this.emit(`for (const __e of ${odVar}_entries) {`);
    this.pushIndent();
    this.emit(
      `try { ${odVar} = await __e.fn(); ${odVar}_err = undefined; } catch (_e) { ${odVar}_err = _e; continue; }`,
    );
    this.emit(`if (${odVar} != null) break;`);
    this.popIndent();
    this.emit("}");
    this.emit(`if (${odVar} == null && ${odVar}_err) throw ${odVar}_err;`);

    if (isRoot) {
      this.emit(`Object.assign(${outputVar}, ${odVar});`);
    } else {
      this.emit(`${targetExpr} = ${odVar};`);
    }
  }

  /**
   * Compute a JS expression that evaluates to the runtime cost of an expression.
   * For tool refs, checks `tools[name].bridge?.cost ?? (tools[name].bridge?.sync ? 1 : 2)`.
   * For non-tool expressions, returns a literal number.
   */
  private computeRuntimeCostExpr(expr: Expression, scope: ScopeChain): string {
    if (expr.type === "ref") {
      const ref = expr.ref;
      if (ref.element) return "0";
      if (ref.type === "Context" || ref.type === "Const") return "0";
      if (ref.module === SELF_MODULE && ref.type === "__local") return "0";
      if (ref.module === SELF_MODULE && ref.instance == null) return "0";
      // Tool ref — generate runtime cost check
      const handle = this.findSourceHandle(ref, scope);
      if (handle) {
        const binding = scope.get(handle);
        if (binding?.kind === "tool" && binding.toolName) {
          return `__toolCost(tools[${jsStr(binding.toolName)}])`;
        }
      }
      const toolKey =
        ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
      return `__toolCost(tools[${jsStr(toolKey)}])`;
    }
    return String(this.computeExprCost(expr, scope));
  }

  /**
   * Compute the static cost of an expression for overdefinition ordering.
   * Mirrors the runtime's computeExprCost logic.
   */
  private computeExprCost(expr: Expression, scope: ScopeChain): number {
    switch (expr.type) {
      case "literal":
      case "control":
        return 0;
      case "ref": {
        const ref = expr.ref;
        if (ref.element) return 0;
        if (ref.type === "Context" || ref.type === "Const") return 0;
        if (ref.module === SELF_MODULE && ref.type === "__local") return 0;
        // Input ref (self-module, no instance → not a tool)
        if (ref.module === SELF_MODULE && ref.instance == null) return 0;
        // Tool ref → default async cost
        return 2;
      }
      case "ternary":
        return Math.max(
          this.computeExprCost(expr.cond, scope),
          this.computeExprCost(expr.then, scope),
          this.computeExprCost(expr.else, scope),
        );
      case "and":
      case "or":
        return Math.max(
          this.computeExprCost(expr.left, scope),
          this.computeExprCost(expr.right, scope),
        );
      case "array":
      case "pipe":
        return this.computeExprCost(expr.source, scope);
      case "binary":
        return Math.max(
          this.computeExprCost(expr.left, scope),
          this.computeExprCost(expr.right, scope),
        );
      case "unary":
        return this.computeExprCost(expr.operand, scope);
      case "concat":
        return Math.max(
          ...expr.parts.map((p) => this.computeExprCost(p, scope)),
        );
    }
  }

  // ── Target reference compilation ──────────────────────────────────────

  private compileTargetRef(
    target: NodeRef,
    _scope: ScopeChain,
    outputVar: string,
    pathPrefix: string[],
  ): string {
    // Output wires: target is in the SELF_MODULE with bridge's type/field
    if (
      target.module === SELF_MODULE &&
      target.type === this.bridge.type &&
      target.field === this.bridge.field
    ) {
      const fullPath = [...pathPrefix, ...target.path];
      // Ensure parent objects exist for nested paths
      if (fullPath.length > 1) {
        this.emitEnsurePath(outputVar, fullPath.slice(0, -1));
      }
      return `${outputVar}${fullPath.map((p) => `[${jsStr(p)}]`).join("")}`;
    }

    // Otherwise it's targeting a tool or something else
    return `${outputVar}${target.path.map((p) => `[${jsStr(p)}]`).join("")}`;
  }

  private emitEnsurePath(baseVar: string, path: string[]) {
    let current = baseVar;
    for (const seg of path) {
      const next = `${current}[${jsStr(seg)}]`;
      this.emit(`${next} ??= {};`);
      current = next;
    }
  }

  // ── Parallel assignment emission ──────────────────────────────────────

  /**
   * Emit a batch of assignments, parallelizing async items via Promise.all.
   * Each item provides the value `expr` and an `assign` function that
   * returns the full assignment statement given the resolved value.
   */
  private emitParallelAssignments(
    items: { expr: string; assign: (valueExpr: string) => string }[],
  ) {
    if (items.length === 0) return;

    const asyncItems = items.filter((it) => it.expr.includes("await"));
    const syncItems = items.filter((it) => !it.expr.includes("await"));

    for (const it of syncItems) {
      this.emit(it.assign(it.expr));
    }

    if (asyncItems.length > 1) {
      const batchId = this.parallelBatchCount++;
      const varNames = asyncItems.map((_, i) => `__p${batchId}_${i}`);
      this.emit(`const [${varNames.join(", ")}] = await Promise.all([`);
      this.pushIndent();
      for (const it of asyncItems) {
        this.emit(`(async () => ${it.expr})(),`);
      }
      this.popIndent();
      this.emit(`]);`);
      for (let i = 0; i < asyncItems.length; i++) {
        this.emit(asyncItems[i]!.assign(varNames[i]!));
      }
    } else if (asyncItems.length === 1) {
      this.emit(asyncItems[0]!.assign(asyncItems[0]!.expr));
    }
  }

  // ── Source chain compilation ──────────────────────────────────────────

  private compileSourceChain(
    sources: WireSourceEntry[],
    wireCatch: WireCatch | undefined,
    scope: ScopeChain,
  ): string {
    if (sources.length === 0) return "undefined";

    let expr = this.compileExpression(sources[0]!.expr, scope);

    // Fallback chain
    for (let i = 1; i < sources.length; i++) {
      const src = sources[i]!;
      const fbExpr = this.compileExpression(src.expr, scope);

      if (src.gate === "nullish") {
        expr = `(${expr} ?? ${fbExpr})`;
      } else if (src.gate === "falsy") {
        expr = `(${expr} || ${fbExpr})`;
      }
    }

    // Catch handler
    if (wireCatch) {
      const catchExpr = this.compileCatch(wireCatch, scope);
      return `await (async () => { try { return ${expr}; } catch (_e) { return ${catchExpr}; } })()`;
    }

    return expr;
  }

  private compileCatch(wireCatch: WireCatch, scope: ScopeChain): string {
    if ("value" in wireCatch) {
      return JSON.stringify(wireCatch.value);
    }
    if ("ref" in wireCatch) {
      return this.compileRefExpr(wireCatch.ref, scope);
    }
    if ("control" in wireCatch) {
      return this.compileControlFlow(wireCatch.control);
    }
    if ("expr" in wireCatch) {
      return this.compileExpression(wireCatch.expr, scope);
    }
    return "undefined";
  }

  // ── Expression compilation ────────────────────────────────────────────

  private compileExpression(expr: Expression, scope: ScopeChain): string {
    switch (expr.type) {
      case "ref":
        return this.compileRefExpr(expr.ref, scope);

      case "literal":
        return JSON.stringify(expr.value);

      case "ternary":
        return `(${this.compileExpression(expr.cond, scope)} ? ${this.compileExpression(expr.then, scope)} : ${this.compileExpression(expr.else, scope)})`;

      case "and":
        return `(${this.compileExpression(expr.left, scope)} && ${this.compileExpression(expr.right, scope)})`;

      case "or":
        return `(${this.compileExpression(expr.left, scope)} || ${this.compileExpression(expr.right, scope)})`;

      case "control":
        return this.compileControlFlow(expr.control);

      case "array":
        return this.compileArrayExpr(expr, scope);

      case "pipe":
        return this.compilePipeExpr(expr, scope);

      case "binary":
        return this.compileBinaryExpr(expr, scope);

      case "unary":
        if (expr.op === "not") {
          return `(!${this.compileExpression(expr.operand, scope)})`;
        }
        return "undefined";

      case "concat":
        return this.compileConcatExpr(expr, scope);
    }
  }

  private compileRefExpr(ref: NodeRef, scope: ScopeChain): string {
    // Element references (array iteration) — must resolve BEFORE self-module
    // because element refs share the same module/type/field as self-module refs.
    if (ref.element) {
      const depth = ref.elementDepth ?? 0;
      const stackIdx = this.iteratorStack.length - 1 - depth;
      if (stackIdx >= 0) {
        return `${this.iteratorStack[stackIdx]!.iterVar}${emitPath(ref)}`;
      }
    }

    // Local references (aliases)
    if (ref.module === "__local" || ref.type === "__local") {
      const binding = scope.get(ref.field);
      if (binding) {
        return `${binding.jsExpr}${emitPath(ref)}`;
      }
    }

    // Self-module references — in source position these are input reads
    if (
      ref.module === SELF_MODULE &&
      ref.type === this.bridge.type &&
      ref.field === this.bridge.field
    ) {
      return `input${emitPath(ref)}`;
    }

    // Context references
    if (ref.module === SELF_MODULE && ref.type === "Context") {
      return `context${emitPath(ref)}`;
    }

    // Const references
    if (ref.module === SELF_MODULE && ref.type === "Const") {
      return `__consts${emitPath(ref)}`;
    }

    // Define-type references — inside a define body, source refs to the define
    // itself resolve to the define's input (e.g., {type: "Define", field: "userProfile"})
    if (ref.module === SELF_MODULE && ref.type === "Define") {
      const marker = scope.get("__defineInput_" + ref.field);
      if (marker) {
        return `${marker.jsExpr}${emitPath(ref)}`;
      }
    }

    // Tool references — resolve through scope chain first, then bridge handles
    const refToolName =
      ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
    // Check scope chain for tool bindings (handles inner tool refs in ToolDef bodies
    // and define bodies where handle name differs from tool name)
    const scopeBinding =
      scope.get(refToolName) ?? scope.findTool(refToolName, ref.instance);
    if (scopeBinding?.kind === "tool") {
      if (ref.rootSafe) {
        return `(await ${scopeBinding.jsExpr}().catch(() => undefined))${emitPath(ref)}`;
      }
      return `(await ${scopeBinding.jsExpr}())${emitPath(ref)}`;
    }

    const handle = this.findSourceHandle(ref, scope);
    if (handle) {
      const binding = scope.get(handle);
      if (binding?.kind === "tool") {
        if (ref.rootSafe) {
          // Error suppression via ?. — swallow tool errors → undefined
          return `(await ${binding.jsExpr}().catch(() => undefined))${emitPath(ref)}`;
        }
        return `(await ${binding.jsExpr}())${emitPath(ref)}`;
      }
      if (binding) {
        return `${binding.jsExpr}${emitPath(ref)}`;
      }
    }

    // Define references — module starts with "__define_"
    if (ref.module.startsWith("__define_")) {
      const defineHandle = ref.module.substring("__define_".length);
      const defineBinding = scope.get(defineHandle);
      if (defineBinding?.kind === "define") {
        return `(await ${defineBinding.jsExpr}())${emitPath(ref)}`;
      }
    }

    // Fallback: direct tool access
    const toolKey =
      ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
    if (ref.rootSafe) {
      return `(await tools[${jsStr(toolKey)}]().catch(() => undefined))${emitPath(ref)}`;
    }
    return `(await tools[${jsStr(toolKey)}]())${emitPath(ref)}`;
  }

  private findSourceHandle(
    ref: NodeRef,
    _scope: ScopeChain,
  ): string | undefined {
    // Look through scope bindings for a match.
    // When multiple handles share the same tool name, use `instance` to
    // pick the correct one.
    let instanceCount = 0;
    for (const h of this.bridge.handles) {
      if (h.kind === "tool") {
        const refName =
          ref.module === SELF_MODULE ? ref.field : `${ref.module}.${ref.field}`;
        const matches = refName === h.name;
        if (matches) {
          instanceCount++;
          if (!ref.instance || instanceCount === ref.instance) {
            return h.handle;
          }
        }
      }
      if (h.kind === "input") {
        if (
          ref.module === SELF_MODULE &&
          ref.type === this.bridge.type &&
          ref.field === this.bridge.field
        ) {
          return h.handle;
        }
      }
    }
    return undefined;
  }

  // ── Array expression ──────────────────────────────────────────────────

  /**
   * Compile an array mapping expression as a wire assignment.
   * Emits: targetExpr = await Promise.all((source ?? []).map(async (el) => { ... }))
   */
  private compileArrayAssignment(
    expr: Extract<Expression, { type: "array" }>,
    targetExpr: string,
    scope: ScopeChain,
  ) {
    const depth = this.arrayDepthCounter++;
    const iterVar = `__el_${depth}`;
    const outVar = `__elOut_${depth}`;

    // Compile the source iterable expression
    const sourceExpr = this.compileExpression(expr.source, scope);

    this.emit(
      `${targetExpr} = await Promise.all((${sourceExpr} ?? []).map(async (${iterVar}) => {`,
    );
    this.pushIndent();
    this.emit(`const ${outVar} = {};`);

    // Create child scope — iterator may shadow parent bindings (scope rules)
    const childScope = scope.child();
    childScope.set(expr.iteratorName, {
      kind: "iterator",
      jsExpr: iterVar,
    });

    // Push iterator stack for element ref resolution
    this.iteratorStack.push({ iterVar, outVar });

    // Compile body using the child scope with element output as outputVar
    this.compileBody(expr.body, childScope, outVar);

    this.iteratorStack.pop();

    this.emit(`return ${outVar};`);
    this.popIndent();
    this.emit(`}));`);
  }

  private compileArrayExpr(
    _expr: Extract<Expression, { type: "array" }>,
    _scope: ScopeChain,
  ): never {
    throw new BridgeCompilerIncompatibleError(
      `${this.bridge.type}.${this.bridge.field}`,
      "Array mapping is not yet supported by the new compiler.",
    );
  }

  // ── Pipe expression ───────────────────────────────────────────────────

  private compilePipeExpr(
    expr: Extract<Expression, { type: "pipe" }>,
    scope: ScopeChain,
  ): string {
    const sourceExpr = this.compileExpression(expr.source, scope);
    const pipePath = expr.path && expr.path.length > 0 ? expr.path : ["in"];

    // Look up tool binding for the pipe handle
    const binding = scope.get(expr.handle);
    if (!binding || binding.kind !== "tool") {
      throw new BridgeCompilerIncompatibleError(
        `${this.bridge.type}.${this.bridge.field}`,
        `Pipe handle "${expr.handle}" is not a tool binding.`,
      );
    }
    const toolName = binding.toolName ?? expr.handle;
    // Resolve fn through ToolDef extends chain
    const toolDef = this.resolveToolDef(toolName);
    const fnName = toolDef?.fn ?? toolName;
    const toolFnExpr = `tools[${jsStr(fnName)}]`;

    // Check if this tool has ToolDef defaults or bridge input wires
    const hasToolDefDefaults = toolDef && toolDef.body.length > 0;

    // Check for bridge-level wires targeting this tool handle
    const hasBridgeWires = this.bridge.body.some(
      (s) =>
        s.kind === "wire" &&
        this.findTargetHandle(s.target, scope) === expr.handle,
    );

    if (!hasToolDefDefaults && !hasBridgeWires) {
      // Simple case — no ToolDef defaults or bridge wires, direct pipe call
      const inputObj = `{ ${pipePath.map((p) => `${jsStr(p)}: ${sourceExpr}`).join(", ")} }`;
      return `(await __pipe(${toolFnExpr}, ${jsStr(toolName)}, ${inputObj}))`;
    }

    // Complex case — merge ToolDef defaults + pipe source
    // Emit as IIFE to build the input object
    const parts: string[] = [];
    parts.push("(await (async () => {");
    parts.push("  const __pipeInput = {};");

    // Compile ToolDef self-wire defaults inline (if toolDef exists)
    const defScope = scope.child();
    if (toolDef) {
      for (const stmt of toolDef.body) {
        if (stmt.kind === "with") {
          // Just register in scope — actual bindings come from parent
          if (stmt.binding.kind === "const") {
            defScope.set(stmt.binding.handle, {
              kind: "const",
              jsExpr: "__consts",
            });
          } else if (stmt.binding.kind === "context") {
            defScope.set(stmt.binding.handle, {
              kind: "context",
              jsExpr: "context",
            });
          }
        }
      }
      for (const stmt of toolDef.body) {
        if (stmt.kind === "wire" && stmt.target.instance == null) {
          const value = this.compileSourceChain(
            stmt.sources,
            stmt.catch,
            defScope,
          );
          const path = stmt.target.path;
          if (path.length === 0) {
            parts.push(`  Object.assign(__pipeInput, ${value});`);
          } else {
            for (let i = 0; i < path.length - 1; i++) {
              const pp = path
                .slice(0, i + 1)
                .map((p) => `[${jsStr(p)}]`)
                .join("");
              parts.push(`  __pipeInput${pp} ??= {};`);
            }
            parts.push(
              `  __pipeInput${path.map((p) => `[${jsStr(p)}]`).join("")} = ${value};`,
            );
          }
          parts.push(
            `  __pipeInput${path.map((p) => `[${jsStr(p)}]`).join("")} = ${value};`,
          );
        }
      }
    }

    // Bridge-level wires targeting this tool handle override ToolDef defaults
    for (const stmt of this.bridge.body) {
      if (stmt.kind !== "wire") continue;
      const handleName = this.findTargetHandle(stmt.target, scope);
      if (handleName !== expr.handle) continue;
      const value = this.compileSourceChain(stmt.sources, stmt.catch, scope);
      const path = stmt.target.path;
      if (path.length === 0) {
        parts.push(`  Object.assign(__pipeInput, ${value});`);
      } else {
        for (let i = 0; i < path.length - 1; i++) {
          const pp = path
            .slice(0, i + 1)
            .map((p) => `[${jsStr(p)}]`)
            .join("");
          parts.push(`  __pipeInput${pp} ??= {};`);
        }
        parts.push(
          `  __pipeInput${path.map((p) => `[${jsStr(p)}]`).join("")} = ${value};`,
        );
      }
    }

    // Pipe source overrides last
    for (let i = 0; i < pipePath.length - 1; i++) {
      const pp = pipePath
        .slice(0, i + 1)
        .map((p) => `[${jsStr(p)}]`)
        .join("");
      parts.push(`  __pipeInput${pp} ??= {};`);
    }
    parts.push(
      `  __pipeInput${pipePath.map((p) => `[${jsStr(p)}]`).join("")} = ${sourceExpr};`,
    );
    parts.push(
      `  return __pipe(${toolFnExpr}, ${jsStr(toolName)}, __pipeInput);`,
    );
    parts.push("})())");

    return parts.join("\n");
  }

  // ── Binary expression ─────────────────────────────────────────────────

  private compileBinaryExpr(
    expr: Extract<Expression, { type: "binary" }>,
    scope: ScopeChain,
  ): string {
    const left = this.compileExpression(expr.left, scope);
    const right = this.compileExpression(expr.right, scope);

    const opMap: Record<string, string> = {
      add: "+",
      sub: "-",
      mul: "*",
      div: "/",
      eq: "===",
      neq: "!==",
      gt: ">",
      gte: ">=",
      lt: "<",
      lte: "<=",
    };

    const jsOp = opMap[expr.op];
    if (!jsOp) return "undefined";
    return `(${left} ${jsOp} ${right})`;
  }

  // ── Concat expression ─────────────────────────────────────────────────

  private compileConcatExpr(
    expr: Extract<Expression, { type: "concat" }>,
    scope: ScopeChain,
  ): string {
    const parts = expr.parts.map((p) => this.compileExpression(p, scope));
    return `(${parts.join(" + ")})`;
  }

  // ── Control flow ──────────────────────────────────────────────────────

  private compileControlFlow(ctrl: {
    kind: string;
    message?: string;
    levels?: number;
  }): string {
    switch (ctrl.kind) {
      case "throw":
        return `(() => { throw new Error(${jsStr(ctrl.message ?? "")}); })()`;
      case "panic":
        return `(() => { throw new (__opts?.__BridgePanicError ?? Error)(${jsStr(ctrl.message ?? "")}); })()`;
      default:
        return "undefined";
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Compile a single bridge operation into a standalone async JavaScript function.
 *
 * The generated function uses a lazy-getter / pull-based model:
 * - Tools are wrapped in memoized async getters
 * - Output wires pull data on demand
 * - Scopes are JS closures with lexical binding
 */
export function compileBridge(
  document: BridgeDocument,
  options: CompileOptions,
): CompileResult {
  const { operation } = options;
  const dotIdx = operation.indexOf(".");
  if (dotIdx === -1) {
    throw new Error(
      `Invalid operation: "${operation}", expected "Type.field".`,
    );
  }
  const type = operation.substring(0, dotIdx);
  const field = operation.substring(dotIdx + 1);

  const bridge = document.instructions.find(
    (i): i is Bridge =>
      i.kind === "bridge" && i.type === type && i.field === field,
  );
  if (!bridge) {
    throw new Error(`No bridge definition found for operation: ${operation}`);
  }

  // Collect const definitions from the document
  const constDefs = new Map<string, string>();
  for (const inst of document.instructions) {
    if (inst.kind === "const") constDefs.set(inst.name, inst.value);
  }

  // Collect tool definitions from the document
  const toolDefs = new Map<string, ToolDef>();
  for (const inst of document.instructions) {
    if (inst.kind === "tool") toolDefs.set(inst.name, inst);
  }

  // Collect define definitions from the document
  const defineDefs = new Map<string, DefineDef>();
  for (const inst of document.instructions) {
    if (inst.kind === "define") defineDefs.set(inst.name, inst);
  }

  const ctx = new CodegenContext(
    bridge,
    constDefs,
    toolDefs,
    defineDefs,
    options.requestedFields,
  );
  return ctx.compile();
}
